-- 004 · Activos, remediación y verificación posterior.
-- Run with a migration owner, never with the runtime role. Separate from ARCOP tables.
-- Aditivo sobre 001/002/003: no altera la semántica de las columnas existentes.
BEGIN;

-- ---------------------------------------------------------------------
-- 4.0 Catálogo versionado de marcos normativos
-- `controls.reference` sigue siendo texto libre; el catálogo aporta procedencia,
-- vigencia y el freno legal de citar texto licenciado de ISO.
-- ---------------------------------------------------------------------
CREATE TABLE gen_auditor.control_catalog (
  framework     text NOT NULL CHECK(framework IN ('ISO-27001','ISO-27701','CL-21663','CL-19628','CL-21719','NIST-CSF')),
  version       text NOT NULL CHECK(length(version) BETWEEN 1 AND 24),
  reference     text NOT NULL CHECK(length(reference) BETWEEN 1 AND 40),
  title         text NOT NULL CHECK(length(title) BETWEEN 3 AND 240),
  source_url    text NOT NULL,
  applies_from  date NOT NULL,
  applies_to    date,
  -- true = mostrar sólo la referencia pública, nunca el texto del estándar.
  licensed_text boolean NOT NULL DEFAULT true,
  reviewed_by   uuid REFERENCES auth.users(id),
  reviewed_at   timestamptz,
  PRIMARY KEY(framework, version, reference),
  CHECK(applies_to IS NULL OR applies_to > applies_from)
);

CREATE TABLE gen_auditor.framework_targets (
  tenant_id   uuid NOT NULL REFERENCES gen_auditor.tenants(id),
  framework   text NOT NULL,
  version     text NOT NULL,
  status      text NOT NULL DEFAULT 'assessing'
              CHECK(status IN ('assessing','declared','in_scope','out_of_scope','suspended')),
  scope_note  text NOT NULL DEFAULT '',
  declared_by uuid REFERENCES auth.users(id),
  declared_at timestamptz,
  UNIQUE(tenant_id, framework, version)
);

-- ---------------------------------------------------------------------
-- 4.1 Inventario de activos críticos
-- La criticidad es explícita y auditada, no derivada: es una decisión de
-- negocio que el equipo puede justificar distinto del máximo CIA.
-- ---------------------------------------------------------------------
CREATE TABLE gen_auditor.assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  client_id       uuid NOT NULL,
  name            text NOT NULL CHECK(length(name) BETWEEN 2 AND 160),
  kind            text NOT NULL CHECK(kind IN
                  ('web_app','api','host','network_segment','database','cloud_resource',
                   'saas','mobile_app','ci_cd','repository','other')),
  criticality     text NOT NULL CHECK(criticality IN ('critical','high','medium','low')),
  confidentiality smallint NOT NULL CHECK(confidentiality BETWEEN 1 AND 3),
  integrity       smallint NOT NULL CHECK(integrity BETWEEN 1 AND 3),
  availability    smallint NOT NULL CHECK(availability BETWEEN 1 AND 3),
  data_class      text NOT NULL DEFAULT 'internal'
                  CHECK(data_class IN ('public','internal','confidential','restricted_personal','restricted_secret')),
  exposure        text NOT NULL DEFAULT 'internal'
                  CHECK(exposure IN ('internet','vpn','internal','isolated')),
  environment     text NOT NULL DEFAULT 'production'
                  CHECK(environment IN ('production','staging','development','sandbox')),
  inventory_source text NOT NULL DEFAULT 'manual'
                  CHECK(inventory_source IN ('manual','imported','discovered','attested')),
  owner_ref         text NOT NULL DEFAULT '',
  business_owner_ref text NOT NULL DEFAULT '',
  tags              text[] NOT NULL DEFAULT '{}',
  criticality_justification text NOT NULL DEFAULT '',
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_verified_at  timestamptz,
  retired_at        timestamptz,
  notes           text NOT NULL DEFAULT '',
  created_by      uuid NOT NULL REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, id),
  UNIQUE(tenant_id, client_id, name),
  CHECK(retired_at IS NULL OR retired_at >= first_seen_at),
  CHECK(last_verified_at IS NULL OR last_verified_at >= first_seen_at),
  -- El descubrimiento automático no declara criticidad máxima sin justificación.
  CHECK(criticality <> 'critical' OR criticality_justification <> '' OR inventory_source <> 'discovered'),
  FOREIGN KEY(tenant_id, client_id) REFERENCES gen_auditor.clients(tenant_id, id)
);
CREATE INDEX assets_client ON gen_auditor.assets(tenant_id, client_id);
CREATE INDEX assets_crit   ON gen_auditor.assets(tenant_id, criticality, environment) WHERE retired_at IS NULL;
CREATE INDEX assets_kind   ON gen_auditor.assets(tenant_id, kind);

CREATE TABLE gen_auditor.asset_endpoints (
  tenant_id   uuid NOT NULL,
  asset_id    uuid NOT NULL,
  domain_id   uuid NOT NULL,
  path_prefix text NOT NULL DEFAULT '' CHECK(length(path_prefix) <= 200),
  PRIMARY KEY(tenant_id, asset_id, domain_id),
  FOREIGN KEY(tenant_id, asset_id)  REFERENCES gen_auditor.assets(tenant_id, id),
  FOREIGN KEY(tenant_id, domain_id) REFERENCES gen_auditor.domains(tenant_id, id)
);

CREATE FUNCTION gen_auditor.suggested_criticality(c smallint, i smallint, a smallint) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE GREATEST(c,i,a) WHEN 3 THEN 'critical' WHEN 2 THEN 'high' ELSE 'low' END
$$;

