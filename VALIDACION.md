# Validación de la entrega de desarrollo

16 de octubre de 2026 · Node 24.19.0.

## Ejecutado

- `npm run check` en apps/gen-auditor: comprobación de sintaxis, **10 pruebas** y build Vite/React.
- `npm test` en packages/arcop-open: **2 pruebas** de workflow y SDK HTTP.
- SQL aplicado y ejercitado sobre PostgreSQL embebido PGlite (no simulado con objetos JavaScript): RLS, FK por tenant, bloqueos de log, verificación/tamper y API con escrituras reales en la base de prueba.
- Prueba del servicio ARCOP independiente: subject OIDC genérico de texto, idempotencia/rechazo de cambio de contenido, identidad, resolución segregada, comprobante de ejecución y cadena verificable.
- Prueba de API Gen-Auditor: autenticación inválida, rol lector, tenant ajeno, cliente/consentimiento reales en base de prueba, ausencia de identidad en respuesta, ausencia de configuración de firma y bloqueo de recepción ARCOP en el SaaS.
- SSRF/alcance: destinos internos/mapeados y DNS mixto rechazados, plan activo sin shell, verificación/alcance/ventana obligatorios. No se ejecutó Nmap ni se enviaron chequeos a terceros.
- PDFKit + Ed25519: PDF real, manifiesto verificado y rechazo de PDF alterado.
- Chromium/Playwright: dashboard y privacidad desktop, filtro de clientes, navegación móvil y ausencia de overflow/errores JavaScript. Inspección visual del dashboard realizada.
- ARCOP en navegador: frame en origen distinto, handshake de padre permitido, recepción autenticada con datos ficticios y sin persistir token en localStorage; viewport móvil sin overflow de documento.
- Sintaxis JSON de OpenAPI y YAML de Compose; `git diff --check`.
- `npm audit --omit=dev` para Gen-Auditor: **0 vulnerabilidades reportadas por el registro** en esa ejecución. No equivale a ausencia de vulnerabilidades ni a auditoría de infraestructura.

## No ejecutado / no aceptado

- PHP/Composer/Pest/PHPStan/Pint originales: no hay PHP en este entorno. No se modificaron src/config/vistas ni reglas del paquete Laravel histórico.
- Docker, construcción de imágenes, red/CA/TLS PostgreSQL reales, Supabase/OIDC real, MFA del proveedor y proxy Coolify.
- Carga, concurrencia distribuida, pentesting independiente, recuperación real y accesibilidad WCAG completa.
- Ningún escaneo contra clientes/terceros ni envío a ANCI, correo o sistemas productivos.

Las pruebas de autenticación HTTP usan un verificador fixture para ejercitar la aplicación; no se presentan como prueba end-to-end del proveedor OIDC. Los JWT de producción se validan con JOSE/JWKS y necesitan aceptación contra el proveedor real.

Las capacidades pendientes están detalladas en ESTADO-Y-PENDIENTES.md y en los README de ambos productos. La entrega sigue siendo una base de desarrollo revisable.
