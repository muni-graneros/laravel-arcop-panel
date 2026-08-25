<?php

use Illuminate\Support\Facades\Route;
use Muni\Arcop\Http\Controllers\AccionesController;
use Muni\Arcop\Http\Controllers\ExpedienteController;
use Muni\Arcop\Http\Controllers\RecepcionController;
use Muni\Arcop\Http\Controllers\SolicitudesController;
use Muni\Arcop\Permisos;

/*
 * Ningún estado avanza por GET.
 *
 * Las páginas de acción (`resolver`, `rectificar`, `suprimir`) solo muestran el
 * formulario y lo que hay que leer antes de decidir; lo que escribe es el POST
 * del mismo camino. Un GET que resolviera una solicitud se dispararía con un
 * prefetch del navegador, con un rastreador de enlaces o con una imagen incluida
 * en un correo.
 */
Route::name('arcop.')->group(function (): void {
    Route::get('solicitudes', [SolicitudesController::class, 'index'])
        ->middleware('can:'.Permisos::VER)
        ->name('solicitudes.index');

    // Antes de `solicitudes/{solicitud}`: si no, «recibir» se lee como un id.
    Route::get('solicitudes/recibir', [RecepcionController::class, 'buscar'])
        ->middleware(['can:'.Permisos::RECIBIR, 'throttle:'.config('arcop-panel.buscador.throttle')])
        ->name('solicitudes.buscar');

    Route::get('solicitudes/recibir/{titular}', [RecepcionController::class, 'formulario'])
        ->middleware('can:'.Permisos::RECIBIR)
        ->name('solicitudes.formulario');

    Route::post('solicitudes', [RecepcionController::class, 'store'])
        ->middleware('can:'.Permisos::RECIBIR)
        ->name('solicitudes.store');

    Route::get('solicitudes/{solicitud}', [SolicitudesController::class, 'show'])
        ->middleware('can:'.Permisos::VER)
        ->name('solicitudes.show');

    Route::get('solicitudes/{solicitud}/expediente', [ExpedienteController::class, 'descargar'])
        // Resolver y no ver: llevarse la copia completa de los datos de una
        // persona es la acción más sensible del panel, y quien solo mira la
        // bandeja no tiene por qué poder hacerlo.
        ->middleware('can:'.Permisos::RESOLVER)
        ->name('solicitudes.expediente');

    Route::post('solicitudes/{solicitud}/tomar', [AccionesController::class, 'tomar'])
        ->middleware('can:'.Permisos::RESOLVER)
        ->name('solicitudes.tomar');

    foreach (['resolver', 'rectificar', 'suprimir'] as $accion) {
        Route::get("solicitudes/{solicitud}/{$accion}", [AccionesController::class, 'formulario'])
            ->middleware('can:'.Permisos::RESOLVER)
            ->defaults('accion', $accion)
            ->name("solicitudes.{$accion}");

        Route::post("solicitudes/{solicitud}/{$accion}", [AccionesController::class, $accion])
            ->middleware('can:'.Permisos::RESOLVER)
            ->name("solicitudes.{$accion}.aplicar");
    }
});
