<?php

use Illuminate\Http\Request;
use Illuminate\Routing\Route;
use Muni\Arcop\Http\Controllers\AccionesController;
use Muni\Shared\Privacidad\Modelos\Solicitud;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/*
 * `Request::route()` devuelve `Route|null` (Laravel 13.39+). El formulario de
 * cada acción lee de la ruta cuál es: sin ruta o sin ese dato debe responder
 * 404, no un error opaco de propiedad sobre null.
 */
it('responde 404 si la petición no tiene ruta asociada', function () {
    app(AccionesController::class)->formulario(Request::create('/'), new Solicitud);
})->throws(NotFoundHttpException::class);

it('responde 404 si la ruta no declara la acción', function () {
    $peticion = Request::create('/');
    $peticion->setRouteResolver(fn (): Route => new Route('GET', '/', fn () => null));

    app(AccionesController::class)->formulario($peticion, new Solicitud);
})->throws(NotFoundHttpException::class);
