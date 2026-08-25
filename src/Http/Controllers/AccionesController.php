<?php

namespace Muni\Arcop\Http\Controllers;

use Illuminate\Contracts\View\View;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Muni\Shared\Privacidad\Ciclo\AlcanceDelCese;
use Muni\Shared\Privacidad\Ciclo\PreviaDeSupresion;
use Muni\Shared\Privacidad\Ciclo\ResultadosDisponibles;
use Muni\Shared\Privacidad\Ciclo\ResumenDeSupresion;
use Muni\Shared\Privacidad\Ciclo\SeparacionDeFunciones;
use Muni\Shared\Privacidad\Contratos\TitularDeDatos;
use Muni\Shared\Privacidad\EstadoDeSolicitud;
use Muni\Shared\Privacidad\Modelos\Solicitud;
use Muni\Shared\Privacidad\Rectificaciones;
use Muni\Shared\Privacidad\Solicitudes;
use Muni\Shared\Privacidad\SolicitudRechazada;
use Muni\Shared\Privacidad\Supresiones;
use Muni\Shared\Privacidad\TipoDeSolicitud;

/**
 * Las acciones que mueven una solicitud.
 *
 * Cada una es una página propia y no un modal: un `<dialog>` necesita
 * JavaScript para abrirse, y este panel no usa. La página server-rendered
 * además atrapa el foco sola y no pelea con la política de contenido.
 *
 * NADA de acá escribe la fila directamente. Todo pasa por los servicios del
 * módulo, que son los que aplican la verificación, el plazo, la lista blanca de
 * campos rectificables, la propagación al maestro, el bloqueo y la bitácora.
 */
class AccionesController extends Controller
{
    /** La página de la acción: solo muestra lo que hay que leer antes de decidir. */
    public function formulario(Request $peticion, Solicitud $solicitud): View
    {
        $accion = (string) $peticion->route()->defaults['accion'];

        $this->exigirPendiente($solicitud);
        $this->exigirTipoCorrecto($accion, $solicitud);

        $solicitud->loadMissing('titular');
        $titular = $solicitud->titular;

        return view("arcop-panel::solicitudes.{$accion}", [
            'solicitud' => $solicitud,
            'advertencia' => SeparacionDeFunciones::advertencia($solicitud, auth()->id()),
            'resultados' => ResultadosDisponibles::para($solicitud->tipo),
            'nota' => ResultadosDisponibles::nota($solicitud->tipo),
            'previa' => $accion === 'suprimir' ? PreviaDeSupresion::de($solicitud) : null,
            'campos' => $titular instanceof TitularDeDatos ? $titular->camposRectificables() : [],
            'titular' => $titular,
        ]);
    }

    public function tomar(Solicitud $solicitud): RedirectResponse
    {
        return $this->conElModulo($solicitud, function () use ($solicitud): string {
            app(Solicitudes::class)->tomar($solicitud);

            return 'Tomaste el caso: queda en trámite a tu nombre.';
        });
    }

    public function resolver(Request $peticion, Solicitud $solicitud): RedirectResponse
    {
        $disponibles = array_keys(ResultadosDisponibles::para($solicitud->tipo));

        $datos = $peticion->validate([
            'resultado' => ['required', 'string', 'in:'.implode(',', $disponibles)],
            'fundamento' => ['required', 'string', 'min:5'],
        ], [
            'resultado.in' => 'Ese resultado no se puede elegir a mano para este tipo de solicitud.',
        ], ['fundamento' => 'fundamento de la resolución']);

        return $this->conElModulo($solicitud, function () use ($solicitud, $datos): string {
            $resultado = EstadoDeSolicitud::from($datos['resultado']);
            $servicio = app(Solicitudes::class);

            match ($resultado) {
                EstadoDeSolicitud::Acogida => $servicio->acoger($solicitud, $datos['fundamento']),
                EstadoDeSolicitud::AcogidaParcial => $servicio->acogerParcialmente($solicitud, $datos['fundamento']),
                default => $servicio->rechazar($solicitud, $datos['fundamento']),
            };

            return 'Solicitud '.mb_strtolower($resultado->etiqueta()).'. '
                .$this->alcance()->efectoSobreElBloqueo($solicitud->tipo, $resultado);
        });
    }

