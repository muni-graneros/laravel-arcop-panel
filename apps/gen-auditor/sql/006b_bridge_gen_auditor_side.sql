-- 006b · Lado Gen-Auditor · Receptor idempotente y proyecciones de ARCOP.
-- Se aplica a la BASE DE GEN-AUDITOR, después de 004_assets_remediation.sql.
-- El emisor (006a) vive en la base de ARCOP.
--
-- La firma Ed25519 NO se verifica aquí: se verifica en Node antes de llamar a
-- esta función, igual que los manifiestos de informe. Esta capa resuelve
-- deduplicación, anti-replay, alcance de tenant y aplicación atómica.
--
-- Run with a migration owner, never with the runtime role.
BEGIN;

CREATE SCHEMA integration;
REVOKE ALL ON SCHEMA integration FROM PUBLIC;

CREATE TABLE integration.webhook_receipts (
  source       text NOT NULL,
  event_hash   text NOT NULL CHECK(event_hash ~ '^[a-f0-9]{64}$'),
  signature_key text NOT NULL DEFAULT '',
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  outcome      text NOT NULL DEFAULT 'received'
               CHECK(outcome IN ('received','applied','duplicate','invalid_signature','replayed',
                                 'malformed','unknown_type','quarantined','stale_tenant')),
  detail       text NOT NULL DEFAULT '',
  tenant_id    uuid,
  entity_type  text,
  entity_id    uuid,
  event_seq    bigint,
  PRIMARY KEY(source, event_hash)
);
CREATE INDEX webhook_recent ON integration.webhook_receipts(tenant_id, received_at DESC);
CREATE INDEX webhook_pending ON integration.webhook_receipts(received_at) WHERE processed_at IS NULL;

-- Llave pública del emisor. La privada jamás está en esta base.
CREATE TABLE integration.trusted_signers (
  name              text PRIMARY KEY,
  public_key        bytea NOT NULL,
  algorithm         text NOT NULL DEFAULT 'ed25519' CHECK(algorithm = 'ed25519'),
  fingerprint       text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{16}$'),
  valid_from        timestamptz NOT NULL DEFAULT now(),
  valid_to          timestamptz,
  revoked_at        timestamptz,
  revocation_reason text NOT NULL DEFAULT ''
);

-- Anti-replay: la secuencia de una entidad no puede retroceder.
CREATE TABLE integration.entity_cursors (
  source      text NOT NULL,
  tenant_id   uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  last_seq    bigint NOT NULL DEFAULT 0 CHECK(last_seq >= 0),
  last_hash   text NOT NULL DEFAULT repeat('0',64),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source, tenant_id, entity_type, entity_id)
);

-- Proyección de expedientes ARCO: copia de SOLO lectura.
-- Si divergen con ARCOP, manda ARCOP: esta tabla no decide el estado.
CREATE TABLE integration.arcop_request_projections (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  source                 text NOT NULL,
  source_request_id      uuid NOT NULL,
  product                text NOT NULL DEFAULT 'desconocido',
  right_type             text NOT NULL DEFAULT 'access'
                         CHECK(right_type IN ('access','rectification','erasure','opposition','portability')),
  status                 text NOT NULL DEFAULT 'in_review'
                         CHECK(status IN ('identity_pending','in_review','action_pending','completed','rejected')),
  legal_profile          text NOT NULL DEFAULT '',
  due_at                 timestamptz,
  last_seq               bigint NOT NULL DEFAULT 1,
  last_hash              text NOT NULL,
  snapshot               jsonb NOT NULL DEFAULT '{}',
  received_at            timestamptz NOT NULL DEFAULT now(),
  is_stale               boolean NOT NULL DEFAULT false,
  stale_since            timestamptz,
  UNIQUE(tenant_id, source, source_request_id),
  FOREIGN KEY(tenant_id) REFERENCES gen_auditor.tenants(id)
);
CREATE INDEX arcop_proj_due   ON integration.arcop_request_projections(tenant_id, status, due_at);
CREATE INDEX arcop_proj_stale ON integration.arcop_request_projections(received_at) WHERE is_stale;

