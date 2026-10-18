# Seguridad, marco normativo y amenazas

## Aplicabilidad antes de automatización

Fuentes primarias revisadas: [Ley 21.663](https://www.bcn.cl/leychile/navegar?idNorma=1202434), [DS 295](https://www.bcn.cl/leychile/navegar?idNorma=1211466), [Ley 21.719](https://www.bcn.cl/leychile/navegar?idNorma=1209272), [Academia Judicial](https://academiajudicial.cl/recursos/actualizaciones-normativas/ley-21-719-que-regula-la-proteccion-y-el-tratamiento-de-los-datos-personales-y-crea-la-agencia-de-proteccion-de-datos-personales/), [ISO/IEC 27001:2022](https://www.iso.org/standard/27001).

- Incidentes sujetos al deber de reporte: alerta temprana 3 h; actualización 72 h, o 24 h para OIV con servicio esencial afectado; informe final 15 días desde la alerta, con tratamiento específico si continúa en curso. OIV: plan de acción dentro de 7 días desde conocimiento. El sistema exige contexto y no usa 48 h universal.
- La Ley 21.719 entra en vigor el 01-12-2026. Versionar reglas y revisar régimen aplicable. No calcular derechos/plazos nuevos como si estuvieran vigentes antes de esa fecha.
- Retención de 12 meses es configuración inicial pendiente de revisión por finalidad, sector, conservación y legal hold, no obligación universal atribuida al artículo 7.
- SLA interno de remediación: crítico 48 h, alto 7 días, medio 15, bajo 30. No son plazos normativos impuestos por ISO. «Antes de 48 h» requiere alertar antes del vencimiento y medir la precisión operacional; no equivale a «reportar incidentes en 48 h».
- Referencia actual de gestión de vulnerabilidades: ISO 27001:2022 A.8.8; A.12.6.1 corresponde a edición 2013. No reproducir texto licenciado del estándar ni anunciar certificación automática.

Perfiles propuestos deben registrar jurisdicción, versión, fechas de vigencia, fuente, aplicabilidad, responsable revisor y fecha de próxima revisión. Calendarios de días hábiles, suspensión y excepciones deben pertenecer al motor legal validado; no duplicarse en componentes de pantalla.

## Modelo de amenazas

| Amenaza | Control implementado | Límite / aceptación pendiente |
| --- | --- | --- |
| IDOR y cruce de tenant | Membresía en transacción + RLS + claves compuestas | Ensayar conexión real y pooling bajo carga |
| Autoasignación de roles | Sin endpoint de alta de membresía; rol de BD restringido | Procedimiento de altas/bajas y break-glass |
| JWT falso/confusión de algoritmo | JWKS, issuer/audience, ES256/RS256 | Rotación/revocación y ciclo de sesión del proveedor |
| XSS/exfiltración | React/DOM textContent, CSP, sin tokens persistidos | Revisar CSP en proxy y todos los formularios |
| SSRF/rebinding | Dominio normalizado, resolución de todas las IP, bloqueo de rangos no públicos, conexión fijada, sin redirects | Firewall egress independiente y pruebas DNS reales |
| Escaneo fuera de alcance | DNS reciente + autorización documental hash + IP/herramienta/ventana + revalidación worker | El hash no demuestra que el documento autorice legalmente; revisión humana obligatoria |
| Inyección de shell | execFile con ruta y argumentos fijos; shell=false | No aceptar flags ni plantillas libres |
| Modificación de bitácora | Rol sin UPDATE/DELETE/TRUNCATE, triggers y hash encadenado | Owner/superusuario puede reescribir BD: no es inmutabilidad absoluta |
| Filtración de PII | AES-256-GCM, AAD tenant, HMAC del identificador; listados sin PII | Rotación de claves, acceso a evidencia y retención ensayados |
| Falso cumplimiento | Métricas sin medición cuando no hay controles; evidencia/revisión separadas | Catálogo, alcance y revisión experta completos |
| Abuso de recursos | Límites de cuerpo, peticiones, timeouts, workers por tenant | Rate limits en memoria no son defensa distribuida ni facturación |

## Auditoría

Append por función SECURITY DEFINER con search_path fijo, permisos revocados a PUBLIC, actor derivado de contexto autenticado y secuencia serializada mediante lock por tenant. La función guarda el payload canónico exacto; la verificación compara secuencia, hash anterior, contenido y cabeza. Las marcas de tiempo se normalizan a UTC para no depender de TimeZone.

El rol runtime no es propietario. RLS no elimina la confianza depositada en el servidor API: este fija los GUC desde el JWT verificado; un robo de credenciales de BD o compromiso del servidor cambia el modelo de amenaza. No usar esas credenciales desde clientes ni exponer PostgreSQL públicamente para integraciones.

No incluir RUT, IP completa, texto de solicitudes, claves o documentos en metadata de auditoría. Los identificadores pseudónimos todavía pueden ser datos personales. Separar PII eliminable/bloqueable de evidencia mínima que deba conservarse conforme a una base legal evaluada. No eliminar automáticamente todo al recibir una solicitud ni conservar datos indefinidamente por tener un hash.

**Anclajes externos pendientes:** exportar diariamente cabeza y secuencia, firmar con KMS/HSM fuera de BD, guardar en almacenamiento WORM administrado separadamente y registrar recibos. Sin ese anclaje, un administrador podría recalcular una cadena completa. Probar truncamiento de cola y sustitución completa, no solo cambiar una fila.

## Escaneo y pentesting

El chequeo HTTPS hace HEAD al / del dominio verificado, 443 únicamente, TLS validado y timeout de 8 s. Una ausencia de cabecera no se convierte en explotación confirmada. Guardar solo la evidencia necesaria.

El worker activo opcional ejecuta Nmap connect TCP 80/443, sin NSE, scripts, fuerza bruta, explotación, -A o argumentos libres. Fija IP públicas de la autorización, limita salida/tiempo y vuelve a validar antes de ejecutar. No se ejecutó sobre ningún tercero en esta tarea.

Futuros Nuclei/ZAP: imágenes y templates por digest/hash, revisión de licencia y código, allowlist de plantillas, sin code/headless/fuzzing por defecto, egress al alcance aprobado y sin montaje de Docker socket o secretos del API. Una firma de plantilla no sustituye revisión; comprobar cachés y versiones. Separar autenticación de pruebas, manejo de credenciales efímeras, ventana de mantenimiento, kill switch y límites por activo.

Nmap tiene su propia licencia; esta entrega no incluye binarios Nmap ni concede licencia OEM. Revisar términos antes de distribuir un contenedor comercial. El código MIT de la plataforma no relicencia herramientas ni modelos ajenos.

## Firma de reportes

Ed25519 da verificación criptográfica cuando la clave pública es confiable. No implica acreditación como firma electrónica avanzada ni certificación legal del informe. El manifiesto y el PDF deben entregarse juntos, con un verificador y un registro de claves vigentes/revocadas. La clave privada no debe almacenarse en BD ni exponerse al worker de escaneo.
