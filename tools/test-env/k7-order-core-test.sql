-- Run only after the local bootstrap and exact K7 migration. Transaction rolls back test data.
BEGIN;
SET LOCAL test.jwt_role='service_role';
SET ROLE service_role;
SELECT public.clover_order_ingest_v1('11111111-1111-4111-8111-111111111111','MERCHANT123',
 '{"id":"ORDEREXACT1","createdTime":1792454400000,"online":true,"orderTypeId":"ONLINETYPE1","customerEmail":"one@example.invalid","customerPhone":null,"total":5000,"state":"OPEN","items":[{"id":"ITEMEXACT1","name":"Meal","price":5000,"quantity":1}],"payments":[{"id":"PAYEXACT1","amount":5000,"result":"SUCCESS"}],"refunds":[]}'::jsonb);
SELECT public.clover_order_ingest_v1('11111111-1111-4111-8111-111111111111','MERCHANT123',
 '{"id":"ORDEREXACT1","createdTime":1792454400000,"online":true,"orderTypeId":"ONLINETYPE1","customerEmail":"ONE@EXAMPLE.INVALID","customerPhone":null,"total":5000,"state":"OPEN","items":[{"id":"ITEMEXACT1","name":"Meal","price":5000,"quantity":1}],"payments":[{"id":"PAYEXACT1","amount":5000,"result":"SUCCESS"}],"refunds":[]}'::jsonb);
SELECT public.clover_order_ingest_v1('11111111-1111-4111-8111-111111111111','MERCHANT123',
 '{"id":"ORDERAMBIG1","createdTime":1792454400000,"online":true,"orderTypeId":"ONLINETYPE1","customerEmail":null,"customerPhone":"(203) 555-0102","total":2200,"state":"OPEN","items":[],"payments":[],"refunds":[]}'::jsonb);
SELECT public.clover_order_ingest_v1('11111111-1111-4111-8111-111111111111','MERCHANT123',
 '{"id":"ORDERNONE01","createdTime":1792454400000,"online":true,"orderTypeId":"ONLINETYPE1","customerEmail":"stranger@example.invalid","customerPhone":null,"total":9999,"state":"OPEN","items":[],"payments":[],"refunds":[]}'::jsonb);
SELECT public.clover_order_ingest_v1('11111111-1111-4111-8111-111111111111','MERCHANT123',
 '{"id":"ORDEREXACT1","createdTime":1792454400000,"online":true,"orderTypeId":"ONLINETYPE1","customerEmail":"one@example.invalid","customerPhone":null,"total":5000,"state":"OPEN","items":[{"id":"ITEMEXACT1","name":"Meal","price":5000,"quantity":1}],"payments":[{"id":"PAYEXACT1","amount":5000,"result":"SUCCESS"}],"refunds":[{"id":"REFUNDEXACT1","amount":5000,"payment":{"id":"PAYEXACT1"}}]}'::jsonb);
RESET ROLE;
DO $$ BEGIN
 IF (SELECT count(*) FROM core.orders)<>3 OR (SELECT count(*) FROM core.order_items)<>1
   OR (SELECT count(*) FROM core.payments)<>1 OR (SELECT count(*) FROM core.refunds)<>1 THEN
   RAISE EXCEPTION 'Duplicate or missing ledger rows'; END IF;
 IF NOT EXISTS(SELECT 1 FROM core.orders o WHERE clover_order_id='ORDEREXACT1'
   AND customer_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND match_status='exact'
   AND (SELECT s.status FROM core.clover_order_status_v1(o.id) s)='refunded') THEN
   RAISE EXCEPTION 'Exact match or refunded status wrong'; END IF;
 IF NOT EXISTS(SELECT 1 FROM core.orders o JOIN core.order_match_review r ON r.order_id=o.id
   WHERE o.clover_order_id='ORDERAMBIG1' AND o.customer_id IS NULL AND o.match_status='ambiguous'
   AND r.status='open' AND pg_catalog.cardinality(r.candidate_customer_ids)=2) THEN
   RAISE EXCEPTION 'Ambiguous match not queued'; END IF;
 IF NOT EXISTS(SELECT 1 FROM core.orders WHERE clover_order_id='ORDERNONE01'
   AND customer_id IS NULL AND match_status='unmatched') THEN
   RAISE EXCEPTION 'Unmatched order linked'; END IF;
 IF EXISTS(SELECT 1 FROM core.orders o WHERE clover_order_id='ORDERNONE01'
   AND (SELECT s.status FROM core.clover_order_status_v1(o.id) s)='paid') THEN
   RAISE EXCEPTION 'Order total incorrectly counted as paid'; END IF;
END $$;
SET LOCAL test.staff='1';
SET LOCAL test.uid='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
SET ROLE authenticated;
DO $$ BEGIN
 IF pg_catalog.jsonb_array_length(public.clover_order_match_queue_v1('11111111-1111-4111-8111-111111111111'))<>1 THEN
   RAISE EXCEPTION 'Staff queue did not show ambiguous order'; END IF;
 IF public.clover_order_day_totals_v1('11111111-1111-4111-8111-111111111111',
   '2026-10-20 00:00+00','2026-10-21 00:00+00')->>'orderCount'<>'3'
   OR public.clover_order_day_totals_v1('11111111-1111-4111-8111-111111111111',
   '2026-10-20 00:00+00','2026-10-21 00:00+00')->>'netCents'<>'0' THEN
   RAISE EXCEPTION 'Closed-day totals disagree with synthetic ledger'; END IF;
END $$;
SELECT public.clover_order_match_resolve_v1('11111111-1111-4111-8111-111111111111',
  (public.clover_order_match_queue_v1('11111111-1111-4111-8111-111111111111')->0->>'reviewId')::uuid,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
RESET ROLE;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.orders WHERE clover_order_id='ORDERAMBIG1'
   AND customer_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
   AND match_status='staff_resolved' AND match_source='staff') THEN
   RAISE EXCEPTION 'Staff resolution was not saved'; END IF;
END $$;
ROLLBACK;