-- Un activo sólo es escaneable si su superficie está verificada y autorizada.
-- Añadir un activo al inventario NO abre una vía de escaneo nueva.
CREATE FUNCTION gen_auditor.asset_is_scannable(p_asset uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog, gen_auditor AS $$
  SELECT EXISTS(
    SELECT 1
      FROM gen_auditor.assets a
      JOIN gen_auditor.asset_endpoints e ON e.tenant_id=a.tenant_id AND e.asset_id=a.id
      JOIN gen_auditor.domains d        ON d.tenant_id=e.tenant_id AND d.id=e.domain_id
     WHERE a.tenant_id = gen_auditor.tenant_id() AND a.id = p_asset
       AND a.retired_at IS NULL
       AND d.verified_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM gen_auditor.scan_authorizations s
                    WHERE s.tenant_id=d.tenant_id AND s.domain_id=d.id
                      AND s.revoked_at IS NULL AND s.expires_at > now()))
$$;

CREATE TABLE gen_auditor.finding_rules (
  tenant_id uuid NOT NULL REFERENCES gen_auditor.tenants(id),
  rule_key  text NOT NULL CHECK(length(rule_key) BETWEEN 2 AND 120),
  title     text NOT NULL CHECK(length(title) BETWEEN 3 AND 240),
  tool      text NOT NULL DEFAULT 'gen_auditor' CHECK(length(tool) <= 60),
  UNIQUE(tenant_id, rule_key)
);

-- ---------------------------------------------------------------------
-- 4.2 Hallazgos: huella estable y ciclo de vida completo
-- fingerprint = sha256(asset_id | rule_key | location).
-- Excluye severidad (se recalcula) y scan_id (cambia cada corrida), de modo
-- que un re-escaneo actualiza el hallazgo en vez de duplicarlo.
-- ---------------------------------------------------------------------
ALTER TABLE gen_auditor.vulnerabilities
  ADD COLUMN asset_id        uuid,
  ADD COLUMN fingerprint     text NOT NULL DEFAULT '',
  ADD COLUMN first_detected_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_detected_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN occurrence_count integer NOT NULL DEFAULT 1 CHECK(occurrence_count >= 1),
  ADD COLUMN source          text NOT NULL DEFAULT 'header_hygiene'
    CHECK(source IN ('header_hygiene','nmap','nuclei','zap','sarif','trivy','manual','integration')),
  ADD COLUMN external_ref    text NOT NULL DEFAULT '' CHECK(length(external_ref) <= 160),
  ADD COLUMN cvss            numeric(3,1) CHECK(cvss IS NULL OR cvss BETWEEN 0 AND 10),
  ADD COLUMN rule_key        text NOT NULL DEFAULT '',
  ADD COLUMN attempt_count   integer NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  ADD COLUMN closed_at       timestamptz,
  ADD COLUMN closed_by_verification uuid,
  ADD COLUMN resolution_reason text NOT NULL DEFAULT '',
  -- Cerrado exige verificación posterior revisada.
  ADD CONSTRAINT vuln_closed_requires_verification
    CHECK(status <> 'closed' OR closed_by_verification IS NOT NULL);
ALTER TABLE gen_auditor.vulnerabilities
  ADD CONSTRAINT vuln_evidence_asset
    FOREIGN KEY(tenant_id, asset_id) REFERENCES gen_auditor.assets(tenant_id, id);

DO $$ BEGIN
  ALTER TABLE gen_auditor.vulnerabilities DROP CONSTRAINT IF EXISTS vulnerabilities_status_check;
  ALTER TABLE gen_auditor.vulnerabilities
    ADD CONSTRAINT vulnerabilities_status_check CHECK(status IN
      ('open','triaged','in_progress','awaiting_verification','closed',
       'accepted','false_positive','reopened'));
END $$;

