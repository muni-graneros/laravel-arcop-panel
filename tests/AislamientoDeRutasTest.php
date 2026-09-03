<?php

use Illuminate\Support\Facades\Gate;
use Muni\Arcop\Permisos;
use Muni\Arcop\Tests\Fixtures\SolicitudAjena;
use Muni\Arcop\Tests\Fixtures\UsuarioDePrueba;
use Muni\Arcop\Tests\Fixtures\VecinoDePrueba;
use Muni\Shared\Privacidad\Modelos\Solicitud;
use Muni\Shared\Privacidad\ResultadoVerificacion;
use Muni\Shared\Privacidad\Solicitudes;
use Muni\Shared\Privacidad\TipoDeSolicitud;

/*
 * `Route::bind()` es global: se aplica a TODAS las rutas de la aplicación que
 * usen ese nombre de parámetro y gana sobre el binding implícito. Un paquete
 * que registre `solicitud` le cambia el modelo a cualquier `{solicitud}` del
 * sistema que lo instala.
 */
beforeEach(function () {
    foreach (Permisos::todos() as $permiso) {
        Gate::define($permiso, fn (): bool => true);
    }

    $this->actingAs(UsuarioDePrueba::create(['name' => 'Ana Soto', 'email' => 'ana@ejemplo.cl']));
});

it('una ruta {solicitud} del sistema adoptante sigue resolviendo SU modelo con el paquete instalado', function () {
    $ajena = SolicitudAjena::create(['nombre' => 'Licencia clase B de Juan']);

    $this->get('/ajeno/'.$ajena->getKey())
        ->assertOk()
        ->assertSee('ajena: Licencia clase B de Juan');
});

it('aunque exista una solicitud ARCOP con el mismo id, la ruta ajena no la ve', function () {
    $vecino = VecinoDePrueba::create([
        'nombre' => 'Rocío Paredes', 'documento' => '11.111.111-1',
        'fecha_nacimiento' => now()->subYears(40)->toDateString(),
    ]);

    $arcop = app(Solicitudes::class)->registrar(
        $vecino,
        TipoDeSolicitud::Acceso,
        'Pide copia de sus datos.',
        new ResultadoVerificacion(true, 'cedula_presencial', []),
    );

    $ajena = SolicitudAjena::create(['nombre' => 'Licencia clase B de Juan']);

    expect($ajena->getKey())->toBe($arcop->getKey());

    $this->get('/ajeno/'.$ajena->getKey())
        ->assertOk()
        ->assertSee('ajena: Licencia clase B de Juan');
});

it('las rutas ARCOP con parámetro siguen filtrando por sistema en todas sus formas', function () {
    $vecino = VecinoDePrueba::create([
        'nombre' => 'Rocío Paredes', 'documento' => '11.111.111-1',
        'fecha_nacimiento' => now()->subYears(40)->toDateString(),
    ]);

    $ajena = app(Solicitudes::class)->registrar(
        $vecino,
        TipoDeSolicitud::Supresion,
        'Pide que borren sus datos.',
        new ResultadoVerificacion(true, 'cedula_presencial', []),
    );
    $ajena->forceFill(['sistema' => 'otro-organismo'])->save();

    expect(Solicitud::count())->toBe(1);

    $id = $ajena->getKey();

    $this->get("/privacidad/solicitudes/{$id}")->assertNotFound();
    $this->get("/privacidad/solicitudes/{$id}/expediente")->assertNotFound();
    $this->get("/privacidad/solicitudes/{$id}/resolver")->assertNotFound();
    $this->get("/privacidad/solicitudes/{$id}/suprimir")->assertNotFound();
    $this->post("/privacidad/solicitudes/{$id}/tomar")->assertNotFound();
    $this->post("/privacidad/solicitudes/{$id}/resolver", ['resultado' => 'rechazada', 'fundamento' => 'x'])->assertNotFound();
    $this->post("/privacidad/solicitudes/{$id}/suprimir", ['fundamento' => 'Se suprime.'])->assertNotFound();
});
