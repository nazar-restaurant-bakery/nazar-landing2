BEGIN;
INSERT INTO core.orders(business_id,clover_order_id,clover_merchant_id,clover_order_type_id,
 online_order,created_at,raw_response) VALUES
 ('11111111-1111-4111-8111-111111111111','K13BLABELDINE','MERCHANT123','TYPEK13B',false,
  '2026-10-15 17:00Z','{"raw":{"orderType":{"label":"DINE-IN"}},"refundsVerified":true}'),
 ('11111111-1111-4111-8111-111111111111','K13BLABELDELIVERY','MERCHANT123','TYPEK13B',true,
  '2026-10-15 18:00Z','{"raw":{"orderType":{"label":"Delivery"}},"refundsVerified":true}'),
 ('11111111-1111-4111-8111-111111111111','K13BLABELUBER','MERCHANT123','TYPEK13B',true,
  '2026-10-15 19:00Z','{"raw":{"orderType":{"label":"Uber Eats"}},"refundsVerified":true}'),
 ('11111111-1111-4111-8111-111111111111','K13BNAMEFALLBACK','MERCHANT123','TYPEK13B',true,
  '2026-10-15 20:00Z','{"raw":{"orderType":{"name":"Pickup"}},"refundsVerified":true}'),
 ('11111111-1111-4111-8111-111111111111','K13BUNKNOWN','MERCHANT123','TYPEK13B',true,
  '2026-10-15 21:00Z','{"raw":{"orderType":{"label":"Unexpected channel"}},"refundsVerified":true}');
INSERT INTO core.payments(business_id,order_id,clover_payment_id,amount_cents,payment_status,
 created_at,raw_response)
 SELECT business_id,id,'PAY'||clover_order_id,
   CASE clover_order_id WHEN 'K13BLABELDINE' THEN 20000
     WHEN 'K13BLABELDELIVERY' THEN 6254 WHEN 'K13BLABELUBER' THEN 1000
     WHEN 'K13BNAMEFALLBACK' THEN 500 ELSE 100 END,
   'SUCCESS','2026-10-15 22:00Z',
   CASE clover_order_id WHEN 'K13BLABELDINE' THEN '{"taxAmount":1500}'::jsonb
     WHEN 'K13BLABELDELIVERY' THEN '{"taxAmount":949}'::jsonb
     ELSE '{"taxAmount":0}'::jsonb END
 FROM core.orders WHERE clover_order_id LIKE 'K13B%';
DO $test$ DECLARE row_data record; month_data jsonb; BEGIN
 SELECT * INTO row_data FROM core.commission_order_day_rows_v1(
   '11111111-1111-4111-8111-111111111111','2026-10-01') WHERE day='2026-10-15';
 IF row_data.order_count<>5 OR row_data.gross_cents<>25305
   OR row_data.unknown_channel<>1 OR row_data.missing_fields<>0
 THEN RAISE EXCEPTION 'K13B_LABEL_CLASSIFICATION_FAILED'; END IF;
 month_data:=core.commission_input_from_orders_v1(
   '11111111-1111-4111-8111-111111111111','2026-10-01');
 IF (month_data->>'unknownChannelCount')::int<>1
   OR (month_data->>'grossSalesCents')::bigint<>25305
 THEN RAISE EXCEPTION 'K13B_UNKNOWN_CHANNEL_NOT_FLAGGED'; END IF;
 IF (SELECT sum(amount_cents) FROM core.payments
     WHERE clover_payment_id IN ('PAYK13BLABELDINE','PAYK13BLABELDELIVERY'))<>26254
   OR (SELECT sum(amount_cents-(raw_response->>'taxAmount')::bigint)
     FROM core.payments WHERE clover_payment_id IN
       ('PAYK13BLABELDINE','PAYK13BLABELDELIVERY'))<>23805
 THEN RAISE EXCEPTION 'K13B_OCT15_COLLECTED_VS_SALES_FAILED'; END IF;
END $test$;
ROLLBACK;
