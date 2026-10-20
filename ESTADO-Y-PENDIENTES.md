# Entrega de avance · ARCOP Open y Gen-Auditor

Fecha: 16 de octubre de 2026. **Entrega de desarrollo ampliada, no suite completa aceptada para producción.**

## Cierre del ciclo de remediación y del puente entre productos

Se implementó y se **probó contra PostgreSQL real** (PGlite en los tests, 41 pruebas en verde) lo que faltaba:

### El hueco de mayor riesgo, cerrado
`PATCH /findings/{id}` permitía `status: resolved` sin re-escaneo: un hallazgo se cerraba con un clic. Hoy **no existe ese camino**. El cierre exige una verificación posterior revisada por una persona distinta de quien ejecutó la corrección, y la garantía vive en la base, no en la interfaz:

- `REVOKE UPDATE ON gen_auditor.vulnerabilities` al rol de aplicación; `status` no es escribible.
- `close_finding()` / `reopen_finding()` / `advance_finding()` / `mark_awaiting_verification()`: `SECURITY DEFINER`, validan plan entregado, verificación limpia, revisor distinto y evidencia posterior a la entrega.
- `CHECK (status <> 'closed' OR closed_by_verification IS NOT NULL)`: ni el propietario puede marcar cerrado sin señalar una verificación.
- Una verificación `inconclusive` **reabre** y registra el motivo. A los tres intentos fallidos se emite `remediation.escalation_required`.
- El endpoint `PATCH /findings/:id` se eliminó; lo reemplaza `/remediation/backlog`, `/findings/:id/plan`, `/plans/:id/{submit,verify}`.

### Inventario, remediación y verificación
`004_assets_remediation.sql`: `assets` con criticidad explícita y justificada, `remediation_plans`, `remediation_steps`, `verification_runs`, `risk_acceptances`, `evidence_objects`, `audit_anchors`, `compliance_snapshots`, catálogo normativo versionado y las vistas `v_asset_exposure` / `v_finding_backlog`.

**Huella estable** `fingerprint = sha256(asset_id|rule_key|ubicación)`, sin severidad ni `scan_id`: un re-escaneo actualiza el hallazgo en vez de crear otro que nadie cierra. Índice único parcial sobre hallazgos activos.

### Puente entre productos, por fin automático
Outbox transaccional en ARCOP alimentado por un **trigger sobre `evidence_events`**: es imposible cambiar el estado sin emitir el evento. Receptor idempotente en Gen-Auditor con deduplicación por `event_hash`, anti-replay por secuencia monótona, cuarentena de tenants desconocidos y firma Ed25519 verificada en Node antes de parsear.

### ARCOP: consentimientos
`packages/arcop-open`: registro de consentimiento sellado (SHA-256 del texto **publicado por ARCOP**, nunca del enviado por el cliente), `capture_method` que distingue la evidencia medida de la declarada, retirar/restringir que nunca reescribe el grant, bloqueo/supresión/anonimización con comprobante obligatorio, perfiles legales versionados y cadena de evidencia unificada con `append_evidence`/`verify_evidence_chain`.

### Qué sigue pendiente
- El **worker de escaneo** sigue siendo Nmap TCP 80/443 acotado. No es pentesting completo.
- Bloqueo/supresión/anonimización en ARCOP están en esquema y funciones; **sin endpoints HTTP todavía**.
- El anclaje externo existe como tabla y función; falta la firma real con KMS/HSM y el almacén WORM.
- Falta el adaptador de ejecución por sistema anfitrión.
- El `evidence_events` de `entity_type='request'` arranca vacío en instalaciones nuevas; el histórico sigue verificable con `verify_chain`.
- Sin despliegue, sin Supabase configurado, sin usuarios reales. Los tests de BD corren sobre PGlite, no sobre una instancia Supabase real.

## Son dos productos separados

