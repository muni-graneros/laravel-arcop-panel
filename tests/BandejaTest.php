<?php

use Illuminate\Support\Facades\Gate;
use Muni\Arcop\Permisos;
use Muni\Arcop\Tests\Fixtures\UsuarioDePrueba;
use Muni\Arcop\Tests\Fixtures\VecinoDePrueba;
use Muni\Shared\Privacidad\BaseLicitud;
use Muni\Shared\Privacidad\Modelos\Finalidad;
use Muni\Shared\Privacidad\ResultadoVerificacion;
use Muni\Shared\Privacidad\Solicitudes;
use Muni\Shared\Privacidad\TipoDeSolicitud;

beforeEach(function () {
    foreach (Permisos::todos() as $permiso) {
        Gate::define($permiso, fn (): bool => true);
    }

    Finalidad::create([
        'sistema' => 'atencionvecino', 'codigo' => 'requerimientos', 'nombre' => 'Requerimientos vecinales',
        'base_licitud' => BaseLicitud::FuncionLegal, 'norma_habilitante' => 'Ley 18.695',
    ]);

    $this->actingAs(UsuarioDePrueba::create(['name' => 'Ana Soto', 'email' => 'ana@ejemplo.cl']));
});

it('pagina con una vista propia: sin Tailwind, con etiqueta y página actual anunciadas', function () {
    $vecino = VecinoDePrueba::create([
        'nombre' => 'Rocío Paredes', 'documento' => '11.111.111-1',
        'fecha_nacimiento' => now()->subYears(40)->toDateString(),
    ]);

    // Una más que la página: 26.
    foreach (range(1, 26) as $n) {
        app(Solicitudes::class)->registrar(
            $vecino,
            TipoDeSolicitud::Acceso,
            "Solicitud número {$n}.",
            new ResultadoVerificacion(true, 'cedula_presencial', []),
        );
    }

    $html = (string) $this->get('/privacidad/solicitudes')
        ->assertOk()
        ->assertSee('Paginación de solicitudes')
        ->assertSee('aria-current="page"', false)
        // La vista Tailwind por defecto pinta a la vez el bloque móvil y el de
        // escritorio en un panel que no carga Tailwind: dos «Siguiente».
        ->assertDontSee('sm:hidden')
        ->getContent();

    expect(substr_count($html, 'rel="next"'))->toBe(1);

    // La segunda página trae la que sobró.
    $segunda = (string) $this->get('/privacidad/solicitudes?page=2')->assertOk()->getContent();

    expect(substr_count($segunda, 'la solicitud N.º'))->toBe(1);
});
