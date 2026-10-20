-- Run after the K7 baseline and 20261020000900 migration. All synthetic rows roll back.
BEGIN;
SET LOCAL test.jwt_role='service_role';
SET ROLE service_role;
SELECT public.clover_order_ingest_v1('11111111-1111-4111-8111-111111111111','MERCHANT123',
 '{"id":"ORDERSCOPE1","createdTime":1792454400000,"online":true,"orderTypeId":"ONLINETYPE1","customerEmail":null,"customerPhone":null,"customerAccess":"denied","refundsVerified":false,"items":[],"payments":[{"id":"PAYSCOPE01","amount":5000,"result":"SUCCESS"}],"refunds":[]}'::jsonb);
RESET ROLE;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.orders WHERE clover_order_id='ORDERSCOPE1' AND customer_id IS NULL)
   OR EXISTS(SELECT 1 FROM core.order_match_review r JOIN core.orders o ON o.id=r.order_id
     WHERE o.clover_order_id='ORDERSCOPE1') THEN
   RAISE EXCEPTION 'Denied customer scope must not create a match or review item';
 END IF;
END $$;
SET LOCAL test.staff='1';
SET LOCAL test.uid='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
SET ROLE authenticated;
DO $$ DECLARE v jsonb; BEGIN
 v := public.clover_order_day_totals_v1('11111111-1111-4111-8111-111111111111',
   '2026-10-20 00:00+00','2026-10-21 00:00+00');
 IF v->>'refundUnverifiedCount'<>'1' OR v->>'customerAccessDeniedCount'<>'1'
   OR v->>'reconciliationConfirmed'<>'false' THEN
   RAISE EXCEPTION 'Missing scope must leave day unconfirmed with separate counts';
 END IF;
END $$;
RESET ROLE;
SET ROLE service_role;
SELECT public.clover_order_ingest_v1('11111111-1111-4111-8111-111111111111','MERCHANT123',
 '{"id":"ORDERSCOPE1","createdTime":1792454400000,"online":true,"orderTypeId":"ONLINETYPE1","customerEmail":"one@example.invalid","customerPhone":null,"customerAccess":"verified","refundsVerified":true,"items":[],"payments":[{"id":"PAYSCOPE01","amount":5000,"result":"SUCCESS"}],"refunds":[]}'::jsonb);
RESET ROLE;
DO $$ BEGIN
 IF (SELECT count(*) FROM core.orders WHERE clover_order_id='ORDERSCOPE1')<>1
   OR NOT EXISTS(SELECT 1 FROM core.orders WHERE clover_order_id='ORDERSCOPE1'
     AND customer_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND match_status='exact') THEN
   RAISE EXCEPTION 'Repeated pull must update the same order and restore exact match';
 END IF;
END $$;
SET ROLE authenticated;
DO $$ DECLARE v jsonb; BEGIN
 v := public.clover_order_day_totals_v1('11111111-1111-4111-8111-111111111111',
   '2026-10-20 00:00+00','2026-10-21 00:00+00');
 IF v->>'refundUnverifiedCount'<>'0' OR v->>'customerAccessDeniedCount'<>'0'
   OR v->>'reconciliationConfirmed'<>'true' THEN
   RAISE EXCEPTION 'Scope recovery did not clear unconfirmed counters';
 END IF;
END $$;
RESET ROLE;
ROLLBACK;
