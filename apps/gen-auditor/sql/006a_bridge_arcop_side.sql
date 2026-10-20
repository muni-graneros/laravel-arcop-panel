-- 006a · Lado ARCOP · Outbox transaccional de la cadena de evidencia.
-- Se aplica a la BASE DE ARCOP, después de 002_consents_evidencia.sql.
-- El otro lado (receptor) está en 006b y va en la base de Gen-Auditor.
--
-- Decisión de diseño: el outbox NO lo alimenta la aplicación, lo alimenta un
-- TRIGGER sobre arcop.evidence_events. Así es imposible cambiar el estado de
-- un expediente sin emitir su evento: o se escribe el eslabón y sale el
-- evento en la misma transacción, o no ocurre ninguno de los dos.
--
-- Run with a migration owner, never with the runtime role.
BEGIN;

CREATE SCHEMA integration;
REVOKE ALL ON SCHEMA integration FROM PUBLIC;

CREATE TABLE integration.outbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  entity_type  text NOT NULL CHECK(entity_type IN ('request','consent','execution','erasure')),
  entity_id    uuid NOT NULL,
  event_seq    bigint NOT NULL CHECK(event_seq >= 1),
  action       text NOT NULL,
  event_hash   text NOT NULL CHECK(event_hash ~ '^[a-f0-9]{64}$'),
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  attempts     integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error   text NOT NULL DEFAULT '',
  -- El hash del eslabón identifica el evento de forma global: la unicidad
  -- hace que el receptor descarte duplicados sin coordinación adicional.
  UNIQUE(event_hash),
  UNIQUE(tenant_id, entity_type, entity_id, event_seq)
);
CREATE INDEX outbox_pending ON integration.outbox(available_at) WHERE delivered_at IS NULL;

-- Destinos permitidos. Sin fila activa no hay entrega: un destino nuevo exige
-- incorporación controlada, no una variable de entorno.
CREATE TABLE integration.subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,
  target_url      text NOT NULL CHECK(target_url ~ '^https://'),
  signing_key_ref text NOT NULL,
  event_types     text[] NOT NULL DEFAULT '{}',
  active          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Captura por trigger: se emite exactamente un evento por eslabón.
CREATE FUNCTION integration.capture_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, integration AS $$
BEGIN
  INSERT INTO integration.outbox(tenant_id, entity_type, entity_id, event_seq, action, event_hash, payload)
  VALUES (NEW.tenant_id, NEW.entity_type, NEW.entity_id, NEW.seq, NEW.action, NEW.event_hash, NEW.metadata)
  ON CONFLICT (event_hash) DO NOTHING;
  RETURN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER outbox_capture AFTER INSERT ON arcop.evidence_events
    FOR EACH ROW EXECUTE FUNCTION integration.capture_event();
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'arcop.evidence_events no existe todavia: se creara el trigger al aplicar 002_consents_evidencia.sql';
END $$;

-- Emisor. El dispatcher corre FUERA de la base; esto sólo toma el lote.
CREATE FUNCTION integration.claim_batch(p_limit integer DEFAULT 50)
RETURNS SETOF integration.outbox
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog, integration AS $$
  WITH picked AS (
    SELECT id FROM integration.outbox
     WHERE delivered_at IS NULL AND available_at <= now()
     ORDER BY available_at, id
     LIMIT least(greatest(p_limit,1),200)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE integration.outbox o SET attempts = o.attempts + 1
    FROM picked p WHERE o.id = p.id
  RETURNING o.*;
$$;

CREATE FUNCTION integration.mark_delivered(p_id uuid, p_receipt text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog, integration AS $$
  UPDATE integration.outbox SET delivered_at=now(), last_error=left(coalesce(p_receipt,''),500)
   WHERE id=p_id AND delivered_at IS NULL;
$$;

-- Backoff exponencial con techo: un destino caído no bloquea al resto.
CREATE FUNCTION integration.mark_failed(p_id uuid, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog, integration AS $$
  UPDATE integration.outbox
     SET last_error = left(coalesce(p_error,''),500),
         available_at = now() + least(interval '30 seconds' * power(2, least(attempts,8)), interval '1 hour')
   WHERE id=p_id AND delivered_at IS NULL;
$$;

-- Tras 12 intentos el evento queda estacionado. Un evento que nunca se entrega
-- es evidencia perdida: se ve, no se reintenta para siempre.
CREATE TABLE integration.dead_letters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id   uuid NOT NULL,
  event_hash  text NOT NULL CHECK(event_hash ~ '^[a-f0-9]{64}$'),
  reason      text NOT NULL,
  attempts    integer NOT NULL,
  parked_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(outbox_id)
);
CREATE FUNCTION integration.park_dead(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, integration AS $$
DECLARE n integer;
BEGIN
  INSERT INTO integration.dead_letters(outbox_id, event_hash, reason, attempts)
  SELECT o.id, o.event_hash, coalesce(nullif(o.last_error,''),'unknown'), o.attempts
    FROM integration.outbox o
   WHERE o.delivered_at IS NULL AND o.attempts >= 12
     AND NOT EXISTS (SELECT 1 FROM integration.dead_letters d WHERE d.outbox_id=o.id)
   LIMIT least(p_limit,200);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA integration FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA integration FROM PUBLIC;
GRANT SELECT ON integration.outbox TO arcop_dispatcher;
GRANT EXECUTE ON FUNCTION integration.claim_batch(integer),
                     integration.mark_delivered(uuid,text),
                     integration.mark_failed(uuid,text),
                     integration.park_dead(integer) TO arcop_dispatcher;

COMMIT;