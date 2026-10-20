-- Migración aditiva: se carga DESPUÉS de sql/schema.sql (db.exec de ambos, en orden).
-- Unifica la cadena de evidencia de ARCO y añade consentimiento, bloqueo/supresión y anonimización.
-- Postura: ARCOP no borra datos. Ordena, sella y registra el comprobante que devuelve el sistema anfitrión.
-- La PII se cifra en Node (src/crypto.js). Aquí solo se reciben textos ya cifrados.
BEGIN;
-- ---------------------------------------------------------------------------------------------
-- 1. Cadena de evidencia unificada (request, consent, execution, erasure)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE arcop.evidence_chains(tenant_id uuid NOT NULL REFERENCES arcop.tenants(id),entity_type text NOT NULL CHECK(entity_type IN ('request','consent','execution','erasure')),entity_id uuid NOT NULL,seq bigint NOT NULL DEFAULT 0,head_hash text NOT NULL DEFAULT repeat('0',64),PRIMARY KEY(tenant_id,entity_type,entity_id));
CREATE TABLE arcop.evidence_events(tenant_id uuid NOT NULL,entity_type text NOT NULL CHECK(entity_type IN ('request','consent','execution','erasure')),entity_id uuid NOT NULL,seq bigint NOT NULL,action text NOT NULL,actor text NOT NULL,occurred_at timestamptz NOT NULL,metadata jsonb NOT NULL,previous_hash text NOT NULL,event_hash text NOT NULL,canonical text NOT NULL,PRIMARY KEY(tenant_id,entity_type,entity_id,seq),UNIQUE(tenant_id,event_hash),FOREIGN KEY(tenant_id,entity_type,entity_id) REFERENCES arcop.evidence_chains(tenant_id,entity_type,entity_id));
CREATE TRIGGER evidence_immutable BEFORE UPDATE OR DELETE ON arcop.evidence_events FOR EACH ROW EXECUTE FUNCTION arcop.no_mutation();
CREATE TRIGGER evidence_no_truncate BEFORE TRUNCATE ON arcop.evidence_events FOR EACH STATEMENT EXECUTE FUNCTION arcop.no_mutation();
-- append_evidence: serializa por entidad con FOR UPDATE sobre la fila de la cadena.
CREATE FUNCTION arcop.append_evidence(etype text,eid uuid,action text,data jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,arcop AS $$
DECLARE c arcop.evidence_chains;stamp timestamptz:=clock_timestamp();payload text;h text;
BEGIN
 IF etype NOT IN ('request','consent','execution','erasure') THEN RAISE EXCEPTION 'invalid_entity_type'; END IF;
 IF action !~ '^[a-z_.]{2,60}$' OR data IS NULL OR jsonb_typeof(data)<>'object' OR octet_length(data::text)>4096 THEN RAISE EXCEPTION 'invalid_event'; END IF;
 IF NOT arcop.allowed(arcop.tenant(),ARRAY['admin','receiver','resolver']) THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF etype='request' AND NOT EXISTS(SELECT 1 FROM arcop.requests WHERE id=eid AND tenant_id=arcop.tenant()) THEN RAISE EXCEPTION 'not_found'; END IF;
 INSERT INTO arcop.evidence_chains(tenant_id,entity_type,entity_id) VALUES(arcop.tenant(),etype,eid) ON CONFLICT DO NOTHING;
 SELECT * INTO c FROM arcop.evidence_chains WHERE tenant_id=arcop.tenant() AND entity_type=etype AND entity_id=eid FOR UPDATE;
 payload:=jsonb_build_object('v',1,'entity_type',etype,'entity_id',eid,'tenant_id',c.tenant_id,'seq',c.seq+1,'actor',arcop.actor(),'action',action,'at',to_char(stamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'metadata',data)::text;
 h:=encode(sha256(convert_to(c.head_hash||E'\n'||payload,'UTF8')),'hex');
 INSERT INTO arcop.evidence_events VALUES(c.tenant_id,etype,eid,c.seq+1,action,arcop.actor(),stamp,data,c.head_hash,h,payload);
 UPDATE arcop.evidence_chains SET seq=c.seq+1,head_hash=h WHERE tenant_id=c.tenant_id AND entity_type=etype AND entity_id=eid;
 RETURN h;
END $$;
-- verify_evidence_chain: devuelve el eslabón roto, no un booleano.
CREATE FUNCTION arcop.verify_evidence_chain(etype text,eid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,arcop AS $$
DECLARE c arcop.evidence_chains;e arcop.evidence_events;prev text:=repeat('0',64);n bigint:=0;ents jsonb:='[]'::jsonb;ok boolean:=true;bat bigint;rsn text;
BEGIN
 IF etype NOT IN ('request','consent','execution','erasure') THEN RAISE EXCEPTION 'invalid_entity_type'; END IF;
 SELECT * INTO c FROM arcop.evidence_chains WHERE tenant_id=arcop.tenant() AND entity_type=etype AND entity_id=eid;
 IF c.entity_id IS NULL THEN RETURN jsonb_build_object('ok',false,'broken_at',0,'reason','sin_cadena','entries','[]'::jsonb); END IF;
 IF NOT arcop.allowed(c.tenant_id,ARRAY['admin','receiver','resolver','auditor']) THEN RAISE EXCEPTION 'forbidden'; END IF;
 FOR e IN SELECT * FROM arcop.evidence_events WHERE tenant_id=c.tenant_id AND entity_type=etype AND entity_id=eid ORDER BY seq LOOP
  n:=n+1;
  IF e.seq<>n THEN ok:=false;bat:=e.seq;rsn:='secuencia_rota';
  ELSIF e.previous_hash<>prev THEN ok:=false;bat:=e.seq;rsn:='enlace_previo_incorrecto';
  ELSIF e.event_hash<>encode(sha256(convert_to(prev||E'\n'||e.canonical,'UTF8')),'hex') THEN ok:=false;bat:=e.seq;rsn:='hash_incorrecto';
  ELSIF e.canonical::jsonb IS DISTINCT FROM jsonb_build_object('v',1,'entity_type',e.entity_type,'entity_id',e.entity_id,'tenant_id',e.tenant_id,'seq',e.seq,'actor',e.actor,'action',e.action,'at',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'metadata',e.metadata) THEN ok:=false;bat:=e.seq;rsn:='metadatos_alterados';
  END IF;
  prev:=e.event_hash;
  ents:=ents||jsonb_build_object('seq',e.seq,'action',e.action,'at',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'event_hash',e.event_hash);
  EXIT WHEN NOT ok;
 END LOOP;
 IF ok AND (n<>c.seq OR prev<>c.head_hash) THEN ok:=false;bat:=n+1;rsn:='cadena_incompleta'; END IF;
 RETURN jsonb_build_object('ok',ok,'broken_at',CASE WHEN ok THEN NULL ELSE bat END,'reason',CASE WHEN ok THEN NULL ELSE rsn END,'entries',ents);
END $$;
-- Compatibilidad: service.js sigue llamando append_event(rid,kind,data).
CREATE OR REPLACE FUNCTION arcop.append_event(rid uuid,kind text,data jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,arcop AS $$
DECLARE r arcop.requests;stamp timestamptz:=clock_timestamp();payload text;h text;
BEGIN
 SELECT * INTO r FROM arcop.requests WHERE id=rid AND tenant_id=arcop.tenant() FOR UPDATE;
 IF r.id IS NULL OR NOT arcop.allowed(r.tenant_id,ARRAY['admin','receiver','resolver']) THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF kind !~ '^[a-z_.]{2,60}$' OR jsonb_typeof(data)<>'object' OR octet_length(data::text)>4096 THEN RAISE EXCEPTION 'invalid_event'; END IF;
 payload:=jsonb_build_object('v',1,'request_id',rid,'tenant_id',r.tenant_id,'seq',r.seq+1,'actor',arcop.actor(),'action',kind,'at',to_char(stamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'metadata',data)::text;
 h:=encode(sha256(convert_to(r.head_hash||E'\n'||payload,'UTF8')),'hex');
 INSERT INTO arcop.events VALUES(r.tenant_id,rid,r.seq+1,kind,arcop.actor(),stamp,data,r.head_hash,h,payload);
 UPDATE arcop.requests SET seq=r.seq+1,head_hash=h WHERE id=rid;
 PERFORM arcop.append_evidence('request',rid,kind,data);
 RETURN h;
END $$;
-- BACKFILL OPCIONAL (no se ejecuta; requiere ventana de mantenimiento y revisión humana):
--  1) Crear la cadena unificada por solicitud. Arranca en el punto de corte de esta migración:
--     el histórico previo sigue verificable con arcop.verify_chain(rid) sobre arcop.events.
--  2) Re-sellar arcop.events en orden cronológico dentro de la cadena nueva (el hash cambia de
--     formato: entity_type/entity_id sustituyen a request_id, así que las cabeceras no se copian):
--     INSERT INTO arcop.evidence_events(tenant_id,entity_type,entity_id,seq,action,actor,occurred_at,metadata,previous_hash,event_hash,canonical)
--     WITH o AS (SELECT tenant_id,request_id,row_number() OVER(PARTITION BY tenant_id,request_id ORDER BY seq) n FROM arcop.events)
--     ... rehacer prev/h en RECURSIVE CTE y terminar con UPDATE arcop.evidence_chains SET seq,head_hash.
--  3) Verificar cada cadena (ok=true) antes de retirar la bitácora antigua.

-- ---------------------------------------------------------------------------------------------
-- 2. Texto legal versionado. El hash se calcula en el servidor sobre el texto publicado.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE arcop.consent_definitions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES arcop.tenants(id),code text NOT NULL,purpose text NOT NULL,required boolean NOT NULL DEFAULT false,retention_until date,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,code));
CREATE TABLE arcop.consent_texts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES arcop.tenants(id),definition_id uuid NOT NULL REFERENCES arcop.consent_definitions(id),version int NOT NULL CHECK(version>0),locale text NOT NULL DEFAULT 'es',body text NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 65536),legal_sha256 text NOT NULL CHECK(legal_sha256 ~ '^[a-f0-9]{64}$'),status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','retired')),published_at timestamptz,published_by text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,definition_id,version),CHECK(status<>'published' OR (published_at IS NOT NULL AND published_by IS NOT NULL)));
CREATE UNIQUE INDEX consent_texts_one_published ON arcop.consent_texts(tenant_id,definition_id) WHERE status='published';
-- El texto publicado y su hash son inmutables: sólo se permite retirarlo (published -> retired).
CREATE FUNCTION arcop.text_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'append_only'; END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.body IS DISTINCT FROM OLD.body OR NEW.legal_sha256 IS DISTINCT FROM OLD.legal_sha256 OR NEW.version IS DISTINCT FROM OLD.version OR NEW.locale IS DISTINCT FROM OLD.locale OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.published_by IS DISTINCT FROM OLD.published_by THEN RAISE EXCEPTION 'texto_publicado_inmutable'; END IF;
 IF OLD.status<>'published' OR NEW.status<>'retired' THEN RAISE EXCEPTION 'transicion_texto_no_permitida'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER text_lifecycle_check BEFORE UPDATE ON arcop.consent_texts FOR EACH ROW EXECUTE FUNCTION arcop.text_lifecycle();
