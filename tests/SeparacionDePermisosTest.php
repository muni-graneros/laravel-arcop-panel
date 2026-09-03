<?php

use Illuminate\Support\Facades\Gate;
use Muni\Arcop\Permisos;
use Muni\Arcop\Tests\Fixtures\UsuarioDePrueba;
use Muni\Arcop\Tests\Fixtures\VecinoDePrueba;
use Muni\Shared\Privacidad\Modelos\Solicitud;

/*
 * Los tres permisos existen para que el municipio pueda SEPARAR la recepción
 * de la resolución. Acá se prueba esa separación ruta por ruta: tener los
 * otros dos permisos no abre la que exige el tercero. Cambiar RESOLVER por VER
 * en una línea de routes/arcop.php pone esto en rojo.
 */
beforeEach(function () {
    foreach (Permisos::todos() as $permiso) {
        Gate::define($permiso, fn (): bool => true);
    }

    $this->funcionario = UsuarioDePrueba::create(['name' => 'Ana Soto', 'email' => 'ana@ejemplo.cl']);

    $this->vecino = VecinoDePrueba::create([
        'nombre' => 'Rocío Paredes',
        'documento' => '11.111.111-1',
        'fecha_nacimiento' => now()->subYears(40)->toDateString(),
    ]);

    $this->actingAs($this->funcionario);

    // Con los tres permisos abiertos, para que exista algo que proteger.
    recibirSolicitud()->assertRedirect();
    $this->solicitud = Solicitud::sole();
});

/** Deja abiertos los dos permisos que NO son el exigido, y cerrado el exigido. */
function soloSinElPermiso(string $exigido): void
{
    foreach (Permisos::todos() as $permiso) {
        Gate::define($permiso, fn (): bool => $permiso !== $exigido);
    }
}

/** Deja abierto SOLO el permiso exigido. */
function soloConElPermiso(string $exigido): void
{
    foreach (Permisos::todos() as $permiso) {
        Gate::define($permiso, fn (): bool => $permiso === $exigido);
    }
}

dataset('rutas del panel', [
    'bandeja' => ['GET', '/privacidad/solicitudes', Permisos::VER],
    'paso 1: buscador' => ['GET', '/privacidad/solicitudes/recibir', Permisos::RECIBIR],
    'paso 1: buscar' => ['POST', '/privacidad/solicitudes/recibir', Permisos::RECIBIR],
    'paso 2: formulario' => ['GET', '/privacidad/solicitudes/recibir/'.str_repeat('a', 32), Permisos::RECIBIR],
    'paso 3: recibir' => ['POST', '/privacidad/solicitudes', Permisos::RECIBIR],
    'expediente en pantalla' => ['GET', '/privacidad/solicitudes/{id}', Permisos::VER],
    'descarga del expediente' => ['GET', '/privacidad/solicitudes/{id}/expediente', Permisos::RESOLVER],
    'tomar' => ['POST', '/privacidad/solicitudes/{id}/tomar', Permisos::RESOLVER],
    'resolver: página' => ['GET', '/privacidad/solicitudes/{id}/resolver', Permisos::RESOLVER],
    'resolver: aplicar' => ['POST', '/privacidad/solicitudes/{id}/resolver', Permisos::RESOLVER],
    'rectificar: página' => ['GET', '/privacidad/solicitudes/{id}/rectificar', Permisos::RESOLVER],
    'rectificar: aplicar' => ['POST', '/privacidad/solicitudes/{id}/rectificar', Permisos::RESOLVER],
    'suprimir: página' => ['GET', '/privacidad/solicitudes/{id}/suprimir', Permisos::RESOLVER],
    'suprimir: aplicar' => ['POST', '/privacidad/solicitudes/{id}/suprimir', Permisos::RESOLVER],
]);

it('con los otros dos permisos y sin el exigido, la ruta es 403', function (string $metodo, string $ruta, string $exigido) {
    soloSinElPermiso($exigido);

    $ruta = str_replace('{id}', (string) $this->solicitud->getKey(), $ruta);

    $this->call($metodo, $ruta)->assertForbidden();
})->with('rutas del panel');

it('con solo el permiso exigido, la ruta no es 403', function (string $metodo, string $ruta, string $exigido) {
    soloConElPermiso($exigido);

    $ruta = str_replace('{id}', (string) $this->solicitud->getKey(), $ruta);

    // Lo que pase después de la autorización —validación, 404 por tipo, 405—
    // no es lo que se prueba acá: lo que importa es que el permiso correcto es
    // el que abre la puerta.
    expect($this->call($metodo, $ruta)->getStatusCode())->not->toBe(403);
})->with('rutas del panel');
