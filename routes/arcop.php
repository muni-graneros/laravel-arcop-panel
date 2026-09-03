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
 *
 * El parámetro se llama `solicitudArcop` y no `solicitud` a propósito: el
 * binding explícito que lo resuelve (ver el proveedor) es global a toda la
 * aplicación adoptante, y un sistema que ya tenga sus propias rutas
 * `{solicitud}` —licencias de conducir tiene once— las vería resolver contra
 * la tabla del módulo de privacidad. Los nombres de ruta y las URL no cambian.
 */
Route::name('arcop.')->group(function (): void {
    $topeDelBuscador = 'throttle:'.config('arcop-panel.buscador.throttle');

    Route::get('solicitudes', [SolicitudesController::class, 'index'])
        ->middleware('can:'.Permisos::VER)
        ->name('solicitudes.index');

    // Antes de `solicitudes/{solicitudArcop}`: si no, «recibir» se lee como un id.
    Route::get('solicitudes/recibir', [RecepcionController::class, 'buscador'])
        ->middleware('can:'.Permisos::RECIBIR)
        ->name('solicitudes.buscar');

    // La búsqueda es POST y redirige (Post/Redirect/Get): lo tipeado —un nombre,
    // un RUT— no queda en la URL ni, por lo tanto, en el access log.
    Route::post('solicitudes/recibir', [RecepcionController::class, 'buscar'])
        ->middleware(['can:'.Permisos::RECIBIR, $topeDelBuscador])
        ->name('solicitudes.buscar.ejecutar');

    // `{referencia}` es una clave opaca que emitió una búsqueda de ESTA sesión,
    // nunca la clave del titular. Con tope propio (el sufijo separa la cubeta
    // de la del buscador) para que tampoco se pueda barrer a fuerza bruta.
    Route::get('solicitudes/recibir/{referencia}', [RecepcionController::class, 'formulario'])
        ->middleware(['can:'.Permisos::RECIBIR, $topeDelBuscador.',arcop-titular'])
        ->where('referencia', '[0-9a-f]{32}')
        ->name('solicitudes.formulario');

    Route::post('solicitudes', [RecepcionController::class, 'store'])
        ->middleware('can:'.Permisos::RECIBIR)
        ->name('solicitudes.store');

    Route::get('solicitudes/{solicitudArcop}', [SolicitudesController::class, 'show'])
        ->middleware('can:'.Permisos::VER)
        ->name('solicitudes.show');

    Route::get('solicitudes/{solicitudArcop}/expediente', [ExpedienteController::class, 'descargar'])
        // Resolver y no ver: llevarse la copia completa de los datos de una
        // persona es la acción más sensible del panel, y quien solo mira la
        // bandeja no tiene por qué poder hacerlo.
        ->middleware('can:'.Permisos::RESOLVER)
        ->name('solicitudes.expediente');

    Route::post('solicitudes/{solicitudArcop}/tomar', [AccionesController::class, 'tomar'])
        ->middleware('can:'.Permisos::RESOLVER)
        ->name('solicitudes.tomar');

    foreach (['resolver', 'rectificar', 'suprimir'] as $accion) {
        Route::get("solicitudes/{solicitudArcop}/{$accion}", [AccionesController::class, 'formulario'])
            ->middleware('can:'.Permisos::RESOLVER)
            ->defaults('accion', $accion)
            ->name("solicitudes.{$accion}");

        Route::post("solicitudes/{solicitudArcop}/{$accion}", [AccionesController::class, $accion])
            ->middleware('can:'.Permisos::RESOLVER)
            ->name("solicitudes.{$accion}.aplicar");
    }
});
