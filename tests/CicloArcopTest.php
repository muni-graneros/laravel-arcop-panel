<?php

use Illuminate\Support\Facades\Gate;
use Illuminate\Testing\TestResponse;
use Muni\Arcop\Permisos;
use Muni\Arcop\Tests\Fixtures\UsuarioDePrueba;
use Muni\Arcop\Tests\Fixtures\VecinoDePrueba;
use Muni\Shared\Privacidad\BaseLicitud;
use Muni\Shared\Privacidad\EstadoDeSolicitud;
use Muni\Shared\Privacidad\Modelos\EntradaBitacora;
use Muni\Shared\Privacidad\Modelos\Finalidad;
use Muni\Shared\Privacidad\Modelos\Solicitud;
use Muni\Shared\Privacidad\TipoDeSolicitud;

beforeEach(function () {
    // Como en un sistema que ya mapeó los tres permisos.
    foreach (Permisos::todos() as $permiso) {
        Gate::define($permiso, fn (): bool => true);
    }

    $this->funcionario = UsuarioDePrueba::create(['name' => 'Ana Soto', 'email' => 'ana@ejemplo.cl']);
    $this->otro = UsuarioDePrueba::create(['name' => 'Luis Díaz', 'email' => 'luis@ejemplo.cl']);

    Finalidad::create([
        'sistema' => 'atencionvecino', 'codigo' => 'requerimientos', 'nombre' => 'Requerimientos vecinales',
        'base_licitud' => BaseLicitud::FuncionLegal, 'norma_habilitante' => 'Ley 18.695',
    ]);

    $this->vecino = VecinoDePrueba::create([
        'nombre' => 'Rocío Paredes',
        'documento' => '11.111.111-1',
        'correo' => 'rocio@ejemplo.cl',
        'fecha_nacimiento' => now()->subYears(40)->toDateString(),
    ]);
});

function recibirSolicitud(array $extra = []): TestResponse
{
    return test()->post('/privacidad/solicitudes', array_merge([
        'titular_id' => test()->vecino->getKey(),
        'tipo' => TipoDeSolicitud::Acceso->value,
        'solicitante' => 'titular',
        'detalle' => 'Pide copia de todo lo que el municipio tiene sobre ella.',
        'credencial' => '11.111.111-1',
    ], $extra));
}

it('recibe una solicitud y el plazo legal empieza a correr', function () {
    $this->actingAs($this->funcionario);

    recibirSolicitud()->assertRedirect();

    $solicitud = Solicitud::sole();

    expect($solicitud->sistema)->toBe('atencionvecino')
        ->and($solicitud->estado)->toBe(EstadoDeSolicitud::Recibida)
        ->and($solicitud->getAttribute('user_registro_id'))->toBe($this->funcionario->getKey())
        ->and($solicitud->vence_en->toDateString())->toBe(now()->addDays(30)->toDateString());
});

it('no recibe nada si la credencial no acredita al titular, y lo dice con el mensaje del módulo', function () {
    $this->actingAs($this->funcionario);

    recibirSolicitud(['credencial' => '22.222.222-2'])
        ->assertSessionHasErrors('modulo');

    expect(Solicitud::count())->toBe(0);
});

it('el buscador no consulta por debajo del mínimo de caracteres', function () {
    $this->actingAs($this->funcionario);

    $this->get('/privacidad/solicitudes/recibir?q=Ro')
        ->assertOk()
        ->assertSee('al menos 3 caracteres')
        ->assertDontSee('Rocío Paredes');
});

it('cada búsqueda de titulares queda en la bitácora', function () {
    $this->actingAs($this->funcionario);

    $this->get('/privacidad/solicitudes/recibir?q=Rocío')->assertOk()->assertSee('Rocío Paredes');

    expect(EntradaBitacora::where('evento', 'arcop.titulares.buscados')->count())->toBe(1);
});

it('el buscador tiene tope de intentos: es por donde se enumera el padrón', function () {
    $this->actingAs($this->funcionario);

    foreach (range(1, 20) as $intento) {
        $this->get('/privacidad/solicitudes/recibir?q=Roc'.$intento)->assertOk();
    }

    $this->get('/privacidad/solicitudes/recibir?q=Rocio')->assertStatus(429);
});

it('una solicitud de otro sistema no existe para este panel', function () {
    $this->actingAs($this->funcionario);
    recibirSolicitud();

    $ajena = Solicitud::sole();
    $ajena->forceFill(['sistema' => 'otro-organismo'])->save();

    $this->get('/privacidad/solicitudes/'.$ajena->getKey())->assertNotFound();
    $this->get('/privacidad/solicitudes')->assertOk()->assertDontSee('Rocío Paredes');
});

it('ningún estado avanza por GET', function () {
    $this->actingAs($this->funcionario);
    recibirSolicitud();
    $solicitud = Solicitud::sole();

    // «Tomar» no tiene GET: el router responde 405 antes de llegar a nada.
    $this->get("/privacidad/solicitudes/{$solicitud->getKey()}/tomar")->assertStatus(405);

    // Las páginas de acción existen, pero solo muestran el formulario.
    $this->get("/privacidad/solicitudes/{$solicitud->getKey()}/resolver")->assertOk();

    expect($solicitud->fresh()->estado)->toBe(EstadoDeSolicitud::Recibida);
});