CREATE INDEX vuln_asset ON gen_auditor.vulnerabilities(tenant_id, asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX vuln_fp    ON gen_auditor.vulnerabilities(tenant_id, fingerprint, last_detected_at DESC)
                        WHERE fingerprint <> '';
-- Un hallazgo activo por huella: impide duplicados y resurrecciones.
CREATE UNIQUE INDEX vuln_fp_active ON gen_auditor.vulnerabilities(tenant_id, fingerprint)
  WHERE fingerprint <> ''
    AND status IN ('open','triaged','in_progress','awaiting_verification','reopened');

-- ---------------------------------------------------------------------
-- 4.3 SLA interno. NO es plazo legal: vive aparte de incidents a propósito.
-- ---------------------------------------------------------------------
CREATE FUNCTION gen_auditor.sla_hours(p_severity text) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE p_severity
  WHEN 'critical' THEN 48 WHEN 'high' THEN 168
  WHEN 'medium' THEN 360 WHEN 'low' THEN 720 ELSE NULL END $$;

CREATE FUNCTION gen_auditor.sla_due_at(p_severity text, p_detected_at timestamptz) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$ SELECT p_detected_at + make_interval(hours => gen_auditor.sla_hours(p_severity)) $$;

-- La criticidad del activo NUNCA aligera la severidad.
CREATE FUNCTION gen_auditor.effective_severity(p_severity text, p_criticality text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE
  WHEN p_severity = 'critical' THEN 'critical'
  WHEN p_criticality = 'critical' AND p_severity IN ('medium','low','info') THEN 'high'
  WHEN p_criticality = 'high' AND p_severity = 'info' THEN 'low'
  ELSE p_severity END $$;

-- ---------------------------------------------------------------------
-- 4.4 Planes de remediación
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- 4.6b Transiciones no terminales.
-- `status` NO es actualizable en absoluto por el rol runtime: un REVOKE de
-- columna no anula un GRANT de tabla, así que la única forma de que "closed"
-- sea inalcanzable por UPDATE es retirarle la columna entera. Todas las
-- transiciones pasan por funciones SECURITY DEFINER que dejan rastro.
-- ---------------------------------------------------------------------
CREATE FUNCTION gen_auditor.advance_finding(p_finding uuid, p_action text, p_notes text DEFAULT '')
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, gen_auditor AS $$
DECLARE t uuid := gen_auditor.tenant_id();
        cur gen_auditor.vulnerabilities;
        target text;
        head text;
BEGIN
  IF NOT gen_auditor.has_role(t, ARRAY['owner','security']) THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT * INTO cur FROM gen_auditor.vulnerabilities WHERE id=p_finding AND tenant_id=t FOR UPDATE;
  IF cur.id IS NULL THEN RAISE EXCEPTION 'not_found'; END IF;

  target := CASE p_action
    WHEN 'start'   THEN 'in_progress'
    WHEN 'accept'  THEN 'accepted'
    WHEN 'false_positive' THEN 'false_positive'
    ELSE NULL END;
  IF target IS NULL THEN RAISE EXCEPTION 'unknown_action'; END IF;

  -- Un hallazgo cerrado sólo se reabre con una verificación, no desde aquí.
  IF cur.status = 'closed' THEN RAISE EXCEPTION 'closed_requires_verification'; END IF;
  IF p_action = 'accept' AND length(coalesce(p_notes,'')) < 20 THEN RAISE EXCEPTION 'justification_required'; END IF;
  IF p_action = 'false_positive' AND length(coalesce(p_notes,'')) < 20 THEN RAISE EXCEPTION 'evidence_required'; END IF;

  UPDATE gen_auditor.vulnerabilities
     SET status=target, resolution_reason=left(coalesce(p_notes,''),2000)
   WHERE tenant_id=t AND id=p_finding;

  head := gen_auditor.append_audit('vulnerability.advanced', p_finding,
    jsonb_build_object('action', p_action, 'from', cur.status, 'to', target));
  RETURN head;
END $$;

-- ---------------------------------------------------------------------
-- 4.1b Registro de hallazgos por escaneo.
-- Vive en la base, y no en la aplicación, por dos razones: el índice único
-- parcial que deduplica está aquí, y `severity` no es escribible por el rol
-- runtime. Así nadie puede rebajar una severidad a mano: sólo un re-escaneo
-- autorizado la recalcula, con la severidad efectiva según la criticidad.
-- ---------------------------------------------------------------------
CREATE FUNCTION gen_auditor.record_finding(
  p_scan uuid, p_asset uuid, p_title text, p_severity text, p_criticality text,
  p_recommendation text, p_code_example text, p_rule_key text, p_location text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, gen_auditor AS $$
DECLARE
  t uuid := gen_auditor.tenant_id();
  effective text := gen_auditor.effective_severity(p_severity, p_criticality);
  fp text;
  fid uuid;
  sc gen_auditor.scans;
BEGIN
  IF NOT gen_auditor.has_role(t, ARRAY['owner','security']) THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT * INTO sc FROM gen_auditor.scans WHERE id=p_scan AND tenant_id=t;
  IF sc.id IS NULL THEN RAISE EXCEPTION 'scan_not_found'; END IF;
  IF p_asset IS NULL THEN RAISE EXCEPTION 'asset_required'; END IF;

  fp := encode(sha256(convert_to(p_asset::text||'|'||p_rule_key||'|'||coalesce(p_location,''),'UTF8')),'hex');

  INSERT INTO gen_auditor.vulnerabilities AS v
    (tenant_id,scan_id,asset_id,title,severity,recommendation,code_example,fingerprint,rule_key,first_detected_at,due_at)
  VALUES (t,p_scan,p_asset,left(p_title,240),effective,left(p_recommendation,4000),left(p_code_example,20000),fp,p_rule_key,now(),
          gen_auditor.sla_due_at(effective,now()))
  ON CONFLICT (tenant_id,fingerprint)
    WHERE fingerprint<>'' AND status IN ('open','triaged','in_progress','awaiting_verification','reopened')
  DO UPDATE SET last_detected_at=now(), occurrence_count=v.occurrence_count+1, severity=EXCLUDED.severity,
                recommendation=EXCLUDED.recommendation, code_example=EXCLUDED.code_example, scan_id=EXCLUDED.scan_id
  RETURNING id INTO fid;

  IF fid IS NULL THEN
    SELECT id INTO fid FROM gen_auditor.vulnerabilities WHERE tenant_id=t AND fingerprint=fp LIMIT 1;
  END IF;
  PERFORM gen_auditor.append_audit('vulnerability.detected', fid,
    jsonb_build_object('severity',effective,'fingerprint',fp,'source','scan'));
  RETURN fid;
END $$;

CREATE TABLE gen_auditor.remediation_plans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  finding_id         uuid NOT NULL,
  asset_id           uuid NOT NULL,
  summary            text NOT NULL CHECK(length(summary) BETWEEN 10 AND 400),
  technical_approach text NOT NULL DEFAULT '',
  -- Propuesta técnica del auditor: no es un parche aplicado ni garantiza el cierre.
  code_example       text NOT NULL DEFAULT '' CHECK(octet_length(code_example) <= 20000),
  change_ticket_ref  text NOT NULL DEFAULT '' CHECK(length(change_ticket_ref) <= 120),
  owner_id           uuid REFERENCES auth.users(id),
  due_at             timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'draft' CHECK(status IN
                       ('draft','approved','in_progress','submitted_for_verification',
                        'verified','rejected','superseded')),
  paused_at          timestamptz,
  pause_reason       text NOT NULL DEFAULT '',
  pause_approved_by  uuid REFERENCES auth.users(id),
  submitted_at       timestamptz,
  submitted_by       uuid REFERENCES auth.users(id),
  verified_at        timestamptz,
  verified_by        uuid REFERENCES auth.users(id),
  rejected_reason    text NOT NULL DEFAULT '',
  version            integer NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_by         uuid NOT NULL REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, id),
  -- Quien ejecutó no puede certificar su propio cierre.
  CONSTRAINT plan_verifier_separation
    CHECK(status <> 'verified' OR (verified_by IS NOT NULL AND submitted_by IS NOT NULL AND verified_by <> submitted_by)),
  CONSTRAINT plan_pause_justified
    CHECK(paused_at IS NULL OR (length(pause_reason) >= 10 AND pause_approved_by IS NOT NULL)),
  CONSTRAINT plan_rejection_explained
    CHECK(status <> 'rejected' OR length(rejected_reason) >= 10),
  CONSTRAINT plan_window_valid CHECK(due_at > created_at),
  CONSTRAINT plan_submission_consistent CHECK((submitted_at IS NULL) = (submitted_by IS NULL)),
  FOREIGN KEY(tenant_id, finding_id) REFERENCES gen_auditor.vulnerabilities(tenant_id, id),
  FOREIGN KEY(tenant_id, asset_id)   REFERENCES gen_auditor.assets(tenant_id, id)
);
CREATE UNIQUE INDEX remediation_one_live ON gen_auditor.remediation_plans(tenant_id, finding_id)
  WHERE status IN ('draft','approved','in_progress','submitted_for_verification');
CREATE INDEX remediation_due   ON gen_auditor.remediation_plans(tenant_id, status, due_at);
CREATE INDEX remediation_owner ON gen_auditor.remediation_plans(tenant_id, owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE gen_auditor.remediation_steps (
  tenant_id    uuid NOT NULL,
  plan_id      uuid NOT NULL,
  position     smallint NOT NULL CHECK(position BETWEEN 1 AND 60),
  description  text NOT NULL CHECK(length(description) BETWEEN 3 AND 600),
  evidence_id  uuid,
  completed_at timestamptz,
  completed_by uuid REFERENCES auth.users(id),
  PRIMARY KEY(tenant_id, plan_id, position),
  CHECK((completed_at IS NULL) = (completed_by IS NULL)),
  FOREIGN KEY(tenant_id, plan_id) REFERENCES gen_auditor.remediation_plans(tenant_id, id)
);

-- La entrega mueve el estado del hallazgo desde la base, no desde la API:
-- `vulnerabilities.status` no es escribible por el rol de aplicación, y así
-- es imposible dejar un hallazgo en 'awaiting_verification' sin plan entregado.
CREATE FUNCTION gen_auditor.mark_awaiting_verification(p_finding uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, gen_auditor AS $$
DECLARE t uuid := gen_auditor.tenant_id();
        p gen_auditor.remediation_plans;
        head text;
BEGIN
  IF NOT gen_auditor.has_role(t, ARRAY['owner','security']) THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT * INTO p FROM gen_auditor.remediation_plans
   WHERE tenant_id=t AND finding_id=p_finding AND status='submitted_for_verification' FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'no_submitted_plan'; END IF;
  IF EXISTS (SELECT 1 FROM gen_auditor.remediation_steps s
              WHERE s.tenant_id=t AND s.plan_id=p.id AND s.completed_at IS NULL) THEN
    RAISE EXCEPTION 'steps_incomplete';
  END IF;
  UPDATE gen_auditor.vulnerabilities SET status='awaiting_verification' WHERE tenant_id=t AND id=p_finding;
  head := gen_auditor.append_audit('remediation.awaiting_verification', p_finding,
    jsonb_build_object('plan_id', p.id, 'submitted_by', p.submitted_by));
  RETURN head;
END $$;

-- ---------------------------------------------------------------------
-- 4.5 Verificación posterior
-- Una verificación inconclusa NO cierra nada: devuelve el hallazgo a abierto.
-- ---------------------------------------------------------------------
CREATE TABLE gen_auditor.verification_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  finding_id   uuid NOT NULL,
  plan_id      uuid,
  scan_id      uuid,
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  outcome      text NOT NULL DEFAULT 'pending'
               CHECK(outcome IN ('pending','clean','still_present','inconclusive','out_of_scope_confirmed')),
  method       text NOT NULL DEFAULT 'rescan'
               CHECK(method IN ('rescan','manual_review','config_diff','external_attestation')),
  evidence     jsonb NOT NULL DEFAULT '{}',
  reviewed_by  uuid REFERENCES auth.users(id),
  reviewed_at  timestamptz,
  notes        text NOT NULL DEFAULT '',
  UNIQUE(tenant_id, id),
  CONSTRAINT verification_completed_has_time CHECK(outcome = 'pending' OR completed_at IS NOT NULL),
  CONSTRAINT verification_clean_needs_reviewer
    CHECK(outcome <> 'clean' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CONSTRAINT verification_notes_for_negative
    CHECK(outcome NOT IN ('still_present','inconclusive') OR length(notes) >= 10),
  -- El retest debe ser POSTERIOR a la entrega del plan.
  -- Un CHECK no puede leer otra tabla: se valida en close_finding() con
  -- RAISE EXCEPTION 'verification_predates_fix'.
  FOREIGN KEY(tenant_id, finding_id) REFERENCES gen_auditor.vulnerabilities(tenant_id, id),
  FOREIGN KEY(tenant_id, plan_id)    REFERENCES gen_auditor.remediation_plans(tenant_id, id),
  FOREIGN KEY(tenant_id, scan_id)    REFERENCES gen_auditor.scans(tenant_id, id)
);
CREATE INDEX verification_finding ON gen_auditor.verification_runs(tenant_id, finding_id, requested_at DESC);
CREATE INDEX verification_open    ON gen_auditor.verification_runs(tenant_id, requested_at DESC) WHERE outcome = 'pending';

-- El escaneo que sirve de retest debe estar cubierto por autorización vigente.
CREATE FUNCTION gen_auditor.assert_scan_authorized(p_scan uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, gen_auditor AS $$
DECLARE s gen_auditor.scans;
BEGIN
  SELECT * INTO s FROM gen_auditor.scans WHERE id = p_scan AND tenant_id = gen_auditor.tenant_id();
  IF s.id IS NULL THEN RAISE EXCEPTION 'scan_not_found'; END IF;
  IF s.kind <> 'active' THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM gen_auditor.scan_authorizations a
                  WHERE a.tenant_id = s.tenant_id AND a.id = s.authorization_id
                    AND a.revoked_at IS NULL AND a.expires_at > now()) THEN
    RAISE EXCEPTION 'scan_authorization_expired';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4.6 Transiciones controladas
-- El cierre se revoca como UPDATE directo y sólo existe vía función.
-- ---------------------------------------------------------------------
CREATE FUNCTION gen_auditor.close_finding(p_finding uuid, p_verification uuid, p_notes text DEFAULT '')
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, gen_auditor AS $$
DECLARE t uuid := gen_auditor.tenant_id();
        v gen_auditor.verification_runs;
        p gen_auditor.remediation_plans;
        head text;
BEGIN
  IF NOT gen_auditor.has_role(t, ARRAY['owner','security']) THEN RAISE EXCEPTION 'forbidden'; END IF;

  SELECT * INTO p FROM gen_auditor.remediation_plans
   WHERE tenant_id=t AND finding_id=p_finding AND status='submitted_for_verification' FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'no_submitted_plan'; END IF;

  SELECT * INTO v FROM gen_auditor.verification_runs
   WHERE tenant_id=t AND id=p_verification AND finding_id=p_finding FOR UPDATE;
  IF v.id IS NULL THEN RAISE EXCEPTION 'verification_not_found'; END IF;
  IF v.outcome <> 'clean' OR v.reviewed_by IS NULL THEN RAISE EXCEPTION 'verification_not_clean'; END IF;
  IF p.submitted_by IS NULL OR v.reviewed_by = p.submitted_by THEN RAISE EXCEPTION 'separation_of_duties'; END IF;
  IF v.reviewed_at IS NULL OR p.submitted_at IS NULL OR v.reviewed_at < p.submitted_at THEN
    RAISE EXCEPTION 'verification_predates_fix';
  END IF;

  UPDATE gen_auditor.remediation_plans
     SET status='verified', verified_at=clock_timestamp(), verified_by=v.reviewed_by, updated_at=clock_timestamp()
   WHERE tenant_id=t AND id=p.id;
  UPDATE gen_auditor.vulnerabilities
     SET status='closed', closed_at=clock_timestamp(), closed_by_verification=v.id,
         resolution_reason=left(coalesce(p_notes,''),2000), resolved_at=clock_timestamp()
   WHERE tenant_id=t AND id=p_finding;

  head := gen_auditor.append_audit('vulnerability.closed', p_finding,
    jsonb_build_object('verification_id', p_verification, 'reviewer', v.reviewed_by, 'plan_id', p.id));
  RETURN head;
END $$;

CREATE FUNCTION gen_auditor.reopen_finding(p_finding uuid, p_verification uuid, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, gen_auditor AS $$
DECLARE t uuid := gen_auditor.tenant_id();
        p gen_auditor.remediation_plans;
        n integer;
        head text;
BEGIN
  IF NOT gen_auditor.has_role(t, ARRAY['owner','security']) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF length(coalesce(p_reason,'')) < 10 THEN RAISE EXCEPTION 'reason_required'; END IF;

  SELECT * INTO p FROM gen_auditor.remediation_plans
   WHERE tenant_id=t AND finding_id=p_finding AND status='submitted_for_verification' FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'no_submitted_plan'; END IF;

  UPDATE gen_auditor.remediation_plans
     SET status='rejected', rejected_reason=left(p_reason,2000), verified_at=NULL, verified_by=NULL,
         updated_at=clock_timestamp()
   WHERE tenant_id=t AND id=p.id;
  UPDATE gen_auditor.vulnerabilities
     SET status='reopened', attempt_count = attempt_count + 1,
         closed_at=NULL, closed_by_verification=NULL, resolution_reason=left(p_reason,2000)
   WHERE tenant_id=t AND id=p_finding;

  SELECT count(*) INTO n FROM gen_auditor.verification_runs
   WHERE tenant_id=t AND finding_id=p_finding AND outcome IN ('still_present','inconclusive');

  head := gen_auditor.append_audit('vulnerability.reopened', p_finding,
    jsonb_build_object('verification_id', p_verification, 'attempts', n, 'escalation_required', n >= 3));
  IF n >= 3 THEN
    PERFORM gen_auditor.append_audit('remediation.escalation_required', p_finding,
      jsonb_build_object('attempts', n, 'requires', 'owner_decision'));
  END IF;
  RETURN head;
END $$;

CREATE TABLE gen_auditor.risk_acceptances (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  finding_id            uuid NOT NULL,
  justification         text NOT NULL CHECK(length(justification) BETWEEN 20 AND 4000),
  compensating_controls text NOT NULL DEFAULT '',
  approved_by           uuid NOT NULL REFERENCES auth.users(id),
  requested_by          uuid NOT NULL REFERENCES auth.users(id),
  approved_at           timestamptz NOT NULL DEFAULT now(),
  review_due_at         timestamptz NOT NULL,
  revoked_at            timestamptz,
  revoked_reason        text NOT NULL DEFAULT '',
  UNIQUE(tenant_id, id),
  CHECK(approved_by <> requested_by),
  CHECK(review_due_at > approved_at),
  FOREIGN KEY(tenant_id, finding_id) REFERENCES gen_auditor.vulnerabilities(tenant_id, id)
);
CREATE UNIQUE INDEX risk_acceptance_one ON gen_auditor.risk_acceptances(tenant_id, finding_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- 4.7 Evidencia y anclaje externo
-- ---------------------------------------------------------------------
CREATE TABLE gen_auditor.evidence_objects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  kind            text NOT NULL CHECK(kind IN
                  ('pdf','screenshot','scanner_output','sarif','document','attestation','config_diff')),
  storage_ref     text NOT NULL CHECK(length(storage_ref) BETWEEN 3 AND 400),
  sha256          text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  byte_size       bigint NOT NULL CHECK(byte_size > 0),
  mime            text NOT NULL CHECK(length(mime) <= 120),
  description     text NOT NULL DEFAULT '',
  legal_hold      boolean NOT NULL DEFAULT false,
  retention_until date,
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, id),
  UNIQUE(tenant_id, sha256, kind)
);
CREATE INDEX evidence_hold ON gen_auditor.evidence_objects(tenant_id, created_at DESC) WHERE legal_hold;

ALTER TABLE gen_auditor.remediation_steps
  ADD CONSTRAINT remediation_step_evidence
  FOREIGN KEY(tenant_id, evidence_id) REFERENCES gen_auditor.evidence_objects(tenant_id, id);

CREATE TABLE gen_auditor.audit_anchors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  seq            bigint NOT NULL CHECK(seq >= 0),
  head_hash      text NOT NULL CHECK(head_hash ~ '^[a-f0-9]{64}$'),
  anchored_at    timestamptz NOT NULL DEFAULT now(),
  anchor_receipt text NOT NULL CHECK(length(anchor_receipt) BETWEEN 16 AND 4000),
  store_ref      text NOT NULL CHECK(length(store_ref) BETWEEN 3 AND 400),
  key_id         text NOT NULL CHECK(length(key_id) <= 120),
  UNIQUE(tenant_id, id),
  UNIQUE(tenant_id, seq)
);
-- El ancla se inserta sólo desde anchor_current(), que valida contra la
-- bitácora real. Aquí no hay CHECK con subconsulta: PostgreSQL no lo admite.
CREATE FUNCTION gen_auditor.anchor_current(p_receipt text, p_store_ref text, p_key_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, gen_auditor AS $$
DECLARE t uuid := gen_auditor.tenant_id();
        h gen_auditor.audit_heads;
        aid uuid;
BEGIN
  IF NOT gen_auditor.has_role(t, ARRAY['owner','security']) THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT * INTO h FROM gen_auditor.audit_heads WHERE tenant_id=t;
  IF h.tenant_id IS NULL THEN RAISE EXCEPTION 'empty_chain'; END IF;
  -- Sólo se ancla una cabeza que existe en la cadena.
  IF NOT EXISTS (SELECT 1 FROM gen_auditor.audit_logs l
                  WHERE l.tenant_id=t AND l.seq=h.seq AND l.entry_hash=h.head_hash) THEN
    RAISE EXCEPTION 'head_not_in_chain';
  END IF;
  INSERT INTO gen_auditor.audit_anchors(tenant_id,seq,head_hash,anchor_receipt,store_ref,key_id)
  VALUES (t,h.seq,h.head_hash,left(p_receipt,4000),left(p_store_ref,400),left(p_key_id,120))
  RETURNING id INTO aid;
  PERFORM gen_auditor.append_audit('audit.anchored', aid, jsonb_build_object('seq', h.seq, 'key_id', left(p_key_id,120)));
  RETURN aid;
END $$;

DO $$ DECLARE t text; BEGIN
  CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON gen_auditor.audit_anchors
    FOR EACH ROW EXECUTE FUNCTION gen_auditor.reject_mutation();
  CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON gen_auditor.audit_anchors
    FOR EACH STATEMENT EXECUTE FUNCTION gen_auditor.reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- 4.8 Informes
-- ---------------------------------------------------------------------
-- reports (001) sólo tiene PK en id: la FK compuesta de supersesión lo exige.
-- Es la misma convención que el resto del esquema.
ALTER TABLE gen_auditor.reports ADD CONSTRAINT reports_tenant_id_key UNIQUE(tenant_id, id);
ALTER TABLE gen_auditor.reports
  ADD COLUMN supersedes        uuid,
  ADD COLUMN key_ref           text NOT NULL DEFAULT '',
  ADD COLUMN sections          jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN anchor_seq        bigint,
  ADD COLUMN snapshot_taken_at timestamptz;
ALTER TABLE gen_auditor.reports
  ADD CONSTRAINT reports_supersedes FOREIGN KEY(tenant_id, supersedes) REFERENCES gen_auditor.reports(tenant_id, id);
-- GA-SE-XXXXXXXX es identificador humano; la prueba es el manifiesto firmado.
ALTER TABLE gen_auditor.reports
  ADD CONSTRAINT reports_code_shape CHECK(report_code ~ '^GA-SE-[0-9A-F]{8}$');

CREATE TABLE gen_auditor.report_verifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  report_id    uuid NOT NULL,
  verifier_ref text NOT NULL DEFAULT '',
  outcome      text NOT NULL CHECK(outcome IN ('valid','invalid_signature','digest_mismatch','unknown_key','revoked_key')),
  detail       text NOT NULL DEFAULT '',
  verified_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, id),
  FOREIGN KEY(tenant_id, report_id) REFERENCES gen_auditor.reports(tenant_id, id)
);

-- ---------------------------------------------------------------------
-- 4.9 Snapshots de cumplimiento
-- percent NULL = sin medición. Un catálogo vacío nunca muestra 100 %.
-- ---------------------------------------------------------------------
CREATE TABLE gen_auditor.compliance_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  taken_at            timestamptz NOT NULL DEFAULT now(),
  framework           text NOT NULL,
  version             text NOT NULL,
  applicable_controls integer NOT NULL CHECK(applicable_controls >= 0),
  verified_controls   integer NOT NULL CHECK(verified_controls >= 0),
  percent             numeric(5,2) CHECK(percent IS NULL OR percent BETWEEN 0 AND 100),
  measured            boolean NOT NULL DEFAULT false,
  open_findings       integer NOT NULL DEFAULT 0,
  overdue_plans       integer NOT NULL DEFAULT 0,
  audit_head_hash     text NOT NULL,
  UNIQUE(tenant_id, id),
  CHECK(verified_controls <= applicable_controls),
  CHECK((percent IS NULL) = (NOT measured))
);

