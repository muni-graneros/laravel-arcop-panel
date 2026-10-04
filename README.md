# laravel-arcop-panel

El ciclo ARCOP de la **Ley 21.719** —recibir la solicitud de un vecino y
resolverla con fundamento— como panel Blade, para **cualquier Laravel 12/13**.

Sin Filament. Sin Livewire. Sin Tailwind. Sin JavaScript. Sin `package.json`.

## Requisitos

- PHP **^8.3**
- Laravel **12 o 13** (`illuminate/*` `^12.0|^13.0`)
- **`muni-graneros/laravel-muni-shared` `^1.16`** — de ahí salen las tablas, los
  modelos (`Solicitud`, bitácora) y las reglas legales del ciclo.

## Instalación

Ninguno de los dos paquetes está en Packagist, así que **el `composer.json` del
proyecto adoptante** tiene que declarar los dos repositorios VCS. Composer no
hereda los `repositories` de un paquete instalado, solo lee los de la raíz:
declarar solo `arcop-panel` termina en un «could not be found» de
`laravel-muni-shared` que no dice por qué.

```json
"repositories": {
    "arcop-panel": { "type": "vcs", "url": "https://github.com/muni-graneros/laravel-arcop-panel.git" },
    "muni-shared": { "type": "vcs", "url": "https://github.com/muni-graneros/laravel-muni-shared.git", "no-api": true }
},
"require": {
    "muni-graneros/laravel-arcop-panel": "^0.4"
}
```

**No hace falta token**: `laravel-arcop-panel` y `laravel-muni-shared` son
repositorios públicos de `muni-graneros` (verificado el 2026-09-14). Sí lo
necesitan otros paquetes del ecosistema que sí son privados —`laravel-muni-acceso`,
`laravel-panel-base`, `laravel-anonimizacion`, `laravel-centinela`,
`laravel-rag`—: ahí el PAT de GitHub va configurado **fuera del repositorio**
(`composer config --global --auth github-oauth.github.com <token>`, o la
variable `COMPOSER_AUTH` en el servidor de despliegue), nunca escrito en
`composer.json` ni en un `.env` versionado.

> **El caret en 0.x no hace lo que parece.** Este paquete sigue en `0.x`, y ahí
> `^0.4` acepta 0.4.1 y 0.4.2 pero **no** 0.5. Al publicarse una menor hay que
> editar la restricción a mano (`^0.5`); un `composer update` no la trae sola, y
> así es como un sistema se queda meses en una versión vieja creyendo que está
> al día.

```bash
composer require muni-graneros/laravel-arcop-panel
php artisan migrate                                   # las tablas las trae muni-shared
php artisan vendor:publish --tag=arcop-panel-css      # → public/vendor/arcop-panel
php artisan vendor:publish --tag=arcop-panel-config   # opcional
php artisan vendor:publish --tag=arcop-panel-views    # opcional, solo si vas a editar las vistas
```

El service provider se descubre solo. Los tags publicables son cuatro:
`arcop-panel-css` (el único obligatorio: el layout carga
`public/vendor/arcop-panel/arcop-panel.css` y sin él el panel sale sin estilos),
`arcop-panel-config`, `arcop-panel-views` y `arcop-panel-migrations`.

**El CSS hay que republicarlo en cada `composer update`**, o el panel sirve una
hoja vieja. Va en el `composer.json` del adoptante:

```json
"post-update-cmd": [
    "@php artisan vendor:publish --tag=arcop-panel-css --ansi --force"
]
```

La config y las vistas **no** se republican solas a propósito: son las dos cosas
que el adoptante personaliza, y un `--force` en cada `update` le pisaría los
cambios.

### Dos variables del módulo de privacidad que este panel necesita sí o sí

Las define `laravel-muni-shared` (config `privacidad`), no este paquete, pero sin
ellas el panel no sirve:

| Variable | Qué pasa si falta |
|---|---|
| `PRIVACIDAD_SISTEMA` | El panel filtra las solicitudes por sistema. Sin valor, la bandeja sale **vacía** aunque la tabla tenga filas |
| `PRIVACIDAD_DISCO_EVIDENCIA` | La recepción con representante no puede guardar el documento que la acredita y falla |

### El índice de la línea de tiempo del expediente (opcional, MariaDB/MySQL)

`privacidad_bitacora` es inmutable y solo crece; sin índice, cada expediente
abierto escanea todas las filas del sistema para armar su línea de tiempo. El
paquete trae una migración publicable —no se aplica sola, como ninguna
migración de este ecosistema— que agrega una columna generada e indexada:

```bash
php artisan vendor:publish --tag=arcop-panel-migrations
php artisan migrate --pretend   # revisar el SQL antes de correrla de verdad
php artisan migrate
```

Solo hace algo en MariaDB/MySQL (json_unquote/json_extract como columna
generada). Sin correrla, el panel sigue funcionando igual: filtra por la clave
JSON sin índice, como hasta ahora.

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
resolución** pueda hacerlo: es una garantía para el vecino. El paquete solo
define los que el adoptante no definió, así que mapearlos antes o después no
cambia nada.

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

## Qué monta en la aplicación

Las rutas cuelgan de `arcop-panel.prefijo` (por defecto `privacidad`) con la
pila `arcop-panel.middleware` (por defecto `web` + `auth`: el paquete **no trae
autenticación propia**). Todas se llaman `arcop.*`.

