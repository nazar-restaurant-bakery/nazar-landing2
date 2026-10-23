-- One-time operator template. Edit ONLY the business UUID and JSON between
-- $approved$ markers after Yucel approves the exact text/dates/codes.
-- Run the SAME edited file in Sandbox first, then Production. It never activates.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $import$
DECLARE
  v_business_id uuid := '00000000-0000-0000-0000-000000000000'; -- REPLACE
  v_payload jsonb := $approved$[]$approved$::jsonb; -- REPLACE with approved JSON array
  v_row record;
  v_offer_id uuid;
BEGIN
  IF v_business_id = '00000000-0000-0000-0000-000000000000'::uuid
     OR jsonb_typeof(v_payload) IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_payload) = 0 THEN
    RAISE EXCEPTION 'Business and approved offers are required';
  END IF;
  PERFORM 1 FROM core.businesses WHERE id = v_business_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown business'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_business_id::text, 0));

  CREATE TEMP TABLE offer_calendar_input (
    name text, description text, code text, starts_at date, ends_at date,
    approval_reference text
  ) ON COMMIT DROP;
  INSERT INTO offer_calendar_input
  SELECT name, description, code, starts_at, ends_at, approval_reference
  FROM jsonb_to_recordset(v_payload) AS x(
    name text, description text, code text, starts_at date, ends_at date,
    approval_reference text
  );

  IF EXISTS (
    SELECT 1 FROM offer_calendar_input i
    WHERE length(btrim(coalesce(i.name,''))) NOT BETWEEN 1 AND 200
      OR length(btrim(coalesce(i.description,''))) NOT BETWEEN 1 AND 1000
      OR coalesce(i.code,'') !~ '^[A-Za-z0-9_-]{1,40}$'
      OR i.starts_at IS NULL OR i.ends_at IS NULL OR i.starts_at > i.ends_at
      OR length(btrim(coalesce(i.approval_reference,''))) NOT BETWEEN 1 AND 300
  ) THEN RAISE EXCEPTION 'Invalid offer field, date or approval reference'; END IF;

  IF EXISTS (
    SELECT 1 FROM offer_calendar_input a JOIN offer_calendar_input b
      ON a.ctid < b.ctid
     AND (lower(a.code) = lower(b.code)
       OR (a.starts_at <= b.ends_at AND b.starts_at <= a.ends_at))
  ) THEN RAISE EXCEPTION 'Duplicate code or overlapping approved dates'; END IF;

  IF EXISTS (
    SELECT 1 FROM offer_calendar_input i JOIN core.offers o
      ON o.business_id = v_business_id
     AND (lower(o.code) = lower(i.code)
       OR (o.starts_at <= i.ends_at AND i.starts_at <= o.ends_at))
  ) THEN RAISE EXCEPTION 'Code or dates conflict with existing offer'; END IF;

  FOR v_row IN SELECT * FROM offer_calendar_input ORDER BY starts_at LOOP
    INSERT INTO core.offers (
      business_id, name, description, code, channel_target, starts_at, ends_at,
      active, is_test
    ) VALUES (
      v_business_id, btrim(v_row.name), btrim(v_row.description), upper(v_row.code),
      'clover', v_row.starts_at, v_row.ends_at, false, false
    ) RETURNING id INTO v_offer_id;
    INSERT INTO core.ops_offer_approvals (
      business_id, offer_id, reference, condition_fingerprint
    )
    SELECT v_business_id, v_offer_id, btrim(v_row.approval_reference),
      md5((to_jsonb(o)-'active'-'created_at'-'updated_at')::text)
    FROM core.offers o WHERE o.id = v_offer_id;
  END LOOP;
  RAISE NOTICE 'Imported % approved offers as inactive', (SELECT count(*) FROM offer_calendar_input);
END $import$;
COMMIT;
