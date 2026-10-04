<?php

namespace Muni\Arcop\Http\Controllers;

use Illuminate\Contracts\View\View;
use Illuminate\Http\Request;
use Muni\Arcop\Bitacora\LineaDeTiempo;
use Muni\Shared\Privacidad\Ciclo\PlazoLegal;
use Muni\Shared\Privacidad\EstadoDeSolicitud;
use Muni\Shared\Privacidad\Modelos\Solicitud;
use Muni\Shared\Privacidad\TipoDeSolicitud;

class SolicitudesController extends Controller
{
    /**
     * La bandeja.
     *
     * Ordena por vencimiento y no por fecha de recepción: lo que hay que mirar
     * primero es lo que se vence antes, no lo que llegó antes.
     */
    public function index(Request $peticion): View
    {
        $consulta = Solicitud::query()
            ->where('sistema', (string) config('privacidad.sistema'))
            // Sin esto, listar 50 filas consulta 50 veces al titular. Y con
            // `preventLazyLoading` encendido —como corresponde— sería un 500.
            ->with('titular');

        if ($peticion->filled('estado')) {
            $consulta->where('estado', $peticion->string('estado')->toString());
        }

        if ($peticion->filled('tipo')) {
            $consulta->where('tipo', $peticion->string('tipo')->toString());
        }

        // Los scopes del modelo se llaman por su nombre real
        // (`getModel()->scopeVencidas($consulta)`) y no por el `when()` con el
        // `__call` mágico de Eloquent (`$q->vencidas()`): ese último es un
        // método que solo existe por convención de nombre, y PHPStan no lo
        // puede tipar sin anotaciones del modelo que este paquete no controla
        // (vive en el paquete compartido).
        $plazo = $peticion->string('plazo')->toString();

        if ($plazo === 'vencidas') {
            $consulta->getModel()->scopeVencidas($consulta);
        } elseif ($plazo === 'por_vencer') {
            $consulta->getModel()->scopePorVencer($consulta);
        } elseif ($plazo === 'pendientes') {
            $consulta->getModel()->scopePendientes($consulta);
        }

        $solicitudes = $consulta
            ->orderBy('vence_en')
            ->paginate(25)
            ->withQueryString();

        return view('arcop-panel::solicitudes.index', [
            'solicitudes' => $solicitudes,
            'estados' => EstadoDeSolicitud::cases(),
            'tipos' => TipoDeSolicitud::cases(),
            'filtros' => [
                'estado' => $peticion->string('estado')->toString(),
                'tipo' => $peticion->string('tipo')->toString(),
                'plazo' => $peticion->string('plazo')->toString(),
            ],
        ]);
    }

    /**
     * El expediente en pantalla.
     *
     * `loadMissing()` y no acceso suelto: `exportarDatosPersonales()` y la
     * bitácora tocan varias relaciones, y con `preventLazyLoading` cada una sin
     * precargar es un 500 justo en la pantalla donde se atiende al vecino.
     */
    public function show(Solicitud $solicitud): View
    {
        $solicitud->loadMissing('titular');

        return view('arcop-panel::solicitudes.show', [
            'solicitud' => $solicitud,
            'plazo' => PlazoLegal::de($solicitud),
            'bitacora' => app(LineaDeTiempo::class)->de($solicitud),
        ]);
    }
}
