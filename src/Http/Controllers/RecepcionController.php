<?php

namespace Muni\Arcop\Http\Controllers;

use Illuminate\Contracts\View\View;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Muni\Shared\Privacidad\Ciclo\EtiquetaDeTitular;
use Muni\Shared\Privacidad\Contratos\BuscaTitulares;
use Muni\Shared\Privacidad\Contratos\RegistroDeEvidencia;
use Muni\Shared\Privacidad\Contratos\VerificadorIdentidad;
use Muni\Shared\Privacidad\Solicitante;
use Muni\Shared\Privacidad\Solicitudes;
use Muni\Shared\Privacidad\SolicitudRechazada;
use Muni\Shared\Privacidad\TipoDeSolicitud;

/**
 * La recepción en el mesón, en dos pasos: primero se busca a la persona, después
 * se llena la solicitud.
 *
 * Son dos pantallas y no una con buscador incrustado porque este panel no usa
 * JavaScript: sin él, un selector con búsqueda en vivo no existe. El costo es
 * una recarga; la ganancia es que funciona en cualquier navegador, con lector de
 * pantalla y sin depender de que un bundle haya cargado.
 */
class RecepcionController extends Controller
{
    public function buscar(Request $peticion, RegistroDeEvidencia $evidencia): View
    {
        $termino = trim($peticion->string('q')->toString());
        $minimo = (int) config('arcop-panel.buscador.minimo_caracteres');
        $resultados = [];
        $buscoDeVerdad = $termino !== '' && mb_strlen($termino) >= $minimo;

        if ($buscoDeVerdad) {
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

        return view('arcop-panel::solicitudes.buscar', [
            'termino' => $termino,
            'minimo' => $minimo,
            'buscoDeVerdad' => $buscoDeVerdad,
            'resultados' => $resultados,
        ]);
    }

    public function formulario(string $titular): View
    {
        $encontrado = app(BuscaTitulares::class)->encontrar($titular);

        abort_if($encontrado === null, 404);

        return view('arcop-panel::solicitudes.recibir', [
            'titular' => $encontrado,
            'etiquetaTitular' => EtiquetaDeTitular::de($encontrado),
            'tipos' => TipoDeSolicitud::cases(),
            'solicitantes' => Solicitante::cases(),
        ]);
    }

    public function store(Request $peticion): RedirectResponse
    {
        $datos = $peticion->validate([
            'titular_id' => ['required'],
            'tipo' => ['required', 'string'],
            'solicitante' => ['required', 'string'],
            'detalle' => ['required', 'string', 'min:5'],
            'credencial' => ['nullable', 'string', 'max:255'],
            'acreditacion_path' => ['nullable', 'string', 'max:255'],
        ], [], [
            'detalle' => 'detalle que dicta el ciudadano',
            'credencial' => (string) config('arcop-panel.credencial.etiqueta'),
        ]);

        $titular = app(BuscaTitulares::class)->encontrar($datos['titular_id']);

        if ($titular === null) {
            throw ValidationException::withMessages([
                'titular_id' => 'Ese registro ya no existe en este sistema. Volvé a buscar a la persona antes de '
                    .'recibir la solicitud: una solicitud sin titular no se puede tramitar ni responder.',
            ]);
        }

        $solicitante = Solicitante::from($datos['solicitante']);

        // Qué cuenta como identidad acreditada lo decide el sistema adoptante
        // —la cédula en el mesón en uno, otra cosa en otro—: el panel solo le
        // entrega el contexto del mostrador.
        $verificacion = app(VerificadorIdentidad::class)->verificar([
            'titular' => $titular,
            'credencial' => (string) ($datos['credencial'] ?? ''),
            'funcionario_id' => auth()->id(),
        ]);

        try {
            $solicitud = app(Solicitudes::class)->registrar(
                $titular,
                TipoDeSolicitud::from($datos['tipo']),
                $datos['detalle'],
                $verificacion,
                $solicitante,
                $this->rutaDeAcreditacion($datos),
            );
        } catch (SolicitudRechazada $e) {
            // El mensaje del módulo va TAL CUAL: cada negativa dice una cosa
            // distinta que hacer —que la cédula no calza, que falta acreditar la
            // fecha de nacimiento, que tiene que venir el representante legal,
            // que falta el poder— y cambiarlo por un «no se pudo» dejaría al
            // funcionario sin lo único que le sirve.
            throw ValidationException::withMessages(['modulo' => $e->getMessage()]);
        }

        return redirect()
            ->route('arcop.solicitudes.show', $solicitud)
            ->with('arcop.aviso', 'Solicitud recibida: el plazo legal de respuesta empezó a correr.');
    }

    /** @param array<string, mixed> $datos */
    private function rutaDeAcreditacion(array $datos): ?string
    {
        $ruta = trim((string) ($datos['acreditacion_path'] ?? ''));

        return $ruta === '' ? null : $ruta;
    }
}
