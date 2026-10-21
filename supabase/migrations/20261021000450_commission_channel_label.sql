-- K13b: Clover orderType.label is the primary channel field; name is fallback.
-- All orders present in Nazar's Clover ledger are Nazar-channel sales.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$ BEGIN
 IF to_regprocedure('core.commission_order_day_rows_v1(uuid,date)') IS NULL
 THEN RAISE EXCEPTION 'K13B_REQUIRES_K13'; END IF;
END $guard$;

CREATE OR REPLACE FUNCTION core.commission_order_day_rows_v1(p_business_id uuid,p_month date)
RETURNS TABLE(day date,order_count bigint,gross_cents bigint,refund_cents bigint,
 missing_fields bigint,unknown_channel bigint,refund_unverified bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH bounds AS (
   SELECT (p_month::timestamp AT TIME ZONE 'America/New_York') AS lo,
          ((p_month + interval '1 month')::timestamp AT TIME ZONE 'America/New_York') AS hi
 ), tx AS (
   SELECT o.id AS order_id,p.created_at AS happened,p.amount_cents AS amount,
     p.raw_response AS raw,false AS is_refund,o.raw_response AS source
   FROM core.payments p JOIN core.orders o ON o.id=p.order_id AND o.business_id=p.business_id
   CROSS JOIN LATERAL core.clover_order_status_v1(o.id) s
   WHERE o.business_id=p_business_id AND s.status IN ('paid','refunded')
     AND upper(coalesce(p.payment_status,''))='SUCCESS'
   UNION ALL
   SELECT o.id,r.created_at,r.amount_cents,r.raw_response,true,o.raw_response
   FROM core.refunds r JOIN core.orders o ON o.id=r.order_id AND o.business_id=r.business_id
   CROSS JOIN LATERAL core.clover_order_status_v1(o.id) s
   WHERE o.business_id=p_business_id AND s.status='refunded'
     AND coalesce(r.raw_response->>'voided','false')<>'true'
 ), classified AS (
   SELECT tx.*, (tx.happened AT TIME ZONE 'America/New_York')::date AS ny_day,
     trim(regexp_replace(lower(coalesce(nullif(tx.source#>>'{raw,orderType,label}',''),
       tx.source#>>'{raw,orderType,name}','')),'[ _-]+',' ','g')) AS channel,
     CASE WHEN tx.raw->>'taxAmount' ~ '^[0-9]{1,12}$'
       THEN (tx.raw->>'taxAmount')::bigint END AS tax_cents
   FROM tx,bounds WHERE tx.happened>=bounds.lo AND tx.happened<bounds.hi
 ), classified_channel AS (
   SELECT *, channel IN ('dine in','dinein','pickup','pick up','takeout','take out',
     'delivery','doordash','door dash','uber eats','ubereats','grubhub','grub hub',
     'catering') AS known
   FROM classified
 )
 SELECT ny_day,count(DISTINCT order_id) FILTER (WHERE NOT is_refund),
   coalesce(sum(amount-tax_cents) FILTER
     (WHERE NOT is_refund AND known AND tax_cents IS NOT NULL
       AND amount>=tax_cents),0)::bigint,
   coalesce(sum(amount-tax_cents) FILTER
     (WHERE is_refund AND known AND tax_cents IS NOT NULL
       AND amount>=tax_cents),0)::bigint,
   count(*) FILTER (WHERE tax_cents IS NULL OR amount<tax_cents),
   count(*) FILTER (WHERE NOT known),
   count(DISTINCT order_id) FILTER (WHERE source->>'refundsVerified' IS DISTINCT FROM 'true')
 FROM classified_channel GROUP BY ny_day
$$;

REVOKE ALL ON FUNCTION core.commission_order_day_rows_v1(uuid,date)
 FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
