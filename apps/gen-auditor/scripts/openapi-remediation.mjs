// Añade al openapi.json las rutas del ciclo de remediación y del inventario.
// Se ejecuta una vez y es idempotente: si la ruta ya existe, no la duplica.
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../openapi.json', import.meta.url);
const spec = JSON.parse(readFileSync(file, 'utf8'));

const ERR = ref => ({ 'application/json': { schema: { $ref: ref } } });
const errorSchema = { $ref: '#/components/schemas/Error' };
const responses = (extra = {}) => ({
  200: { description: 'Success. See endpoint description for result fields.',
    content: { 'application/json': { schema: { type: 'object array' } } } },
  401: { description: 'Invalid or missing access token', content: ERR(errorSchema) },
  403: { description: 'Membership/MFA/role forbidden', content: ERR(errorSchema) },
  404: { description: 'Resource not found', content: ERR(errorSchema) },
  409: { description: 'Conflict, missing authority or blocked capability', content: ERR(errorSchema) },
  422: { description: 'Invalid input', content: ERR(errorSchema) },
  429: { description: 'Rate limit', content: ERR(errorSchema) },
  500: { description: 'Internal failure', content: ERR(errorSchema) },
  ...extra,
});

const tenant = { in: 'header', name: 'X-Tenant-ID', required: true, schema: { type: 'string', format: 'uuid' } };
const id = { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } };
const planId = { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } };
const body = props => ({ required: true, content: { 'application/json': { schema: { type: 'object', properties: props, additionalProperties: false } } } });

const s = (t, extra = {}) => ({ type: t, ...extra });
const uuid = s('string', { format: 'uuid' });
const int13 = s('integer', { minimum: 1, maximum: 3 });
const text = (min, max) => s('string', { minLength: min, maxLength: max });