-- ---------------------------------------------------------------------
-- 4.10 Vistas de lectura para la UI
-- ---------------------------------------------------------------------
-- security_invoker=true es obligatorio: sin él la vista se ejecuta con los
-- permisos de su propietario (el migrador, superusuario) y EVADIRÍA la RLS de
-- las tablas de base, mostrando los activos de todos los tenants.
CREATE VIEW gen_auditor.v_asset_exposure WITH (security_invoker=true) AS
SELECT a.tenant_id, a.client_id, a.id AS asset_id, a.name, a.kind, a.criticality,
       a.environment, a.exposure, a.data_class, a.retired_at,
       count(f.id) FILTER (WHERE f.status IN ('open','triaged','in_progress','awaiting_verification','reopened')) AS open_findings,
       count(f.id) FILTER (WHERE f.status IN ('open','triaged','in_progress','awaiting_verification','reopened')
                            AND f.severity = 'critical') AS critical_findings,
       min(f.due_at) FILTER (WHERE f.status NOT IN ('closed','accepted','false_positive')) AS nearest_due_at
  FROM gen_auditor.assets a
  LEFT JOIN gen_auditor.vulnerabilities f ON f.tenant_id = a.tenant_id AND f.asset_id = a.id
 GROUP BY a.tenant_id, a.client_id, a.id;