- `packages/arcop-open/`: componente open source MIT con servicio HTTP, panel embebible, contrato de integración independiente del lenguaje y flujo ARCOP. No necesita PHP ni el paquete municipal para ejecutarse.
- `apps/gen-auditor/`: aplicación de gobernanza y ciberseguridad con React/Tailwind, API Node y esquema PostgreSQL/Supabase. Supervisa privacidad y seguridad; no reemplaza el paquete ARCOP.
- El paquete Composer histórico en la raíz conserva su funcionamiento y licencia. `laravel-muni-shared` figura como proprietary y no se ha relicenciado ni copiado dentro de los productos nuevos.

## Implementado en el código

### Gen-Auditor
- Interfaz responsive con sidebar, dashboard, privacidad, clientes/dominios, **inventario de activos, tablero de remediación en cuatro estados y reportes verificables**, hallazgos, bitácora e integración ARCOP; demostración expresamente ficticia.
- Autenticación JWT asimétrica con JWKS Supabase; comprobación MFA configurable, RBAC y contexto de tenant por transacción.
- SQL de tenants, miembros, clientes, dominios, consentimientos, solicitudes proyectadas, evaluaciones, incidentes, riesgos, controles, escaneos, hallazgos, auditoría e informes.
- RLS, relaciones compuestas por tenant, bitácora de solo anexado para rol runtime y cadena SHA-256 con verificación.
- Cifrado AES-GCM de identidad/IP/user agent y referencia HMAC del titular.
- Verificación DNS TXT y comprobación HTTPS acotada con protección SSRF, DNS fijado y sin redirecciones.
- Autorizaciones de escaneo y worker opcional Nmap de alcance TCP 80/443, bloqueado por defecto. No se ejecutaron escaneos externos ni se desplegó el worker.
- PDF ejecutivo y manifiesto con firma técnica Ed25519; no firma electrónica avanzada acreditada.
- Separación de plazos legales de incidentes y SLA internos; controles de evidencia, revisión y métricas sin inventar cumplimiento.

### ARCOP Open
- Servicio independiente con emisor OIDC/JWKS configurable, RLS y roles recepción/resolución/auditoría.
- Recepción con Idempotency-Key y cifrado de datos personales.
- Transiciones para verificar identidad, aprobar/rechazar y acreditar ejecución externa, con separación entre receptor y resolutor.
- Resoluciones bloqueadas hasta revisar y habilitar el perfil legal correspondiente.
- Evidencia encadenada por expediente; hashes de documentos, sin rutas de borrado controladas por el cliente.
- Panel HTML/CSS/JS embebible; credenciales solo en memoria mediante postMessage desde origen configurado. No tokens en URL/localStorage.
- Cliente JavaScript HTTP y helper de integración iframe. El mismo contrato se consume desde otros lenguajes.

## Validación realizada y límites

- Compilación React/Vite inicial correcta; sintaxis y primeras pruebas de servicios.
- **41 pruebas automáticas en verde**: 29 en Gen-Auditor (api, arcop-integration, database, bridge, remediation, remediation-api, security) y 12 en ARCOP (workflow, consents). Corren contra **PGlite**, que sí aplica RLS, GRANT y REVOKE. Ver VALIDACION.md para la ejecución final.
- Comprobar las pruebas y build con los comandos incluidos antes de aceptar esta copia en tu entorno.
- No se ejecutaron las pruebas PHP/Composer: este entorno no dispone de PHP.
- No hay despliegue real, proyecto Supabase configurado, usuarios, CA, SMTP, secretos reales ni pruebas contra sistemas externos.
- Comprobaciones de navegador sobre la versión actual: dashboard, Activos (tabla, filtros y modal de detalle), tablero de Remediación y Reportes; activación por teclado del detalle de activo y ausencia de trampas de foco; sin overflow horizontal entre ~485 y 1280 px. ARCOP embebido entre dos orígenes, recepción autenticada y ausencia de localStorage. No sustituyen una auditoría de accesibilidad completa ni la aceptación real de OIDC/Supabase.

## Qué completar, en orden

