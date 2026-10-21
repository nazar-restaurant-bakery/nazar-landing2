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
-- Clover payment.amount is already tip-free: Oct 15 net sales must match
-- $262.54 collected before tip less $24.49 tax = $238.05.
INSERT INTO core.orders(business_id,clover_order_id,clover_merchant_id,clover_order_type_id,
 online_order,created_at,raw_response) VALUES
 ('22222222-2222-4222-8222-222222222222','SIMPAYOCT15','MERCHANT123','TYPEK13A',true,
  '2026-10-15 18:00Z','{"raw":{"orderType":{"name":"Pickup"}},"refundsVerified":true}'),
 ('22222222-2222-4222-8222-222222222222','SIMREFDAY','MERCHANT123','TYPEK13A',true,
  '2026-10-16 18:00Z','{"raw":{"orderType":{"name":"Pickup"}},"refundsVerified":true}');
INSERT INTO core.payments(business_id,order_id,clover_payment_id,amount_cents,payment_status,
 created_at,raw_response)
 SELECT business_id,id,'PAY'||clover_order_id,
   CASE clover_order_id WHEN 'SIMPAYOCT15' THEN 26254 ELSE 10000 END,
   'SUCCESS',CASE clover_order_id WHEN 'SIMPAYOCT15' THEN '2026-10-15 18:10Z'::timestamptz
     ELSE '2026-10-16 18:10Z'::timestamptz END,
   CASE clover_order_id WHEN 'SIMPAYOCT15' THEN '{"taxAmount":2449,"tipAmount":1819}'::jsonb
     ELSE '{"taxAmount":1000,"tipAmount":1500}'::jsonb END
 FROM core.orders WHERE clover_order_id IN ('SIMPAYOCT15','SIMREFDAY');
INSERT INTO core.refunds(business_id,order_id,clover_refund_id,amount_cents,created_at,raw_response)
 SELECT business_id,id,'REFUNDK13REFDAY',3000,'2026-10-16 19:00Z',
   '{"taxAmount":300,"tipAmount":450}'::jsonb
 FROM core.orders WHERE clover_order_id='SIMREFDAY';
DO $tip$ DECLARE d15 record; d16 record; month_data jsonb; BEGIN
 SELECT * INTO d15 FROM core.commission_order_day_rows_v1(
   '22222222-2222-4222-8222-222222222222','2026-10-01') WHERE day='2026-10-15';
 SELECT * INTO d16 FROM core.commission_order_day_rows_v1(
   '22222222-2222-4222-8222-222222222222','2026-10-01') WHERE day='2026-10-16';
 IF d15.gross_cents<>23805 OR d15.refund_cents<>0 OR d15.missing_fields<>0
 THEN RAISE EXCEPTION 'k13_oct15_tip_double_counted'; END IF;
 IF d16.gross_cents<>9000 OR d16.refund_cents<>2700 OR d16.gross_cents-d16.refund_cents<>6300
 THEN RAISE EXCEPTION 'k13_same_day_refund_failed'; END IF;
 month_data:=core.commission_input_from_orders_v1(
   '22222222-2222-4222-8222-222222222222','2026-10-01');
 IF (month_data->>'qualifiedNetCents')::bigint<>30105 OR
   (month_data->>'missingFieldCount')::bigint<>0
 THEN RAISE EXCEPTION 'k13_tip_refund_month_failed'; END IF;
END $tip$;
-- Contract §4: generated local Auth identities, two tenants, no hosted users.
CREATE TEMP TABLE k13_contract_users(name text PRIMARY KEY,id uuid NOT NULL DEFAULT gen_random_uuid());
GRANT SELECT ON k13_contract_users TO authenticated;
INSERT INTO k13_contract_users(name) VALUES
 ('platformOnly'),('platformMember'),('ownerA'),('managerA'),('staffA'),
 ('inactiveA'),('staffB'),('legacyOnly');
INSERT INTO auth.users(id) SELECT id FROM k13_contract_users;
INSERT INTO core.platform_operators(staff_id)
 SELECT id FROM k13_contract_users WHERE name IN ('platformOnly','platformMember');
INSERT INTO core.business_staff(business_id,staff_id,role,active)
 SELECT CASE WHEN name='staffB' THEN '22222222-2222-4222-8222-222222222222'::uuid
   ELSE '11111111-1111-4111-8111-111111111111'::uuid END,
   id,CASE name WHEN 'ownerA' THEN 'owner' WHEN 'managerA' THEN 'manager' ELSE 'staff' END,
   name<>'inactiveA'
 FROM k13_contract_users WHERE name IN
 ('platformMember','ownerA','managerA','staffA','inactiveA','staffB');
INSERT INTO core.crm_staff(auth_user_id,active)
 SELECT id,true FROM k13_contract_users WHERE name='legacyOnly';
SET ROLE authenticated;
SET test.jwt_role='authenticated';
DO $scope$ DECLARE u record; actor uuid;
 a uuid:='11111111-1111-4111-8111-111111111111';
 b uuid:='22222222-2222-4222-8222-222222222222';
