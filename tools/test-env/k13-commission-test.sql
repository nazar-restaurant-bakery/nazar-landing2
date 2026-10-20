BEGIN;
-- Known month: gross $15,700, one partial refund $300, net $15,400.
INSERT INTO core.orders(business_id,clover_order_id,clover_merchant_id,clover_order_type_id,
 online_order,created_at,raw_response) VALUES
 ('11111111-1111-4111-8111-111111111111','ORDERK13A','MERCHANT123','TYPEK13A',true,'2026-09-15 18:00Z',
  '{"raw":{"orderType":{"name":"Pickup"}},"refundsVerified":true}'),
 ('11111111-1111-4111-8111-111111111111','ORDERK13B','MERCHANT123','TYPEK13A',true,'2026-09-15 18:01Z',
  '{"raw":{"orderType":{"name":"Pickup"}},"refundsVerified":true}'),
 ('22222222-2222-4222-8222-222222222222','ORDERK13C','MERCHANT123','TYPEK13A',true,'2026-09-15 18:00Z',
  '{"raw":{"orderType":{"name":"Pickup"}},"refundsVerified":true}');
INSERT INTO core.payments(business_id,order_id,clover_payment_id,amount_cents,payment_status,
 created_at,raw_response)
 SELECT business_id,id,'PAY'||clover_order_id,CASE clover_order_id WHEN 'ORDERK13A' THEN 1000000
 WHEN 'ORDERK13B' THEN 570000 ELSE 10000 END,'SUCCESS','2026-09-15 18:10Z',
 '{"taxAmount":0,"tipAmount":0}' FROM core.orders WHERE clover_order_id LIKE 'ORDERK13%';
INSERT INTO core.refunds(business_id,order_id,clover_refund_id,amount_cents,created_at,raw_response)
 SELECT business_id,id,'REFUNDK13A',30000,'2026-09-16 18:10Z',
 '{"taxAmount":0,"tipAmount":0}' FROM core.orders WHERE clover_order_id='ORDERK13A';
INSERT INTO core.ops_csv_imports VALUES
 ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',
  repeat('a',64),'synthetic.csv','2026-09-01','2026-09-30',15400,3,true,'2026-10-01 12:00Z');
INSERT INTO core.ops_metrics VALUES
 ('11111111-1111-4111-8111-111111111111','clover','manual_csv','2026-10-01 12:00Z','2026-09-15','2026-09-15','net_sales',15700),
 ('11111111-1111-4111-8111-111111111111','clover','manual_csv','2026-10-01 12:00Z','2026-09-15','2026-09-15','product_refunds',0),
 ('11111111-1111-4111-8111-111111111111','clover','manual_csv','2026-10-01 12:00Z','2026-09-15','2026-09-15','orders',2),
 ('11111111-1111-4111-8111-111111111111','clover','manual_csv','2026-10-01 12:00Z','2026-09-16','2026-09-16','net_sales',-300),
 ('11111111-1111-4111-8111-111111111111','clover','manual_csv','2026-10-01 12:00Z','2026-09-16','2026-09-16','product_refunds',300),
 ('11111111-1111-4111-8111-111111111111','clover','manual_csv','2026-10-01 12:00Z','2026-09-16','2026-09-16','orders',0);
INSERT INTO core.ops_metrics
SELECT '11111111-1111-4111-8111-111111111111','clover','manual_csv',
 '2026-10-01 12:00Z',d::date,d::date,metric,0
FROM generate_series('2026-09-01'::date,'2026-09-30'::date,'1 day') d
CROSS JOIN (VALUES ('net_sales'),('product_refunds'),('orders')) m(metric)
WHERE d::date NOT IN ('2026-09-15','2026-09-16');
DO $test$ DECLARE data jsonb; other jsonb;
BEGIN
 data:=core.commission_compare_from_orders_v1('11111111-1111-4111-8111-111111111111','2026-09-01');
 IF data->>'canPersist'<>'true' OR (data->>'orderCount')::int<>2
 OR (data->>'grossSalesCents')::bigint<>1570000 OR (data->>'refundCents')::bigint<>30000
 OR (data->>'qualifiedNetCents')::bigint<>1540000 OR (data->>'qicr')::numeric<>3400
 OR (data->>'commission_amount')::numeric<>680 OR (data->>'csvCommission')::numeric<>680
 OR (data->>'missingCsvDays')::int<>0 THEN RAISE EXCEPTION 'k13_known_month_failed %',data; END IF;
 other:=core.commission_input_from_orders_v1('22222222-2222-4222-8222-222222222222','2026-09-01');
 IF (other->>'qualifiedNetCents')::bigint<>10000 THEN RAISE EXCEPTION 'k13_tenant_isolation_failed'; END IF;
 IF EXISTS(SELECT 1 FROM core.commissions) THEN RAISE EXCEPTION 'k13_preview_persisted'; END IF;
