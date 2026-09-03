# laravel-arcop-panel

Paquete Composer: el ciclo ARCOP de la Ley 21.719 como panel Blade, sin
Filament, sin Livewire, sin Tailwind y sin JavaScript. El `CLAUDE.md` global de
César (`~/.claude/CLAUDE.md`) manda sobre este archivo salvo en lo que sigue,
que es propio de este paquete.

## Qué NO va acá

**Las reglas legales del ciclo ARCOP no viven en este repo.** Viven en
`Muni\Shared\Privacidad\Ciclo` (paquete `muni-graneros/laravel-muni-shared`) y
las comparte con el panel de Filament de `laravel-muni-ui`. Este paquete es
solo la pantalla: plazos, qué resultado corresponde a qué tipo de solicitud,
qué campos son rectificables, qué cesa una supresión — todo eso lo decide
`muni-shared`. Escribir esa lógica acá (aunque sea "solo para esta pantalla")
la duplica, y dos implementaciones de la misma regla legal divergen: el mismo
vecino tendría una respuesta distinta según qué mesón lo atendió.

Corolario para las migraciones: este paquete no es dueño de
`privacidad_bitacora` ni de `privacidad_solicitudes` (las trae `muni-shared`).
La única migración que trae este paquete (`database/migrations/`, columna
generada e indexada sobre `datos->solicitud_id`) es publicable y NO se carga
con `loadMigrationsFrom()` — el adoptante la corre cuando quiere, después de
revisar el SQL, como cualquier migración de este ecosistema.

## Qué publicar en `post-update-cmd` del adoptante

El sistema que instala el paquete tiene que republicar el CSS en cada
`composer update`, o el panel queda sirviendo un `arcop-panel.css` viejo desde
`public/vendor/arcop-panel/`:

```json
"post-update-cmd": [
    "@php artisan vendor:publish --tag=arcop-panel-css --ansi --force"
]
```

La config (`arcop-panel-config`) y las vistas (`arcop-panel-views`) NO se
republican solas a propósito: son las dos cosas que el adoptante personaliza,
y forzar su publicación en cada `update` le pisaría los cambios. Las migra el
adoptante a mano cuando corresponda.

## Verificación de este paquete

```bash
composer test   # Pest + Testbench, SQLite en memoria — no necesita Docker
composer stan   # PHPStan nivel 8, sin baseline
vendor/bin/pint # formato
```

`composer stan` corre de verdad desde que existe `phpstan.neon` en la raíz
(antes no había fichero de configuración y el comando no analizaba nada pese a
que el README lo anunciaba desde la v0.3.5). Si un cambio agrega un error de
PHPStan, se arregla la causa — no se agrega `@phpstan-ignore`, `assert()`,
`@var` para forzar un tipo, ni una entrada de baseline.

## El candado de `acreditacion_path`

El documento que acredita la representación (`RecepcionController`) se sube
como archivo; la ruta en el disco de evidencia la decide el panel al
guardarlo, nunca el cliente. Es a propósito: el núcleo de `muni-shared` BORRA
ese documento cuando se suprime al titular, así que una ruta tecleada a mano
dejaba que cualquiera con `arcop.recibir` hiciera borrar el documento de OTRO
vecino, firmando el borrado como evidencia legal. Si algún día hace falta
reutilizar un documento ya subido (en vez de subir uno nuevo), la solución es
un `<select>` con las rutas asociadas a ESE titular — nunca un campo de texto
libre con una ruta.
