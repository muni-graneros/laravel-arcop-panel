<?php

namespace Muni\Arcop\Tests;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Muni\Arcop\ArcopPanelServiceProvider;
use Muni\Arcop\Tests\Fixtures\BuscadorDeVecinos;
use Muni\Arcop\Tests\Fixtures\UsuarioDePrueba;
use Muni\Arcop\Tests\Fixtures\VerificadorDeMeson;
use Muni\Shared\MuniSharedServiceProvider;
use Muni\Shared\Privacidad\Contratos\BuscaTitulares;
use Muni\Shared\Privacidad\Contratos\VerificadorIdentidad;
use Orchestra\Testbench\TestCase as Base;

abstract class TestCase extends Base
{
    use RefreshDatabase;

    /** @return array<int, class-string> */
    protected function getPackageProviders($app): array
    {
        return [MuniSharedServiceProvider::class, ArcopPanelServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        // Testbench no trae APP_KEY y la sesión de `web` la necesita.
        $app['config']->set('app.key', 'base64:'.base64_encode(random_bytes(32)));
        $app['config']->set('database.default', 'testing');
        $app['config']->set('database.connections.testing', [
            'driver' => 'sqlite',
            'database' => ':memory:',
            'prefix' => '',
        ]);
        $app['config']->set('privacidad.sistema', 'atencionvecino');
        $app['config']->set('privacidad.plazo_respuesta_dias', 30);
        $app['config']->set('auth.providers.users.model', UsuarioDePrueba::class);

        // Lo que engancha el sistema adoptante: cómo busca a su gente y qué
        // cuenta como identidad acreditada en su mesón. El paquete no trae
        // ninguna de las dos.
        $app->bind(BuscaTitulares::class, BuscadorDeVecinos::class);
        $app->bind(VerificadorIdentidad::class, VerificadorDeMeson::class);
    }

    /**
     * Lo que engancha el sistema adoptante: cómo busca a su gente y qué cuenta
     * como identidad acreditada en su mesón. El paquete no trae ninguna de las
     * dos.
     */
    /**
     * El sistema adoptante siempre tiene su propia pantalla de ingreso; el
     * paquete no trae ninguna. Acá se declara solo para que el redirect de
     * `auth` tenga adónde ir, como en un sistema real.
     */
    protected function defineRoutes($router): void
    {
        $router->get('/ingresar', fn (): string => 'ingreso del sistema')->name('login');

        // Una ruta del sistema adoptante, para ejercitar el enlace de ayuda que
        // el panel ofrece en la recepción.
        $router->get('/ayuda-del-sistema/{titular}', fn (): string => 'ayuda')->name('ayuda.de.prueba');
    }

    protected function defineDatabaseMigrations(): void
    {
        $this->loadMigrationsFrom(__DIR__.'/Fixtures/migrations');
    }
}
