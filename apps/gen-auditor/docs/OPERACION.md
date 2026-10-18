# Operación, despliegue y aceptación

## Preparación

1. Usar bases/proyectos de ensayo separados para ARCOP y Gen-Auditor; mantener fuera del esquema público expuesto las tablas privadas.
2. Crear usuarios del proveedor de identidad y anotar sus subject IDs; no aceptar roles de un formulario de alta.
3. Ejecutar los SQL de cada producto como propietario de migración. No se integran en las migraciones Composer ni se ejecutan al arrancar el contenedor.
4. Establecer contraseña aleatoria de los roles runtime fuera del repo, por ejemplo con `\password gen_auditor_api` o `\password arcop_api` en psql administrativo. Nunca usar postgres/service_role en el API.
5. Provisionar tenant y membresías con SQL parametrizado/administración controlada. Gen referencia auth.users de Supabase; ARCOP admite subject OIDC de texto sin tabla de usuarios propia.
6. Ejecutar inicializadores para generar secretos nuevos por producto. Instalar CA del proyecto y ajustar URL/issuer/audience. No compartir claves PII/HMAC entre productos o ambientes.
7. Verificar conectividad al endpoint directo PostgreSQL, incluida IPv6 si corresponde; no sustituir por pooler transaccional sin ensayar set_config local, locks y migraciones.
8. Configurar firma asimétrica Supabase; la implementación no acepta JWT HS256 heredado mediante JWKS. MFA requiere factor TOTP previamente inscrito; la UI no implementa todavía incorporación de factores.

## Docker/Coolify

Cada producto se construye desde su propia carpeta con su Dockerfile y Compose. Configurar servicio Gen-Auditor en puerto interno 3000 y ARCOP en 3001, dominios HTTPS independientes. No publicar DB, no Docker socket, no volúmenes de otros proyectos. Los ejemplos no publican puertos de host: Coolify debe añadir su proxy/red de servicio.

El código corre como usuario node (1000). Las carpetas secrets creadas con modo 0700 y claves privadas 0600 pueden necesitar ajuste de propietario/ACL para ser legibles por ese UID dentro del contenedor; hacer ese ajuste de forma deliberada en el servidor, sin abrir permisos globales. Verificar el arranque con el usuario efectivo antes de entregar. CA pública puede ser 0644; secretos nunca 0644 por comodidad.

Se fija la imagen Node por digest. Se dispone de lockfiles npm. No se construyeron imágenes ni se ejecutó Docker en este entorno; comprobar la imagen para la arquitectura, npm audit, usuario, archivos read-only, CA y healthchecks reales. Los healthchecks prueban proceso HTTP, no certifican acceso a todos los proveedores ni toda la lógica del negocio.

## Worker activo opcional

No se incluye en Compose por defecto. Antes de habilitarlo:

- Revisar autorización del cliente: propietario, activos/IP, herramientas, ventanas, terceros/CDN, prohibiciones y contactos. DNS TXT por sí solo no autoriza pruebas contra infraestructura compartida.
- Crear rol `gen_auditor_scanner` usando SQL 003 y una identidad técnica miembro security de un solo tenant. Sin acceso a PII o claves de firma.
- Instalar Nmap /usr/bin/nmap en un contenedor aislado del operador; revisar licencia y versión. No se distribuye un binario con este repo.
- Dar al worker DATABASE_URL con su rol, CA y SCANNER_TENANT_ID/SCANNER_ACTOR_ID. ACTIVE_SCANNER_ENABLED=true es una habilitación explícita del operador.
- Limitar egress con firewall/política del entorno a DNS autorizado, DB y destinos/puertos aprobados. No usar red internal si impide llegar a Supabase. No otorgar NET_RAW, privilegios, host network ni Docker socket.
- Registrar autorización mediante POST /api/v1/scan-authorizations. Configurar ACTIVE_SCANNER_ENABLED=true en API solo después de comprobar el worker. Encolar con authorization_id; queued no significa completado.
- Ejecutar `node server/active-worker.js`. Revalida DNS/IP/ventana. Soporta TCP connect 80/443 exclusivamente, no CVE, NSE ni pentesting integral.
- Si el worker muere con job running, revisar el alcance y estado antes de reintentar; no hay lease/reanudación automática. No se implementó kill switch de jobs en curso; completar antes de ampliar herramientas/producción.

## Backups y recuperación

Respaldar por separado cada esquema, roles/provisionamiento, configuración de identidad, repositorio documental si se añade y secretos. Supabase backup/PITR de BD no reemplaza la copia segura de PII_KEY, SUBJECT_HMAC_KEY y clave Ed25519. Sin la clave PII no se puede recuperar los campos cifrados; cambiar HMAC sin migración rompe la correlación de titulares.

Usar pg_dump consistente y un plan para archivos/evidencia/colas; cifrar fuera del VPS, acceso separado y retención revisada. Los scripts completos de backup/restore automatizados son pendientes en esta aplicación nueva. Ensayar restauración sobre destino vacío, versionado compatible y sin envíos/escaneos salientes. No restaurar sobre tablas ocupadas ni degradar el código sobre un esquema migrado sin plan de reversión.

Rotación: guardar versión/key_id de claves, conservar claves históricas necesarias bajo control, recifrar por lotes y verificar antes de retirar. El cifrado actual usa formato v1 y una clave activa; el registro de claves y rotación automatizada son pendientes.

## Aceptación mínima

- Tests npm de ambos productos y build React correctos; pruebas Composer/Pest/PHPStan/Pint originales en entorno PHP compatible.
- Migraciones en PostgreSQL/Supabase real; RLS/roles con credenciales runtime, cross-tenant denegado, sin permisos administrativos.
- Login/MFA, expiración, refresco y baja de membresía; no secretos en frontend, errores o logs.
- Consentimiento registra contexto correcto; no atribuir IP del operador al titular. Retiro no se presenta como cese externo ejecutado.
- ARCOP iframe con origen permitido funciona; otro origen, token falso, tenant ajeno y mismo receptor/resolutor se rechazan. El adaptador ejecuta y acredita efectos reales antes de cerrar.
- DNS real, TLS inválido, redirects, destinos privados, IPv6, cambios de IP y caducidad de autorización. Nmap solo con autorización específica de aceptación; ningún escaneo contra terceros por esta entrega.
- Alteración/truncamiento de logs detectados y anclaje externo ensayado antes de afirmar mayor inmutabilidad.
- PDF/verificador con clave pública de confianza; alteraciones rechazadas. Clave ausente devuelve error, no firma simulada.
- Interfaz desktop/móvil, formularios, teclado/foco, contraste, estados de error/vacío, paginación y carga. Las pruebas visuales incluidas no sustituyen auditoría WCAG.
- Restauración completa documentada y ensayada; monitoreo/alertas sobre errores, colas y vencimientos.

No marcar producción aceptada hasta cerrar estos puntos y los conectores que formen parte del contrato comercial.

## Verificación de un reporte exportado

`node scripts/verify-report.mjs informe.pdf manifiesto.json clave-publica-confiable.pem`

La clave debe obtenerse por canal confiable, no solo de un manifiesto entregado junto al PDF. Conservar también el identificador de clave y registro de rotación.
