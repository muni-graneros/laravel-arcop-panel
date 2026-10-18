-- Run with a migration owner, never with the runtime role. Separate from ARCOP tables.
BEGIN;
CREATE SCHEMA gen_auditor;
REVOKE ALL ON SCHEMA gen_auditor FROM PUBLIC;
CREATE TABLE gen_auditor.tenants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(name) BETWEEN 2 AND 160),
 retention_months integer NOT NULL DEFAULT 12 CHECK(retention_months BETWEEN 1 AND 120),
 legal_profile text NOT NULL DEFAULT 'pending_review', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gen_auditor.tenant_members (
 tenant_id uuid NOT NULL REFERENCES gen_auditor.tenants(id), user_id uuid NOT NULL REFERENCES auth.users(id),
 role text NOT NULL CHECK(role IN ('owner','security','privacy','auditor','reader')), active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(tenant_id,user_id)
);
CREATE FUNCTION gen_auditor.actor_id() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('app.actor_id',true),'')::uuid
$$;
CREATE FUNCTION gen_auditor.tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('app.tenant_id',true),'')::uuid
$$;
CREATE FUNCTION gen_auditor.has_role(t uuid, roles text[]) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,gen_auditor AS $$
 SELECT t=gen_auditor.tenant_id() AND EXISTS(SELECT 1 FROM gen_auditor.tenant_members m
 WHERE m.tenant_id=t AND m.user_id=gen_auditor.actor_id() AND m.active AND m.role=ANY(roles))