-- Un hallazgo tiene historial de planes, pero el tablero muestra UNO: el
-- vigente. Un JOIN simple traería una fila por cada plan no superseded y
-- duplicaría cada tarjeta del tablero.
CREATE VIEW gen_auditor.v_finding_backlog WITH (security_invoker=true) AS
SELECT f.tenant_id, f.id, f.asset_id, a.name AS asset_name, a.criticality,
       f.title, f.severity, f.status, f.source, f.external_ref,
       f.first_detected_at, f.last_detected_at, f.occurrence_count, f.attempt_count,
       gen_auditor.sla_due_at(f.severity, f.first_detected_at) AS due_at,
       (now() > gen_auditor.sla_due_at(f.severity, f.first_detected_at)) AS overdue,
       p.id AS plan_id, p.status AS plan_status, p.owner_id, p.submitted_at, p.due_at AS plan_due_at,
       (p.paused_at IS NOT NULL) AS plan_paused
  FROM gen_auditor.vulnerabilities f
  JOIN gen_auditor.assets a ON a.tenant_id = f.tenant_id AND a.id = f.asset_id
  LEFT JOIN LATERAL (
    SELECT q.* FROM gen_auditor.remediation_plans q
     WHERE q.tenant_id = f.tenant_id AND q.finding_id = f.id
     ORDER BY (CASE WHEN q.status = 'superseded' THEN 1 ELSE 0 END), q.version DESC, q.created_at DESC
     LIMIT 1
  ) p ON true;

