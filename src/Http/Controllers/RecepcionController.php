<?php

namespace Muni\Arcop\Http\Controllers;

use Illuminate\Contracts\View\View;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Muni\Arcop\AdoptanteIncompleto;
use Muni\Arcop\Recepcion\TitularesBuscados;
use Muni\Shared\Privacidad\Ciclo\EtiquetaDeTitular;
use Muni\Shared\Privacidad\Contratos\BuscaTitulares;
use Muni\Shared\Privacidad\Contratos\RegistroDeEvidencia;
use Muni\Shared\Privacidad\Contratos\TitularDeDatos;
use Muni\Shared\Privacidad\Contratos\VerificadorIdentidad;
use Muni\Shared\Privacidad\Solicitante;
use Muni\Shared\Privacidad\Solicitudes;
use Muni\Shared\Privacidad\SolicitudRechazada;
use Muni\Shared\Privacidad\TipoDeSolicitud;
use RuntimeException;

/**
 * La recepción en el mesón, en dos pasos: primero se busca a la persona, después
 * se llena la solicitud.
 *
 * Son dos pantallas y no una con buscador incrustado porque este panel no usa
 * JavaScript: sin él, un selector con búsqueda en vivo no existe. El costo es
 * una recarga; la ganancia es que funciona en cualquier navegador, con lector de
 * pantalla y sin depender de que un bundle haya cargado.
 *
 * Entre los dos pasos no viaja la clave del titular —en atencionvecino ES el
 * RUT— sino una referencia opaca que solo esta sesión sabe traducir (ver
 * `TitularesBuscados`). Es lo que cierra la enumeración del padrón por el paso
 * 2 y lo que saca el RUT del access log y del historial del navegador.
 */
class RecepcionController extends Controller
{
    /** Dónde guarda el panel, dentro del disco de evidencia, los documentos de representación. */
    private const CARPETA_ACREDITACIONES = 'acreditaciones';

    /** El paso 1: el buscador, con lo que la última búsqueda de esta sesión encontró. */
    public function buscador(TitularesBuscados $buscados): View
    {
        $busqueda = $buscados->ultimaBusqueda();
        $minimo = (int) config('arcop-panel.buscador.minimo_caracteres');

        return view('arcop-panel::solicitudes.buscar', [
            'termino' => $busqueda['termino'],
            'minimo' => $minimo,
            'buscoDeVerdad' => $this->alcanzaElMinimo($busqueda['termino'], $minimo),
            'resultados' => $busqueda['resultados'],
        ]);
    }

    /**
     * La búsqueda, por POST y con redirección (Post/Redirect/Get).
     *
     * Lo tipeado —un nombre, un RUT— no queda en la URL, y por lo tanto tampoco
     * en el access log del servidor ni en el historial del navegador compartido
     * del mesón. La bitácora guarda a propósito el LARGO del término y no el
     * término; dejarlo en la barra de direcciones anulaba esa minimización.
     */
    public function buscar(Request $peticion, RegistroDeEvidencia $evidencia, TitularesBuscados $buscados): RedirectResponse
    {
        $termino = trim($peticion->string('q')->toString());
        $minimo = (int) config('arcop-panel.buscador.minimo_caracteres');
        $resultados = [];

        if ($this->alcanzaElMinimo($termino, $minimo)) {
            $resultados = array_slice(
                app(BuscaTitulares::class)->buscar($termino),
                0,
                (int) config('arcop-panel.buscador.maximo_resultados'),
                true,
            );

            // Quién buscó a quién queda anotado. Este buscador es la superficie
            // por donde se puede barrer el padrón de un municipio, y la Ley
            // 21.719 pide poder demostrar quién accedió a datos personales: sin
            // esta línea, el barrido no deja rastro.
            $evidencia->registrar('arcop.titulares.buscados', [
                'termino_largo' => mb_strlen($termino),
                'resultados' => count($resultados),
            ]);
        }

        $buscados->recordar($termino, $resultados);

        return redirect()->route('arcop.solicitudes.buscar');
    }

    /**
     * El paso 2. Solo se abre con una referencia que emitió una búsqueda de ESTA
     * sesión; cualquier otra cosa es un 404, igual que una clave inventada.
     */
    public function formulario(string $referencia, RegistroDeEvidencia $evidencia, TitularesBuscados $buscados): View
    {
        $encontrado = $this->titularReferido($referencia, $buscados);

        abort_if($encontrado === null, 404);

        // Abrir la ficha de una persona es un acceso a sus datos, y queda
        // anotado como tal. El titular va en el morph —que la anonimización
        // sabe soltar— y no en `datos`, que es inmutable: una clave copiada ahí
        // sobreviviría a la anonimización.
        $evidencia->registrar('arcop.titular.consultado', [], $encontrado);

        return view('arcop-panel::solicitudes.recibir', [
            'titular' => $encontrado,
            'referencia' => $referencia,
            'etiquetaTitular' => EtiquetaDeTitular::de($encontrado),
            'tipos' => TipoDeSolicitud::cases(),
            'solicitantes' => Solicitante::cases(),
        ]);
    }