$$;
CREATE TABLE gen_auditor.clients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES gen_auditor.tenants(id),
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 160), product text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE TABLE gen_auditor.domains (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, client_id uuid NOT NULL,
 hostname text NOT NULL CHECK(hostname=lower(hostname) AND length(hostname)<=253),
 verification_token_hash text CHECK(verification_token_hash ~ '^[a-f0-9]{64}$'),
 verification_expires_at timestamptz, verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,hostname),
 FOREIGN KEY(tenant_id,client_id) REFERENCES gen_auditor.clients(tenant_id,id)
);
CREATE TABLE gen_auditor.scan_authorizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, domain_id uuid NOT NULL,
 approved_by uuid NOT NULL REFERENCES auth.users(id), authorization_sha256 text NOT NULL CHECK(authorization_sha256 ~ '^[a-f0-9]{64}$'),
 approved_ips inet[] NOT NULL CHECK(cardinality(approved_ips)>0), allowed_tools text[] NOT NULL,
 starts_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 CHECK(expires_at>starts_at AND expires_at<=starts_at+interval '7 days'), UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,domain_id),
 FOREIGN KEY(tenant_id,domain_id) REFERENCES gen_auditor.domains(tenant_id,id)
);
CREATE TABLE gen_auditor.scans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, domain_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('passive','active')), status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
 authorization_id uuid, score integer CHECK(score BETWEEN 0 AND 100), evidence jsonb NOT NULL DEFAULT '{}',
 error_code text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 CHECK(kind<>'active' OR authorization_id IS NOT NULL), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,domain_id) REFERENCES gen_auditor.domains(tenant_id,id),
 FOREIGN KEY(tenant_id,authorization_id,domain_id) REFERENCES gen_auditor.scan_authorizations(tenant_id,id,domain_id)
);
CREATE TABLE gen_auditor.vulnerabilities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, scan_id uuid NOT NULL,
 title text NOT NULL, severity text NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','accepted')),
 recommendation text NOT NULL, code_example text NOT NULL DEFAULT '', detected_at timestamptz NOT NULL DEFAULT now(),
 due_at timestamptz, resolved_at timestamptz, UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,scan_id) REFERENCES gen_auditor.scans(tenant_id,id)
);
CREATE TABLE gen_auditor.consents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, client_id uuid NOT NULL,
 subject_ref text NOT NULL CHECK(subject_ref ~ '^[a-f0-9]{64}$'), identity_ciphertext text NOT NULL,
 purpose text NOT NULL CHECK(length(purpose) BETWEEN 3 AND 500), legal_text text NOT NULL, legal_version text NOT NULL,
 legal_sha256 text NOT NULL CHECK(legal_sha256 ~ '^[a-f0-9]{64}$'), ip_ciphertext text NOT NULL, user_agent_ciphertext text NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES auth.users(id), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,client_id) REFERENCES gen_auditor.clients(tenant_id,id)
);
CREATE TABLE gen_auditor.consent_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, consent_id uuid NOT NULL,
 event text NOT NULL CHECK(event IN ('withdrawn','restriction_requested')), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,consent_id) REFERENCES gen_auditor.consents(tenant_id,id)
);
CREATE TABLE gen_auditor.arco_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, client_id uuid NOT NULL,
 subject_ref text NOT NULL, identity_ciphertext text NOT NULL, right_type text NOT NULL CHECK(right_type IN ('access','rectification','erasure','opposition','portability')),
 state text NOT NULL DEFAULT 'identity_pending' CHECK(state IN ('identity_pending','received','forwarded','closed_external')),
 upstream_request_id text, legal_regime text NOT NULL, due_at timestamptz,
 description_ciphertext text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,client_id) REFERENCES gen_auditor.clients(tenant_id,id)
);
CREATE FUNCTION gen_auditor.my_tenants() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,gen_auditor AS $$ SELECT coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'role',m.role)),'[]') FROM gen_auditor.tenants t JOIN gen_auditor.tenant_members m ON m.tenant_id=t.id WHERE m.user_id=gen_auditor.actor_id() AND m.active $$;
CREATE TABLE gen_auditor.controls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES gen_auditor.tenants(id),
 framework text NOT NULL, reference text NOT NULL, title text NOT NULL, created_by uuid NOT NULL REFERENCES auth.users(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','evidence','verified','not_applicable')),
 evidence_ref text NOT NULL DEFAULT '', reviewed_at timestamptz, reviewed_by uuid REFERENCES auth.users(id),
 UNIQUE(tenant_id,framework,reference), CHECK(status<>'verified' OR (reviewed_by IS NOT NULL AND reviewed_by<>created_by AND reviewed_at IS NOT NULL AND length(evidence_ref)>=10))
);
CREATE TABLE gen_auditor.risks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES gen_auditor.tenants(id),
 title text NOT NULL, severity text NOT NULL CHECK(severity IN ('critical','high','medium','low')),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','mitigated','accepted')), due_at timestamptz
);
CREATE TABLE gen_auditor.anomalies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES gen_auditor.tenants(id),
 title text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gen_auditor.eipds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES gen_auditor.tenants(id),
 title text NOT NULL, processing_purpose text NOT NULL, risk_summary text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','in_review')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gen_auditor.anonymization_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES gen_auditor.tenants(id),
 title text NOT NULL, dataset_ref text NOT NULL, method text NOT NULL, status text NOT NULL DEFAULT 'proposed' CHECK(status='proposed'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gen_auditor.incidents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES gen_auditor.tenants(id),
 title text NOT NULL, known_at timestamptz NOT NULL, obligated boolean NOT NULL, oiv boolean NOT NULL, essential_affected boolean NOT NULL,
 early_sent_at timestamptz, update_sent_at timestamptz, final_sent_at timestamptz, resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gen_auditor.audit_heads (
 tenant_id uuid PRIMARY KEY REFERENCES gen_auditor.tenants(id), seq bigint NOT NULL DEFAULT 0,
 head_hash text NOT NULL DEFAULT repeat('0',64)
);
CREATE TABLE gen_auditor.audit_logs (
 tenant_id uuid NOT NULL REFERENCES gen_auditor.tenants(id), seq bigint NOT NULL, actor_id uuid NOT NULL,
 action text NOT NULL, entity_id uuid, occurred_at timestamptz NOT NULL, metadata jsonb NOT NULL,
 previous_hash text NOT NULL, entry_hash text NOT NULL, canonical_payload text NOT NULL,
 PRIMARY KEY(tenant_id,seq), UNIQUE(tenant_id,entry_hash)
);
CREATE TABLE gen_auditor.reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, client_id uuid NOT NULL,
 report_code text NOT NULL, pdf bytea NOT NULL, manifest jsonb NOT NULL, signature text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES auth.users(id),
 FOREIGN KEY(tenant_id,client_id) REFERENCES gen_auditor.clients(tenant_id,id)
);
CREATE INDEX domains_client ON gen_auditor.domains(tenant_id,client_id);
CREATE INDEX scan_latest ON gen_auditor.scans(tenant_id,domain_id,started_at DESC);
CREATE INDEX vuln_due ON gen_auditor.vulnerabilities(tenant_id,status,due_at);
CREATE INDEX requests_due ON gen_auditor.arco_requests(tenant_id,state,due_at);
CREATE INDEX consent_subject ON gen_auditor.consents(tenant_id,subject_ref,accepted_at DESC);
CREATE INDEX audit_recent ON gen_auditor.audit_logs(tenant_id,occurred_at DESC);
CREATE FUNCTION gen_auditor.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'append_only'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['audit_logs','consents','consent_events','reports'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON gen_auditor.%I FOR EACH ROW EXECUTE FUNCTION gen_auditor.reject_mutation()',t);
 EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON gen_auditor.%I FOR EACH STATEMENT EXECUTE FUNCTION gen_auditor.reject_mutation()',t);
 END LOOP;
END $$;
CREATE FUNCTION gen_auditor.append_audit(p_action text,p_entity uuid DEFAULT NULL,p_metadata jsonb DEFAULT '{}') RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gen_auditor AS $$
DECLARE t uuid:=gen_auditor.tenant_id(); a uuid:=gen_auditor.actor_id(); h gen_auditor.audit_heads; stamp timestamptz:=clock_timestamp(); payload text; result text;
BEGIN
 IF NOT gen_auditor.has_role(t,ARRAY['owner','security','privacy','auditor','reader']) THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF p_action !~ '^[a-z][a-z0-9_.]{1,80}$' OR jsonb_typeof(p_metadata)<>'object' OR octet_length(p_metadata::text)>8192 THEN RAISE EXCEPTION 'invalid_event'; END IF;
 INSERT INTO gen_auditor.audit_heads(tenant_id) VALUES(t) ON CONFLICT DO NOTHING;
 SELECT * INTO h FROM gen_auditor.audit_heads WHERE tenant_id=t FOR UPDATE;
 payload:=jsonb_build_object('v',1,'tenant_id',t,'seq',h.seq+1,'actor_id',a,'action',p_action,'entity_id',p_entity,'occurred_at',to_char(stamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'metadata',p_metadata)::text;
 result:=encode(sha256(convert_to(h.head_hash||E'\n'||payload,'UTF8')),'hex');
 INSERT INTO gen_auditor.audit_logs VALUES(t,h.seq+1,a,p_action,p_entity,stamp,p_metadata,h.head_hash,result,payload);
 UPDATE gen_auditor.audit_heads SET seq=h.seq+1,head_hash=result WHERE tenant_id=t;
 RETURN result;
END $$;
CREATE FUNCTION gen_auditor.verify_audit() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,gen_auditor AS $$
DECLARE t uuid:=gen_auditor.tenant_id(); r gen_auditor.audit_logs; prev text:=repeat('0',64); n bigint:=0; h gen_auditor.audit_heads;
BEGIN
 IF NOT gen_auditor.has_role(t,ARRAY['owner','security','privacy','auditor','reader']) THEN RAISE EXCEPTION 'forbidden'; END IF;
 FOR r IN SELECT * FROM gen_auditor.audit_logs WHERE tenant_id=t ORDER BY seq LOOP
 n:=n+1;
 IF r.seq<>n OR r.previous_hash<>prev OR r.entry_hash<>encode(sha256(convert_to(prev||E'\n'||r.canonical_payload,'UTF8')),'hex')
 OR r.canonical_payload::jsonb IS DISTINCT FROM jsonb_build_object('v',1,'tenant_id',r.tenant_id,'seq',r.seq,'actor_id',r.actor_id,'action',r.action,'entity_id',r.entity_id,'occurred_at',to_char(r.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'metadata',r.metadata) THEN RETURN false; END IF;
 prev:=r.entry_hash;
 END LOOP;
 SELECT * INTO h FROM gen_auditor.audit_heads WHERE tenant_id=t;
 RETURN coalesce((n=0 AND h.tenant_id IS NULL) OR (h.seq=n AND h.head_hash=prev),false);
END $$;
-- Membership is readable only by its own subject. SECURITY DEFINER helper avoids recursive RLS.
ALTER TABLE gen_auditor.tenant_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_self ON gen_auditor.tenant_members FOR SELECT USING(user_id=gen_auditor.actor_id() AND active);
ALTER TABLE gen_auditor.tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON gen_auditor.tenants FOR SELECT USING(gen_auditor.has_role(id,ARRAY['owner','security','privacy','auditor','reader']));
DO $$ DECLARE t text; writers text[]; insert_writers text[]; BEGIN
 FOREACH t IN ARRAY ARRAY['clients','domains','scan_authorizations','scans','vulnerabilities','consents','consent_events','arco_requests','controls','risks','anomalies','eipds','anonymization_plans','incidents','reports','audit_logs','audit_heads'] LOOP
 EXECUTE format('ALTER TABLE gen_auditor.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_read ON gen_auditor.%I FOR SELECT USING(gen_auditor.has_role(tenant_id,ARRAY[''owner'',''security'',''privacy'',''auditor'',''reader'']))',t);
 IF t IN ('audit_logs','audit_heads') THEN CONTINUE; END IF;
 writers:=CASE WHEN t='controls' THEN ARRAY['owner','security','auditor'] WHEN t IN ('consents','consent_events','arco_requests','eipds','anonymization_plans') THEN ARRAY['owner','privacy'] ELSE ARRAY['owner','security'] END;
 insert_writers:=CASE WHEN t='controls' THEN ARRAY['owner','security'] ELSE writers END;
 EXECUTE format('CREATE POLICY tenant_insert ON gen_auditor.%I FOR INSERT WITH CHECK(gen_auditor.has_role(tenant_id,%L::text[]))',t,insert_writers);
 IF t NOT IN ('consents','consent_events','reports') THEN
 EXECUTE format('CREATE POLICY tenant_update ON gen_auditor.%I FOR UPDATE USING(gen_auditor.has_role(tenant_id,%L::text[])) WITH CHECK(gen_auditor.has_role(tenant_id,%L::text[]))',t,writers,writers);
 END IF;
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA gen_auditor FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gen_auditor FROM PUBLIC;
-- Runtime grants live in 002_runtime_role.sql; no grant to anon/authenticated/service_role.
COMMIT;