1. Ejecutar de nuevo `cd apps/gen-auditor && npm ci && npm test && npm run build` y `cd packages/arcop-open && npm ci && npm test`.
2. Probar ARCOP end-to-end contra PostgreSQL: roles, RLS, idempotencia, transiciones, firma/hashes de evidencia y separación de personas. Completar los tests de integración del panel embebido y rechazo de orígenes.
3. Validar visualmente desktop/móvil, navegación por teclado, formularios, gestión del foco, errores y estados vacíos. Revisar CSP, autenticación, renovación y cierre de sesión.
4. OpenAPI y ejemplos Python/PHP/cURL/JavaScript incluidos. Validar ejemplos en cada entorno y ampliar contratos cuando se añadan funciones. No se ha publicado en npm ni Packagist.
5. Documentación de arquitectura, amenazas y operación incluida. Completar políticas legales versionadas, automatización de backups y recuperación ensayada.
6. Dockerfile/Compose incluidos, no ejecutados aquí. Construir y probar imágenes, generar secretos, instalar CA y crear roles mínimos. Nunca usar postgres/service_role ni versionar secretos.
7. Crear usuarios del proveedor OIDC y membresías por administración controlada. Verificar MFA e incorporación. El panel no crea tenants ni roles automáticamente desde el navegador.
8. Revisar perfiles legales con responsable competente: aplicabilidad Ley 21.663, Ley 19.628 y transición Ley 21.719 (vigente desde 01-12-2026), plazos y conservación. No tratar 48 h ni 12 meses como obligaciones universales.
9. Implementar y aceptar el adaptador de ejecución ARCOP en cada sistema anfitrión: acceso, rectificación, bloqueo/supresión, oposición y portabilidad. Un estado en el panel no cambia por sí solo datos o tratamientos externos.
10. Conectar Gen-Auditor con ARCOP: el conector **ya está implementado** (`sql/006a`/`006b`: outbox por trigger, firma Ed25519, deduplicación y anti-replay). Falta ejercitarlo con **ambos productos desplegados a la vez**; hoy el recorrido se valida con fixtures, no con dos procesos reales. La recepción en Gen-Auditor sigue bloqueada: corresponde al producto independiente.
11. Para escaneo activo: crear identidad y rol de worker, instalar Nmap en contenedor aislado, validar licencias de herramientas, egress y ventana de autorización. Ejecutar solo en alcance expresamente autorizado. Nmap TCP 80/443 es inventario acotado, no pentesting completo.
12. Inventario de activos y remediación con verificación posterior: **implementados** (`004`). Siguen **sin** implementación la importación/normalización de Nuclei, ZAP, SARIF y Trivy, el SBOM, IAM/cloud y las campañas de pentesting. No anunciar cobertura automática completa.
13. Persistir evidencia documental en repositorio privado con retención/holds; completar anclajes externos de auditoría y recuperación ensayada. El propietario de una BD puede reescribir la infraestructura: una cadena de hashes local no es inmutabilidad absoluta.
14. Integrar reportes oficiales solo mediante canales autorizados; actualmente se registran evidencias de reportes, no se envían incidentes a ANCI.
15. Ejecutar auditoría de dependencias, pruebas de carga, análisis de seguridad, SQL en Supabase real y recuperación completa antes de producción.
16. Revisar la rama/PR de desarrollo y aceptar pruebas antes de fusionar. No se despliega ni fusiona automáticamente. Consultar el enlace de entrega para el estado de publicación.

## Arranque del desarrollo

Gen-Auditor: `npm ci`, `npm run dev` para interfaz. La demostración está en `http://127.0.0.1:5173/?demo=1`. No necesita backend para mostrar datos ficticios; las operaciones reales sí requieren configuración de API/BD.

ARCOP: `npm ci`, `node init.mjs`, completar .env, ejecutar SQL/schema.sql como administrador en una base de ensayo y provisionar miembros; `npm start` inicia servicio y panel. En Docker las variables van por entorno y el comando deberá ejecutar directamente `node src/server.js`.

Cada producto tiene .env.example; no se incluyen credenciales reales. No apuntar las migraciones a bases productivas sin backup y revisión.