const additions = {
  '/assets': {
    get: { summary: 'Inventario de activos con exposición y hallazgos abiertos',
      description: 'Cada activo expone criticidad, CIA, entorno, exposición y el número de hallazgos abiertos. La criticidad es una decisión registrada, no un valor derivado.',
      parameters: [tenant], responses: responses() },
    post: { summary: 'Registra un activo crítico',
      description: 'Un activo con inventory_source=discovered y criticidad=critical exige criticality_justification. Añadir un activo NO habilita escanear: hereda la verificación y la autorización de su dominio.',
      parameters: [tenant],
      requestBody: body({
        client_id: uuid, name: text(2, 160),
        kind: { type: 'string', enum: ['web_app','api','host','network_segment','database','cloud_resource','saas','mobile_app','ci_cd','repository','other'] },
        criticality: { type: 'string', enum: ['critical','high','medium','low'] },
        confidentiality: int13, integrity: int13, availability: int13,
        data_class: { type: 'string', enum: ['public','internal','confidential','restricted_personal','restricted_secret'] },
        exposure: { type: 'string', enum: ['internet','vpn','internal','isolated'] },
        environment: { type: 'string', enum: ['production','staging','development','sandbox'] },
        inventory_source: { type: 'string', enum: ['manual','imported','discovered','attested'] },
        owner_ref: text(0, 120), criticality_justification: text(0, 2000), notes: text(0, 2000),
      }),
      responses: responses() },
  },
  '/assets/{id}': {
    get: { summary: 'Detalle de un activo con sus hallazgos',
      description: 'Incluye scannable, que sólo es true si el activo tiene un dominio verificado con autorización vigente.',
      parameters: [tenant, id], responses: responses() },
  },
  '/assets/{id}/endpoints': {
    post: { summary: 'Enlaza el activo con un dominio verificado',
      description: 'Enlazar no abre una vía de escaneo: el activo hereda la autorización del dominio.',
      parameters: [tenant, id],
      requestBody: body({ domain_id: uuid, path_prefix: text(0, 200) }), responses: responses() },
  },
  '/assets/{id}/retire': {
    post: { summary: 'Retira el activo del alcance',
      description: 'Un activo retirado deja de ser escaneable. Los hallazgos abiertos NO se cierran solos.',
      parameters: [tenant, id],
      requestBody: body({ reason: text(10, 2000) }), responses: responses() },
  },
  '/remediation/backlog': {
    get: { summary: 'Tablero de remediación y resumen de SLA',
      description: 'El SLA es interno de Gen-Auditor: NO es un plazo normativo ni un plazo de reporte de incidentes. due_at se calcula sobre first_detected_at y no se reinicia en un re-escaneo.',
      parameters: [tenant], responses: responses() },
  },
  '/findings/{id}/plan': {
    post: { summary: 'Crea un plan de remediación',
      description: 'El fragmento de código es una propuesta técnica del auditor: no es un parche aplicado ni garantiza el cierre. El plan hereda el SLA del hallazgo.',
      parameters: [tenant, id],
      requestBody: body({
        summary: text(10, 400), technical_approach: text(0, 4000), code_example: text(0, 20000),
        change_ticket_ref: text(0, 120), owner_id: uuid,
        steps: { type: 'array', maxItems: 60, items: { type: 'object', properties: { description: text(3, 600) }, required: ['description'], additionalProperties: false } },
      }),
      responses: responses() },
  },
  '/findings/{id}/advance': {
    post: { summary: 'Transición no terminal del hallazgo',
      description: 'NO existe ninguna acción de cierre aquí. Un hallazgo sólo se cierra con verificación posterior revisada por otra persona.',
      parameters: [tenant, id],
      requestBody: body({ action: { type: 'string', enum: ['start','accept','false_positive'] }, reason: text(0, 2000) }),
      responses: responses() },
  },
  '/findings/{id}/accept-risk': {
    post: { summary: 'Acepta el riesgo con justificación y fecha de revisión',
      description: 'El aprobador debe ser distinto del solicitante. Sin fecha de revisión el hallazgo quedaría silenciado.',
      parameters: [tenant, id],
      requestBody: body({ justification: text(20, 4000), compensating_controls: text(0, 2000), review_due_at: s('string', { format: 'date-time' }), requested_by: uuid }),
      responses: responses() },
  },
  '/findings/{id}/verifications': {
    get: { summary: 'Historial de verificaciones posteriores de un hallazgo',
      parameters: [tenant, id], responses: responses() },
  },
  '/plans/{id}': {
    patch: { summary: 'Aprueba, arranca, pausa o reanuda un plan',
      description: 'Pausar exige motivo escrito y aprobador. Se pausa el reloj, no el riesgo: el hallazgo sigue abierto.',
      parameters: [tenant, planId],
      requestBody: body({ action: { type: 'string', enum: ['approve','start','pause','resume'] }, reason: text(10, 2000), approved_by: uuid }),
      responses: responses() },
  },
  '/plans/{id}/submit': {
    post: { summary: 'Entrega la remediación para verificación',
      description: 'Requiere todos los pasos completados. Tras la entrega, quien entregó NO puede certificar el cierre.',
      parameters: [tenant, planId], responses: responses() },
  },
  '/plans/{id}/verify': {
    post: { summary: 'Verificación posterior: cierre o reapertura',
      description: 'clean cierra el hallazgo. still_present e inconclusive reabren con el motivo registrado: una verificación inconclusa no es un cierre silencioso. 409 separation_of_duties si quien entrega intenta verificar su propio trabajo.',
      parameters: [tenant, planId],
      requestBody: body({
        outcome: { type: 'string', enum: ['clean','still_present','inconclusive'] },
        notes: text(0, 4000),
        method: { type: 'string', enum: ['rescan','manual_review','config_diff','external_attestation'] },
        evidence: { type: 'object' }, scan_id: uuid,
      }),
      responses: responses() },
  },
  '/audit/anchor': {
    post: { summary: 'Ancla la cabeza de la bitácora fuera de la base',
      description: 'Sin anclaje externo, el propietario de la base puede reescribir la cadena completa y recalcular todos los hashes.',
      parameters: [tenant],
      requestBody: body({ anchor_receipt: text(16, 4000), store_ref: text(3, 400), key_id: text(0, 120) }),
      responses: responses() },
  },
  '/compliance/snapshot': {
    post: { summary: 'Congela el porcentaje de cumplimiento de un marco',
      description: 'Sin catálogo declarado, measured=false y percent=null: se informa «sin medición», nunca 100 %.',
      parameters: [tenant],
      requestBody: body({ framework: text(2, 160), version: text(2, 160) }), responses: responses() },
  },
};

// /reports ya existe con POST: se le añade el listado.
if (spec.paths['/reports'] && !spec.paths['/reports'].get) {
  spec.paths['/reports'].get = {
    summary: 'Lista de informes firmados del tenant',
    description: 'report_code (GA-SE-XXXXXXXX) es un identificador humano. La prueba criptográfica es el manifiesto firmado con Ed25519, no el código. No es firma electrónica avanzada acreditada.',
    parameters: [tenant], responses: responses(),
  };
}

let added = 0;
for (const [path, item] of Object.entries(additions)) {
  const existing = spec.paths[path] || {};
  let changed = false;
  for (const [method, op] of Object.entries(item)) {
    if (!existing[method]) { existing[method] = op; changed = true; }
  }
  if (changed) { spec.paths[path] = existing; added++; }
}

spec.info.version = '0.2.0';
spec.info.description = `${spec.info.description} Inventario de activos, ciclo de remediación con verificación posterior, receptor del puente ARCOP y anclaje externo de la bitácora.`;

writeFileSync(file, JSON.stringify(spec, null, 2) + '\n', 'utf8');
console.log(`rutas documentadas: ${Object.keys(spec.paths).length} · nuevas o completadas: ${added}`);