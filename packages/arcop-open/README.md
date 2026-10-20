# ARCOP Open

**Producto independiente, open source MIT.** Servicio HTTP y panel embebible para recibir y tramitar derechos de datos personales. No necesita Gen-Auditor, Laravel ni `laravel-muni-shared`.

Puede integrarse desde cualquier lenguaje mediante JSON/HTTP: [OpenAPI](openapi.json), [cliente JavaScript](sdk/client.mjs), [ejemplos Python/PHP/cURL](docs/INTEGRACION.md). El runtime de referencia es Node + PostgreSQL; agnóstico describe el contrato de integración, no que el mismo código Node se ejecute dentro de PHP o Java.

## Instalación

```sh
npm ci
node init.mjs
```

Completar .env con OIDC/JWKS, audience, claves generadas, CA y DB. Revisar los SQL como administrador sobre una base de ensayo dedicada, **en este orden**:

1. `sql/schema.sql` — esquema base, rol `arcop_api`, cadena de expedientes.
2. `sql/002_consents_evidencia.sql` — consentimientos encadenados, cadena de evidencia unificada, bloqueo/supresión/anonimización, perfiles legales versionados.

El paso 2 es aditivo pero **requiere el 1**. Si lo aplicas sobre una base ya en producción, revisa el bloque de backfill comentado: la migración de eventos existentes va en tres pasos (dual-write → backfill → corte) y `append_event()` queda como envoltorio durante la transición. Ninguna de las dos crea contraseñas versionadas ni requiere `auth.users` ni un proveedor OIDC particular.

```sh
npm test
npm start
```

El panel se sirve desde `/`; `/index.html?demo=1` muestra una fila ficticia, sin operaciones reales. Producción: HTTPS y proxy a puerto interno 3001. Configurar EMBED_ALLOWED_ORIGINS con orígenes HTTPS exactos, sin comodines. Un anfitrión autenticado entrega un access token mediante el handshake documentado; nunca por query string ni localStorage.

## Qué resuelve

- Recepción con identificador idempotente; mismo contenido/misma clave devuelve expediente previo, contenido distinto se rechaza.
- Identidad y descripción cifradas, referencias HMAC y listados mínimos.
- Roles separados de recepción, resolución y auditoría.
- Workflow explícito: pendiente de identidad → revisión → ejecución pendiente → completada, o rechazo fundamentado.
- Registros de eventos append-only, hashes por expediente y verificación de cadena.
- Panel independiente y SDK de referencia, sin acoplar al lenguaje del sistema anfitrión.

## Qué necesita el sistema anfitrión

El componente **no puede borrar, corregir o entregar datos de un sistema que no esté integrado**. Aprobar una solicitud emite un estado de ejecución pendiente, no una supresión realizada. Para completar exige referencia y hash del comprobante del anfitrión. Este debe conservar el documento y ejecutar la operación mediante un adaptador autorizado.

La verificación de identidad es una operación humana/externa acreditada por evidencia; no un verificador biométrico instalado. La decisión requiere persona distinta de quien recibió, rol de resolución, fundamento y perfil legal previamente revisado. LEGAL_POLICY_REVIEWED=false bloquea aprobación/rechazo hasta configurar perfiles concretos en APPROVED_LEGAL_PROFILES. No confundir esa configuración con validación jurídica automática.

No se implementan todavía plazos legales automatizados, notificaciones, subida/almacenamiento de documentos, colector público de solicitudes anónimas, motor de ejecución del anfitrión, webhooks firmados ni sincronización con Gen-Auditor. Ver [integración y pendientes](docs/INTEGRACION.md).

## Licencia y compatibilidad

Solo esta carpeta nueva se ofrece bajo MIT. El paquete Composer histórico de la raíz y la dependencia municipal proprietary conservan sus condiciones. Esta implementación no copia ese núcleo ni pretende relicenciarlo.
