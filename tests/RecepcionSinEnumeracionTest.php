<?php

use Illuminate\Support\Facades\Gate;
use Muni\Arcop\Permisos;
use Muni\Arcop\Tests\Fixtures\UsuarioDePrueba;
use Muni\Arcop\Tests\Fixtures\VecinoDePrueba;
use Muni\Shared\Privacidad\Modelos\EntradaBitacora;
use Muni\Shared\Privacidad\Modelos\Solicitud;
use Muni\Shared\Privacidad\TipoDeSolicitud;

/*
 * El paso 2 de la recepción era la superficie por donde se enumeraba el padrón:
 * `recibir/{clave}` aceptaba cualquier clave —en atencionvecino la clave del
 * vecino ES el RUT—, sin tope de intentos y sin dejar rastro, y el 404 servía
 * de oráculo de «este RUT existe». Además el RUT quedaba en el access log y en
 * el historial del navegador compartido del mesón.
 *
 * Lo que se prueba acá: el paso 2 solo se abre con una referencia opaca que
 * salió de una búsqueda de ESTA sesión, y ni el RUT ni el término buscado
 * pasan por una URL.
 */
beforeEach(function () {
    foreach (Permisos::todos() as $permiso) {
        Gate::define($permiso, fn (): bool => true);
    }

    $this->funcionario = UsuarioDePrueba::create(['name' => 'Ana Soto', 'email' => 'ana@ejemplo.cl']);
    $this->otro = UsuarioDePrueba::create(['name' => 'Luis Díaz', 'email' => 'luis@ejemplo.cl']);

    $this->vecino = VecinoDePrueba::create([
        'nombre' => 'Rocío Paredes',
        'documento' => '11.111.111-1',
        'correo' => 'rocio@ejemplo.cl',
        'fecha_nacimiento' => now()->subYears(40)->toDateString(),
    ]);

    $this->actingAs($this->funcionario);
});

it('la lista de resultados enlaza al paso 2 por una referencia opaca, nunca por la clave del titular', function () {
    $html = (string) buscarTitulares('Rocío')->assertOk()->assertSee('Rocío Paredes')->getContent();

    expect($html)->not->toContain('/privacidad/solicitudes/recibir/'.$this->vecino->getKey())
        ->and($html)->toMatch('#/privacidad/solicitudes/recibir/[0-9a-f]{32}#');
});

it('el término buscado no viaja en la URL: se busca por POST y se redirige sin query string', function () {
    $this->post('/privacidad/solicitudes/recibir', ['q' => 'Rocío'])
        ->assertRedirect('/privacidad/solicitudes/recibir');

    // La página de resultados conserva lo tipeado para que el funcionario lo
    // vea y lo corrija, pero lo saca de la sesión, no de la URL.
    $this->get('/privacidad/solicitudes/recibir')->assertOk()->assertSee('Rocío Paredes');
});

it('un GET con ?q= ya no busca nada: dejó de ser la superficie de enumeración', function () {
    $this->get('/privacidad/solicitudes/recibir?q=Rocío')
        ->assertOk()
        ->assertDontSee('Rocío Paredes');

    expect(EntradaBitacora::where('evento', 'arcop.titulares.buscados')->count())->toBe(0);
});

it('la clave del titular escrita a mano en la URL del paso 2 no abre nada', function () {
    $this->get('/privacidad/solicitudes/recibir/'.$this->vecino->getKey())->assertNotFound();
});

it('una referencia que no salió de una búsqueda de esta sesión no abre el paso 2', function () {
    $referencia = referenciaDe($this->vecino);

    // Inventada.
    $this->get('/privacidad/solicitudes/recibir/'.str_repeat('a', 32))->assertNotFound();

    // Real, pero de OTRA sesión: el enlace copiado de la pantalla de un colega.
    $this->flushSession();
    $this->actingAs($this->otro)
        ->get('/privacidad/solicitudes/recibir/'.$referencia)
        ->assertNotFound();
});

it('abrir el paso 2 queda en la bitácora, sin copiar la clave del titular en los datos', function () {
    $referencia = referenciaDe($this->vecino);

    $this->get('/privacidad/solicitudes/recibir/'.$referencia)->assertOk()->assertSee('Rocío Paredes');

    $entrada = EntradaBitacora::where('evento', 'arcop.titular.consultado')->sole();

    // El titular va en el morph, que `Bitacora::desvincular()` sabe soltar al
    // anonimizar. En `datos` no: esa columna es inmutable y una clave copiada
    // ahí sobreviviría a la anonimización.
    // `toEqual`: la columna del morph es string —tiene que poder guardar un RUT—.
    expect($entrada->titular_id)->toEqual($this->vecino->getKey())
        ->and($entrada->user_id)->toEqual($this->funcionario->getKey())
        ->and(json_encode($entrada->datos))->not->toContain((string) $this->vecino->getKey())
        ->and(json_encode($entrada->datos))->not->toContain('11.111.111-1');
});

it('el paso 2 tiene tope de intentos propio, separado del buscador', function () {
    $referencia = referenciaDe($this->vecino);

    foreach (range(1, 20) as $intento) {
        $this->get('/privacidad/solicitudes/recibir/'.$referencia)->assertOk();
    }

    $this->get('/privacidad/solicitudes/recibir/'.$referencia)->assertStatus(429);

    // El tope del paso 2 no le come intentos al buscador.
    $this->post('/privacidad/solicitudes/recibir', ['q' => 'Rocío'])->assertRedirect();
});

it('el paso 3 tampoco acepta la clave del titular: solo la referencia de la búsqueda', function () {
    $this->post('/privacidad/solicitudes', [
        'titular' => $this->vecino->getKey(),
        'titular_id' => $this->vecino->getKey(),
        'tipo' => TipoDeSolicitud::Acceso->value,
        'solicitante' => 'titular',
        'detalle' => 'Pide copia de todo lo que el municipio tiene sobre ella.',
        'credencial' => '11.111.111-1',
    ])->assertSessionHasErrors('titular');

    expect(Solicitud::count())->toBe(0);
});

it('con la referencia de la búsqueda la solicitud se recibe, y la sesión olvida la búsqueda al terminar', function () {
    $referencia = referenciaDe($this->vecino);

    $this->post('/privacidad/solicitudes', [
        'titular' => $referencia,
        'tipo' => TipoDeSolicitud::Acceso->value,
        'solicitante' => 'titular',
        'detalle' => 'Pide copia de todo lo que el municipio tiene sobre ella.',
        'credencial' => '11.111.111-1',
    ])->assertRedirect();

    expect(Solicitud::sole()->titular_id)->toEqual($this->vecino->getKey());

    // Recibida la solicitud, ni los resultados ni la referencia siguen vivos.
    $this->get('/privacidad/solicitudes/recibir')->assertOk()->assertDontSee('Rocío Paredes');
    $this->get('/privacidad/solicitudes/recibir/'.$referencia)->assertNotFound();
});

it('si el titular desapareció entre la búsqueda y el paso 2, es un 404 y no un 500', function () {
    $referencia = referenciaDe($this->vecino);

    $this->vecino->delete();

    $this->get('/privacidad/solicitudes/recibir/'.$referencia)->assertNotFound();
});