    public function rectificar(Request $peticion, Solicitud $solicitud): RedirectResponse
    {
        $this->exigirTipoCorrecto('rectificar', $solicitud);

        $datos = $peticion->validate([
            'valores' => ['array'],
            'fundamento' => ['required', 'string', 'min:5'],
        ], [], ['fundamento' => 'fundamento de la resolución']);

        $cambios = $this->cambiosPedidos($solicitud, (array) ($datos['valores'] ?? []));

        if ($cambios === []) {
            throw ValidationException::withMessages([
                'valores' => 'No cambiaste ningún dato. Acoger una rectificación sin corregir nada certificaría una '
                    .'corrección que no se hizo.',
            ]);
        }

        return $this->conElModulo($solicitud, function () use ($solicitud, $cambios, $datos): string {
            app(Rectificaciones::class)->aplicar($solicitud, $cambios, $datos['fundamento']);

            return 'Rectificación aplicada y solicitud acogida.';
        });
    }

    public function suprimir(Request $peticion, Solicitud $solicitud): RedirectResponse
    {
        $this->exigirTipoCorrecto('suprimir', $solicitud);

        $datos = $peticion->validate([
            'fundamento' => ['required', 'string', 'min:5'],
        ], [], ['fundamento' => 'fundamento de la resolución']);

        return $this->conElModulo($solicitud, function () use ($solicitud, $datos): string {
            $resumen = ResumenDeSupresion::de(app(Supresiones::class)->aplicar($solicitud, $datos['fundamento']));

            return $resumen->titulo().'. '.$resumen->cuerpo();
        });
    }

    /**
     * Ejecuta la acción y traduce una negativa del módulo en un error de
     * formulario con SU mensaje.
     *
     * El texto del módulo es lo que se le responde al titular; reemplazarlo por
     * un «no se pudo» genérico dejaría al funcionario sin lo único que le sirve.
     *
     * @param  callable(): string  $accion
     */
    private function conElModulo(Solicitud $solicitud, callable $accion): RedirectResponse
    {
        try {
            $aviso = $accion();
        } catch (SolicitudRechazada $e) {
            throw ValidationException::withMessages(['modulo' => $e->getMessage()]);
        }

        return redirect()
            ->route('arcop.solicitudes.show', $solicitud)
            ->with('arcop.aviso', $aviso);
    }

    private function alcance(): AlcanceDelCese
    {
        return new AlcanceDelCese(config('arcop-panel.alcance_del_cese'));
    }

    /**
     * Los cambios que el funcionario efectivamente pidió.
     *
     * Se recorre lo que trae el formulario y NO `camposRectificables()`: filtrar
     * acá contra la lista blanca la duplicaría en el panel y dejaría sin
     * ejercitar la del módulo, que es la que manda.
     *
     * @param  array<string, mixed>  $valores
     * @return array<string, mixed>
     */
    private function cambiosPedidos(Solicitud $solicitud, array $valores): array
    {
        $titular = $solicitud->titular;

        if (! $titular instanceof TitularDeDatos) {
            return [];
        }

        $cambios = [];

        foreach ($valores as $campo => $nuevo) {
            $nuevo = is_string($nuevo) ? trim($nuevo) : $nuevo;
            $actual = $titular instanceof Model
                ? $titular->getAttribute((string) $campo)
                : null;

            if ((string) $nuevo === (string) $actual) {
                continue;
            }

            $cambios[(string) $campo] = $nuevo === '' ? null : $nuevo;
        }

        return $cambios;
    }

    private function exigirPendiente(Solicitud $solicitud): void
    {
        abort_if($solicitud->estado->estaResuelta(), 404);
    }

    private function exigirTipoCorrecto(string $accion, Solicitud $solicitud): void
    {
        $exigido = match ($accion) {
            'rectificar' => TipoDeSolicitud::Rectificacion,
            'suprimir' => TipoDeSolicitud::Supresion,
            default => null,
        };

        abort_if($exigido !== null && $solicitud->tipo !== $exigido, 404);
    }
}
