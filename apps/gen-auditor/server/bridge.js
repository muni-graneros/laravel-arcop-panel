import { verify } from 'node:crypto';

// Receptor de eventos de ARCOP.
//
// El cuerpo se firma con Ed25519. La clave pública del emisor viene de
// ARCOP_BRIDGE_KEYS (JSON: [{source, key(base64), fingerprint}]) y NO de la
// propia base: una llave que se guarda junto al material que verifica no
// aporta nada. La comparación de huella permite detectar una llave rotada.
//
// Reglas que este módulo sostiene y que conviene no relajar:
//   · se verifica la firma ANTES de interpretar el contenido;
//   · nunca se sigue una redirección ni se acepta un destino libre: la URL la
//     fija el emisor, no el mensaje;
//   · el cuerpo va limitedo y el resultado real vive en webhook_receipts,
//     no en el código de respuesta.

const MAX_BODY = 262144; // 256 KB

export function bridgeKeys(env = process.env) {
  const raw = env.ARCOP_BRIDGE_KEYS;
  if (!raw) return new Map();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('ARCOP_BRIDGE_KEYS must be valid JSON'); }
  if (!Array.isArray(parsed)) throw new Error('ARCOP_BRIDGE_KEYS must be an array');
  return new Map(parsed.map(k => {
    if (typeof k.source !== 'string' || typeof k.key !== 'string') throw new Error('ARCOP_BRIDGE_KEYS entry needs source and key');
    const key = Buffer.from(k.key, 'base64');
    if (key.length !== 32) throw new Error(`ARCOP_BRIDGE_KEYS key for ${k.source} must be 32 bytes base64`);
    return [k.source, { key, fingerprint: typeof k.fingerprint === 'string' ? k.fingerprint : null }];
  }));
}

export function verifyBridgeSignature(source, rawBody, signature, keys) {
  if (!keys || !keys.size) return { ok: false, reason: 'no_trusted_keys' };
  const entry = keys.get(source);
  if (!entry) return { ok: false, reason: 'unknown_source' };
  if (!signature || signature.length !== 64) return { ok: false, reason: 'malformed_signature' };
  let valid = false;
  try { valid = verify(null, rawBody, entry.key, signature); } catch { return { ok: false, reason: 'signature_check_failed' }; }
  if (!valid) return { ok: false, reason: 'invalid_signature' };
  return { ok: true, keyId: entry.fingerprint || source };
}

export function parseBridgeBody(rawBody) {
  if (Buffer.byteLength(rawBody) > MAX_BODY) return { error: 'payload_too_large' };
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return { error: 'malformed_json' }; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'malformed_payload' };
  if (typeof payload.entity_type !== 'string' || typeof payload.action !== 'string') return { error: 'malformed_payload' };
  return { payload };
}

// Ruta montada fuera de /api/v1 a propósito: no hay sesión, ni cookies, ni
// CORS. La autenticidad la porta la firma del cuerpo, no un token de sesión.
export function bridgeRouter({ pool, keys = bridgeKeys() }) {
  return async function handle(req, res) {
    const source = String(req.get('x-arcop-source') || '');
    const signature = req.get('x-arcop-signature')
      ? Buffer.from(req.get('x-arcop-signature').replace(/^ed25519:/, ''), 'base64') : null;

    // Firma antes de parsear: no se interpreta nada que no venga firmado.
    const check = verifyBridgeSignature(source, req.rawBody || Buffer.alloc(0), signature, keys);
    if (!check.ok) {
      console.error(JSON.stringify({ route: 'arcop_bridge', source, reason: check.reason }));
      return res.status(401).json({ error: 'signature_rejected' });
    }

    const { payload, error } = parseBridgeBody((req.rawBody || Buffer.alloc(0)).toString('utf8'));
    if (error) return res.status(422).json({ error });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT integration.apply_arcop_event($1,$2,$3,$4) AS status',
        [source, JSON.stringify(payload), true, check.keyId]);
      await client.query('COMMIT');
      return res.status(202).json({ status: rows[0].status });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(JSON.stringify({ route: 'arcop_bridge', error_code: e.code || 'unknown' }));
      return res.status(500).json({ error: 'internal_error' });
    } finally { client.release(); }
  };
}