| Método y URL | Nombre | Permiso |
|---|---|---|
| `GET solicitudes` | `arcop.solicitudes.index` | VER |
| `GET solicitudes/{id}` | `arcop.solicitudes.show` | VER |
| `GET/POST solicitudes/recibir` | `arcop.solicitudes.buscar[.ejecutar]` | RECIBIR |
| `GET solicitudes/recibir/{referencia}` | `arcop.solicitudes.formulario` | RECIBIR |
| `POST solicitudes` | `arcop.solicitudes.store` | RECIBIR |
| `GET solicitudes/{id}/expediente` | `arcop.solicitudes.expediente` | **RESOLVER** |
| `POST solicitudes/{id}/tomar` | `arcop.solicitudes.tomar` | RESOLVER |
| `GET/POST solicitudes/{id}/{resolver\|rectificar\|suprimir}` | `arcop.solicitudes.<accion>[.aplicar]` | RESOLVER |

Descargar el expediente pide RESOLVER y no VER a propósito: llevarse la copia
completa de los datos de una persona es la acción más sensible del panel.

El paquete también registra `Route::bind('solicitudArcop')`, que filtra por
`privacidad.sistema`: una solicitud de otro sistema del ecosistema no existe
para este panel. El parámetro no se llama `{solicitud}` porque ese binding es
global a la aplicación adoptante y le cambiaría el modelo a cualquier
`{solicitud}` propia (licencias de conducir tiene once).

## Configuración

`config/arcop-panel.php`, publicable con `--tag=arcop-panel-config`:

| Clave | Por defecto | Para qué |
|---|---|---|
| `prefijo` (`ARCOP_PREFIJO`) | `privacidad` | Bajo qué ruta cuelga el panel |
| `middleware` | `['web', 'auth']` | La pila del adoptante |
| `layout` | `arcop-panel::layouts.app` | El cascarón; apuntalo al del sistema |
| `titulo` | `Solicitudes de datos personales` | Título de las pantallas |
| `buscador.minimo_caracteres` | `3` | Tope contra la enumeración del padrón |
| `buscador.maximo_resultados` | `20` | Ídem |
| `buscador.throttle` | `20,1` | Ídem (formato `intentos,minutos`) |
| `alcance_del_cese` (`ARCOP_ALCANCE_DEL_CESE`) | sin declarar | Qué deja de hacer este sistema con los datos al haber un bloqueo. Ver abajo |
| `credencial.etiqueta` / `.ayuda` | `Credencial que presenta` | Cómo se llama en el mesón lo que acredita identidad |
| `ayuda_del_adoptante.texto` / `.ruta` | `null` | El enlace de arriba |
| `permisos.*` | Las constantes de `Permisos` | Nombres de las tres habilidades |

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
- **Entre los dos pasos de la recepción viaja una referencia opaca de la
  sesión, no la clave del titular.** En atencionvecino esa clave ES el RUT, y en
  la URL quedaba en el access log y en el historial del navegador compartido del
  mesón.
- **El buscador tiene mínimo de caracteres, tope de resultados y throttle, y
  cada búsqueda queda en la bitácora.** Es la superficie por donde se puede
  enumerar el padrón de un municipio.
- **Las reglas legales no están acá.** Viven en
  `Muni\Shared\Privacidad\Ciclo` (muni-shared) y las comparte con el panel de
  Filament de `laravel-muni-ui`. Dos implementaciones de la misma regla
  divergen, y divergir acá es responderle distinto al mismo vecino según qué
  mesón lo atendió.
- **El documento que acredita la representación se sube, nunca se tipea.** El
  formulario de recepción lo recibe como archivo (`<input type="file">`) y es
  el panel el que decide la ruta en el disco de evidencia al guardarlo
  (`RecepcionController::guardarAcreditacion()`); el cliente nunca controla esa
  ruta. Es a propósito: el núcleo **borra** ese documento cuando se suprime al
  titular, y una ruta tipeada a mano dejaba que cualquiera con `arcop.recibir`
  hiciera borrar el documento de OTRO vecino, firmando el borrado como
  evidencia legal.

## Identidad visual

El CSS está escrito sobre los tokens `--muni-*`. Con `laravel-muni-ui` presente
hereda la identidad municipal; sin él usa sus propios valores. Modo oscuro por
`prefers-color-scheme` (solo en pantalla, y cede ante `.light`, `data-theme="light"` o `data-muni-theme="light"` del anfitrión), por `.dark` y por `data-muni-theme="dark"`.

**Si reemplazás el layout, envolvé el contenido en `.arcop-cuerpo`.** Ahí viven los
tokens de color y la jerarquía de títulos; sin esa clase el panel hereda el reset
del sistema —Tailwind iguala `h1..h6` al texto corriente— y los encabezados
desaparecen. El layout que trae el paquete ya la pone:

```blade
@section('contenido')
    <div class="arcop-cuerpo">
        @yield('arcop')
    </div>
@endsection
```

Para meter el panel dentro del cascarón del sistema, apuntá
`arcop-panel.layout` al layout propio (tiene que rendir `@yield('arcop')`).

El CSS del paquete no tiene reglas globales: todo cuelga de `.arcop-cuerpo`, así
que no le cambia el color de los enlaces ni el anillo de foco al sistema
anfitrión. `tests/EstilosAcotadosTest.php` lo comprueba.

## Desarrollo

```bash
composer test   # Pest + Testbench
composer stan   # PHPStan, nivel 8, sin baseline (ver phpstan.neon)
```

Ver `CHANGELOG.md` para qué cambió en cada versión.
