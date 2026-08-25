<?php

use Muni\Arcop\Permisos;

return [

    /*
     * Bajo qué ruta cuelga el panel. El adoptante lo cambia si ya tiene algo en
     * `privacidad`.
     */
    'prefijo' => env('ARCOP_PREFIJO', 'privacidad'),

    /*
     * La pila del adoptante. El paquete NO trae autenticación propia: se cuelga
     * de la del sistema, que es la que ya sabe quién es cada funcionario.
     *
     * Va `web` por defecto porque sin sesión no hay `auth()->id()`, y sin eso no
     * se puede saber quién recibió ni quién resolvió, que es lo que la Ley pide
     * poder demostrar.
     */
    'middleware' => ['web', 'auth'],

    /*
     * El cascarón donde se dibujan las pantallas. Poné acá el layout del sistema
     * para que el panel quede adentro de su navegación, en vez del que trae el
     * paquete.
     *
     * El layout tiene que rendir `@yield('arcop')` o un `$slot`; ver
     * `resources/views/layouts/app.blade.php`.
     */
    'layout' => 'arcop-panel::layouts.app',

    'titulo' => 'Solicitudes de datos personales',

    'buscador' => [
        /*
         * Este buscador es la superficie por donde se puede ENUMERAR el padrón
         * de un municipio: quien tenga el permiso de recepción podría barrer
         * apellidos hasta armarse una lista. Los tres topes están para eso.
         */
        'minimo_caracteres' => 3,
        'maximo_resultados' => 20,
        // Formato de Laravel: intentos,minutos.
        'throttle' => '20,1',
    ],

    /*
     * Qué deja de hacer ESTE sistema con los datos de una persona cuando queda
     * un bloqueo vigente.
     *
     * Sin declarar, el panel dice en pantalla que no se declaró. Es a propósito:
     * tener la pantalla es la superficie del cumplimiento, no el cumplimiento.
     * Un sistema que muestre este panel sin escribir su candado le certificaría
     * por escrito a un vecino un cese que no ocurre.
     */
    'alcance_del_cese' => env('ARCOP_ALCANCE_DEL_CESE'),

    /*
     * Cómo se llama, en el mesón de ESTE sistema, lo que la persona presenta
     * para acreditar su identidad.
     */
    'credencial' => [
        'etiqueta' => 'Credencial que presenta',
        'ayuda' => null,
    ],

    /*
     * Un enlace del propio sistema en la pantalla de recepción.
     *
     * Existe porque el módulo puede negarse a tramitar por algo que solo el
     * sistema adoptante sabe resolver —el caso real: falta la fecha de
     * nacimiento del titular, y sin ella no se puede saber si es menor de
     * edad—. Sin este enlace el funcionario lee la negativa y no tiene adónde
     * ir, que es la peor forma de tener razón.
     *
     * La ruta recibe la clave del titular como único parámetro.
     */
    'ayuda_del_adoptante' => [
        'texto' => null,
        'ruta' => null,
    ],

    'permisos' => [
        'ver' => Permisos::VER,
        'recibir' => Permisos::RECIBIR,
        'resolver' => Permisos::RESOLVER,
    ],
];
