-- Apply after 20261013_catering_decision_queue.sql.
-- Records one delivery event per decision transition. No email is sent here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF to_regclass('core.catering_decisions') IS NULL THEN
    RAISE EXCEPTION 'STOP: catering decision queue must be installed first';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS core.crm_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL REFERENCES core.catering_decisions(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('decision_requested', 'decision_answered')),
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  last_error text,
  UNIQUE (decision_id, event_type)
);
CREATE INDEX IF NOT EXISTS crm_notification_outbox_unsent
  ON core.crm_notification_outbox(created_at) WHERE sent_at IS NULL;
ALTER TABLE core.crm_notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.crm_notification_outbox FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION core.queue_catering_decision_notification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO core.crm_notification_outbox(decision_id, event_type)
    VALUES (NEW.id, 'decision_requested') ON CONFLICT DO NOTHING;
  ELSIF OLD.recorded_at IS NULL AND NEW.recorded_at IS NOT NULL THEN
    INSERT INTO core.crm_notification_outbox(decision_id, event_type)
    VALUES (NEW.id, 'decision_answered') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION core.queue_catering_decision_notification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS catering_decision_notification ON core.catering_decisions;
CREATE TRIGGER catering_decision_notification
AFTER INSERT OR UPDATE OF recorded_at ON core.catering_decisions
FOR EACH ROW EXECUTE FUNCTION core.queue_catering_decision_notification();

COMMIT;