-- ---------------------------------------------------------------------
-- 4.11 RLS
-- ---------------------------------------------------------------------
DO $$ DECLARE t text; writers text[]; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'framework_targets','assets','asset_endpoints','finding_rules',
    'remediation_plans','remediation_steps','verification_runs','risk_acceptances',
    'evidence_objects','audit_anchors','compliance_snapshots','report_verifications'] LOOP

    EXECUTE format('ALTER TABLE gen_auditor.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON gen_auditor.%I FOR SELECT USING(gen_auditor.has_role(tenant_id,ARRAY[''owner'',''security'',''privacy'',''auditor'',''reader'']))',t);

    -- El ciclo de remediación se escribe sólo con rol de seguridad.
    IF t IN ('remediation_plans','remediation_steps','verification_runs','risk_acceptances') THEN
      EXECUTE format('CREATE POLICY tenant_write ON gen_auditor.%I FOR ALL USING(gen_auditor.has_role(tenant_id,ARRAY[''owner'',''security''])) WITH CHECK(gen_auditor.has_role(tenant_id,ARRAY[''owner'',''security'']))',t);
      CONTINUE;
    END IF;

    writers := CASE WHEN t IN ('framework_targets','compliance_snapshots') THEN ARRAY['owner','security','auditor']
                    ELSE ARRAY['owner','security'] END;
    EXECUTE format('CREATE POLICY tenant_insert ON gen_auditor.%I FOR INSERT WITH CHECK(gen_auditor.has_role(tenant_id,%L::text[]))',t,writers);
    EXECUTE format('CREATE POLICY tenant_update ON gen_auditor.%I FOR UPDATE USING(gen_auditor.has_role(tenant_id,%L::text[])) WITH CHECK(gen_auditor.has_role(tenant_id,%L::text[]))',t,writers,writers);
  END LOOP;