CREATE TABLE integration.consent_projections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  source              text NOT NULL,
  source_consent_id   uuid NOT NULL,
  product             text NOT NULL DEFAULT 'desconocido',
  purpose             text NOT NULL DEFAULT '',
  legal_version       text NOT NULL DEFAULT '',
  legal_sha256        text NOT NULL DEFAULT '',
  granted_at          timestamptz NOT NULL DEFAULT now(),
  state               text NOT NULL DEFAULT 'active'
                      CHECK(state IN ('active','withdrawn','restricted')),
  capture_method      text NOT NULL DEFAULT 'host_asserted',
  evidence_strength   text NOT NULL DEFAULT 'asserted_by_host',
  last_seq            bigint NOT NULL DEFAULT 1,
  last_hash           text NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, source, source_consent_id),
  FOREIGN KEY(tenant_id) REFERENCES gen_auditor.tenants(id)
);
CREATE INDEX consent_proj_state ON integration.consent_projections(tenant_id, state, granted_at DESC);

-- Correlación de sujeto sin PII y sin llave HMAC compartida.
-- Es el punto más sensible del puente: ningún rol de interfaz la puede leer.
CREATE TABLE integration.subject_correlation (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  subject_ref         text NOT NULL CHECK(subject_ref ~ '^[a-f0-9]{64}$'),
  correlation_key_id  text NOT NULL,
  correlation_ref     text NOT NULL CHECK(correlation_ref ~ '^[a-f0-9]{64}$'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz,
  use_count           integer NOT NULL DEFAULT 0,
  UNIQUE(tenant_id, subject_ref),
  UNIQUE(tenant_id, correlation_ref)
);

-- ---------------------------------------------------------------------------
-- Aplicación atómica: dedup → anti-replay → alcance → upsert → auditoría.
-- p_verified: la firma ya fue comprobada en Node. Un false no llega aquí, pero
-- la función lo exige para que ningún llamador pueda saltarse esa etapa.
-- ---------------------------------------------------------------------------
CREATE FUNCTION integration.apply_arcop_event(
  p_source text, p_payload jsonb, p_verified boolean, p_key_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog, integration, gen_auditor AS $$
DECLARE
  etype   text; eid uuid; eseq bigint; ehash text; etenant uuid; act text; m jsonb;
  cur     integration.entity_cursors;
  status  text;
BEGIN
  IF NOT COALESCE(p_verified,false) THEN RETURN 'invalid_signature'; END IF;

  m := COALESCE(p_payload->'metadata','{}'::jsonb);
  etype   := p_payload->>'entity_type';
  eid     := NULLIF(p_payload->>'entity_id','')::uuid;
  eseq    := (p_payload->>'seq')::bigint;
  etenant := NULLIF(p_payload->>'tenant_id','')::uuid;
  act     := p_payload->>'action';
  ehash   := m->>'_hash';

  IF eid IS NULL OR eseq IS NULL OR etenant IS NULL OR etype IS NULL OR act IS NULL THEN
    INSERT INTO integration.webhook_receipts(source,event_hash,outcome,detail)
    VALUES (p_source,coalesce(ehash,repeat('0',64)),'malformed','faltan campos obligatorios');
    RETURN 'malformed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM integration.trusted_signers
                  WHERE name=p_source AND revoked_at IS NULL
                    AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())) THEN
    INSERT INTO integration.webhook_receipts(source,event_hash,outcome,detail)
    VALUES (p_source,coalesce(ehash,repeat('0',64)),'invalid_signature','emisor no confiable');
    RETURN 'invalid_signature';
  END IF;

  IF ehash IS NULL THEN ehash := encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'); END IF;

  IF EXISTS (SELECT 1 FROM integration.webhook_receipts WHERE source=p_source AND event_hash=ehash) THEN
    RETURN 'duplicate';
  END IF;

  -- Un emisor autenticado no escribe fuera de los tenants que existen aquí.
  IF NOT EXISTS (SELECT 1 FROM gen_auditor.tenants WHERE id=etenant) THEN
    INSERT INTO integration.webhook_receipts(source,event_hash,outcome,detail,tenant_id)
    VALUES (p_source,ehash,'stale_tenant','tenant desconocido o dado de baja',etenant);
    RETURN 'quarantined';
  END IF;

  SELECT * INTO cur FROM integration.entity_cursors
   WHERE source=p_source AND tenant_id=etenant AND entity_type=etype AND entity_id=eid FOR UPDATE;
  IF cur.last_seq IS NOT NULL AND eseq <= cur.last_seq THEN
    INSERT INTO integration.webhook_receipts(source,event_hash,outcome,detail,tenant_id,entity_type,entity_id,event_seq)
    VALUES (p_source,ehash,'replayed','seq '||eseq||' <= '||cur.last_seq,etenant,etype,eid,eseq);
    RETURN 'replayed';
  END IF;

  INSERT INTO integration.webhook_receipts(source,event_hash,signature_key,tenant_id,entity_type,entity_id,event_seq)
  VALUES (p_source,ehash,left(coalesce(p_key_id,''),120),etenant,etype,eid,eseq);

  CASE etype
    WHEN 'request' THEN
      INSERT INTO integration.arcop_request_projections AS p
        (tenant_id,source,source_request_id,product,right_type,status,legal_profile,due_at,last_seq,last_hash,snapshot)
      VALUES (etenant,p_source,eid,
              left(coalesce(m->>'product','desconocido'),120),
              coalesce(m->>'right_type','access'),
              coalesce(m->>'status','in_review'),
              left(coalesce(m->>'legal_profile',''),120),
              NULLIF(m->>'due_at','')::timestamptz, eseq, ehash, m)
      ON CONFLICT (tenant_id,source,source_request_id) DO UPDATE
        SET status=EXCLUDED.status, due_at=EXCLUDED.due_at, last_seq=EXCLUDED.last_seq,
            last_hash=EXCLUDED.last_hash, snapshot=EXCLUDED.snapshot,
            received_at=now(), is_stale=false, stale_since=NULL
        WHERE EXCLUDED.last_seq > p.last_seq;

    WHEN 'consent' THEN
      INSERT INTO integration.consent_projections AS p
        (tenant_id,source,source_consent_id,product,purpose,legal_version,legal_sha256,granted_at,state,capture_method,evidence_strength,last_seq,last_hash)
      VALUES (etenant,p_source,eid,
              left(coalesce(m->>'product','desconocido'),120),
              left(coalesce(m->>'purpose',''),500),
              left(coalesce(m->>'legal_version',''),40),
              left(coalesce(m->>'legal_sha256',''),64),
              COALESCE(NULLIF(m->>'granted_at','')::timestamptz, now()),
              CASE WHEN act LIKE 'consent.withdrawn%' THEN 'withdrawn'
                   WHEN act LIKE 'consent.restricted%' THEN 'restricted'
                   ELSE 'active' END,
              left(coalesce(m->>'capture_method','host_asserted'),40),
              left(coalesce(m->>'evidence_strength','asserted_by_host'),40),
              eseq, ehash)
      ON CONFLICT (tenant_id,source,source_consent_id) DO UPDATE
        SET state=EXCLUDED.state, last_seq=EXCLUDED.last_seq, last_hash=EXCLUDED.last_hash,
            received_at=now()
        WHERE EXCLUDED.last_seq > p.last_seq;

    ELSE
      -- Un tipo desconocido se registra, no se descarta en silencio.
      UPDATE integration.webhook_receipts SET outcome='unknown_type', detail=left(etype,80)
       WHERE source=p_source AND event_hash=ehash;
      RETURN 'unknown_type';
  END CASE;

  INSERT INTO integration.entity_cursors(source,tenant_id,entity_type,entity_id,last_seq,last_hash)
  VALUES (p_source,etenant,etype,eid,eseq,ehash)
  ON CONFLICT (source,tenant_id,entity_type,entity_id) DO UPDATE
    SET last_seq=EXCLUDED.last_seq, last_hash=EXCLUDED.last_hash, updated_at=now();

  -- La evidencia del evento ARCOP entra en la bitácora encadenada del tenant.
  PERFORM gen_auditor.append_audit('arcop.projection_applied', eid,
    jsonb_build_object('entity_type',etype,'event_seq',eseq,'source',left(p_source,80)));

  status := 'applied';
  UPDATE integration.webhook_receipts SET outcome='applied', processed_at=now()
   WHERE source=p_source AND event_hash=ehash;
  RETURN status;
