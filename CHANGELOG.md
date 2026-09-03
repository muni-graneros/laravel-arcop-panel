# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.0.0/).
Este paquete todavía no sigue versionado semántico estricto: 0.x significa que
la forma de publicar vistas y el contrato de configuración pueden cambiar
entre versiones menores sin previo aviso.

## Sin publicar

Trabajo ya en la rama `develop`, sin tag todavía.

### Seguridad

- La documentación que acredita la representación se sube por archivo; el
  panel decide la ruta en el disco de evidencia al guardarlo. Antes era un
  `<input type="text">` con la ruta tecleada por el funcionario, validada solo
  como `string|max:255`, y el núcleo borra ese documento al suprimir al
  titular: cualquiera con `arcop.recibir` podía hacer borrar el documento de
  OTRO vecino, firmando el borrado como evidencia legal.
- El paso 2 de la recepción (`solicitudes/recibir/{titular}`) ya no recibe la
  clave del titular en la URL. Sin throttle ni bitácora, era la superficie por
  donde se podía enumerar el padrón municipal —en atencionvecino, la clave
  primaria del titular ES el RUT— y cada intento quedaba en el access log y en
  el historial del navegador compartido del mesón. La búsqueda pasa a ser POST
  con redirección (Post/Redirect/Get); entre los dos pasos viaja una
  referencia opaca de esta sesión, no la clave real, con throttle propio.
- `TipoDeSolicitud` y `Solicitante` se validan con `Rule::enum(...)` antes del
  `::from()`: un valor manipulado ahora es un error de validación, no un
  `ValueError` (500).
- `json_encode()` del expediente usa `JSON_THROW_ON_ERROR` y corre ANTES de
  asentar la descarga en la bitácora: un byte inválido en un dato del vecino
  ya no entrega un archivo vacío con 200 después de haber certificado una
  entrega que no ocurrió.
- El CSS del paquete deja de tener reglas globales (`a`, `:focus-visible` sin
  prefijo): ya no le cambia el color de los enlaces ni el anillo de foco al
  sistema anfitrión. Todo vive bajo `.arcop-cuerpo`.
- `Route::bind('solicitud', ...)` pasa a `Route::bind('solicitudArcop', ...)`:
  el binding es global a la aplicación adoptante y ganaba sobre el binding
  implícito de cualquier otra ruta `{solicitud}` del sistema que instale el
  paquete (licencias de conducir tiene once).

### Agregado

- Paginador propio (`resources/views/partes/paginacion.blade.php`) para la
  bandeja: la vista Tailwind por defecto de Laravel pintaba a la vez el bloque
  móvil y el de escritorio —dos «Siguiente»— en un panel que no carga
  Tailwind.
- `EtiquetaDeEvento` se usa en la línea de tiempo del expediente: los eventos
  se leen en castellano («Búsqueda de titulares») y no como la clave cruda
  (`arcop.titulares.buscados`).
- Errores de formulario con `aria-invalid` y `aria-describedby` por campo,
  además del resumen superior (WCAG 3.3.1 y 3.3.3). El buscador deja de llevar
  `autofocus`: saltaba el skip-link y la cabecera para lectores de pantalla.
- Tests de separación de los tres permisos (`SeparacionDePermisosTest`): antes
  ninguna prueba distinguía VER de RECIBIR de RESOLVER, y una regresión que
  intercambiara dos permisos en `routes/arcop.php` pasaba en verde.
- Migración publicable (no automática) que agrega una columna generada e
  indexada a `privacidad_bitacora` en MariaDB/MySQL, para que abrir un
  expediente no escanee toda la tabla. Ver «El índice de la línea de tiempo
  del expediente» en el README.
- `phpstan.neon` (nivel 8, sin baseline): el paquete anunciaba PHPStan desde
  la v0.3.5 sin que `composer stan` analizara nada.

## [v0.3.5] - 2026-08-25

### Corregido

- Sin acciones disponibles, la pantalla del expediente ya no deja el hueco de
  la sección de acciones: dice que el caso está cerrado.

## [v0.3.4] - 2026-08-25

### Corregido

- La jerarquía de títulos (`h1`..`h6`) vuelve a colgar de `.arcop-cuerpo` y no
  del reset del sistema anfitrión.

## [v0.3.3] - 2026-08-25

### Corregido

- Los títulos dejan de depender de los estilos por defecto del navegador.

## [v0.3.2] - 2026-08-25

### Corregido

- El botón de buscar se alinea con el cuadro de texto del buscador.

## [v0.3.1] - 2026-08-25

### Corregido

- Un caso cerrado lo dice en pantalla, en vez de dejar el hueco de la sección
  de acciones (primera versión de este arreglo; ver v0.3.5).

## [v0.3.0] - 2026-08-25

### Corregido

- La descarga del expediente se ofrece solo cuando la solicitud da derecho a
  ella: pedirla a mano por URL en una supresión devolvía un 500 con traza en
  vez de una negativa.

## [v0.2.0] - 2026-08-24

### Agregado

- Enlace configurable del sistema adoptante (`arcop-panel.ayuda_del_adoptante`)
  en la pantalla de recepción, para las negativas del módulo que solo el
  sistema adoptante puede resolver (el caso real: falta la fecha de
  nacimiento del titular).

## [v0.1.1] - 2026-08-24

### Corregido

- El panel pasa a caber en el teléfono; los objetivos táctiles suben al mínimo
  de accesibilidad.

## [v0.1.0] - 2026-08-24

### Agregado

- Primera versión: el ciclo ARCOP completo (recepción y resolución de
  solicitudes de la Ley 21.719) como panel Blade, sin Filament, sin Livewire,
  sin Tailwind y sin JavaScript.

[v0.3.5]: https://github.com/muni-graneros/laravel-arcop-panel/releases/tag/v0.3.5
[v0.3.4]: https://github.com/muni-graneros/laravel-arcop-panel/releases/tag/v0.3.4
[v0.3.3]: https://github.com/muni-graneros/laravel-arcop-panel/releases/tag/v0.3.3
[v0.3.2]: https://github.com/muni-graneros/laravel-arcop-panel/releases/tag/v0.3.2
[v0.3.1]: https://github.com/muni-graneros/laravel-arcop-panel/releases/tag/v0.3.1
[v0.3.0]: https://github.com/muni-graneros/laravel-arcop-panel/releases/tag/v0.3.0
[v0.2.0]: https://github.com/muni-graneros/laravel-arcop-panel/releases/tag/v0.2.0
[v0.1.1]: https://github.com/muni-graneros/laravel-arcop-panel/releases/tag/v0.1.1
[v0.1.0]: https://github.com/muni-graneros/laravel-arcop-panel/releases/tag/v0.1.0
