-- LOCAL SYNTHETIC full-baseline proof only. Never run against hosted Supabase.
-- Run after full reviewed baseline + canonical migrations + new K9, in fresh DB.
BEGIN;
SET LOCAL statement_timeout='60s';
CREATE FUNCTION pg_temp.k9_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
RAISE NOTICE 'PASS %',label; END $$;
CREATE FUNCTION pg_temp.k9_denied(command text,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE command;
  EXCEPTION WHEN SQLSTATE '42501' THEN RAISE NOTICE 'PASS %',label; RETURN; END;
  RAISE EXCEPTION 'FAIL expected42501 %',label;
END $$;
DO $test$
DECLARE
  a uuid; b uuid:=gen_random_uuid(); ua uuid:=gen_random_uuid(); ub uuid:=gen_random_uuid();
  platform_user uuid:=gen_random_uuid(); legacy_user uuid:=gen_random_uuid();
  ca uuid:=gen_random_uuid(); cb uuid:=gen_random_uuid(); sa uuid:=gen_random_uuid(); sb uuid:=gen_random_uuid();
  ra uuid:=gen_random_uuid(); rb uuid:=gen_random_uuid(); tb uuid:=gen_random_uuid();
  task_a uuid; decision_a uuid; decision_b uuid:=gen_random_uuid(); error_id uuid:=gen_random_uuid();
  offer_a uuid:=gen_random_uuid(); offer_b uuid:=gen_random_uuid(); result jsonb;
BEGIN
  SELECT business_id INTO a FROM core.ops_connections LIMIT 1;
  IF a IS NULL THEN RAISE EXCEPTION 'Full Ops baseline fixture required'; END IF;
  INSERT INTO core.businesses(id,name,is_test) VALUES(a,'Synthetic A',true);
  INSERT INTO auth.users(id) VALUES(ua),(ub),(platform_user),(legacy_user);
  INSERT INTO core.business_staff(business_id,staff_id,role,active) VALUES(a,ua,'owner',true);
  INSERT INTO core.platform_operators(staff_id,active) VALUES(platform_user,true);
  INSERT INTO core.crm_staff(auth_user_id,role,active) VALUES(legacy_user,'owner',true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub',ua::text,true);
  PERFORM pg_temp.k9_assert(public.crm_staff_authorized_v1(),'legacy single-business menu');
  PERFORM pg_temp.k9_assert(public.crm_form_errors_v1()->>'total_open'='0','legacy errors single-business read');
  PERFORM pg_temp.k9_assert(public.ops_actions_v()->'items'='[]'::jsonb,'legacy Ops single-business read');
  PERFORM pg_temp.k9_assert(public.ops_connections_v()->'items' IS NOT NULL,'legacy Ops connection read');
  PERFORM pg_temp.k9_assert(public.ops_dashboard_v()->'metrics' IS NOT NULL,'legacy Ops dashboard read');
  INSERT INTO core.form_errors(id,form_kind,stage,error_code,http_status)
    VALUES(error_id,'vip','database','database_unavailable',503);
  PERFORM pg_temp.k9_assert(public.crm_resolve_form_error_v1(error_id),'legacy error write membership');
  PERFORM set_config('request.jwt.claim.sub',legacy_user::text,true);
  PERFORM pg_temp.k9_assert(NOT public.crm_staff_authorized_v1(),'legacy-only menu denied');
  PERFORM pg_temp.k9_denied('SELECT public.crm_form_errors_v1()','legacy-only error read denied');
  PERFORM pg_temp.k9_denied('SELECT public.ops_actions_v()','legacy-only Ops read denied');
  PERFORM set_config('request.jwt.claim.sub',platform_user::text,true);
  PERFORM pg_temp.k9_assert(public.ops_connections_v()->'items' IS NOT NULL,'platform-only Ops read');
  PERFORM pg_temp.k9_denied(format('SELECT public.crm_resolve_form_error_v1(%L::uuid)',error_id),'platform-only error write denied');
  PERFORM pg_temp.k9_denied('SELECT public.ops_request_action(''collect'',''{}''::jsonb)','platform-only Ops request denied');

  INSERT INTO core.businesses(id,name,is_test) VALUES(b,'Synthetic B',true);
  INSERT INTO core.business_staff(business_id,staff_id,role,active) VALUES(b,ub,'staff',true);
  INSERT INTO core.customers(id,business_id,identity_key,name,email,is_test) VALUES
    (ca,a,'fixture:'||ca::text,'INTERNAL TEST A',ca::text||'@example.invalid',true),
    (cb,b,'fixture:'||cb::text,'INTERNAL TEST B',cb::text||'@example.invalid',true);
  INSERT INTO core.signups(id,business_id,customer_id,name,email,source,fingerprint,is_test,test_reason) VALUES
    (sa,a,ca,'INTERNAL TEST A',ca::text||'@example.invalid','catering','a:'||sa::text,true,'local synthetic'),
    (sb,b,cb,'INTERNAL TEST B',cb::text||'@example.invalid','catering','b:'||sb::text,true,'local synthetic');
  INSERT INTO core.catering_requests(id,signup_id,customer_id,status,assigned_to,follow_up_at,is_test) VALUES
    (ra,sa,ca,'new','Synthetic',now()+interval '1 day',true),
    (rb,sb,cb,'new','Synthetic',now()+interval '1 day',true);
  INSERT INTO core.customer_follow_up_tasks(id,customer_id,created_by,title,assigned_to,due_at)
    VALUES(tb,cb,ub,'Synthetic B task','Synthetic',now()+interval '1 day');
  INSERT INTO core.catering_decisions(id,request_id,question,requested_by)
    VALUES(decision_b,rb,'Synthetic B question',ub);
  INSERT INTO core.offers(id,business_id,name,starts_at,ends_at,is_test) VALUES
    (offer_a,a,'Synthetic A',current_date,current_date+1,true),
    (offer_b,b,'Synthetic B',current_date,current_date+1,true);
  PERFORM set_config('request.jwt.claim.sub',ua::text,true);
  PERFORM pg_temp.k9_assert(NOT public.crm_staff_authorized_v1(),'ambiguous legacy menu fail-closed');
  PERFORM pg_temp.k9_denied('SELECT public.crm_form_errors_v1()','ambiguous tenantless errors denied');
  PERFORM pg_temp.k9_denied('SELECT public.ops_actions_v()','ambiguous legacy Ops denied');
  result:=public.crm_overview();
  PERFORM pg_temp.k9_assert(jsonb_array_length(result->'customers')=1 AND result->'customers'->0->>'id'=ca::text,'overview A only');
  result:=public.crm_overview_v2('','test');
  PERFORM pg_temp.k9_assert(jsonb_array_length(result->'customers')=1 AND result->'customers'->0->>'id'=ca::text,'overviewv2 A only');
  PERFORM pg_temp.k9_assert(public.crm_add_note(ca,'Synthetic note'),'A note write');
  PERFORM pg_temp.k9_denied(format('SELECT public.crm_add_note(%L::uuid,''Synthetic note'')',cb),'B note write denied');
  task_a:=public.crm_create_task_v1(ca,'Synthetic A task','Synthetic',now()+interval '1 day');
  PERFORM pg_temp.k9_assert(task_a IS NOT NULL,'A task create');
  PERFORM pg_temp.k9_denied(format('SELECT public.crm_create_task_v1(%L::uuid,''Synthetic task'',''Synthetic'',now())',cb),'B task create denied');
  PERFORM pg_temp.k9_assert(jsonb_array_length(public.crm_customer_tasks_v1(ca))=1,'A task read');
  PERFORM pg_temp.k9_denied(format('SELECT public.crm_customer_tasks_v1(%L::uuid)',cb),'B task read denied');
  PERFORM pg_temp.k9_assert(public.crm_complete_task_v1(task_a),'A task complete');
  PERFORM pg_temp.k9_denied(format('SELECT public.crm_complete_task_v1(%L::uuid)',tb),'B task complete denied');
  PERFORM pg_temp.k9_assert(public.crm_update_catering(ra,'contacted','Synthetic',now()+interval '1 day'),'A catering write');
  PERFORM pg_temp.k9_denied(format('SELECT public.crm_update_catering(%L::uuid,''contacted'',''Synthetic'',now())',rb),'B catering write denied');
  decision_a:=public.crm_request_catering_decision_v1(ra,'Synthetic A question');
  PERFORM pg_temp.k9_assert(decision_a IS NOT NULL,'A decision request');
  PERFORM pg_temp.k9_denied(format('SELECT public.crm_request_catering_decision_v1(%L::uuid,''Synthetic'')',rb),'B decision request denied');
  PERFORM pg_temp.k9_denied(format('SELECT public.crm_record_catering_decision_v1(%L::uuid,''Synthetic answer'')',decision_a),'decision-maker workflow retained');
  INSERT INTO core.catering_decision_makers(auth_user_id,active) VALUES(ua,true);
  PERFORM pg_temp.k9_assert(public.crm_record_catering_decision_v1(decision_a,'Synthetic answer'),'A decision with workflow proof');
  PERFORM pg_temp.k9_denied(format('SELECT public.crm_record_catering_decision_v1(%L::uuid,''Synthetic answer'')',decision_b),'B decision write denied');
  PERFORM pg_temp.k9_assert(jsonb_array_length(public.crm_catering_decisions_v1()->'items')=1,'decisions A only');
  PERFORM pg_temp.k9_assert(jsonb_array_length(public.crm_catering_notification_status_v1()->'items')=1,'notifications A only');
  PERFORM pg_temp.k9_assert(public.crm_follow_up_queue_v1()->'items' IS NOT NULL,'followup queue permission');
  PERFORM pg_temp.k9_assert(public.crm_klaviyo_status_v1(ca)->>'localStatus'='not_subscribed','A Klaviyo observation read');
  PERFORM pg_temp.k9_denied(format('SELECT public.crm_klaviyo_status_v1(%L::uuid)',cb),'B Klaviyo observation denied');
  PERFORM pg_temp.k9_assert((SELECT count(*) FROM public.list_offers(a))=1,'A offers read');
  PERFORM pg_temp.k9_denied(format('SELECT public.list_offers(%L::uuid)',b),'B offers denied');
  PERFORM pg_temp.k9_assert(public.crm_profile_sync_queue_v1(a)->'counts' IS NOT NULL,'A profile queue read');
  PERFORM pg_temp.k9_denied(format('SELECT public.crm_profile_sync_queue_v1(%L::uuid)',b),'B profile queue denied');
  PERFORM pg_temp.k9_assert(public.clover_order_match_queue_v1(a)='[]'::jsonb,'A order match queue');
  PERFORM pg_temp.k9_denied(format('SELECT public.clover_order_match_queue_v1(%L::uuid)',b),'B order queue denied');
  PERFORM pg_temp.k9_assert(public.clover_order_day_totals_v1(a,now()-interval '1 day',now())->>'orderCount'='0','A order totals');
  PERFORM pg_temp.k9_denied(format('SELECT public.clover_order_day_totals_v1(%L::uuid,now()-interval ''1 day'',now())',b),'B order totals denied');
  PERFORM pg_temp.k9_denied(format('SELECT public.clover_order_match_resolve_v1(%L::uuid,%L::uuid,NULL)',b,gen_random_uuid()),'B order match write denied');
  PERFORM pg_temp.k9_denied(format('SELECT public.crm_restore_email_consent_v1(%L::uuid,now(),''customer_web'',''Synthetic'',%L,true,true)',cb,repeat('a',64)),'B consent restore denied before evidence');
  PERFORM set_config('request.jwt.claim.sub',platform_user::text,true);
  PERFORM pg_temp.k9_assert((SELECT count(*) FROM public.list_offers(b))=1,'platform cross-business read');
  PERFORM pg_temp.k9_denied(format('SELECT public.crm_add_note(%L::uuid,''Synthetic'')',ca),'platform-only CRM write denied');
  PERFORM pg_temp.k9_denied(format('SELECT public.clover_order_match_resolve_v1(%L::uuid,%L::uuid,NULL)',a,gen_random_uuid()),'platform-only order match denied');
  PERFORM set_config('request.jwt.claim.sub',legacy_user::text,true);
  PERFORM pg_temp.k9_denied('SELECT public.crm_overview()','legacy-only overview denied');
  PERFORM pg_temp.k9_denied(format('SELECT public.list_offers(%L::uuid)',a),'legacy-only offer read denied');
END $test$;
ROLLBACK;