END $$;

-- El catálogo normativo es referencia: lectura universal, escritura con gobierno.
ALTER TABLE gen_auditor.control_catalog ENABLE ROW LEVEL SECURITY;
CREATE POLICY catalog_read ON gen_auditor.control_catalog FOR SELECT USING(true);
CREATE POLICY catalog_write ON gen_auditor.control_catalog FOR ALL
  USING(gen_auditor.has_role(gen_auditor.tenant_id(), ARRAY['owner','auditor']))
  WITH CHECK(gen_auditor.has_role(gen_auditor.tenant_id(), ARRAY['owner','auditor']));

-- El ancla sólo se inserta vía anchor_current(); no hay UPDATE/DELETE de nadie.
REVOKE INSERT, UPDATE, DELETE ON gen_auditor.audit_anchors FROM PUBLIC;

COMMIT;

-- 004b · Privilegios del rol runtime.
-- El cierre de hallazgos se RETIRA del UPDATE directo: sólo por función.
-- 002 dio UPDATE a nivel de TABLA sobre vulnerabilities; un REVOKE de columna
-- no lo anula, así que se revoca la tabla y se readmiten columnas seguras.
-- `status` no se readmite: ninguna transición se escribe directamente.
-- Database owner session.
REVOKE UPDATE ON gen_auditor.vulnerabilities FROM gen_auditor_api;
GRANT UPDATE(detected_at,due_at,recommendation,code_example,cvss,external_ref,
             last_detected_at,occurrence_count,rule_key,source)
  ON gen_auditor.vulnerabilities TO gen_auditor_api;