CREATE TRIGGER text_no_delete BEFORE DELETE ON arcop.consent_texts FOR EACH ROW EXECUTE FUNCTION arcop.no_mutation();
CREATE TRIGGER text_no_truncate BEFORE TRUNCATE ON arcop.consent_texts FOR EACH STATEMENT EXECUTE FUNCTION arcop.no_mutation();

-- ---------------------------------------------------------------------------------------------
-- 3. Consentimientos. capture_method separa la captura real del titular de la declarada por un tercero.
--    evidence_strength es derivada en la base: no la puede fijar el cliente ni el servicio.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE arcop.consents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES arcop.tenants(id),definition_id uuid NOT NULL REFERENCES arcop.consent_definitions(id),text_id uuid NOT NULL REFERENCES arcop.consent_texts(id),subject_ref text NOT NULL CHECK(subject_ref ~ '^[a-f0-9]{64}$'),identity_ciphertext text NOT NULL,ip_ciphertext text,user_agent_ciphertext text,legal_version int NOT NULL CHECK(legal_version>0),legal_sha256 text NOT NULL CHECK(legal_sha256 ~ '^[a-f0-9]{64}$'),legal_text_snapshot text NOT NULL,granted_at timestamptz NOT NULL,capture_method text NOT NULL CHECK(capture_method IN ('arcop_capture','host_forwarded','host_asserted','operator_entered')),evidence_strength text GENERATED ALWAYS AS(CASE WHEN capture_method='arcop_capture' THEN 'strong' ELSE 'declared' END) STORED,idempotency_key uuid NOT NULL,request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),registered_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,idempotency_key));
CREATE TRIGGER consent_immutable BEFORE UPDATE OR DELETE ON arcop.consents FOR EACH ROW EXECUTE FUNCTION arcop.no_mutation();
CREATE TRIGGER consent_no_truncate BEFORE TRUNCATE ON arcop.consents FOR EACH STATEMENT EXECUTE FUNCTION arcop.no_mutation();
CREATE TABLE arcop.consent_actions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES arcop.tenants(id),consent_id uuid NOT NULL,action text NOT NULL CHECK(action IN ('withdrawn','restricted')),scope text,reason text,action_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(action_evidence)='object' AND octet_length(action_evidence::text)<=4096),actor text NOT NULL,occurred_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,consent_id) REFERENCES arcop.consents(tenant_id,id));
CREATE TRIGGER consent_action_immutable BEFORE UPDATE OR DELETE ON arcop.consent_actions FOR EACH ROW EXECUTE FUNCTION arcop.no_mutation();
CREATE TRIGGER consent_action_no_truncate BEFORE TRUNCATE ON arcop.consent_actions FOR EACH STATEMENT EXECUTE FUNCTION arcop.no_mutation();
-- Publicación de texto: el hash se calcula aquí sobre los bytes que quedan almacenados, nunca
-- sobre lo que declara el cliente. Publicar una versión nueva retira la anterior en la misma transacción.
CREATE FUNCTION arcop.publish_consent_text(dcode text,ver int,locale text,body text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,arcop AS $$
DECLARE d arcop.consent_definitions;tid uuid;sha text;
BEGIN
 IF NOT arcop.allowed(arcop.tenant(),ARRAY['admin']) THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF ver<1 OR locale !~ '^[a-zA-Z-]{2,10}$' OR octet_length(body) NOT BETWEEN 50 AND 20000 THEN RAISE EXCEPTION 'invalid_text'; END IF;
 SELECT * INTO d FROM arcop.consent_definitions WHERE tenant_id=arcop.tenant() AND code=dcode FOR UPDATE;
 IF d.id IS NULL THEN RAISE EXCEPTION 'definition_not_found'; END IF;
 IF EXISTS(SELECT 1 FROM arcop.consent_texts WHERE tenant_id=arcop.tenant() AND definition_id=d.id AND version=ver) THEN RAISE EXCEPTION 'version_exists'; END IF;
 UPDATE arcop.consent_texts SET status='retired' WHERE tenant_id=arcop.tenant() AND definition_id=d.id AND status='published';
 sha:=encode(sha256(convert_to(body,'UTF8')),'hex');tid:=gen_random_uuid();
 INSERT INTO arcop.consent_texts(id,tenant_id,definition_id,version,locale,body,legal_sha256,status,published_at,published_by) VALUES(tid,arcop.tenant(),d.id,ver,locale,body,sha,'published',clock_timestamp(),arcop.actor());
 RETURN jsonb_build_object('id',tid,'definition_code',dcode,'version',ver,'locale',locale,'legal_sha256',sha,'status','published');
END $$;
-- Registro: el hash y el texto vendrán SIEMPRE de la versión publicada; el cliente no los envía.
CREATE FUNCTION arcop.register_consent(dcode text,sref text,identity_ct text,ip_ct text,ua_ct text,granted timestamptz,method text,idem uuid,fingerprint text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,arcop AS $$
DECLARE d arcop.consent_definitions;t arcop.consent_texts;cid uuid;h text;
BEGIN
 IF NOT arcop.allowed(arcop.tenant(),ARRAY['admin','receiver']) THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF dcode !~ '^[a-z0-9_.]{2,80}$' OR sref !~ '^[a-f0-9]{64}$' OR fingerprint !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_consent'; END IF;
 IF method='operator_entered' AND (ip_ct IS NOT NULL OR ua_ct IS NOT NULL) THEN RAISE EXCEPTION 'ip_de_operador_no_es_del_titular'; END IF;
 IF method='arcop_capture' AND (ip_ct IS NULL OR ua_ct IS NULL) THEN RAISE EXCEPTION 'captura_arcop_requiere_ip_y_agente'; END IF;
 SELECT * INTO d FROM arcop.consent_definitions WHERE tenant_id=arcop.tenant() AND code=dcode FOR UPDATE;
 IF d.id IS NULL THEN RAISE EXCEPTION 'definition_not_found'; END IF;
 SELECT * INTO t FROM arcop.consent_texts WHERE tenant_id=arcop.tenant() AND definition_id=d.id AND status='published' FOR UPDATE;
 IF t.id IS NULL THEN RAISE EXCEPTION 'legal_text_not_published'; END IF;
 IF t.legal_sha256<>encode(sha256(convert_to(t.body,'UTF8')),'hex') THEN RAISE EXCEPTION 'legal_text_hash_mismatch'; END IF;
 cid:=gen_random_uuid();
 INSERT INTO arcop.consents(id,tenant_id,definition_id,text_id,subject_ref,identity_ciphertext,ip_ciphertext,user_agent_ciphertext,legal_version,legal_sha256,legal_text_snapshot,granted_at,capture_method,idempotency_key,request_fingerprint,registered_by)
 VALUES(cid,arcop.tenant(),d.id,t.id,sref,identity_ct,ip_ct,ua_ct,t.version,t.legal_sha256,t.body,coalesce(granted,clock_timestamp()),method,idem,fingerprint,arcop.actor());
 h:=arcop.append_evidence('consent',cid,'consent_granted',jsonb_build_object('definition',d.code,'legal_version',t.version,'legal_sha256',t.legal_sha256,'granted_at',to_char(coalesce(granted,clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'capture_method',method,'evidence_strength',CASE WHEN method='arcop_capture' THEN 'strong' ELSE 'declared' END,'locale',t.locale));
 RETURN jsonb_build_object('id',cid,'definition_code',d.code,'legal_version',t.version,'legal_sha256',t.legal_sha256,'locale',t.locale,'capture_method',method,'evidence_strength',CASE WHEN method='arcop_capture' THEN 'strong' ELSE 'declared' END,'head_hash',h);
END $$;
-- Retirada o restricción: evento adicional. El grant original nunca se reescribe.
CREATE FUNCTION arcop.record_consent_action(cid uuid,kind text,ascope text,areason text,data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,arcop AS $$
DECLARE aid uuid;h text;effective text;
BEGIN
 IF NOT arcop.allowed(arcop.tenant(),ARRAY['admin','receiver']) THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF kind NOT IN ('withdrawn','restricted') THEN RAISE EXCEPTION 'invalid_action'; END IF;
 IF data IS NULL OR jsonb_typeof(data)<>'object' OR octet_length(data::text)>4096 THEN RAISE EXCEPTION 'invalid_event'; END IF;
 PERFORM 1 FROM arcop.consents WHERE tenant_id=arcop.tenant() AND id=cid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
 SELECT coalesce((SELECT a.action FROM arcop.consent_actions a WHERE a.tenant_id=arcop.tenant() AND a.consent_id=cid ORDER BY a.occurred_at DESC,a.id DESC LIMIT 1),'active') INTO effective;
 IF effective='withdrawn' THEN RAISE EXCEPTION 'consent_withdrawn'; END IF;
 IF effective='restricted' AND kind='restricted' THEN RAISE EXCEPTION 'consent_already_restricted'; END IF;
 aid:=gen_random_uuid();
 INSERT INTO arcop.consent_actions(tenant_id,consent_id,action,scope,reason,action_evidence,actor) VALUES(arcop.tenant(),cid,kind,ascope,areason,coalesce(data,'{}'::jsonb),arcop.actor());
 h:=arcop.append_evidence('consent',cid,kind,data);
 RETURN jsonb_build_object('action_id',aid,'consent_id',cid,'action',kind,'status',kind,'head_hash',h);
END $$;
-- Estado efectivo derivado: el último consent_actions; nunca una columna mutable.
CREATE VIEW arcop.consent_state WITH (security_invoker=true) AS SELECT c.id,c.tenant_id,c.definition_id,c.text_id,c.subject_ref,c.legal_version,c.legal_sha256,c.legal_text_snapshot,c.granted_at,c.capture_method,c.evidence_strength,c.registered_by,coalesce((SELECT a.action FROM arcop.consent_actions a WHERE a.tenant_id=c.tenant_id AND a.consent_id=c.id ORDER BY a.occurred_at DESC,a.id DESC LIMIT 1),'active') AS status FROM arcop.consents c;

-- ---------------------------------------------------------------------------------------------
-- 4. Bloqueo, supresión y anonimización. ARCOP ordena; el anfitrión ejecuta y devuelve comprobante.
--    Las reglas de estado se expresan con CHECK sobre columnas de la misma tabla (PostgreSQL no
--    permite subconsultas dentro de un CHECK); lo que requiera otras tablas vive en funciones.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE arcop.host_adapters(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES arcop.tenants(id),code text NOT NULL CHECK(code ~ '^[a-z0-9_.]{2,80}$'),kind text NOT NULL CHECK(kind IN ('block','suppress','anonymize','export')),endpoint_url text NOT NULL CHECK(endpoint_url ~ '^https://'),auth_ref text NOT NULL,timeout_ms int NOT NULL DEFAULT 10000 CHECK(timeout_ms BETWEEN 1000 AND 60000),status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,code));
CREATE TABLE arcop.subject_systems(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES arcop.tenants(id),code text NOT NULL CHECK(code ~ '^[a-z0-9_.]{2,80}$'),adapter_id uuid NOT NULL REFERENCES arcop.host_adapters(id),system_type text NOT NULL CHECK(system_type IN ('crm','billing','analytics','warehouse','backup','support','other')),data_class text NOT NULL DEFAULT 'personal' CHECK(data_class IN ('personal','sensitive')),owner text,registered_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,code));
CREATE TABLE arcop.subject_actions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES arcop.tenants(id),consent_id uuid,request_id uuid,
 adapter_id uuid NOT NULL REFERENCES arcop.host_adapters(id),subject_system_id uuid NOT NULL REFERENCES arcop.subject_systems(id),
 entity_type text NOT NULL CHECK(entity_type IN ('request','consent','execution','erasure')),entity_id uuid NOT NULL,subject_ref text CHECK(subject_ref IS NULL OR subject_ref ~ '^[a-f0-9]{64}$'),
 operation text NOT NULL CHECK(operation IN ('block','unblock','suppress','restore','anonymize','export')),legal_profile text NOT NULL,
 status text NOT NULL DEFAULT 'ordered' CHECK(status IN ('ordered','dispatched','accepted','completed','failed','rejected')),
 receipt_ref text,receipt_sha256 text CHECK(receipt_sha256 IS NULL OR receipt_sha256 ~ '^[a-f0-9]{64}$'),
 reident_report_sha256 text CHECK(reident_report_sha256 IS NULL OR reident_report_sha256 ~ '^[a-f0-9]{64}$'),reident_tester text,reident_tester_role text,reident_checked_at timestamptz,
 ordered_by text NOT NULL,ordered_at timestamptz NOT NULL DEFAULT now(),dispatched_at timestamptz,completed_at timestamptz,completed_by text,failure_reason text,
 -- Sin comprobante del anfitrión no se declara completada. Sin informe de reidentificación y revisor, tampoco.
 CHECK(status<>'completed' OR receipt_sha256 IS NOT NULL),
 CHECK(operation<>'anonymize' OR status<>'accepted' OR (reident_report_sha256 IS NOT NULL AND reident_tester IS NOT NULL AND reident_tester_role IS NOT NULL AND reident_checked_at IS NOT NULL)),
 CHECK(status<>'completed' OR completed_by IS NOT NULL)
);
CREATE INDEX subject_actions_open ON arcop.subject_actions(tenant_id,status,ordered_at DESC);
CREATE TABLE arcop.retention_exceptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES arcop.tenants(id),subject_ref text NOT NULL CHECK(subject_ref ~ '^[a-f0-9]{64}$'),scope text NOT NULL CHECK(octet_length(scope) BETWEEN 1 AND 500),legal_basis text NOT NULL CHECK(octet_length(legal_basis) BETWEEN 10 AND 2000),reason text NOT NULL CHECK(octet_length(reason) BETWEEN 10 AND 2000),legal_profile text NOT NULL,granted_by text NOT NULL,granted_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL CHECK(expires_at>granted_at),UNIQUE(tenant_id,subject_ref,scope));
CREATE TABLE arcop.anonymization_jobs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES arcop.tenants(id),subject_ref text NOT NULL CHECK(subject_ref ~ '^[a-f0-9]{64}$'),request_id uuid,consent_id uuid,
 strategy text NOT NULL CHECK(strategy IN ('pseudonymize','suppress','crypto_shred')),scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(scope)='object'),systems text NOT NULL,
 status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','ordered','accepted','completed','failed')),
 action_id uuid REFERENCES arcop.subject_actions(id),reident_report_sha256 text CHECK(reident_report_sha256 IS NULL OR reident_report_sha256 ~ '^[a-f0-9]{64}$'),reviewed_by text,reviewed_at timestamptz,receipt_sha256 text CHECK(receipt_sha256 IS NULL OR receipt_sha256 ~ '^[a-f0-9]{64}$'),
 created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 -- Una anonimización no pasa a 'accepted' sin informe de reidentificación y revisor responsable.
 CHECK(status<>'accepted' OR (reident_report_sha256 IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
 CHECK(status<>'completed' OR receipt_sha256 IS NOT NULL)
);
CREATE INDEX anonymization_jobs_open ON arcop.anonymization_jobs(tenant_id,status,created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- 5. Perfiles legales versionados: una sola versión vigente por código y ejecución bloqueada sin perfil aprobado.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE arcop.legal_profiles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES arcop.tenants(id),code text NOT NULL CHECK(code ~ '^[a-z0-9_.]{2,80}$'),version int NOT NULL CHECK(version>0),jurisdiction text NOT NULL,summary text NOT NULL CHECK(octet_length(summary) BETWEEN 10 AND 4000),status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','superseded')),approved_by text,approved_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,code,version),CHECK(status<>'active' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)));
CREATE UNIQUE INDEX legal_profiles_one_active ON arcop.legal_profiles(tenant_id,code) WHERE status='active';
CREATE TABLE arcop.legal_profile_rules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),profile_id uuid NOT NULL REFERENCES arcop.legal_profiles(id) ON DELETE RESTRICT,rule_key text NOT NULL CHECK(rule_key ~ '^[a-z0-9_.]{2,60}$'),rule_value jsonb NOT NULL CHECK(jsonb_typeof(rule_value)<>'null'),note text,UNIQUE(profile_id,rule_key));
CREATE FUNCTION arcop.assert_profile_ready(pcode text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,arcop AS $$
DECLARE p arcop.legal_profiles;
BEGIN
 IF pcode IS NULL OR pcode='' OR pcode='review_required' THEN RAISE EXCEPTION 'legal_profile_not_reviewed'; END IF;
 SELECT * INTO p FROM arcop.legal_profiles WHERE tenant_id=arcop.tenant() AND code=pcode AND status='active';
 IF p.id IS NULL THEN RAISE EXCEPTION 'legal_profile_not_reviewed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM arcop.legal_profile_rules WHERE profile_id=p.id) THEN RAISE EXCEPTION 'legal_profile_without_rules'; END IF;
 RETURN true;
END $$;
-- Ordenar una acción de bloqueo/supresión/anonimización: exige perfil vigente y abre la cadena execution|erasure.
CREATE FUNCTION arcop.order_subject_action(pcode text,sysid uuid,adapterid uuid,op text,consent uuid,request uuid,entity_type text,entity_id uuid,sref text,data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,arcop AS $$
DECLARE aid uuid;h text;
BEGIN
 IF NOT arcop.allowed(arcop.tenant(),ARRAY['admin','resolver']) THEN RAISE EXCEPTION 'forbidden'; END IF;
 PERFORM arcop.assert_profile_ready(pcode);
 IF op NOT IN ('block','unblock','suppress','restore','anonymize','export') OR entity_type NOT IN ('request','consent','execution','erasure') THEN RAISE EXCEPTION 'invalid_action'; END IF;
 IF NOT EXISTS(SELECT 1 FROM arcop.subject_systems s JOIN arcop.host_adapters a ON a.id=s.adapter_id WHERE s.id=sysid AND s.tenant_id=arcop.tenant() AND a.id=adapterid AND a.tenant_id=arcop.tenant() AND a.status='active') THEN RAISE EXCEPTION 'adapter_not_available'; END IF;
 aid:=gen_random_uuid();
 INSERT INTO arcop.subject_actions(tenant_id,consent_id,request_id,adapter_id,subject_system_id,entity_type,entity_id,subject_ref,operation,legal_profile,ordered_by) VALUES(arcop.tenant(),consent,request,adapterid,sysid,entity_type,entity_id,sref,op,pcode,arcop.actor());
 h:=arcop.append_evidence(CASE WHEN op='anonymize' THEN 'erasure' ELSE 'execution' END,aid,'action_ordered',data);
 RETURN jsonb_build_object('id',aid,'status','ordered','head_hash',h);
END $$;
-- El anfitrión devuelve el comprobante: se sella y se exige para cerrar.
CREATE FUNCTION arcop.record_action_receipt(aid uuid,new_status text,receipt text,report text,tester text,tester_role text,data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,arcop AS $$
DECLARE a arcop.subject_actions;h text;rsha text;
BEGIN
 IF NOT arcop.allowed(arcop.tenant(),ARRAY['admin','resolver']) THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF new_status NOT IN ('accepted','completed','failed','rejected') THEN RAISE EXCEPTION 'invalid_status'; END IF;
 SELECT * INTO a FROM arcop.subject_actions WHERE id=aid AND tenant_id=arcop.tenant() FOR UPDATE;
 IF a.id IS NULL THEN RAISE EXCEPTION 'not_found'; END IF;
 IF a.status IN ('completed','failed','rejected') THEN RAISE EXCEPTION 'action_already_closed'; END IF;
 rsha:=CASE WHEN receipt IS NULL THEN NULL ELSE encode(sha256(convert_to(a.id||E'\n'||receipt,'UTF8')),'hex') END;
 IF new_status='completed' AND rsha IS NULL THEN RAISE EXCEPTION 'host_execution_receipt_required'; END IF;
 IF a.operation='anonymize' AND new_status='accepted' AND (report IS NULL OR tester IS NULL OR tester_role IS NULL) THEN RAISE EXCEPTION 'reidentification_report_required'; END IF;
 UPDATE arcop.subject_actions SET status=new_status,receipt_ref=receipt,receipt_sha256=rsha,reident_report_sha256=report,reident_tester=tester,reident_tester_role=tester_role,reident_checked_at=CASE WHEN report IS NULL THEN reident_checked_at ELSE clock_timestamp() END,completed_at=CASE WHEN new_status='completed' THEN clock_timestamp() ELSE completed_at END,completed_by=CASE WHEN new_status='completed' THEN arcop.actor() ELSE completed_by END,failure_reason=CASE WHEN new_status='failed' THEN data->>'reason' ELSE failure_reason END WHERE id=aid;
 h:=arcop.append_evidence(CASE WHEN a.operation='anonymize' THEN 'erasure' ELSE 'execution' END,aid,'host_acknowledged',jsonb_strip_nulls(jsonb_build_object('status',new_status,'receipt_sha256',rsha,'reident_report_sha256',report,'tester',tester,'tester_role',tester_role)));
 RETURN jsonb_build_object('id',aid,'status',new_status,'receipt_sha256',rsha,'head_hash',h);
END $$;

-- ---------------------------------------------------------------------------------------------
-- 6. RLS, revocaciones y permisos de runtime (mismo patrón que schema.sql)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE arcop.evidence_chains ENABLE ROW LEVEL SECURITY;CREATE POLICY tenant_read ON arcop.evidence_chains FOR SELECT USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver','auditor']));
ALTER TABLE arcop.evidence_events ENABLE ROW LEVEL SECURITY;CREATE POLICY tenant_read ON arcop.evidence_events FOR SELECT USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver','auditor']));
ALTER TABLE arcop.consent_definitions ENABLE ROW LEVEL SECURITY;CREATE POLICY tenant_read ON arcop.consent_definitions FOR SELECT USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver','auditor']));
ALTER TABLE arcop.consent_texts ENABLE ROW LEVEL SECURITY;CREATE POLICY tenant_read ON arcop.consent_texts FOR SELECT USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver','auditor']));
ALTER TABLE arcop.consents ENABLE ROW LEVEL SECURITY;CREATE POLICY tenant_read ON arcop.consents FOR SELECT USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver','auditor']));
ALTER TABLE arcop.consent_actions ENABLE ROW LEVEL SECURITY;CREATE POLICY tenant_read ON arcop.consent_actions FOR SELECT USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver','auditor']));
ALTER TABLE arcop.host_adapters ENABLE ROW LEVEL SECURITY;CREATE POLICY tenant_read ON arcop.host_adapters FOR SELECT USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver','auditor']));
ALTER TABLE arcop.subject_systems ENABLE ROW LEVEL SECURITY;CREATE POLICY tenant_read ON arcop.subject_systems FOR SELECT USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver','auditor']));
ALTER TABLE arcop.subject_actions ENABLE ROW LEVEL SECURITY;CREATE POLICY tenant_read ON arcop.subject_actions FOR SELECT USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver','auditor']));CREATE POLICY order_action ON arcop.subject_actions FOR INSERT WITH CHECK(arcop.allowed(tenant_id,ARRAY['admin','resolver']));CREATE POLICY update_action ON arcop.subject_actions FOR UPDATE USING(arcop.allowed(tenant_id,ARRAY['admin','resolver'])) WITH CHECK(arcop.allowed(tenant_id,ARRAY['admin','resolver']));
ALTER TABLE arcop.retention_exceptions ENABLE ROW LEVEL SECURITY;CREATE POLICY tenant_read ON arcop.retention_exceptions FOR SELECT USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver','auditor']));CREATE POLICY grant_exception ON arcop.retention_exceptions FOR INSERT WITH CHECK(arcop.allowed(tenant_id,ARRAY['admin']));
ALTER TABLE arcop.anonymization_jobs ENABLE ROW LEVEL SECURITY;CREATE POLICY tenant_read ON arcop.anonymization_jobs FOR SELECT USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver','auditor']));CREATE POLICY plan_job ON arcop.anonymization_jobs FOR INSERT WITH CHECK(arcop.allowed(tenant_id,ARRAY['admin','resolver']));CREATE POLICY update_job ON arcop.anonymization_jobs FOR UPDATE USING(arcop.allowed(tenant_id,ARRAY['admin','resolver'])) WITH CHECK(arcop.allowed(tenant_id,ARRAY['admin','resolver']));
ALTER TABLE arcop.legal_profiles ENABLE ROW LEVEL SECURITY;CREATE POLICY tenant_read ON arcop.legal_profiles FOR SELECT USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver','auditor']));
-- legal_profile_rules cuelga del perfil: el alcance se resuelve por EXISTS para no duplicar tenant_id.
ALTER TABLE arcop.legal_profile_rules ENABLE ROW LEVEL SECURITY;CREATE POLICY tenant_read ON arcop.legal_profile_rules FOR SELECT USING(EXISTS(SELECT 1 FROM arcop.legal_profiles p WHERE p.id=profile_id AND arcop.allowed(p.tenant_id,ARRAY['admin','receiver','resolver','auditor'])));
REVOKE ALL ON arcop.evidence_chains,arcop.evidence_events,arcop.consent_definitions,arcop.consent_texts,arcop.consents,arcop.consent_actions,arcop.host_adapters,arcop.subject_systems,arcop.subject_actions,arcop.retention_exceptions,arcop.anonymization_jobs,arcop.legal_profiles,arcop.legal_profile_rules FROM PUBLIC;
GRANT SELECT ON arcop.evidence_chains,arcop.evidence_events,arcop.consent_definitions,arcop.consent_texts,arcop.consents,arcop.consent_actions,arcop.host_adapters,arcop.subject_systems,arcop.subject_actions,arcop.retention_exceptions,arcop.anonymization_jobs,arcop.legal_profiles,arcop.legal_profile_rules,arcop.consent_state TO arcop_api;
REVOKE ALL ON FUNCTION arcop.append_evidence(text,uuid,text,jsonb),arcop.verify_evidence_chain(text,uuid),arcop.publish_consent_text(text,int,text,text),arcop.register_consent(text,text,text,text,text,timestamptz,text,uuid,text),arcop.record_consent_action(uuid,text,text,text,jsonb),arcop.assert_profile_ready(text),arcop.order_subject_action(text,uuid,uuid,text,uuid,uuid,text,uuid,text,jsonb),arcop.record_action_receipt(uuid,text,text,text,text,text,jsonb),arcop.text_lifecycle() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION arcop.append_evidence(text,uuid,text,jsonb),arcop.verify_evidence_chain(text,uuid),arcop.publish_consent_text(text,int,text,text),arcop.register_consent(text,text,text,text,text,timestamptz,text,uuid,text),arcop.record_consent_action(uuid,text,text,text,jsonb),arcop.assert_profile_ready(text),arcop.order_subject_action(text,uuid,uuid,text,uuid,uuid,text,uuid,text,jsonb),arcop.record_action_receipt(uuid,text,text,text,text,text,jsonb) TO arcop_api;
COMMIT;