-- Optional. No PII or reports permissions, no ownership, no access to other tenants without membership.
CREATE ROLE gen_auditor_scanner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA gen_auditor TO gen_auditor_scanner;
GRANT SELECT ON gen_auditor.tenant_members,gen_auditor.domains,gen_auditor.scan_authorizations,gen_auditor.scans TO gen_auditor_scanner;
GRANT UPDATE(status,finished_at,evidence,error_code) ON gen_auditor.scans TO gen_auditor_scanner;
GRANT EXECUTE ON FUNCTION gen_auditor.actor_id(),gen_auditor.tenant_id(),gen_auditor.has_role(uuid,text[]),gen_auditor.append_audit(text,uuid,jsonb) TO gen_auditor_scanner;
-- Provision SCANNER_ACTOR_ID as dedicated auth.users identity and security membership in one tenant.
