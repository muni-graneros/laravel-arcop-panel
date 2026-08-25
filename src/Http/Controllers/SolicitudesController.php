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
        $solicitudes = Solicitud::query()
            ->where('sistema', (string) config('privacidad.sistema'))
            // Sin esto, listar 50 filas consulta 50 veces al titular. Y con
            // `preventLazyLoading` encendido —como corresponde— sería un 500.
            ->with('titular')
            ->when($peticion->filled('estado'), fn ($q) => $q->where('estado', $peticion->string('estado')->toString()))
            ->when($peticion->filled('tipo'), fn ($q) => $q->where('tipo', $peticion->string('tipo')->toString()))
            ->when($peticion->string('plazo')->toString() === 'vencidas', fn ($q) => $q->vencidas())
            ->when($peticion->string('plazo')->toString() === 'por_vencer', fn ($q) => $q->porVencer())
            ->when($peticion->string('plazo')->toString() === 'pendientes', fn ($q) => $q->pendientes())
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
