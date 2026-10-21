-- Staff management consumer of shared contract v1.1 (staff.manage in #65).
-- No helper replacement, Auth seed, mail, settings activation or global user ban.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF to_regprocedure('core.staff_authorized_v1(uuid,text)') IS NULL THEN RAISE EXCEPTION 'SHARED_STAFF_CONTRACT_REQUIRED'; END IF;
END $$;
CREATE TABLE core.staff_management_settings (
 business_id uuid PRIMARY KEY REFERENCES core.businesses(id),
 invite_enabled boolean NOT NULL DEFAULT false,
 invite_redirect_url text NOT NULL CHECK(invite_redirect_url ~ '^https://[A-Za-z0-9.-]+/staff/system$')
);
CREATE TABLE core.staff_management_invites (
 business_id uuid NOT NULL REFERENCES core.businesses(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 requested_by uuid NOT NULL,email_norm text NOT NULL CHECK(length(email_norm)<=254 AND email_norm=lower(btrim(email_norm)) AND email_norm ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 role text NOT NULL CHECK(role IN('owner','manager','staff')),request_key uuid NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','sending','invited','existing','failed','unknown')),
 claim_token uuid,claimed_at timestamptz,finished_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 auth_user_id uuid REFERENCES auth.users(id),safe_code text NOT NULL DEFAULT 'prepared',
 PRIMARY KEY(business_id,id),UNIQUE(business_id,request_key),
 FOREIGN KEY(business_id,requested_by) REFERENCES core.business_staff(business_id,staff_id),
 CHECK(safe_code IN('prepared','sending','invited','existing_account_added','invite_rejected','invite_unknown','access_revoked','expired'))
);
CREATE UNIQUE INDEX staff_management_one_pending_email ON core.staff_management_invites(business_id,email_norm)
 WHERE state IN('prepared','sending','unknown');
CREATE TABLE core.staff_management_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL REFERENCES core.businesses(id),
 actor_staff_id uuid NOT NULL,target_staff_id uuid,
 action text NOT NULL CHECK(action IN('member_updated','invite_finished')),
 old_role text,new_role text,old_active boolean,new_active boolean,
 safe_code text NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(business_id,actor_staff_id) REFERENCES core.business_staff(business_id,staff_id),
 FOREIGN KEY(business_id,target_staff_id) REFERENCES core.business_staff(business_id,staff_id)
);
ALTER TABLE core.staff_management_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.staff_management_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.staff_management_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.staff_management_settings,core.staff_management_invites,core.staff_management_audit FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.staff_management_context_v1(p_business_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s core.staff_management_settings;
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' OR NOT core.staff_authorized_v1(p_business_id,'staff.manage') THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM core.staff_management_settings WHERE business_id=p_business_id;
 RETURN jsonb_build_object('businessId',p_business_id,'inviteEnabled',coalesce(s.invite_enabled,false),'redirectUrl',s.invite_redirect_url);
END $$;
CREATE FUNCTION public.staff_members_list_v1(p_business_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE context jsonb;
BEGIN
 context:=public.staff_management_context_v1(p_business_id);
 RETURN jsonb_build_object('businessId',p_business_id,'actorId',auth.uid(),'inviteEnabled',context->'inviteEnabled',
 'truncated',(SELECT count(*)>200 FROM core.business_staff WHERE business_id=p_business_id),
 'members',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.email,m."staffId") FROM (
  SELECT s.staff_id AS "staffId",left(coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name',''),200) AS name,
   u.email,s.role,s.active,s.staff_id=auth.uid() AS "isSelf"
  FROM core.business_staff s JOIN auth.users u ON u.id=s.staff_id WHERE s.business_id=p_business_id ORDER BY u.email,s.staff_id LIMIT 200
 )m),'[]'::jsonb),
 'invites',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i."createdAt" DESC) FROM (
  SELECT id,email_norm AS email,role,
   CASE WHEN state='sending' AND claimed_at<clock_timestamp()-interval '5 minutes' THEN 'unknown' ELSE state END AS state,
   CASE WHEN state='sending' AND claimed_at<clock_timestamp()-interval '5 minutes' THEN 'invite_unknown' ELSE safe_code END AS "safeCode",created_at AS "createdAt"
  FROM core.staff_management_invites WHERE business_id=p_business_id ORDER BY created_at DESC LIMIT 30
 )i),'[]'::jsonb));
