# Ciclo 1 — `laravel-arcop-panel`: el ciclo ARCOP en Blade, sin dependencias

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un paquete que, con `composer require` y tres gates mapeados, le da a cualquier Laravel 12/13 el ciclo ARCOP completo de la Ley 21.719 —recibir, tomar, resolver, rectificar, suprimir y descargar el expediente— sin instalar Filament, Livewire, Tailwind ni un solo paquete de npm.

**Architecture:** Controladores clásicos + vistas Blade publicables. Todas las reglas legales salen de `Muni\Shared\Privacidad\Ciclo` (Ciclo 0): este paquete no decide nada legal, arma pantallas. Cada acción es una página propia server-rendered —no hay modales— y los estados avanzan solo por POST con CSRF. El CSS es autocontenido y publicable, escrito sobre tokens `--muni-*`: con `muni-ui` presente hereda la identidad municipal, sin él trae sus propios valores.

**Tech Stack:** PHP 8.3+, Laravel 12/13, `muni-graneros/laravel-muni-shared ^1.14`, Pest 3/4 + Orchestra Testbench. Cero JS.

**Spec:** `../laravel-muni-shared/docs/superpowers/specs/2026-08-24-arcop-panel-blade-design.md`

## Global Constraints

- Repositorio: `/home/cesar/Dev/laravel-arcop-panel`. Namespace `Muni\Arcop\`, tests en `Muni\Arcop\Tests\`.
- **Dependencias permitidas:** `php ^8.3`, `illuminate/*`, `muni-graneros/laravel-muni-shared`. Ninguna otra. Nada de npm.
- **Ninguna regla legal se escribe acá.** Si hace falta una que no está en el núcleo, se agrega al núcleo (muni-shared) y este paquete la consume.
- Los tres gates —`arcop.ver`, `arcop.recibir`, `arcop.resolver`— **deniegan por defecto**. Un gate sin mapear no abre nada.
- Los estados avanzan solo por POST. Todo POST con CSRF. Nada de `<dialog>` ni JS.
- Accesibilidad WCAG 2.2 AA: label asociado, error en texto (no solo color), foco visible, 24×24 mínimo, semáforo con texto además de color.
- Comentarios y textos de pantalla en español. Commits en español, sin atribución a IA.

---

### Task 1: Esqueleto del paquete y los gates que deniegan por defecto

**Files:**
- Create: `composer.json`, `src/ArcopPanelServiceProvider.php`, `src/Permisos.php`, `config/arcop-panel.php`, `routes/arcop.php`, `tests/TestCase.php`, `tests/Pest.php`, `phpunit.xml`
- Test: `tests/AutorizacionTest.php`

**Interfaces:**
- Produces: `Muni\Arcop\Permisos::VER` (`'arcop.ver'`), `::RECIBIR` (`'arcop.recibir'`), `::RESOLVER` (`'arcop.resolver'`); rutas nombradas `arcop.solicitudes.index|recibir|store|show|tomar|resolver|rectificar|suprimir|expediente`; config `arcop-panel.prefijo` (default `privacidad`), `arcop-panel.middleware` (default `['web']`), `arcop-panel.layout` (default `arcop-panel::layouts.app`), `arcop-panel.buscador.minimo_caracteres` (3), `arcop-panel.buscador.maximo_resultados` (20), `arcop-panel.buscador.throttle` (`'20,1'`).

- [ ] **Step 1: Write the failing test** — un usuario sin gates mapeados recibe 403 en las tres puertas, y sin sesión lo manda el middleware del adoptante.
- [ ] **Step 2: Run** `vendor/bin/pest tests/AutorizacionTest.php` — FAIL (no existe el provider).
- [ ] **Step 3:** composer.json, provider (registra config, rutas, vistas, gates por defecto en `false`), rutas.
- [ ] **Step 4: Run** el mismo test — PASS.
- [ ] **Step 5: Commit** `feat: el esqueleto del panel, con los tres permisos denegando por defecto`.

### Task 2: La bandeja

**Files:** `src/Http/Controllers/SolicitudesController.php`, `resources/views/solicitudes/index.blade.php`, `resources/views/layouts/app.blade.php`, `src/Vista/Semaforo.php`; Test: `tests/BandejaTest.php`

**Interfaces:** `Semaforo::clase(EstadoDePlazo): string` — la ÚNICA traducción de estado a CSS del paquete. El texto sale de `EstadoDePlazo::etiqueta()`.

Cubre: solo las solicitudes del sistema configurado (`privacidad.sistema`), filtros por estado/tipo/plazo, el semáforo con texto además de color, y que un caso anonimizado se lista como «Caso anonimizado».

### Task 3: Recepción, paso 1 — buscar al titular

**Files:** `src/Http/Controllers/RecepcionController.php`, `resources/views/solicitudes/buscar.blade.php`; Test: `tests/BuscadorTest.php`

Lo que se verifica, que es lo que importa acá: mínimo de caracteres (por debajo, no consulta), tope de resultados, throttle por usuario, y que **cada búsqueda queda en la bitácora**. Es la superficie por donde se enumera el padrón.

### Task 4: Recepción, paso 2 — el formulario y el registro

**Files:** `RecepcionController@formulario`, `@store`, `resources/views/solicitudes/recibir.blade.php`; Test: `tests/RecepcionTest.php`

Va por `Solicitudes::registrar()`. La acreditación de representación se exige según `Solicitante::exigeAcreditarRepresentacion()`. Un `SolicitudRechazada` del módulo se muestra **con su mensaje tal cual**: ese texto es lo que se le responde al titular.

### Task 5: El expediente en pantalla

**Files:** `SolicitudesController@show`, `resources/views/solicitudes/show.blade.php`; Test: `tests/ExpedienteEnPantallaTest.php`

Muestra la solicitud, su bitácora y las acciones que correspondan según el gate y el estado. Sin carga perezosa: `loadMissing()` y `with()`, con un test que fije `Model::preventLazyLoading()` a mano.

### Task 6: Tomar, resolver, rectificar y suprimir

**Files:** `src/Http/Controllers/AccionesController.php`, `resources/views/solicitudes/{resolver,rectificar,suprimir}.blade.php`; Test: `tests/AccionesTest.php`

- Tomar: POST, `Solicitudes::tomar()`.
- Resolver: las opciones salen de `ResultadosDisponibles::para()` y la nota de `::nota()`; el aviso de `SeparacionDeFunciones::advertencia($solicitud, auth()->id())` se muestra en la página.
- Rectificar: un campo por `camposRectificables()` del titular, precargado; solo se mandan los que cambiaron; va por `Rectificaciones::aplicar()`.
- Suprimir: la página muestra `PreviaDeSupresion::antesDeSuprimir()` ANTES del botón; va por `Supresiones::aplicar()`; el desenlace se cuenta con `ResumenDeSupresion`.
- Un GET nunca cambia un estado: el test lo comprueba pidiendo cada acción por GET y verificando que la solicitud no se movió.

### Task 7: La descarga del expediente

**Files:** `src/Http/Controllers/ExpedienteController.php`; Test: `tests/DescargaTest.php`

Por stream, nunca escrito en `public/`, y **registrado en la bitácora**: es la prueba de que el municipio atendió al vecino.

### Task 8: CSS, accesibilidad y publicación

**Files:** `resources/css/arcop-panel.css`, tags `arcop-panel-views`, `arcop-panel-css`, `arcop-panel-config`; Test: `tests/PublicacionTest.php`

Tokens `--muni-*` con valores propios por defecto, modo oscuro por `prefers-color-scheme` y por `.dark`/`data-muni-theme`, foco visible, 24×24 mínimo.

### Task 9: README y tag v0.1.0

Qué instala, qué tiene que implementar el adoptante (`TitularDeDatos`, `BuscaTitulares`, los tres gates, el candado de cese), y **qué NO hace el paquete**: decidir qué cesa.

## Self-Review

El spec pide diez rutas: index (T2), recibir paso 1 y 2 (T3, T4), store (T4), show (T5), tomar/resolver/rectificar/suprimir (T6) y expediente (T7). Seguridad: gates que deniegan (T1), throttle y bitácora del buscador (T3), IDOR por alcance del sistema (T2 y T5), expediente por stream registrado (T7), lazy loading (T5). Accesibilidad y publicación (T8).