END $test$;
DELETE FROM core.ops_metrics WHERE business_id='11111111-1111-4111-8111-111111111111'
 AND period_start='2026-09-01' AND metric='orders';
DO $test$ DECLARE data jsonb; BEGIN
 data:=core.commission_compare_from_orders_v1('11111111-1111-4111-8111-111111111111','2026-09-01');
 IF data->>'canPersist'<>'false' OR (data->>'missingCsvDays')::int<>1
 THEN RAISE EXCEPTION 'k13_missing_csv_day_not_blocked'; END IF;
END $test$;
INSERT INTO core.ops_metrics VALUES
 ('11111111-1111-4111-8111-111111111111','clover','manual_csv','2026-10-01 12:00Z',
  '2026-09-01','2026-09-01','orders',0);
-- An unverified refund makes posting impossible even with a matching CSV.
UPDATE core.orders SET raw_response=jsonb_set(raw_response,'{refundsVerified}','false'::jsonb)
 WHERE clover_order_id='ORDERK13A';
DO $test$ DECLARE data jsonb; BEGIN
 data:=core.commission_compare_from_orders_v1('11111111-1111-4111-8111-111111111111','2026-09-01');
 IF data->>'canPersist'<>'false' OR (data->>'refundUnverifiedCount')::int=0
 THEN RAISE EXCEPTION 'k13_unverified_refund_not_blocked'; END IF;
END $test$;
SET LOCAL test.jwt_role='service_role';
DO $test$ BEGIN
 BEGIN
  PERFORM public.commission_persist_from_orders_v1('11111111-1111-4111-8111-111111111111','2026-09-01');
  RAISE EXCEPTION 'k13_persist_should_reject';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 IF EXISTS(SELECT 1 FROM core.commissions) THEN RAISE EXCEPTION 'k13_blocked_write_occurred'; END IF;
END $test$;
-- The New York month includes both sides of the fall DST transition and
-- November 30 at 23:59, but excludes October 31 and December 1 local time.
INSERT INTO core.orders(business_id,clover_order_id,clover_merchant_id,clover_order_type_id,
 online_order,created_at,raw_response)
SELECT '11111111-1111-4111-8111-111111111111',v.id,'MERCHANT123','TYPEK13A',true,
 v.ts::timestamptz,'{"raw":{"orderType":{"name":"Pickup"}},"refundsVerified":true}'::jsonb
FROM (VALUES ('ORDERK13OCT','2026-11-01 03:59:00+00'),
 ('ORDERK13DST1','2026-11-01 05:30:00+00'),
 ('ORDERK13DST2','2026-11-01 06:30:00+00'),
 ('ORDERK13END','2026-12-01 04:59:00+00'),
 ('ORDERK13DEC','2026-12-01 05:01:00+00')) AS v(id,ts);
INSERT INTO core.payments(business_id,order_id,clover_payment_id,amount_cents,payment_status,
 created_at,raw_response)
SELECT business_id,id,'PAY'||clover_order_id,10000,'SUCCESS',created_at,
 '{"taxAmount":0,"tipAmount":0}'::jsonb FROM core.orders WHERE clover_order_id LIKE 'ORDERK13%'
 AND clover_order_id NOT IN ('ORDERK13A','ORDERK13B','ORDERK13C');
INSERT INTO core.refunds(business_id,order_id,clover_refund_id,amount_cents,created_at,raw_response)
SELECT business_id,id,'REFUNDK13FULL',10000,'2026-11-02 12:00:00+00',
 '{"taxAmount":0,"tipAmount":0}'::jsonb FROM core.orders WHERE clover_order_id='ORDERK13DST1';
DO $test$ DECLARE november jsonb; BEGIN
 november:=core.commission_input_from_orders_v1('11111111-1111-4111-8111-111111111111','2026-11-01');
 IF (november->>'orderCount')::int<>3 OR (november->>'grossSalesCents')::bigint<>30000
 OR (november->>'refundCents')::bigint<>10000 OR (november->>'qualifiedNetCents')::bigint<>20000
 THEN RAISE EXCEPTION 'k13_full_refund_or_dst_failed %',november; END IF;
 IF (SELECT count(*) FROM core.commission_order_day_rows_v1(
   '11111111-1111-4111-8111-111111111111','2026-11-01') WHERE day='2026-11-01')<>1
 THEN RAISE EXCEPTION 'k13_dst_day_failed'; END IF;
END $test$;
ROLLBACK;
