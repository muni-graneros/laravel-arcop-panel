# laravel-arcop-panel

El ciclo ARCOP de la **Ley 21.719** —recibir la solicitud de un vecino y
resolverla con fundamento— como panel Blade, para **cualquier Laravel 12/13**.

Sin Filament. Sin Livewire. Sin Tailwind. Sin JavaScript. Sin `package.json`.

```bash
composer require muni-graneros/laravel-arcop-panel
php artisan migrate                                   # las tablas las trae muni-shared
php artisan vendor:publish --tag=arcop-panel-css      # → public/vendor/arcop-panel
php artisan vendor:publish --tag=arcop-panel-config   # opcional
```

El repositorio es privado; en el `composer.json` del proyecto:

```json
"repositories": {
    "arcop-panel": { "type": "vcs", "url": "https://github.com/muni-graneros/laravel-arcop-panel.git" }
}
```

## Lo que hay que enchufar

Tres cosas, y ninguna la puede adivinar el paquete.

**1. Quién es un titular** — el modelo de personas del sistema implementa
`Muni\Shared\Privacidad\Contratos\TitularDeDatos`.

**2. Cómo se busca y qué acredita la identidad** — en un proveedor del sistema:

```php
$this->app->bind(BuscaTitulares::class, BuscadorDeVecinos::class);
$this->app->bind(VerificadorIdentidad::class, VerificadorDeMeson::class);
```

Si falta alguno, el panel lo dice con una frase que se puede accionar, no con un
`Target [...] is not instantiable`.

**3. Los tres permisos** — el paquete los define **denegando**; el sistema los
mapea a lo suyo:

```php
Gate::define(Permisos::VER,      fn ($u) => $u->puede('arcop.ver'));
Gate::define(Permisos::RECIBIR,  fn ($u) => $u->puede('arcop.recibir'));
Gate::define(Permisos::RESOLVER, fn ($u) => $u->puede('arcop.resolver'));
```

Son tres y no uno para que el municipio que quiera **separar la recepción de la
resolución** pueda hacerlo: es una garantía para el vecino.

### Un enlace del sistema en la recepción

El módulo puede negarse a tramitar por algo que solo el sistema adoptante sabe
resolver. El caso real: falta la fecha de nacimiento del titular, y sin ella no
se puede saber si es menor de edad —los derechos de un menor los ejerce su
representante legal—. Sin un enlace, el funcionario lee la negativa y no tiene
adónde ir, que es la peor forma de tener razón.

```php
'ayuda_del_adoptante' => [
    'texto' => 'Acreditar la fecha de nacimiento de esta persona',
    'ruta' => 'privacidad.edad.formulario',   // recibe la clave del titular
],
```

## Lo que este paquete NO hace

**Decidir qué cesa.** Tener la pantalla para recibir y resolver solicitudes es la
*superficie* del cumplimiento, no el cumplimiento. Qué pantalla, qué CSV, qué
correo y qué job dejan de tocar a esa persona cuando queda un bloqueo vigente
depende del mapeo tratamiento→finalidad de cada sistema, y eso lo escribe el
adoptante. Se declara en `arcop-panel.alcance_del_cese`; **mientras no se
declare, el panel dice en pantalla que no se declaró**.

Un sistema que monte el panel y no escriba su candado le certificaría por escrito
a un vecino un cese que no ocurre.

## Decisiones que se ven raras hasta que se explican

- **Cada acción es una página, no un modal.** Un `<dialog>` necesita JavaScript
  para abrirse y choca con una política de contenido con nonce. Una página
  server-rendered atrapa el foco sola.
- **La recepción son dos pasos.** Sin JavaScript no existe el selector con
  búsqueda en vivo. El costo es una recarga; la ganancia es que funciona con
  lector de pantalla y sin depender de que un bundle haya cargado.
- **Ningún estado avanza por GET.** Un GET que resolviera una solicitud lo
  dispararía un prefetch del navegador o una imagen en un correo.
- **El buscador tiene mínimo de caracteres, tope de resultados y throttle, y
  cada búsqueda queda en la bitácora.** Es la superficie por donde se puede
  enumerar el padrón de un municipio.
- **Las reglas legales no están acá.** Viven en
  `Muni\Shared\Privacidad\Ciclo` (muni-shared) y las comparte con el panel de
  Filament de `laravel-muni-ui`. Dos implementaciones de la misma regla
  divergen, y divergir acá es responderle distinto al mismo vecino según qué
  mesón lo atendió.

## Identidad visual

El CSS está escrito sobre los tokens `--muni-*`. Con `laravel-muni-ui` presente
hereda la identidad municipal; sin él usa sus propios valores. Modo oscuro por
`prefers-color-scheme`, por `.dark` y por `data-muni-theme="dark"`.

Para meter el panel dentro del cascarón del sistema, apuntá
`arcop-panel.layout` al layout propio (tiene que rendir `@yield('arcop')`).

## Desarrollo

```bash
composer test   # Pest + Testbench
composer stan   # PHPStan
```
