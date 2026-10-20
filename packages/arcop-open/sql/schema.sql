BEGIN;
CREATE SCHEMA arcop;
REVOKE ALL ON SCHEMA arcop FROM PUBLIC;
CREATE TABLE arcop.tenants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL);
CREATE TABLE arcop.members(tenant_id uuid REFERENCES arcop.tenants(id),subject text NOT NULL,role text NOT NULL CHECK(role IN ('admin','receiver','resolver','auditor')),active boolean NOT NULL DEFAULT true,PRIMARY KEY(tenant_id,subject));
CREATE FUNCTION arcop.actor() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.actor_id',true),'') $$;
CREATE FUNCTION arcop.tenant() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id',true),'')::uuid $$;
CREATE FUNCTION arcop.allowed(t uuid,roles text[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,arcop AS $$ SELECT t=arcop.tenant() AND EXISTS(SELECT 1 FROM arcop.members WHERE tenant_id=t AND subject=arcop.actor() AND active AND role=ANY(roles)) $$;
CREATE TABLE arcop.requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES arcop.tenants(id),product text NOT NULL,
 subject_ref text NOT NULL,identity_ciphertext text NOT NULL,description_ciphertext text NOT NULL,
 right_type text NOT NULL CHECK(right_type IN ('access','rectification','erasure','opposition','portability')),
 legal_profile text NOT NULL DEFAULT 'review_required',status text NOT NULL DEFAULT 'identity_pending' CHECK(status IN ('identity_pending','in_review','action_pending','completed','rejected')),
 created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),due_at timestamptz,
 request_fingerprint text NOT NULL,seq bigint NOT NULL DEFAULT 0,head_hash text NOT NULL DEFAULT repeat('0',64),idempotency_key uuid NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,idempotency_key)
);
CREATE TABLE arcop.events(tenant_id uuid NOT NULL,request_id uuid NOT NULL,seq bigint NOT NULL,action text NOT NULL,actor text NOT NULL,
 occurred_at timestamptz NOT NULL,metadata jsonb NOT NULL,previous_hash text NOT NULL,event_hash text NOT NULL,canonical text NOT NULL,
 PRIMARY KEY(tenant_id,request_id,seq),FOREIGN KEY(tenant_id,request_id) REFERENCES arcop.requests(tenant_id,id));
CREATE FUNCTION arcop.no_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append_only'; END $$;
CREATE TRIGGER event_immutable BEFORE UPDATE OR DELETE ON arcop.events FOR EACH ROW EXECUTE FUNCTION arcop.no_mutation();
CREATE TRIGGER event_no_truncate BEFORE TRUNCATE ON arcop.events FOR EACH STATEMENT EXECUTE FUNCTION arcop.no_mutation();
CREATE FUNCTION arcop.append_event(rid uuid,kind text,data jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,arcop AS $$
DECLARE r arcop.requests; stamp timestamptz:=clock_timestamp();payload text;h text;
BEGIN
 SELECT * INTO r FROM arcop.requests WHERE id=rid AND tenant_id=arcop.tenant() FOR UPDATE;
 IF r.id IS NULL OR NOT arcop.allowed(r.tenant_id,ARRAY['admin','receiver','resolver']) THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF kind !~ '^[a-z_.]{2,60}$' OR jsonb_typeof(data)<>'object' OR octet_length(data::text)>4096 THEN RAISE EXCEPTION 'invalid_event';END IF;
 payload:=jsonb_build_object('v',1,'request_id',rid,'tenant_id',r.tenant_id,'seq',r.seq+1,'actor',arcop.actor(),'action',kind,'at',to_char(stamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'metadata',data)::text;
 h:=encode(sha256(convert_to(r.head_hash||E'\n'||payload,'UTF8')),'hex');
 INSERT INTO arcop.events VALUES(r.tenant_id,rid,r.seq+1,kind,arcop.actor(),stamp,data,r.head_hash,h,payload);
 UPDATE arcop.requests SET seq=r.seq+1,head_hash=h WHERE id=rid;
 RETURN h;
END $$;
ALTER TABLE arcop.members ENABLE ROW LEVEL SECURITY;
CREATE POLICY self_read ON arcop.members FOR SELECT USING(subject=arcop.actor() AND tenant_id=arcop.tenant() AND active);
ALTER TABLE arcop.requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON arcop.requests FOR SELECT USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver','auditor']));
CREATE POLICY receive ON arcop.requests FOR INSERT WITH CHECK(arcop.allowed(tenant_id,ARRAY['admin','receiver']));
CREATE POLICY change_request ON arcop.requests FOR UPDATE USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver'])) WITH CHECK(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver']));
ALTER TABLE arcop.events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON arcop.events FOR SELECT USING(arcop.allowed(tenant_id,ARRAY['admin','receiver','resolver','auditor']));
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA arcop FROM PUBLIC;
CREATE ROLE arcop_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA arcop TO arcop_api;
GRANT SELECT ON arcop.members,arcop.requests,arcop.events TO arcop_api;
GRANT INSERT ON arcop.requests TO arcop_api;
GRANT UPDATE(status) ON arcop.requests TO arcop_api;
GRANT EXECUTE ON FUNCTION arcop.actor(),arcop.tenant(),arcop.allowed(uuid,text[]),arcop.append_event(uuid,text,jsonb) TO arcop_api;
CREATE INDEX requests_inbox ON arcop.requests(tenant_id,status,created_at DESC);
COMMIT;
-- Set runtime password outside version control. Provision tenants/members through controlled administration.
CREATE FUNCTION arcop.verify_chain(rid uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,arcop AS $$
DECLARE r arcop.requests;e arcop.events;prev text:=repeat('0',64);n bigint:=0;
BEGIN
 SELECT * INTO r FROM arcop.requests WHERE id=rid AND tenant_id=arcop.tenant();
 IF r.id IS NULL OR NOT arcop.allowed(r.tenant_id,ARRAY['admin','receiver','resolver','auditor']) THEN RAISE EXCEPTION 'forbidden';END IF;
 FOR e IN SELECT * FROM arcop.events WHERE request_id=rid AND tenant_id=r.tenant_id ORDER BY seq LOOP
 n:=n+1;
 IF e.seq<>n OR e.previous_hash<>prev OR e.event_hash<>encode(sha256(convert_to(prev||E'\n'||e.canonical,'UTF8')),'hex')
 OR e.canonical::jsonb IS DISTINCT FROM jsonb_build_object('v',1,'request_id',e.request_id,'tenant_id',e.tenant_id,'seq',e.seq,'actor',e.actor,'action',e.action,'at',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'metadata',e.metadata) THEN RETURN false;END IF;
 prev:=e.event_hash;
 END LOOP;
 RETURN n=r.seq AND prev=r.head_hash;
END $$;
REVOKE ALL ON FUNCTION arcop.verify_chain(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION arcop.verify_chain(uuid) TO arcop_api;