BEGIN
 FOR u IN SELECT * FROM k13_contract_users WHERE name IN
  ('platformOnly','platformMember','ownerA','managerA','staffA') LOOP
   PERFORM set_config('test.uid',u.id::text,false);
   PERFORM public.commission_compare_from_orders_v1(a,'2026-09-01');
 END LOOP;
 SELECT id INTO actor FROM k13_contract_users WHERE name='staffB';
 PERFORM set_config('test.uid',actor::text,false);
 PERFORM public.commission_compare_from_orders_v1(b,'2026-09-01');
 FOR u IN SELECT * FROM k13_contract_users WHERE name IN
  ('ownerA','managerA','staffA','inactiveA','legacyOnly') LOOP
   PERFORM set_config('test.uid',u.id::text,false);
   BEGIN
    PERFORM public.commission_compare_from_orders_v1(b,'2026-09-01');
    RAISE EXCEPTION 'K13_WRONG_BUSINESS_ALLOWED %',u.name;
   EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 END LOOP;
 SELECT id INTO actor FROM k13_contract_users WHERE name='staffB';
 PERFORM set_config('test.uid',actor::text,false);
 BEGIN
  PERFORM public.commission_compare_from_orders_v1(a,'2026-09-01');
  RAISE EXCEPTION 'K13_STAFF_B_READ_A_ALLOWED';
 EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 FOR u IN SELECT * FROM k13_contract_users WHERE name IN ('inactiveA','legacyOnly') LOOP
   PERFORM set_config('test.uid',u.id::text,false);
   BEGIN
    PERFORM public.commission_compare_from_orders_v1(a,'2026-09-01');
    RAISE EXCEPTION 'K13_INACTIVE_OR_LEGACY_ALLOWED %',u.name;
   EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 END LOOP;
 SELECT id INTO actor FROM k13_contract_users WHERE name='platformOnly';
 PERFORM set_config('test.uid',actor::text,false);
 IF NOT public.staff_business_authorized_v1(a,'ops.read')
   OR public.staff_business_authorized_v1(a,'ops.write')
   OR public.staff_business_authorized_v1(a,'unknown.operation')
   OR public.staff_business_authorized_v1(NULL,'ops.read')
 THEN RAISE EXCEPTION 'K13_PLATFORM_READ_WRITE_BOUNDARY'; END IF;
 SELECT id INTO actor FROM k13_contract_users WHERE name='platformMember';
 PERFORM set_config('test.uid',actor::text,false);
 IF NOT public.staff_business_authorized_v1(a,'ops.write')
   OR public.staff_business_authorized_v1(b,'ops.write')
 THEN RAISE EXCEPTION 'K13_PLATFORM_MEMBER_WRITE_BOUNDARY'; END IF;
 PERFORM set_config('test.uid','',false);
 BEGIN
  PERFORM public.commission_compare_from_orders_v1(a,'2026-09-01');
  RAISE EXCEPTION 'K13_NULL_ACTOR_ALLOWED';
 EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 SELECT id INTO actor FROM k13_contract_users WHERE name='legacyOnly';
 PERFORM set_config('test.uid',actor::text,false);
 BEGIN
  PERFORM public.commission_compare_from_orders_v1(a,'2026-09-01',
    (SELECT id FROM k13_contract_users WHERE name='ownerA'));
  RAISE EXCEPTION 'K13_FAKE_ACTOR_ALLOWED';
 EXCEPTION WHEN SQLSTATE '42883' THEN NULL; END;
 BEGIN
  PERFORM count(*) FROM core.business_staff;
  RAISE EXCEPTION 'K13_DIRECT_TABLE_ALLOWED';
 EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
END $scope$;
RESET ROLE;
UPDATE core.platform_operators SET active=false
 WHERE staff_id=(SELECT id FROM k13_contract_users WHERE name='platformOnly');
SET ROLE authenticated;
DO $scope$ DECLARE actor uuid; BEGIN
 SELECT id INTO actor FROM k13_contract_users WHERE name='platformOnly';
 PERFORM set_config('test.uid',actor::text,false);
 BEGIN
  PERFORM public.commission_compare_from_orders_v1(
    '11111111-1111-4111-8111-111111111111','2026-09-01');
  RAISE EXCEPTION 'K13_INACTIVE_PLATFORM_OPERATOR_ALLOWED';
 EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
END $scope$;
RESET ROLE;
UPDATE core.platform_operators SET active=true
 WHERE staff_id=(SELECT id FROM k13_contract_users WHERE name='platformOnly');
SET test.jwt_role='service_role';
DO $scope$ BEGIN
 BEGIN
  PERFORM public.commission_compare_from_orders_v1(
    '11111111-1111-4111-8111-111111111111','2026-09-01');
  RAISE EXCEPTION 'K13_SERVICE_ONLY_READ_ALLOWED';
 EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 BEGIN
  PERFORM public.commission_persist_from_orders_v1(
    '11111111-1111-4111-8111-111111111111','2026-09-01');
  RAISE EXCEPTION 'K13_SERVICE_ONLY_WRITE_ALLOWED';
 EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
END $scope$;
SET test.jwt_role='authenticated';
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
SET ROLE authenticated;
SET test.jwt_role='authenticated';
DO $test$ DECLARE actor uuid; BEGIN
 SELECT id INTO actor FROM k13_contract_users WHERE name='platformOnly';
 PERFORM set_config('test.uid',actor::text,false);
 BEGIN
  PERFORM public.commission_persist_from_orders_v1('11111111-1111-4111-8111-111111111111','2026-09-01');
  RAISE EXCEPTION 'k13_platform_only_persist_allowed';
 EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 SELECT id INTO actor FROM k13_contract_users WHERE name='platformMember';
 PERFORM set_config('test.uid',actor::text,false);
 BEGIN
  PERFORM public.commission_persist_from_orders_v1('11111111-1111-4111-8111-111111111111','2026-09-01');
  RAISE EXCEPTION 'k13_persist_should_reject';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
END $test$;
RESET ROLE;
DO $test$ BEGIN
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
