# Gen-Auditor · Gobernanza y ciberseguridad

Aplicación independiente del paquete ARCOP: React/Tailwind, API Node, PostgreSQL con RLS y autenticación Supabase. Código nuevo bajo MIT; no modifica la licencia del paquete Composer histórico.

**Estado: implementación inicial verificable, no suite completa aceptada para producción.** Ver [arquitectura y cobertura](docs/ARQUITECTURA.md), [seguridad](docs/SEGURIDAD.md), [operación](docs/OPERACION.md) y el [estado general](../../ESTADO-Y-PENDIENTES.md).

## Desarrollo

Node 22.12+ (se comprobó con 24.19):

```sh
npm ci
npm test
npm run build
npm run dev
```

Interfaz: `http://127.0.0.1:5173/?demo=1`. La demostración usa fixtures explícitos, no ejecuta escaneos ni genera firmas falsas. Para API real, ejecutar `node scripts/init.mjs`, editar .env, instalar CA y revisar los SQL como administrador. En desarrollo local ajustar las rutas de CA/clave del .env a archivos existentes y APP_ORIGIN al origen del frontend. `npm run api` inicia la API; Vite redirige /api al puerto 3000.

## Qué funciona en el código

- Clientes/dominios y desafío DNS, chequeo HTTPS acotado, hallazgos y tratamiento.
- Consentimientos cifrados, retiro registrado, EIPD en borrador y planes de anonimización propuestos.
- Riesgos, controles con revisión independiente, incidentes con registro manual de etapas.
- Auditoría encadenada/verificación; PDF + manifiesto Ed25519.
- Worker opcional Nmap TCP 80/443 sujeto a autorización y alcance. Desactivado por defecto.
- Buzón ARCOP de **supervisión**: no recibe ni resuelve solicitudes. El servicio separado es [ARCOP Open](../../packages/arcop-open/README.md). La sincronización entre ambos es pendiente.

## Qué no debe anunciarse como terminado

Pentesting integral, conectores Nuclei/ZAP/SARIF/Trivy/SIEM/cloud, SBOM, envío automático ANCI, sincronización ARCOP, ejecución de anonimización/supresión externa, firma avanzada acreditada, anclaje WORM y recuperación de producción. La especificación define estas extensiones y sus criterios de aceptación.

## Esquema/API

SQL en `sql/`, servicio en `server/`, UI en `web/`, pruebas en `tests/`. `sql/002_runtime_role.sql` crea el rol `gen_auditor_api` sin privilegios administrativos; contraseña fuera del repo. Ejecutar las migraciones exclusivamente en una base de ensayo respaldada. No hay migración automática sobre los datos ARCOP existentes.

### Orden de aplicación del SQL

| Orden | Archivo | Qué añade | Base |
| --- | --- | --- | --- |
| 1 | `001_gen_auditor.sql` | esquema base, RLS, bitácora encadenada | Gen-Auditor |
| 2 | `002_runtime_role.sql` | rol `gen_auditor_api` | Gen-Auditor |
| 3 | `003_scanner_role.sql` | rol del worker de escaneo | Gen-Auditor |
| 4 | `004_assets_remediation.sql` | inventario, remediación, verificación, anclaje | Gen-Auditor |
| 5 | `006b_bridge_gen_auditor_side.sql` | receptor de eventos de ARCOP (**al final**: usa `auth.users`) | Gen-Auditor |
| 6 | `schema.sql` | esquema base ARCOP | ARCOP |
| 7 | `002_consents_evidencia.sql` | consentimientos y cadena unificada | ARCOP |
| 8 | `006a_bridge_arcop_side.sql` | outbox con trigger sobre `evidence_events` | ARCOP |

`004` revoca el `UPDATE` de tabla sobre `vulnerabilities` y sólo readmite columnas seguras: `status` **no** es escribible por el rol de aplicación. Toda transición pasa por función `SECURITY DEFINER`, incluida la entrega (`mark_awaiting_verification`). Si añades código que escriba `vulnerabilities.status`, fallará con `permission denied` — es intencional.

`004` y `006b` crean sus vistas con `security_invoker=true`. Sin esa opción, una vista creada por el propietario **evade la RLS** de las tablas subyacentes y mostraría los activos de todos los tenants.

Las dependencias npm están fijadas en package-lock.json. Nunca publicar .env, CA privadas, claves de cifrado o firma. La clave pública de Supabase sí se entrega al navegador; service_role nunca.
