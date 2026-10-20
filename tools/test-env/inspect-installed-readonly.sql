-- Post-install observation only: no application write, Auth value or body export.
-- Direct SQL cannot establish real Auth/JWT/REST or provider Data API exposure.
BEGIN TRANSACTION READ ONLY;
WITH application_catalog AS (
SELECT jsonb_build_object(
 'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('signature',n.nspname||'.'||p.proname||'('||replace(oidvectortypes(p.proargtypes),', ',',')||')','definition_md5',md5(pg_get_functiondef(p.oid))) ORDER BY n.nspname,p.proname,oidvectortypes(p.proargtypes)),'[]'::jsonb)
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('core','public') AND p.prokind IN('f','p')
 AND NOT(n.nspname='public' AND p.proname='rls_auto_enable' AND p.pronargs=0)
 AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')),
 'relations',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',n.nspname||'.'||c.relname,'kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
 'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity::text,'generated',a.attgenerated::text,'default_md5',CASE WHEN ad.oid IS NULL THEN NULL ELSE md5(pg_get_expr(ad.adbin,ad.adrelid)) END) ORDER BY a.attnum),'[]'::jsonb)
 FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)) ORDER BY n.nspname,c.relname),'[]'::jsonb)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('core','public') AND c.relkind IN('r','p','v','m','S','f')
 AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e'))) AS contract
), table_counts AS (
 SELECT jsonb_build_object(
 'businesses',(SELECT count(*) FROM core.businesses),
 'catering_decision_makers',(SELECT count(*) FROM core.catering_decision_makers),
 'catering_decisions',(SELECT count(*) FROM core.catering_decisions),
 'catering_requests',(SELECT count(*) FROM core.catering_requests),
 'consent_events',(SELECT count(*) FROM core.consent_events),
 'crm_staff',(SELECT count(*) FROM core.crm_staff),
 'customer_follow_up_tasks',(SELECT count(*) FROM core.customer_follow_up_tasks),
 'customer_notes',(SELECT count(*) FROM core.customer_notes),
 'customers',(SELECT count(*) FROM core.customers),
 'form_error_alert_gate',(SELECT count(*) FROM core.form_error_alert_gate),
 'form_errors',(SELECT count(*) FROM core.form_errors),
 'installation',(SELECT count(*) FROM core.installation),
 'klaviyo_email_observations',(SELECT count(*) FROM core.klaviyo_email_observations),
 'offers',(SELECT count(*) FROM core.offers),
 'signups',(SELECT count(*) FROM core.signups),
 'signup_request_keys',(SELECT count(*) FROM core.signup_request_keys)) AS counts
), marker_rows AS (
 SELECT 'businesses' AS name,count(*) AS rows,count(*) FILTER(WHERE is_test) AS test_rows,
 count(*) FILTER(WHERE NOT is_test) AS non_test_rows,bool_and(is_test) AS all_rows_is_test FROM core.businesses
 UNION ALL SELECT 'customers',count(*),count(*) FILTER(WHERE is_test),count(*) FILTER(WHERE NOT is_test),bool_and(is_test) FROM core.customers
 UNION ALL SELECT 'signups',count(*),count(*) FILTER(WHERE is_test),count(*) FILTER(WHERE NOT is_test),bool_and(is_test) FROM core.signups
 UNION ALL SELECT 'catering_requests',count(*),count(*) FILTER(WHERE is_test),count(*) FILTER(WHERE NOT is_test),bool_and(is_test) FROM core.catering_requests
 UNION ALL SELECT 'offers',count(*),count(*) FILTER(WHERE is_test),count(*) FILTER(WHERE NOT is_test),bool_and(is_test) FROM core.offers
), function_rows AS (
 SELECT n.nspname AS schema,p.proname AS name,
 n.nspname||'.'||p.proname||'('||replace(oidvectortypes(p.proargtypes),', ',',')||')' AS signature,
 p.prosecdef AS security_definer,
 (SELECT setting FROM unnest(p.proconfig) setting WHERE setting LIKE 'search_path=%' LIMIT 1) AS search_path_setting,
 EXISTS(SELECT 1 FROM unnest(p.proconfig) setting WHERE setting NOT LIKE 'search_path=%') AS other_configuration_present,
 md5(pg_get_functiondef(p.oid)) AS definition_md5,
 has_function_privilege('anon',p.oid,'EXECUTE') AS execute_anon,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS execute_authenticated,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS execute_service_role
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN('core','public') AND p.prokind IN('f','p')
 AND NOT(n.nspname='public' AND p.proname='rls_auto_enable' AND p.pronargs=0)
 AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
), relation_security AS (
 SELECT n.nspname AS schema,c.relname AS name,c.relkind::text AS kind,
 c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security,
 c.reloptions AS security_options,
 CASE WHEN c.relkind='v' THEN md5(pg_get_viewdef(c.oid,true)) ELSE NULL END AS view_definition_md5
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='core' AND c.relkind IN('r','p','v','m')
), staff_observation AS (
 SELECT count(*) AS total,count(*) FILTER(WHERE active) AS active,
 count(*) FILTER(WHERE NOT active) AS inactive,
 count(*) FILTER(WHERE EXISTS(SELECT 1 FROM auth.users a WHERE a.id=c.auth_user_id)) AS auth_linked,
 count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM auth.users a WHERE a.id=c.auth_user_id)) AS auth_unlinked
 FROM core.crm_staff c
)
SELECT jsonb_build_object(
 'scope','k3_installed_application_read_only_observation_not_auth_rest_acceptance',
 'captured_at',clock_timestamp(),
 'transaction_read_only',current_setting('transaction_read_only'),
 'server_version_num',current_setting('server_version_num')::integer,
 'auth_identities_included',false,
 'function_bodies_included',false,
 'real_auth_jwt_rest_verified',NULL,
 'provider_data_api_exposure_verified',NULL,
 'table_counts',(SELECT counts FROM table_counts),
 'seed_markers',(SELECT jsonb_agg(to_jsonb(m) ORDER BY name) FROM marker_rows m),
 'customer_consent_state_counts',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY email_status),'[]'::jsonb)
   FROM (SELECT email_status,count(*) AS count FROM core.customers GROUP BY email_status) s),
 'active_offer_count',(SELECT count(*) FROM core.offers WHERE active),
 'staff',(SELECT to_jsonb(s) FROM staff_observation s),
 'staff_role_counts',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY role),'[]'::jsonb)
   FROM (SELECT role,count(*) AS count FROM core.crm_staff GROUP BY role) s),
 'managed_counts',jsonb_build_object('auth_users',(SELECT count(*) FROM auth.users),
   'storage_buckets',(SELECT count(*) FROM storage.buckets),'storage_objects',(SELECT count(*) FROM storage.objects)),
 'core_role_usage',(SELECT jsonb_agg(jsonb_build_object('role',r.role,
   'usage',has_schema_privilege(r.role,'core','USAGE'),'create',has_schema_privilege(r.role,'core','CREATE')) ORDER BY r.role)
   FROM (VALUES('anon'),('authenticated'),('service_role')) r(role)),
 'application_function_count',(SELECT count(*) FROM function_rows),
 'application_functions',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY schema,name,signature),'[]'::jsonb) FROM function_rows f),
 'core_table_security',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY schema,name),'[]'::jsonb) FROM relation_security r WHERE kind IN('r','p')),
 'core_view_count',(SELECT count(*) FROM relation_security WHERE kind IN('v','m')),
 'core_views',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY schema,name),'[]'::jsonb) FROM relation_security r WHERE kind IN('v','m')),
 'view_rls_flag_is_not_underlying_table_rls_proof',true,
 'application_catalog_md5',(SELECT md5(contract::text) FROM application_catalog)
) AS observation;
ROLLBACK;
