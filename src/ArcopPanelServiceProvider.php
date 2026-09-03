<?php

namespace Muni\Arcop;

use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;
use Muni\Shared\Privacidad\Contratos\BuscaTitulares;
use Muni\Shared\Privacidad\Contratos\VerificadorIdentidad;
use Muni\Shared\Privacidad\Modelos\Solicitud;

class ArcopPanelServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../config/arcop-panel.php', 'arcop-panel');
        $this->explicarLosContratosQueFaltan();
    }

    /**
     * Los dos contratos que el adoptante tiene que enchufar, con un mensaje que
     * dice qué hacer.
     *
     * Se registran solo si nadie los enlazó: el `bind` del adoptante corre en su
     * propio proveedor y gana, porque el contenedor se queda con el último.
     */
    private function explicarLosContratosQueFaltan(): void
    {
        if (! $this->app->bound(BuscaTitulares::class)) {
            $this->app->bind(BuscaTitulares::class, fn () => throw AdoptanteIncompleto::faltaElBuscador());
        }

        if (! $this->app->bound(VerificadorIdentidad::class)) {
            $this->app->bind(VerificadorIdentidad::class, fn () => throw AdoptanteIncompleto::faltaElVerificador());
        }
    }

    public function boot(): void
    {
        $this->loadViewsFrom(__DIR__.'/../resources/views', 'arcop-panel');
        $this->registrarPermisosQueDeniegan();
        $this->registrarResolucionDeSolicitud();
        $this->registrarRutas();

        if ($this->app->runningInConsole()) {
            $this->publishes([
                __DIR__.'/../config/arcop-panel.php' => config_path('arcop-panel.php'),
            ], 'arcop-panel-config');

            $this->publishes([
                __DIR__.'/../resources/views' => resource_path('views/vendor/arcop-panel'),
            ], 'arcop-panel-views');

            $this->publishes([
                __DIR__.'/../resources/css/arcop-panel.css' => public_path('vendor/arcop-panel/arcop-panel.css'),
            ], 'arcop-panel-css');
        }
    }

    /**
     * Los tres permisos existen desde que se instala el paquete, y los tres
     * dicen que no.
     *
     * Se definen solo si el adoptante NO los definió: su `AuthServiceProvider`
     * corre antes o después según el orden de proveedores, y pisarle el suyo
     * dejaría el panel cerrado con el permiso ya mapeado. `Gate::has()` es lo
     * que distingue «no lo mapeó» de «lo mapeó».
     *
     * Un permiso que se otorga solo por instalar un paquete es un permiso que
     * nadie decidió dar. Acá se ven datos personales de vecinos.
     */
    private function registrarPermisosQueDeniegan(): void
    {
        foreach (Permisos::todos() as $permiso) {
            if (Gate::has($permiso)) {
                continue;
            }

            Gate::define($permiso, fn (): bool => false);
        }
    }

    /**
     * Una solicitud de OTRO sistema no existe para este panel.
     *
     * La tabla del módulo es compartida —los sistemas del ecosistema escriben en
     * la misma— y la columna `sistema` es lo único que los separa. Sin este
     * filtro, cambiar el número de la URL mostraría el expediente de un vecino
     * atendido por otro organismo: fuga entre responsables de tratamiento, no un
     * IDOR cosmético.
     *
     * Va en el binding y no en cada controlador a propósito: una ruta nueva que
     * mañana olvide el filtro no puede saltárselo.
     *
     * El parámetro es `solicitudArcop` y no `solicitud`: `Route::bind()` es
     * global a la aplicación adoptante y gana sobre el binding implícito, así
     * que un nombre genérico le cambiaría el modelo a cualquier `{solicitud}`
     * del sistema que instale el paquete —licencias de conducir tiene once—.
     * Un nombre que nadie más usa no colisiona con nadie.
     */
    private function registrarResolucionDeSolicitud(): void
    {
        Route::bind('solicitudArcop', fn (string $id): Solicitud => Solicitud::query()
            ->where('sistema', (string) config('privacidad.sistema'))
            ->findOrFail($id));
    }

    private function registrarRutas(): void
    {
        Route::group([
            'prefix' => (string) config('arcop-panel.prefijo'),
            'middleware' => (array) config('arcop-panel.middleware'),
        ], function (): void {
            $this->loadRoutesFrom(__DIR__.'/../routes/arcop.php');
        });
    }
}
