-- Nazar only. Add stored note author ID to the existing active-staff-only overview.
-- No note data, author IDs, row filters, table grants or write functions change.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='20s';
DO $migration$
DECLARE definition text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.installation WHERE declared_project_ref='khgczybubufouraqyrcj') THEN RAISE EXCEPTION 'Wrong project'; END IF;
 SELECT pg_get_functiondef('public.crm_overview_v2(text,text)'::regprocedure) INTO definition;
 IF md5(replace(definition,E'\r\n',E'\n'))='90ab6562cb720f99c1402b08e02c1397' THEN RETURN; END IF;
 IF md5(replace(definition,E'\r\n',E'\n'))<>'cc7195cbba782cf8543bb2beb03bcba2' THEN RAISE EXCEPTION 'STOP: CRM overview changed; review current definition before applying'; END IF;
 EXECUTE replace(definition,'SELECT id, body, created_at FROM core.customer_notes','SELECT id, body, created_at, author_id FROM core.customer_notes');
END $migration$;
NOTIFY pgrst,'reload schema';
COMMIT;