it('resuelve con fundamento y deja el caso cerrado', function () {
    $this->actingAs($this->funcionario);
    recibirSolicitud();
    $solicitud = Solicitud::sole();

    $this->post("/privacidad/solicitudes/{$solicitud->getKey()}/tomar")->assertRedirect();
    $this->post("/privacidad/solicitudes/{$solicitud->getKey()}/resolver", [
        'resultado' => EstadoDeSolicitud::Acogida->value,
        'fundamento' => 'Se le entregó copia de su expediente en el mesón.',
    ])->assertRedirect();

    expect($solicitud->fresh()->estado)->toBe(EstadoDeSolicitud::Acogida);
});

it('avisa cuando quien resuelve es quien recibió', function () {
    $this->actingAs($this->funcionario);
    recibirSolicitud();
    $solicitud = Solicitud::sole();

    $this->get("/privacidad/solicitudes/{$solicitud->getKey()}/resolver")
        ->assertOk()
        ->assertSee('Esta solicitud la recibiste tú');

    $this->actingAs($this->otro)
        ->get("/privacidad/solicitudes/{$solicitud->getKey()}/resolver")
        ->assertOk()
        ->assertDontSee('Esta solicitud la recibiste tú');
});

it('una rectificación no se puede acoger a mano desde la resolución', function () {
    $this->actingAs($this->funcionario);
    recibirSolicitud(['tipo' => TipoDeSolicitud::Rectificacion->value, 'detalle' => 'Su correo está mal escrito.']);
    $solicitud = Solicitud::sole();

    $this->post("/privacidad/solicitudes/{$solicitud->getKey()}/resolver", [
        'resultado' => EstadoDeSolicitud::Acogida->value,
        'fundamento' => 'Se corrigió el correo.',
    ])->assertSessionHasErrors('resultado');

    expect($solicitud->fresh()->estado)->not->toBe(EstadoDeSolicitud::Acogida);
});

it('rectifica solo lo que cambió y acoge', function () {
    $this->actingAs($this->funcionario);
    recibirSolicitud(['tipo' => TipoDeSolicitud::Rectificacion->value, 'detalle' => 'Su correo está mal escrito.']);
    $solicitud = Solicitud::sole();

    $this->post("/privacidad/solicitudes/{$solicitud->getKey()}/rectificar", [
        'valores' => ['nombre' => 'Rocío Paredes', 'correo' => 'rocio.paredes@ejemplo.cl'],
        'fundamento' => 'Se corrigió el correo que la titular declaró en el mesón.',
    ])->assertRedirect();

    expect($this->vecino->fresh()->correo)->toBe('rocio.paredes@ejemplo.cl')
        ->and($solicitud->fresh()->estado->esAcogida())->toBeTrue();
});

it('rechaza una rectificación que no cambia nada', function () {
    $this->actingAs($this->funcionario);
    recibirSolicitud(['tipo' => TipoDeSolicitud::Rectificacion->value, 'detalle' => 'Su correo está mal escrito.']);
    $solicitud = Solicitud::sole();

    $this->post("/privacidad/solicitudes/{$solicitud->getKey()}/rectificar", [
        'valores' => ['nombre' => 'Rocío Paredes', 'correo' => 'rocio@ejemplo.cl'],
        'fundamento' => 'Se revisó lo pedido.',
    ])->assertSessionHasErrors('valores');
});

it('la página de supresión muestra hasta dónde llega el derecho antes del botón', function () {
    $this->actingAs($this->funcionario);
    recibirSolicitud(['tipo' => TipoDeSolicitud::Supresion->value, 'detalle' => 'Pide que borren sus datos.']);
    $solicitud = Solicitud::sole();

    $this->get("/privacidad/solicitudes/{$solicitud->getKey()}/suprimir")
        ->assertOk()
        ->assertSee('Hasta dónde llega el derecho de esta persona');

    expect($solicitud->fresh()->estado)->toBe(EstadoDeSolicitud::Recibida)
        ->and(VecinoDePrueba::find($this->vecino->getKey()))->not->toBeNull();
});

it('descarga el expediente y deja registrada la descarga', function () {
    $this->actingAs($this->funcionario);
    recibirSolicitud();
    $solicitud = Solicitud::sole();

    $respuesta = $this->get("/privacidad/solicitudes/{$solicitud->getKey()}/expediente");

    $respuesta->assertOk()
        ->assertHeader('content-type', 'application/json; charset=utf-8');

    // Un expediente con datos de un vecino no lo guarda ningún intermediario ni
    // queda en el historial del navegador compartido de una oficina.
    expect($respuesta->headers->get('cache-control'))->toContain('no-store');

    expect(EntradaBitacora::where('evento', 'arcop.expediente.descargado')->count())->toBe(1);
});

it('ofrece el enlace del sistema cuando el adoptante lo declara', function () {
    config([
        'arcop-panel.ayuda_del_adoptante.texto' => 'Acreditar la fecha de nacimiento',
        'arcop-panel.ayuda_del_adoptante.ruta' => 'ayuda.de.prueba',
    ]);

    $this->actingAs($this->funcionario);

    $this->get('/privacidad/solicitudes/recibir/'.$this->vecino->getKey())
        ->assertOk()
        ->assertSee('Acreditar la fecha de nacimiento')
        ->assertSee('/ayuda-del-sistema/'.$this->vecino->getKey());
});

it('sin declararlo, la pantalla de recepción no inventa ningún enlace', function () {
    $this->actingAs($this->funcionario);

    $this->get('/privacidad/solicitudes/recibir/'.$this->vecino->getKey())
        ->assertOk()
        ->assertDontSee('Acreditar la fecha de nacimiento');
});
