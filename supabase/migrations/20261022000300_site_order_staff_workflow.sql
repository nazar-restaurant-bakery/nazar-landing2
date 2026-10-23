-- K16 PR 3 candidate, after site order foundation. Private tables stay private.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('site_order_staff_workflow_v1',0));

DO $guard$ BEGIN
  IF to_regclass('core.site_orders') IS NULL
    OR to_regclass('core.site_order_payments') IS NULL
    OR to_regclass('core.site_order_tickets') IS NULL
    OR to_regclass('core.site_order_events') IS NULL
    OR to_regprocedure('core.staff_authorized_v1(uuid,text)') IS NULL
  THEN RAISE EXCEPTION 'K16_SITE_ORDER_FOUNDATION_REQUIRED'; END IF;
END $guard$;

CREATE FUNCTION public.site_order_ops_queue_v1(p_business_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_items jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated'
    OR NOT core.staff_authorized_v1(p_business_id,'ops.read') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.requested_at,q.ticket_id),'[]'::jsonb)
    INTO v_items
  FROM (
    SELECT t.id AS ticket_id,t.site_order_id,t.department,t.status AS ticket_status,
      t.requested_at,t.lines,o.customer_name,o.kind,o.fulfillment_method,
      o.preparation_note,o.total_cents,o.status AS order_status,o.created_at
    FROM core.site_order_tickets t
    JOIN core.site_orders o ON o.id=t.site_order_id AND o.business_id=t.business_id
    WHERE t.business_id=p_business_id
      AND t.status IN ('new','needs_reschedule','accepted','preparing','ready')
      AND o.status IN ('paid','needs_reschedule')
      AND EXISTS (
        SELECT 1 FROM core.site_order_payments p
        WHERE p.site_order_id=o.id AND p.business_id=o.business_id
          AND p.status='verified' AND p.clover_payment_id IS NOT NULL
          AND p.verified_cents=o.total_cents)
    ORDER BY t.requested_at,t.id
    LIMIT 50
  ) q;
  RETURN jsonb_build_object('business_id',p_business_id,'items',v_items);
END $$;

CREATE FUNCTION public.site_order_ticket_advance_v1(
  p_business_id uuid,p_ticket_id uuid,p_expected_status text,p_next_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_current text; v_order_id uuid; v_order_status text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated'
    OR NOT core.staff_authorized_v1(p_business_id,'ops.write') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF NOT ((p_expected_status='new' AND p_next_status='preparing')
    OR (p_expected_status='accepted' AND p_next_status='preparing')
    OR (p_expected_status='preparing' AND p_next_status='ready')
    OR (p_expected_status='ready' AND p_next_status='completed')) THEN
    RAISE EXCEPTION 'Invalid ticket transition' USING ERRCODE='22023';
  END IF;
  SELECT t.status,t.site_order_id,o.status INTO v_current,v_order_id,v_order_status
    FROM core.site_order_tickets t
    JOIN core.site_orders o ON o.id=t.site_order_id AND o.business_id=t.business_id
    WHERE t.business_id=p_business_id AND t.id=p_ticket_id FOR UPDATE OF t;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ticket not found' USING ERRCODE='22023'; END IF;
  IF v_current IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'Ticket status changed' USING ERRCODE='40001';
  END IF;
  IF v_order_status<>'paid' OR NOT EXISTS (
    SELECT 1 FROM core.site_order_payments p
    WHERE p.business_id=p_business_id AND p.site_order_id=v_order_id
      AND p.status='verified' AND p.clover_payment_id IS NOT NULL
      AND p.verified_cents=(SELECT o.total_cents FROM core.site_orders o
        WHERE o.business_id=p_business_id AND o.id=v_order_id)) THEN
    RAISE EXCEPTION 'Verified payment required' USING ERRCODE='22023';
  END IF;
  UPDATE core.site_order_tickets SET status=p_next_status,updated_at=clock_timestamp()
    WHERE id=p_ticket_id AND business_id=p_business_id;
  INSERT INTO core.site_order_events(business_id,site_order_id,event_key,event_type,details)
    VALUES(p_business_id,v_order_id,'ticket:'||gen_random_uuid()::text,
      'ticket_status_changed',jsonb_build_object('ticket_id',p_ticket_id,
      'from',v_current,'to',p_next_status,'actor_id',auth.uid()));
  RETURN jsonb_build_object('ticket_id',p_ticket_id,'status',p_next_status);
END $$;

REVOKE ALL ON FUNCTION public.site_order_ops_queue_v1(uuid),
  public.site_order_ticket_advance_v1(uuid,uuid,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.site_order_ops_queue_v1(uuid),
  public.site_order_ticket_advance_v1(uuid,uuid,text,text) TO authenticated;
COMMIT;
