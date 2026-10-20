-- Administrator only. Set password OUTSIDE version control via \password gen_auditor_api.
CREATE ROLE gen_auditor_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA gen_auditor TO gen_auditor_api;
GRANT SELECT ON ALL TABLES IN SCHEMA gen_auditor TO gen_auditor_api;
GRANT INSERT ON gen_auditor.clients,gen_auditor.domains,gen_auditor.scan_authorizations,gen_auditor.scans,gen_auditor.vulnerabilities,
 gen_auditor.consents,gen_auditor.consent_events,gen_auditor.arco_requests,gen_auditor.controls,gen_auditor.risks,
 gen_auditor.anomalies,gen_auditor.eipds,gen_auditor.anonymization_plans,gen_auditor.incidents,gen_auditor.reports TO gen_auditor_api;
GRANT UPDATE ON gen_auditor.clients,gen_auditor.domains,gen_auditor.scans,gen_auditor.vulnerabilities,
 gen_auditor.arco_requests,gen_auditor.controls,gen_auditor.risks,gen_auditor.anomalies,gen_auditor.eipds,gen_auditor.incidents TO gen_auditor_api;
GRANT EXECUTE ON FUNCTION gen_auditor.actor_id(),gen_auditor.tenant_id(),gen_auditor.has_role(uuid,text[]),gen_auditor.append_audit(text,uuid,jsonb),gen_auditor.verify_audit() TO gen_auditor_api;
-- Runtime cannot INSERT/UPDATE/DELETE/TRUNCATE audit logs/heads or provision members.

GRANT EXECUTE ON FUNCTION gen_auditor.my_tenants() TO gen_auditor_api;

GRANT UPDATE(revoked_at) ON gen_auditor.scan_authorizations TO gen_auditor_api;
