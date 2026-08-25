<?php

use Muni\Arcop\AdoptanteIncompleto;
use Muni\Shared\Privacidad\Contratos\BuscaTitulares;
use Muni\Shared\Privacidad\Contratos\VerificadorIdentidad;

it('si el sistema no declaró cómo busca titulares, el error dice qué hacer', function () {
    // Un sistema que instaló el paquete y no enchufó nada.
    app()->forgetInstance(BuscaTitulares::class);
    app()->bind(BuscaTitulares::class, fn () => throw AdoptanteIncompleto::faltaElBuscador());

    expect(fn () => app(BuscaTitulares::class))
        ->toThrow(AdoptanteIncompleto::class, 'no declaró cómo busca a los titulares');
});

it('si el sistema no declaró qué acredita la identidad, el error dice qué hacer', function () {
    app()->forgetInstance(VerificadorIdentidad::class);
    app()->bind(VerificadorIdentidad::class, fn () => throw AdoptanteIncompleto::faltaElVerificador());

    expect(fn () => app(VerificadorIdentidad::class))
        ->toThrow(AdoptanteIncompleto::class, 'identidad acreditada en su mesón');
});

it('el paquete publica config, vistas y CSS por separado', function () {
    $this->artisan('vendor:publish', ['--tag' => 'arcop-panel-config'])->assertSuccessful();
    $this->artisan('vendor:publish', ['--tag' => 'arcop-panel-views'])->assertSuccessful();
    $this->artisan('vendor:publish', ['--tag' => 'arcop-panel-css'])->assertSuccessful();

    expect(file_exists(config_path('arcop-panel.php')))->toBeTrue()
        ->and(file_exists(public_path('vendor/arcop-panel/arcop-panel.css')))->toBeTrue();

    @unlink(config_path('arcop-panel.php'));
});

it('el panel no depende de Filament, Livewire ni de ningún paquete de npm', function () {
    $composer = json_decode((string) file_get_contents(__DIR__.'/../composer.json'), true);

    expect(array_keys($composer['require']))->toBe([
        'php',
        'illuminate/http',
        'illuminate/routing',
        'illuminate/support',
        'illuminate/view',
        'muni-graneros/laravel-muni-shared',
    ])->and(file_exists(__DIR__.'/../package.json'))->toBeFalse();
});
