-- Stage 2 of the hosted preflight. Do not run before metadata review confirms
-- these EXACT old-sandbox tables, required columns, and auth.users relationship.
-- A missing/mismatched table must stop this file; do not invent a 0 count.
-- No production target, dynamic SQL, function creation, or row/identity export.
-- Exact COUNT may scan each small table; the approved caller must supply a
-- connection/statement timeout. This file does not modify session settings.

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT pg_catalog.jsonb_build_object(
  'scope', 'reviewed_old_sandbox_aggregate_counts_not_reset_or_restore',
  'captured_at', pg_catalog.transaction_timestamp(),
  'transaction_read_only', pg_catalog.current_setting('transaction_read_only'),
  'counts', pg_catalog.jsonb_build_object(
    'core.crm_staff', (SELECT count(*) FROM core.crm_staff),
    'public.catering_orders', (SELECT count(*) FROM public.catering_orders),
    'public.site_orders', (SELECT count(*) FROM public.site_orders),
    'public.site_order_groups', (SELECT count(*) FROM public.site_order_groups),
    'public.site_order_events', (SELECT count(*) FROM public.site_order_events)
  ),
  'staff_auth_aggregate', pg_catalog.jsonb_build_object(
    'staff_count', (SELECT count(*) FROM core.crm_staff),
    'active_staff_count', (SELECT count(*) FROM core.crm_staff WHERE active),
    'inactive_staff_count', (SELECT count(*) FROM core.crm_staff WHERE NOT active),
    'staff_auth_linked_count', (SELECT count(*) FROM core.crm_staff AS s
      WHERE EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = s.auth_user_id)),
    'staff_auth_unlinked_count', (SELECT count(*) FROM core.crm_staff AS s
      WHERE NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = s.auth_user_id)),
    'auth_user_count', (SELECT count(*) FROM auth.users),
    'staff_identity_exported', false,
    'staff_preserved_for_install', false,
    'note', 'Counts only. This query does not save or reconstruct any Auth/staff identity.'
  )
) AS inspection;

ROLLBACK;
