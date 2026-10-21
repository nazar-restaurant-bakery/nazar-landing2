-- Run after K7 core, optional-scope and payment-day migrations. Synthetic rows roll back.
BEGIN;
INSERT INTO core.orders(business_id,clover_order_id,clover_merchant_id,clover_order_type_id,
  online_order,created_at,raw_response)
VALUES
('11111111-1111-4111-8111-111111111111','DAYORDER01','MERCHANT123','TYPE123456',false,
 '2026-10-15 22:10+00','{"refundsVerified":true}'::jsonb),
('11111111-1111-4111-8111-111111111111','DAYORDER02','MERCHANT123','TYPE123456',false,
 '2026-10-15 14:00+00','{"refundsVerified":true}'::jsonb);
INSERT INTO core.payments(business_id,order_id,clover_payment_id,amount_cents,payment_status,created_at,raw_response)
SELECT o.business_id,o.id,'DAYPAY0001',9099,'SUCCESS','2026-10-16 16:20+00','{"tipAmount":1638}'::jsonb
FROM core.orders o WHERE o.clover_order_id='DAYORDER01';
INSERT INTO core.payments(business_id,order_id,clover_payment_id,amount_cents,payment_status,created_at,raw_response)
SELECT o.business_id,o.id,'DAYPAY0002',2000,'SUCCESS','2026-10-15 15:00+00','{"tipAmount":300}'::jsonb
FROM core.orders o WHERE o.clover_order_id='DAYORDER02';
INSERT INTO core.refunds(business_id,order_id,clover_refund_id,amount_cents,created_at,raw_response)
SELECT o.business_id,o.id,'DAYREFUND01',500,'2026-10-15 16:00+00','{"tipAmount":100}'::jsonb
FROM core.orders o WHERE o.clover_order_id='DAYORDER02';
SET LOCAL test.staff='1';
SET ROLE authenticated;
DO $$ DECLARE d15 jsonb; d16 jsonb; BEGIN
  d15:=public.clover_order_day_summary_v2('11111111-1111-4111-8111-111111111111',
    '2026-10-15 04:00+00','2026-10-16 04:00+00');
  d16:=public.clover_order_day_summary_v2('11111111-1111-4111-8111-111111111111',
    '2026-10-16 04:00+00','2026-10-17 04:00+00');
  IF d15->>'orderCount'<>'2' OR d15->>'collectedCents'<>'1500' OR d15->>'tipCents'<>'200'
    OR d16->>'orderCount'<>'0' OR d16->>'collectedCents'<>'9099' OR d16->>'tipCents'<>'1638'
    OR d15->>'undatedTransactionCount'<>'0' OR d16->>'undatedTransactionCount'<>'0' THEN
    RAISE EXCEPTION 'Payment day, tip or refund classification incorrect: %, %',d15,d16;
  END IF;
END $$;
RESET ROLE;
INSERT INTO core.payments(business_id,order_id,clover_payment_id,amount_cents,payment_status,raw_response)
SELECT o.business_id,o.id,'DAYPAY0003',100,'SUCCESS','{}'::jsonb
FROM core.orders o WHERE o.clover_order_id='DAYORDER02';
SET LOCAL test.staff='1';
SET ROLE authenticated;
DO $$ DECLARE d jsonb; BEGIN
  d:=public.clover_order_day_summary_v2('11111111-1111-4111-8111-111111111111',
    '2026-10-15 04:00+00','2026-10-16 04:00+00');
  IF d->>'undatedTransactionCount'<>'1' OR d->>'reconciliationConfirmed'<>'false' THEN
    RAISE EXCEPTION 'Undated payment must block confirmation: %',d;
  END IF;
END $$;
RESET ROLE;
SET LOCAL test.staff='0';
SET ROLE authenticated;
DO $$ BEGIN
  IF public.clover_order_day_summary_v2('11111111-1111-4111-8111-111111111111',
    '2026-10-15 04:00+00','2026-10-16 04:00+00') IS NOT NULL THEN
    RAISE EXCEPTION 'Unauthorized day summary must not be visible';
  END IF;
END $$;
RESET ROLE;
ROLLBACK;