END $$;

-- Frescura: una proyección vieja se declara vieja, no se oculta.
CREATE VIEW integration.v_projection_freshness AS
SELECT 'request' AS kind, tenant_id, count(*) AS total,
       count(*) FILTER (WHERE is_stale) AS stale,
       min(received_at) AS oldest_received_at, max(received_at) AS newest_received_at
  FROM integration.arcop_request_projections GROUP BY 1,2
UNION ALL
SELECT 'consent', tenant_id, count(*), 0, min(received_at), max(received_at)
  FROM integration.consent_projections GROUP BY 1,2;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE integration.webhook_receipts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.entity_cursors           ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.arcop_request_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.consent_projections      ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.subject_correlation      ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.trusted_signers          ENABLE ROW LEVEL SECURITY;

CREATE POLICY proj_read    ON integration.arcop_request_projections FOR SELECT
  USING(gen_auditor.has_role(tenant_id, ARRAY['owner','privacy','auditor','reader']));
CREATE POLICY proj_read    ON integration.consent_projections FOR SELECT
  USING(gen_auditor.has_role(tenant_id, ARRAY['owner','privacy','auditor','reader']));
CREATE POLICY receipt_read ON integration.webhook_receipts FOR SELECT
  USING(gen_auditor.has_role(tenant_id, ARRAY['owner','security']));
