-- Nazar only. Readback never grants consent or removes a local suppression.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.installation WHERE declared_project_ref='khgczybubufouraqyrcj')
 OR to_regclass('core.consent_events') IS NULL THEN RAISE EXCEPTION 'STOP: expected Nazar CRM'; END IF;
END $guard$;

CREATE TABLE core.klaviyo_email_observations (
 customer_id uuid PRIMARY KEY REFERENCES core.customers(id),
 status text NOT NULL CHECK(status IN ('confirmed','pending','unsubscribed','suppressed','not_on_list')),
 checked_at timestamptz NOT NULL,
 provider_updated_at timestamptz,
 blocked_status text CHECK(blocked_status IN ('unsubscribed','suppressed')),
 blocked_at timestamptz,
 CHECK((blocked_status IS NULL)=(blocked_at IS NULL))
);
ALTER TABLE core.klaviyo_email_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.klaviyo_email_observations FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.crm_klaviyo_status_v1(p_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.crm_staff WHERE auth_user_id=auth.uid() AND active) THEN
  RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
 END IF;
 SELECT jsonb_build_object('email',lower(trim(c.email)),'localStatus',c.email_status,
   'saved',CASE WHEN o.customer_id IS NULL THEN NULL ELSE jsonb_build_object(
    'status',o.status,'checkedAt',o.checked_at,'providerUpdatedAt',o.provider_updated_at,
    'blocked',c.email_status='unsubscribed' OR o.blocked_at IS NOT NULL,
    'blockedStatus',o.blocked_status,'blockedAt',coalesce(o.blocked_at,c.email_suppressed_at)) END)
 INTO v_result FROM core.customers c LEFT JOIN core.klaviyo_email_observations o ON o.customer_id=c.id
 WHERE c.id=p_customer_id AND c.business_id='a358eba4-b197-4309-805b-46f43a718454'::uuid;
 RETURN v_result;
END $fn$;
REVOKE ALL ON FUNCTION public.crm_klaviyo_status_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.crm_klaviyo_status_v1(uuid) TO authenticated;

CREATE FUNCTION public.record_klaviyo_status_v1(p_customer_id uuid,p_email text,p_status text,
 p_checked_at timestamptz,p_provider_updated_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE c core.customers%ROWTYPE; o core.klaviyo_email_observations%ROWTYPE; v_negative boolean;
 v_blocked_status text; v_blocked_at timestamptz;
BEGIN
 IF p_status IS NULL OR p_status NOT IN ('confirmed','pending','unsubscribed','suppressed','not_on_list')
  OR p_checked_at IS NULL OR p_checked_at>clock_timestamp()+interval '1 minute'
  OR p_checked_at<clock_timestamp()-interval '5 minutes' THEN
  RAISE EXCEPTION 'Invalid observation' USING ERRCODE='22023';
 END IF;
 -- Serialize observations and form updates for this customer; never trust a client-supplied email.
 SELECT * INTO c FROM core.customers WHERE id=p_customer_id
  AND business_id='a358eba4-b197-4309-805b-46f43a718454'::uuid FOR UPDATE;
 IF NOT FOUND OR c.email IS NULL OR lower(trim(c.email)) IS DISTINCT FROM p_email THEN
  RAISE EXCEPTION 'Customer changed or missing' USING ERRCODE='22023';
 END IF;
 SELECT * INTO o FROM core.klaviyo_email_observations WHERE customer_id=c.id;
 v_negative:=p_status IN ('unsubscribed','suppressed');
 IF o.checked_at IS NOT NULL AND o.checked_at>=p_checked_at AND NOT v_negative THEN
  RETURN jsonb_build_object('status',o.status,'checkedAt',o.checked_at,'providerUpdatedAt',o.provider_updated_at,
   'blocked',c.email_status='unsubscribed' OR o.blocked_at IS NOT NULL,
   'blockedStatus',o.blocked_status,'blockedAt',coalesce(o.blocked_at,c.email_suppressed_at));
 END IF;
 v_blocked_status:=coalesce(o.blocked_status,CASE WHEN v_negative THEN p_status END);
 v_blocked_at:=coalesce(o.blocked_at,CASE WHEN v_negative THEN p_checked_at END);
 IF v_negative THEN
  UPDATE core.customers SET email_status='unsubscribed',
   email_suppressed_at=coalesce(email_suppressed_at,p_checked_at),updated_at=now() WHERE id=c.id;
  -- One evidence event on first provider block, not on every profile refresh.
  IF o.blocked_at IS NULL THEN
   INSERT INTO core.consent_events(customer_id,event_type,source,evidence_status,note)
    VALUES(c.id,'suppression','klaviyo_readback','admin_suppression',
     CASE p_status WHEN 'unsubscribed' THEN 'Klaviyo unsubscribe observed; email marketing blocked.'
     ELSE 'Klaviyo suppression observed; email marketing blocked.' END);
  END IF;
 END IF;
 -- A late negative observation still blocks delivery, but cannot replace a newer snapshot.
 IF o.checked_at IS NOT NULL AND o.checked_at>=p_checked_at THEN
  p_status:=o.status; p_checked_at:=o.checked_at; p_provider_updated_at:=o.provider_updated_at;
 END IF;
 INSERT INTO core.klaviyo_email_observations(customer_id,status,checked_at,provider_updated_at,blocked_status,blocked_at)
 VALUES(c.id,p_status,p_checked_at,p_provider_updated_at,
  v_blocked_status,v_blocked_at)
 ON CONFLICT(customer_id) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,
  provider_updated_at=excluded.provider_updated_at,blocked_status=excluded.blocked_status,blocked_at=excluded.blocked_at;
 SELECT * INTO o FROM core.klaviyo_email_observations WHERE customer_id=c.id;
 RETURN jsonb_build_object('status',o.status,'checkedAt',o.checked_at,'providerUpdatedAt',o.provider_updated_at,
  'blocked',v_negative OR c.email_status='unsubscribed' OR o.blocked_at IS NOT NULL,
  'blockedStatus',o.blocked_status,'blockedAt',coalesce(o.blocked_at,c.email_suppressed_at));
END $fn$;
REVOKE ALL ON FUNCTION public.record_klaviyo_status_v1(uuid,text,text,timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_klaviyo_status_v1(uuid,text,text,timestamptz,timestamptz) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
