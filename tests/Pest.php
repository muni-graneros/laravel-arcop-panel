<?php

use Illuminate\Testing\TestResponse;
use Muni\Arcop\Tests\Fixtures\VecinoDePrueba;
use Muni\Arcop\Tests\TestCase;
use Muni\Shared\Privacidad\TipoDeSolicitud;

uses(TestCase::class)->in(__DIR__);

/**
 * Recibe una solicitud como lo hace el funcionario: busca a la persona y manda
 * el paso 3 con la referencia opaca que salió de ESA búsqueda. Usa el vecino
 * del test (`test()->vecino`).
 *
 * @param  array<string, mixed>  $extra
 */
function recibirSolicitud(array $extra = []): TestResponse
{
    return test()->post('/privacidad/solicitudes', array_merge([
        'titular' => referenciaDe(test()->vecino),
        'tipo' => TipoDeSolicitud::Acceso->value,
        'solicitante' => 'titular',
        'detalle' => 'Pide copia de todo lo que el municipio tiene sobre ella.',
        'credencial' => '11.111.111-1',
    ], $extra));
}

/**
 * Busca titulares como lo hace el funcionario: POST con el término y GET de la
 * página de resultados (Post/Redirect/Get). Devuelve esa página.
 */
function buscarTitulares(string $termino): TestResponse
{
    test()->post('/privacidad/solicitudes/recibir', ['q' => $termino])
        ->assertRedirect('/privacidad/solicitudes/recibir');

    return test()->get('/privacidad/solicitudes/recibir');
}

/**
 * La referencia opaca con la que ESTA sesión puede abrir el paso 2 para ese
 * vecino: sale del enlace «Elegir» de la lista de resultados, nunca de la clave
 * del titular.
 */
function referenciaDe(VecinoDePrueba $vecino): string
{
    $html = (string) buscarTitulares($vecino->documento)->getContent();

    preg_match('#/privacidad/solicitudes/recibir/([0-9a-f]{32})#', $html, $coincidencia);

    expect($coincidencia)->not->toBeEmpty('la lista de resultados no ofrece ninguna referencia opaca');

    return $coincidencia[1];
}