CREATE POLICY cursor_read  ON integration.entity_cursors FOR SELECT
  USING(gen_auditor.has_role(tenant_id, ARRAY['owner','security']));

-- La correlación de sujeto NO es legible desde la API de aplicación:
-- la política no concede a ningún rol de interfaz, sólo al puente.
CREATE POLICY correlation_bridge_only ON integration.subject_correlation FOR ALL
  USING(gen_auditor.has_role(gen_auditor.tenant_id(), ARRAY[]::text[]))
  WITH CHECK(gen_auditor.has_role(gen_auditor.tenant_id(), ARRAY[]::text[]));

-- Las proyecciones se llenan únicamente por apply_arcop_event(); la API no escribe.
REVOKE INSERT, UPDATE, DELETE ON integration.arcop_request_projections FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON integration.consent_projections FROM PUBLIC;
REVOKE ALL ON integration.subject_correlation FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA integration FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA integration FROM PUBLIC;

COMMIT;

-- ---------------------------------------------------------------------------
-- 006b-roles · Runtime del puente (database owner session)
-- ---------------------------------------------------------------------------
CREATE ROLE gen_auditor_bridge LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA integration TO gen_auditor_bridge;
GRANT EXECUTE ON FUNCTION integration.apply_arcop_event(text,jsonb,boolean,text) TO gen_auditor_bridge;
GRANT SELECT ON integration.trusted_signers TO gen_auditor_bridge;
GRANT SELECT, INSERT, UPDATE ON integration.entity_cursors, integration.webhook_receipts TO gen_auditor_bridge;
GRANT INSERT, UPDATE ON integration.arcop_request_projections, integration.consent_projections TO gen_auditor_bridge;
-- Sin GRANT sobre subject_correlation a ningún rol de API.