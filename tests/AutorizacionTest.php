<?php

use Illuminate\Support\Facades\Gate;
use Muni\Arcop\Permisos;
use Muni\Arcop\Tests\Fixtures\UsuarioDePrueba;

beforeEach(function () {
    $this->funcionario = UsuarioDePrueba::create([
        'name' => 'Ana Soto', 'email' => 'ana@ejemplo.cl',
    ]);
});

it('sin mapear los permisos, un funcionario identificado no abre nada', function (string $ruta) {
    $this->actingAs($this->funcionario)->get($ruta)->assertForbidden();
})->with([
    '/privacidad/solicitudes',
    '/privacidad/solicitudes/recibir',
]);

it('sin sesión no se llega ni a la bandeja: manda al ingreso del sistema', function () {
    $this->get('/privacidad/solicitudes')->assertRedirect(route('login'));
});

it('los tres permisos existen desde que se instala el paquete', function () {
    expect(Gate::has(Permisos::VER))->toBeTrue()
        ->and(Gate::has(Permisos::RECIBIR))->toBeTrue()
        ->and(Gate::has(Permisos::RESOLVER))->toBeTrue();
});

it('el paquete no le pisa al adoptante un permiso que él ya mapeó', function () {
    // Lo que mapea el sistema adoptante en su AuthServiceProvider.
    Gate::define(Permisos::VER, fn (): bool => true);

    expect(Gate::forUser($this->funcionario)->allows(Permisos::VER))->toBeTrue();
});
