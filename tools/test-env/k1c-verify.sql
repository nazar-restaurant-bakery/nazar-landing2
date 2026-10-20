-- Read-only post-install / post-collect evidence. Run only on the selected environment.
BEGIN READ ONLY;
SELECT declared_project_ref FROM core.installation;
SELECT count(*) AS ops_tables_with_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='core' AND c.relname IN('ops_metrics','ops_actions','ops_connections','ops_offer_approvals','ops_csv_imports','ops_api_budget') AND c.relrowsecurity;
SELECT has_function_privilege('authenticated','public.ops_internal_snapshot_v()','EXECUTE') AS authenticated_internal_must_be_false,
 has_function_privilege('service_role','public.ops_internal_snapshot_v()','EXECUTE') AS service_internal_must_be_true;
SELECT count(*) AS expected_real_forms_7d FROM core.signups
 WHERE business_id=(SELECT id FROM core.businesses) AND NOT is_test AND created_at >= (((now() AT TIME ZONE 'America/New_York')::date-7)::timestamp AT TIME ZONE 'America/New_York')
 AND created_at < ((now() AT TIME ZONE 'America/New_York')::date::timestamp AT TIME ZONE 'America/New_York');
SELECT source,metric,value_num,value_text,collected_at FROM core.ops_metrics
 WHERE source IN('supabase','site') ORDER BY collected_at DESC,source,metric LIMIT 30;
SELECT source,status,last_ok_at FROM core.ops_connections ORDER BY source;
ROLLBACK;
