-- K13: read-only CSV / K7 ledger comparison and guarded table-source posting.
-- The existing core.compute_commission formula and CSV path are unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$ BEGIN
 IF to_regclass('core.orders') IS NULL OR to_regclass('core.payments') IS NULL
 OR to_regclass('core.refunds') IS NULL OR to_regclass('core.ops_csv_imports') IS NULL
 OR to_regclass('core.ops_metrics') IS NULL
 OR to_regprocedure('core.clover_order_status_v1(uuid)') IS NULL
 OR to_regprocedure('core.compute_commission(uuid,date,numeric,numeric,boolean)') IS NULL
 THEN RAISE EXCEPTION 'K13_REQUIRES_K7_AND_OPS'; END IF;
END $guard$;

-- A payment/refund belongs to its transaction's New York day, not the order day.
-- NULL tax/tip/date, unknown channel, and inaccessible refunds never become zero.
CREATE FUNCTION core.commission_order_day_rows_v1(p_business_id uuid,p_month date)
RETURNS TABLE(day date,order_count bigint,gross_cents bigint,refund_cents bigint,
 missing_fields bigint,unknown_channel bigint,refund_unverified bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH bounds AS (
   SELECT (p_month::timestamp AT TIME ZONE 'America/New_York') AS lo,
          ((p_month + interval '1 month')::timestamp AT TIME ZONE 'America/New_York') AS hi
 ), tx AS (
   SELECT o.id AS order_id,p.created_at AS happened,p.amount_cents AS amount,
     p.raw_response AS raw,false AS is_refund,o.raw_response AS source,
     o.clover_order_type_id AS type_id
   FROM core.payments p JOIN core.orders o ON o.id=p.order_id AND o.business_id=p.business_id
   CROSS JOIN LATERAL core.clover_order_status_v1(o.id) s
   WHERE o.business_id=p_business_id AND s.status IN ('paid','refunded')
     AND upper(coalesce(p.payment_status,''))='SUCCESS'
   UNION ALL
   SELECT o.id,r.created_at,r.amount_cents,r.raw_response,true,o.raw_response,o.clover_order_type_id
   FROM core.refunds r JOIN core.orders o ON o.id=r.order_id AND o.business_id=r.business_id
   CROSS JOIN LATERAL core.clover_order_status_v1(o.id) s
   WHERE o.business_id=p_business_id AND s.status='refunded'
     AND coalesce(r.raw_response->>'voided','false')<>'true'
 ), classified AS (
   SELECT tx.*, (tx.happened AT TIME ZONE 'America/New_York')::date AS ny_day,
     trim(regexp_replace(lower(coalesce(tx.source#>>'{raw,orderType,name}','')),
       '[ _-]+',' ','g')) AS channel,
     CASE WHEN tx.raw->>'taxAmount' ~ '^[0-9]{1,12}$'
       THEN (tx.raw->>'taxAmount')::bigint END AS tax_cents,
     CASE WHEN tx.raw->>'tipAmount' ~ '^[0-9]{1,12}$'
       THEN (tx.raw->>'tipAmount')::bigint END AS tip_cents
   FROM tx,bounds WHERE tx.happened>=bounds.lo AND tx.happened<bounds.hi
 ), included AS (
   SELECT *, channel !~ '\muber(\s+eats)?\M|\mgrub\s*hub\M' AS allowed,
     channel IN ('dine in','dinein','pickup','pick up','takeout','take out',
       'delivery','doordash','door dash','catering') AS known
   FROM classified
 )
 SELECT ny_day,count(DISTINCT order_id) FILTER (WHERE NOT is_refund AND allowed),
   coalesce(sum(amount-tax_cents-tip_cents) FILTER
     (WHERE NOT is_refund AND allowed AND known AND tax_cents IS NOT NULL
       AND tip_cents IS NOT NULL AND amount>=tax_cents+tip_cents),0)::bigint,
   coalesce(sum(amount-tax_cents-tip_cents) FILTER
     (WHERE is_refund AND allowed AND known AND tax_cents IS NOT NULL
       AND tip_cents IS NOT NULL AND amount>=tax_cents+tip_cents),0)::bigint,
   count(*) FILTER (WHERE allowed AND
     (tax_cents IS NULL OR tip_cents IS NULL OR amount<tax_cents+tip_cents)),
   count(*) FILTER (WHERE allowed AND NOT known),
   count(DISTINCT order_id) FILTER (WHERE allowed AND source->>'refundsVerified' IS DISTINCT FROM 'true')
 FROM included GROUP BY ny_day
$$;

CREATE FUNCTION core.commission_input_from_orders_v1(p_business_id uuid,p_month date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE gross bigint; refunds bigint; n bigint; missing bigint; unknown bigint;
 unverified bigint; undated bigint; result jsonb;
BEGIN
 IF p_business_id IS NULL OR p_month IS NULL OR date_trunc('month',p_month)::date<>p_month
 THEN RAISE EXCEPTION 'invalid_commission_period' USING ERRCODE='22023'; END IF;
 SELECT coalesce(sum(d.gross_cents),0),coalesce(sum(d.refund_cents),0),
   coalesce(sum(d.order_count),0),coalesce(sum(d.missing_fields),0),
   coalesce(sum(d.unknown_channel),0),coalesce(sum(d.refund_unverified),0)
 INTO gross,refunds,n,missing,unknown,unverified
 FROM core.commission_order_day_rows_v1(p_business_id,p_month) d;
 SELECT (SELECT count(*) FROM core.payments p WHERE p.business_id=p_business_id AND p.created_at IS NULL)
   +(SELECT count(*) FROM core.refunds r WHERE r.business_id=p_business_id AND r.created_at IS NULL)
 INTO undated;
 -- Gross before product refunds, then refund once in the unchanged engine.
 result:=core.compute_commission(p_business_id,p_month,gross::numeric/100,refunds::numeric/100,false);
 RETURN result||jsonb_build_object('source','table','format','gross_before_refund',
   'grossSalesCents',gross,'refundCents',refunds,'qualifiedNetCents',gross-refunds,
   'orderCount',n,'missingFieldCount',missing+undated,'unknownChannelCount',unknown,
   'refundUnverifiedCount',unverified,'pullCoverageUnverified',true,
   'persisted',false);
END $$;

CREATE FUNCTION core.commission_compare_from_orders_v1(p_business_id uuid,p_month date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE imported core.ops_csv_imports%ROWTYPE; tab jsonb; csv_calc jsonb;
 rows jsonb:='[]'::jsonb; d date; csv_net bigint; csv_refund bigint;
 csv_orders bigint; ledger record; comparable boolean:=true; exact boolean:=true;
 missing_csv_days bigint:=0; past_month boolean;
BEGIN
 tab:=core.commission_input_from_orders_v1(p_business_id,p_month);
 SELECT * INTO imported FROM core.ops_csv_imports
 WHERE business_id=p_business_id AND period_start=p_month AND is_complete
   AND period_end=(p_month+interval '1 month - 1 day')::date
 ORDER BY collected_at DESC,action_id DESC LIMIT 1;
 past_month:=p_month+interval '1 month' <= (now() AT TIME ZONE 'America/New_York')::date;
 IF NOT FOUND THEN RETURN tab||jsonb_build_object('source','table','csvAvailable',false,
   'dailyDifferences','[]'::jsonb,'canPersist',false,'provisional',true); END IF;
 csv_calc:=core.compute_commission(p_business_id,p_month,imported.qualified_sales,0::numeric,false);
 FOR d IN SELECT generate_series(p_month,(p_month+interval '1 month - 1 day')::date,'1 day'::interval)::date LOOP
   SELECT max(round(m.value_num*100)::bigint) FILTER (WHERE m.metric='net_sales'),
     max(round(m.value_num*100)::bigint) FILTER (WHERE m.metric='product_refunds'),
     max(m.value_num::bigint) FILTER (WHERE m.metric='orders')
   INTO csv_net,csv_refund,csv_orders FROM core.ops_metrics m
   WHERE m.business_id=p_business_id AND m.source='clover' AND m.collector='manual_csv'
     AND m.collected_at=imported.collected_at AND m.period_start=d AND m.period_end=d
     AND m.metric IN ('net_sales','product_refunds','orders');
   SELECT * INTO ledger FROM core.commission_order_day_rows_v1(p_business_id,p_month) x WHERE x.day=d;
   IF csv_net IS NULL OR csv_refund IS NULL OR csv_orders IS NULL THEN
      comparable:=false;missing_csv_days:=missing_csv_days+1;
   ELSIF csv_net IS DISTINCT FROM coalesce(ledger.gross_cents,0)-coalesce(ledger.refund_cents,0)
      OR csv_refund IS DISTINCT FROM coalesce(ledger.refund_cents,0)
      OR csv_orders IS DISTINCT FROM coalesce(ledger.order_count,0) THEN exact:=false; END IF;
   rows:=rows||jsonb_build_array(jsonb_build_object('day',d,'csvOrders',csv_orders,
     'tableOrders',coalesce(ledger.order_count,0),'orderDifference',
       CASE WHEN csv_orders IS NULL THEN NULL ELSE coalesce(ledger.order_count,0)-csv_orders END,
     'csvNetCents',csv_net,'tableNetCents',coalesce(ledger.gross_cents,0)-coalesce(ledger.refund_cents,0),
     'netDifferenceCents',CASE WHEN csv_net IS NULL THEN NULL ELSE
       coalesce(ledger.gross_cents,0)-coalesce(ledger.refund_cents,0)-csv_net END,
     'csvRefundCents',csv_refund,'tableRefundCents',coalesce(ledger.refund_cents,0),
     'refundDifferenceCents',CASE WHEN csv_refund IS NULL THEN NULL ELSE
       coalesce(ledger.refund_cents,0)-csv_refund END));
 END LOOP;
 RETURN tab||jsonb_build_object('source','both','csvAvailable',true,
   'csvQualifiedNetCents',round(imported.qualified_sales*100)::bigint,
   'csvCommission',csv_calc->'commission_amount','dailyDifferences',rows,
   'missingCsvDays',missing_csv_days,
   'canPersist',comparable AND exact AND past_month
     AND (tab->>'missingFieldCount')::bigint=0
     AND (tab->>'unknownChannelCount')::bigint=0
     AND (tab->>'refundUnverifiedCount')::bigint=0
     AND (tab->>'qualifiedNetCents')::bigint=round(imported.qualified_sales*100)::bigint,
   'provisional',NOT(comparable AND exact AND past_month
     AND (tab->>'missingFieldCount')::bigint=0
     AND (tab->>'unknownChannelCount')::bigint=0
     AND (tab->>'refundUnverifiedCount')::bigint=0
     AND (tab->>'qualifiedNetCents')::bigint=round(imported.qualified_sales*100)::bigint));
END $$;

-- Only service_role can read cross-tenant aggregates or persist. The caller must
-- supply its server-side business identity; browser-supplied IDs are not trusted.
CREATE FUNCTION public.commission_compare_from_orders_v1(p_business_id uuid,p_month date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT core.commission_compare_from_orders_v1(p_business_id,p_month)
$$;
CREATE FUNCTION public.commission_persist_from_orders_v1(p_business_id uuid,p_month date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE comparison jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 comparison:=core.commission_compare_from_orders_v1(p_business_id,p_month);
 IF comparison->>'canPersist' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'commission_source_unverified' USING ERRCODE='55000'; END IF;
 RETURN core.compute_commission(p_business_id,p_month,
   (comparison->>'grossSalesCents')::numeric/100,
   (comparison->>'refundCents')::numeric/100,true);
END $$;

REVOKE ALL ON FUNCTION core.commission_order_day_rows_v1(uuid,date),
 core.commission_input_from_orders_v1(uuid,date),core.commission_compare_from_orders_v1(uuid,date),
 public.commission_compare_from_orders_v1(uuid,date),public.commission_persist_from_orders_v1(uuid,date)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.commission_compare_from_orders_v1(uuid,date),
 public.commission_persist_from_orders_v1(uuid,date) TO service_role;
COMMIT;