GRANT INSERT ON gen_auditor.assets,gen_auditor.asset_endpoints,gen_auditor.finding_rules,
  gen_auditor.remediation_plans,gen_auditor.remediation_steps,gen_auditor.verification_runs,
  gen_auditor.risk_acceptances,gen_auditor.evidence_objects,gen_auditor.compliance_snapshots,
  gen_auditor.report_verifications,gen_auditor.framework_targets,gen_auditor.control_catalog TO gen_auditor_api;
GRANT UPDATE ON gen_auditor.assets,gen_auditor.asset_endpoints,gen_auditor.remediation_plans,
  gen_auditor.remediation_steps,gen_auditor.compliance_snapshots TO gen_auditor_api;
GRANT SELECT ON gen_auditor.assets,gen_auditor.asset_endpoints,gen_auditor.finding_rules,
  gen_auditor.remediation_plans,gen_auditor.remediation_steps,gen_auditor.verification_runs,
  gen_auditor.risk_acceptances,gen_auditor.evidence_objects,gen_auditor.audit_anchors,
  gen_auditor.compliance_snapshots,gen_auditor.report_verifications,
  gen_auditor.framework_targets,gen_auditor.control_catalog TO gen_auditor_api;
-- UPDATE de los campos de transición del plan, no de la columna completa.
GRANT UPDATE(status,paused_at,pause_reason,pause_approved_by,submitted_at,submitted_by,
             verified_at,verified_by,rejected_reason,updated_at)
  ON gen_auditor.remediation_plans TO gen_auditor_api;
GRANT UPDATE(outcome,completed_at,reviewed_by,reviewed_at,notes,evidence)
  ON gen_auditor.verification_runs TO gen_auditor_api;
GRANT UPDATE(revoked_at,revoked_reason) ON gen_auditor.risk_acceptances TO gen_auditor_api;
GRANT INSERT ON gen_auditor.audit_anchors TO gen_auditor_api;
-- Las vistas son objetos propios: sin este GRANT el rol runtime no las puede leer
-- aunque tenga permiso sobre las tablas de base.
GRANT SELECT ON gen_auditor.v_asset_exposure, gen_auditor.v_finding_backlog TO gen_auditor_api;
GRANT EXECUTE ON FUNCTION
  gen_auditor.record_finding(uuid,uuid,text,text,text,text,text,text,text),
  gen_auditor.close_finding(uuid,uuid,text),
  gen_auditor.reopen_finding(uuid,uuid,text),
  gen_auditor.advance_finding(uuid,text,text),
  gen_auditor.mark_awaiting_verification(uuid),
  gen_auditor.anchor_current(text,text,text),
  gen_auditor.assert_scan_authorized(uuid),
  gen_auditor.asset_is_scannable(uuid),
  gen_auditor.suggested_criticality(smallint,smallint,smallint),
  gen_auditor.effective_severity(text,text),
  gen_auditor.sla_due_at(text,timestamptz),
  gen_auditor.sla_hours(text),
  gen_auditor.append_audit(text,uuid,jsonb),
  gen_auditor.verify_audit() TO gen_auditor_api;
REVOKE ALL ON FUNCTION gen_auditor.close_finding(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION gen_auditor.record_finding(uuid,uuid,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION gen_auditor.reopen_finding(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION gen_auditor.advance_finding(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION gen_auditor.anchor_current(text,text,text) FROM PUBLIC;