    public function store(Request $peticion, TitularesBuscados $buscados): RedirectResponse
    {
        $datos = $peticion->validate([
            'titular' => ['required', 'string', 'regex:/^[0-9a-f]{32}$/'],
            // Con `Rule::enum` un valor manipulado es un error de validación;
            // con `string` a secas era un ValueError de `::from()`, o sea un 500.
            'tipo' => ['required', Rule::enum(TipoDeSolicitud::class)],
            'solicitante' => ['required', Rule::enum(Solicitante::class)],
            'detalle' => ['required', 'string', 'min:5'],
            'credencial' => ['nullable', 'string', 'max:255'],
            // Un archivo, nunca una ruta: la ruta la decide el panel (ver
            // guardarAcreditacion()). Si hace falta o no lo dice el módulo.
            'acreditacion' => ['nullable', 'file', 'mimes:pdf,jpg,jpeg,png', 'max:5120'],
        ], [
            'titular.required' => 'Volvé a buscar a la persona: la solicitud solo se recibe para alguien elegido de una búsqueda.',
            'titular.regex' => 'Volvé a buscar a la persona: la solicitud solo se recibe para alguien elegido de una búsqueda.',
        ], [
            'detalle' => 'detalle que dicta el ciudadano',
            'credencial' => (string) config('arcop-panel.credencial.etiqueta'),
            'acreditacion' => 'documento que acredita la representación',
        ]);

        $titular = $this->titularReferido($datos['titular'], $buscados);

        if ($titular === null) {
            throw ValidationException::withMessages([
                'titular' => 'La búsqueda con la que llegaste a este formulario ya no está vigente, o ese registro ya no '
                    .'existe en este sistema. Volvé a buscar a la persona antes de recibir la solicitud: una solicitud '
                    .'sin titular no se puede tramitar ni responder.',
            ])->redirectTo(route('arcop.solicitudes.buscar'));
        }

        $solicitante = Solicitante::from($datos['solicitante']);

        // Qué cuenta como identidad acreditada lo decide el sistema adoptante
        // —la cédula en el mesón en uno, otra cosa en otro—: el panel solo le
        // entrega el contexto del mostrador.
        $verificacion = app(VerificadorIdentidad::class)->verificar([
            'titular' => $titular,
            'credencial' => (string) ($datos['credencial'] ?? ''),
            'funcionario_id' => Auth::id(),
        ]);

        $acreditacion = $this->guardarAcreditacion($peticion);

        try {
            $solicitud = app(Solicitudes::class)->registrar(
                $titular,
                TipoDeSolicitud::from($datos['tipo']),
                $datos['detalle'],
                $verificacion,
                $solicitante,
                $acreditacion,
            );
        } catch (SolicitudRechazada $e) {
            // Sin solicitud no hay a qué pertenezca el documento: se borra, o
            // queda un dato personal de un tercero huérfano en el disco.
            $this->descartarAcreditacion($acreditacion);

            // El mensaje del módulo va TAL CUAL: cada negativa dice una cosa
            // distinta que hacer —que la cédula no calza, que falta acreditar la
            // fecha de nacimiento, que tiene que venir el representante legal,
            // que falta el poder— y cambiarlo por un «no se pudo» dejaría al
            // funcionario sin lo único que le sirve.
            throw ValidationException::withMessages(['modulo' => $e->getMessage()]);
        }

        // Recibida la solicitud, la sesión no tiene por qué seguir sabiendo a
        // quién se buscó.
        $buscados->olvidar();

        return redirect()
            ->route('arcop.solicitudes.show', $solicitud)
            ->with('arcop.aviso', 'Solicitud recibida: el plazo legal de respuesta empezó a correr.');
    }

    private function alcanzaElMinimo(string $termino, int $minimo): bool
    {
        return $termino !== '' && mb_strlen($termino) >= $minimo;
    }

    /** El titular detrás de una referencia de esta sesión, o `null` si no hay tal referencia ni tal titular. */
    private function titularReferido(string $referencia, TitularesBuscados $buscados): (Model&TitularDeDatos)|null
    {
        $clave = $buscados->claveDe($referencia);

        return $clave === null ? null : app(BuscaTitulares::class)->encontrar($clave);
    }

    /**
     * Guarda el documento que acredita la representación en el disco de
     * evidencia y devuelve su ruta, o `null` si no vino ninguno.
     *
     * La ruta la decide el panel, nunca el cliente. Antes `acreditacion_path`
     * era un <input type="text"> con una ruta del disco de evidencia validada
     * como string: como el núcleo BORRA ese documento al suprimir al titular,
     * cualquiera con permiso de recibir podía hacer que el módulo borrara el
     * documento de OTRO vecino, firmando el borrado como evidencia legal.
     *
     * Con nombre generado y no el original: el nombre que le puso el mesón al
     * archivo puede traer el RUT.
     */
    private function guardarAcreditacion(Request $peticion): ?string
    {
        $archivo = $peticion->file('acreditacion');

        if (! $archivo instanceof UploadedFile) {
            return null;
        }

        $ruta = $archivo->store(self::CARPETA_ACREDITACIONES, $this->discoDeEvidencia());

        if ($ruta === false) {
            throw new RuntimeException('No se pudo guardar el documento que acredita la representación en el disco de evidencia.');
        }

        return $ruta;
    }

    private function descartarAcreditacion(?string $ruta): void
    {
        if ($ruta !== null) {
            Storage::disk($this->discoDeEvidencia())->delete($ruta);
        }
    }

    /**
     * El disco donde el adoptante le dijo al módulo que viven los documentos.
     *
     * Es el mismo del que el núcleo los borra al anonimizar: guardar en otro
     * dejaría un documento con datos de un tercero que nadie puede encontrar
     * para suprimir. Sin declarar, se corta acá con una frase accionable —igual
     * que con los contratos que faltan— y no en el barrido de retención meses
     * después.
     */
    private function discoDeEvidencia(): string
    {
        $disco = trim((string) config('privacidad.disco_evidencia'));

        if ($disco === '') {
            throw AdoptanteIncompleto::faltaElDiscoDeEvidencia();
        }

        return $disco;
    }
}