END $$;
CREATE FUNCTION public.staff_member_update_v1(p_business_id uuid,p_target_staff_id uuid,p_role text,p_active boolean,p_expected_role text,p_expected_active boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE before core.business_staff;
BEGIN
 PERFORM public.staff_management_context_v1(p_business_id);
 IF p_role IS NULL OR p_role NOT IN('owner','manager','staff') OR p_active IS NULL OR p_expected_role IS NULL OR p_expected_active IS NULL THEN RAISE EXCEPTION 'Invalid parameters' USING ERRCODE='22023'; END IF;
 -- Same tenant row lock for every management mutation: concurrent owner changes serialize.
 PERFORM 1 FROM core.businesses WHERE id=p_business_id FOR UPDATE;
 PERFORM public.staff_management_context_v1(p_business_id);
 SELECT * INTO before FROM core.business_staff WHERE business_id=p_business_id AND staff_id=p_target_staff_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('changed',false,'code','member_not_found'); END IF;
 IF before.role<>p_expected_role OR before.active<>p_expected_active THEN RETURN jsonb_build_object('changed',false,'code','stale_member'); END IF;
 IF before.role='owner' AND before.active AND p_target_staff_id=auth.uid() AND NOT p_active THEN RETURN jsonb_build_object('changed',false,'code','own_owner'); END IF;
 IF before.role='owner' AND before.active AND (p_role<>'owner' OR NOT p_active)
 AND (SELECT count(*) FROM core.business_staff WHERE business_id=p_business_id AND role='owner' AND active)<=1 THEN RETURN jsonb_build_object('changed',false,'code','last_owner'); END IF;
 IF before.role=p_role AND before.active=p_active THEN RETURN jsonb_build_object('changed',false,'code','unchanged'); END IF;
 UPDATE core.business_staff SET role=p_role,active=p_active WHERE business_id=p_business_id AND staff_id=p_target_staff_id;
 INSERT INTO core.staff_management_audit(business_id,actor_staff_id,target_staff_id,action,old_role,new_role,old_active,new_active,safe_code)
 VALUES(p_business_id,auth.uid(),p_target_staff_id,'member_updated',before.role,p_role,before.active,p_active,'updated');
 RETURN jsonb_build_object('changed',true,'code','updated');
END $$;

CREATE FUNCTION public.staff_invite_prepare_v1(p_business_id uuid,p_email text,p_role text,p_request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE context jsonb;r core.staff_management_invites;mail text:=lower(btrim(p_email));
BEGIN
 context:=public.staff_management_context_v1(p_business_id);
 IF mail IS NULL OR length(mail)>254 OR mail !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR p_role IS NULL OR p_role NOT IN('owner','manager','staff') OR p_request_key IS NULL THEN RAISE EXCEPTION 'Invalid parameters' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM core.businesses WHERE id=p_business_id FOR UPDATE;
 context:=public.staff_management_context_v1(p_business_id);
 IF NOT(context->>'inviteEnabled')::boolean THEN RETURN jsonb_build_object('code','configuration_required'); END IF;
 SELECT * INTO r FROM core.staff_management_invites WHERE business_id=p_business_id AND request_key=p_request_key;
 IF FOUND THEN
  IF r.requested_by<>auth.uid() OR r.email_norm<>mail OR r.role<>p_role THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('inviteId',r.id,'state',r.state,'code',r.safe_code);
 END IF;
 IF EXISTS(SELECT 1 FROM core.business_staff s JOIN auth.users u ON u.id=s.staff_id WHERE s.business_id=p_business_id AND lower(u.email)=mail) THEN RETURN jsonb_build_object('code','member_exists'); END IF;
 UPDATE core.staff_management_invites SET state='failed',safe_code='expired',finished_at=clock_timestamp()
 WHERE business_id=p_business_id AND email_norm=mail AND state='prepared' AND created_at<clock_timestamp()-interval '5 minutes';
 SELECT * INTO r FROM core.staff_management_invites WHERE business_id=p_business_id AND email_norm=mail AND state IN('prepared','sending','unknown');
 IF FOUND THEN RETURN jsonb_build_object('inviteId',r.id,'state',r.state,'code',CASE WHEN r.state='unknown' THEN 'invite_unknown' ELSE 'in_progress' END); END IF;
 INSERT INTO core.staff_management_invites(business_id,requested_by,email_norm,role,request_key) VALUES(p_business_id,auth.uid(),mail,p_role,p_request_key) RETURNING * INTO r;
 RETURN jsonb_build_object('inviteId',r.id,'state',r.state,'code','prepared');
END $$;
CREATE FUNCTION public.staff_invite_gate_v1(p_business_id uuid,p_invite_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.staff_management_invites;
BEGIN
 PERFORM public.staff_management_context_v1(p_business_id);
 PERFORM 1 FROM core.businesses WHERE id=p_business_id FOR UPDATE;
 PERFORM public.staff_management_context_v1(p_business_id);
 UPDATE core.staff_management_invites SET state='sending',safe_code='sending',claim_token=gen_random_uuid(),claimed_at=clock_timestamp()
 WHERE business_id=p_business_id AND id=p_invite_id AND requested_by=auth.uid() AND state='prepared' AND created_at>=clock_timestamp()-interval '5 minutes' RETURNING * INTO r;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('inviteId',r.id,'claimToken',r.claim_token);
END $$;

-- Private persisted actor check for the server finalizer. Actor is read from a JWT-gated
-- invite row, never accepted as a caller-supplied UUID or as a service-key privilege.
CREATE FUNCTION core.staff_invite_actor_active_v1(r core.staff_management_invites) RETURNS boolean
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM core.business_staff s WHERE s.business_id=r.business_id AND s.staff_id=r.requested_by AND s.active
 AND(s.role='owner' OR EXISTS(SELECT 1 FROM core.platform_operators p WHERE p.staff_id=s.staff_id AND p.active)));
$$;
CREATE FUNCTION public.staff_invite_context_v1(p_business_id uuid,p_invite_id uuid,p_claim_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.staff_management_invites;s core.staff_management_settings;u uuid;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM core.staff_management_invites WHERE business_id=p_business_id AND id=p_invite_id AND claim_token=p_claim_token AND state='sending';
 SELECT * INTO s FROM core.staff_management_settings WHERE business_id=p_business_id;
 IF r.id IS NULL OR r.claimed_at<clock_timestamp()-interval '5 minutes' OR NOT core.staff_invite_actor_active_v1(r) OR NOT coalesce(s.invite_enabled,false) THEN RETURN NULL; END IF;
 SELECT id INTO u FROM auth.users WHERE lower(email)=r.email_norm ORDER BY id LIMIT 1;
 RETURN jsonb_build_object('email',r.email_norm,'role',r.role,'redirectUrl',s.invite_redirect_url,'existingUserId',u);
END $$;
CREATE FUNCTION public.staff_invite_finish_v1(p_business_id uuid,p_invite_id uuid,p_claim_token uuid,p_auth_user_id uuid,p_outcome text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.staff_management_invites;code text;s core.staff_management_settings;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN('invited','existing','failed','unknown') THEN RAISE EXCEPTION 'Invalid result' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM core.businesses WHERE id=p_business_id FOR UPDATE;
 SELECT * INTO r FROM core.staff_management_invites WHERE business_id=p_business_id AND id=p_invite_id AND claim_token=p_claim_token FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 IF r.state IN('invited','existing','failed','unknown') THEN RETURN jsonb_build_object('code',r.safe_code,'state',r.state); END IF;
 IF r.state<>'sending' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM core.staff_management_settings WHERE business_id=p_business_id;
 IF p_outcome IN('invited','existing') THEN
  IF NOT core.staff_invite_actor_active_v1(r) OR NOT coalesce(s.invite_enabled,false) OR r.claimed_at<clock_timestamp()-interval '5 minutes' THEN
   p_outcome:='unknown';code:='access_revoked';
  ELSIF p_auth_user_id IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_auth_user_id AND lower(email)=r.email_norm) THEN
   RAISE EXCEPTION 'Identity mismatch' USING ERRCODE='42501';
  ELSE
   -- An invitation can never overwrite/reactivate an existing membership.
   INSERT INTO core.business_staff(business_id,staff_id,role,active) VALUES(p_business_id,p_auth_user_id,r.role,true) ON CONFLICT DO NOTHING;
   code:=CASE WHEN p_outcome='invited' THEN 'invited' ELSE 'existing_account_added' END;
  END IF;
 ELSE code:=CASE WHEN p_outcome='unknown' THEN 'invite_unknown' ELSE 'invite_rejected' END;
 END IF;
 UPDATE core.staff_management_invites SET state=p_outcome,safe_code=code,finished_at=clock_timestamp(),auth_user_id=CASE WHEN p_outcome IN('invited','existing') THEN p_auth_user_id ELSE NULL END
 WHERE business_id=p_business_id AND id=p_invite_id;
 INSERT INTO core.staff_management_audit(business_id,actor_staff_id,target_staff_id,action,new_role,new_active,safe_code)
 VALUES(p_business_id,r.requested_by,CASE WHEN p_outcome IN('invited','existing') THEN p_auth_user_id ELSE NULL END,'invite_finished',r.role,CASE WHEN p_outcome IN('invited','existing') THEN true ELSE NULL END,code);
 RETURN jsonb_build_object('code',code,'state',p_outcome);
END $$;
REVOKE ALL ON FUNCTION core.staff_invite_actor_active_v1(core.staff_management_invites) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.staff_management_context_v1(uuid),public.staff_members_list_v1(uuid),public.staff_member_update_v1(uuid,uuid,text,boolean,text,boolean),public.staff_invite_prepare_v1(uuid,text,text,uuid),public.staff_invite_gate_v1(uuid,uuid),public.staff_invite_context_v1(uuid,uuid,uuid),public.staff_invite_finish_v1(uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.staff_management_context_v1(uuid),public.staff_members_list_v1(uuid),public.staff_member_update_v1(uuid,uuid,text,boolean,text,boolean),public.staff_invite_prepare_v1(uuid,text,text,uuid),public.staff_invite_gate_v1(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_invite_context_v1(uuid,uuid,uuid),public.staff_invite_finish_v1(uuid,uuid,uuid,uuid,text) TO service_role;
COMMIT;
