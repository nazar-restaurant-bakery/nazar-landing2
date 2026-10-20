-- Hosted application preflight, metadata only. Run only after the caller has
-- independently verified the approved sandbox connection. A database name or
-- application schema is not proof of a Supabase project identity.
--
-- This file makes one read-only snapshot and returns one JSON document. It does
-- not execute application routines, reveal function/default/policy bodies,
-- retrieve Auth identities, or count application rows. Definition MD5 values
-- are change detectors; the private reviewed source remains authoritative.
-- Catalog contract: PostgreSQL 17 or newer (the reviewed hosted targets use 17).
--
-- Exact old-application counts are in inspect-hosted-old-counts-readonly.sql.
-- Run that second file ONLY after this inventory confirms its five exact table
-- names and column contracts. A CASE/to_regclass guard cannot make a missing
-- relation safe to reference: PostgreSQL resolves relation names while parsing.
--
-- Staff preservation design (NOT executed here): in the SAME future installer
-- transaction, before dropping approved application objects, a PRIVATE TEMP
-- table ON COMMIT DROP may hold only the existing core.crm_staff Auth link and
-- active flag, with privileges restricted to that installer session. Preserve
-- auth.users untouched; do not export, log, return, or put the Auth UUID into a
-- file. Restore that one link only after the new staff schema/role contract has
-- been explicitly reviewed. Do not infer an owner/staff role from active=true;
-- fail closed if the reviewed source requires a role not supplied by the user.
-- This metadata file does not create a TEMP table or preserve an identity.
--
-- Catalog dependency records do not describe every PL/pgSQL-body dependency.
-- Manual private definition review is still required before an installer is
-- approved. No DROP CASCADE list may be inferred solely from this JSON.

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH RECURSIVE
app_namespaces AS (
  SELECT n.oid, n.nspname, n.nspowner, n.nspacl
  FROM pg_catalog.pg_namespace AS n
  WHERE n.nspname IN ('core', 'public')
),
api_roles AS (
  SELECT requested.role_name, r.oid, r.rolsuper, r.rolinherit, r.rolbypassrls
  FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS requested(role_name)
  LEFT JOIN pg_catalog.pg_roles AS r ON r.rolname = requested.role_name
),
role_reach AS (
  SELECT r.oid AS seed_oid, r.oid AS reached_oid
  FROM api_roles AS r WHERE r.oid IS NOT NULL
  UNION
  SELECT rr.seed_oid, am.roleid
  FROM role_reach AS rr
  JOIN pg_catalog.pg_auth_members AS am ON am.member = rr.reached_oid
),
extension_members AS (
  SELECT d.classid, d.objid, d.objsubid, e.extname
  FROM pg_catalog.pg_depend AS d
  JOIN pg_catalog.pg_extension AS e
    ON d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
   AND d.refobjid = e.oid
  WHERE d.deptype = 'e'
),
app_routines AS (
  SELECT p.*, n.nspname, l.lanname,
         (SELECT em.extname FROM extension_members AS em
          WHERE em.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            AND em.objid = p.oid AND em.objsubid = 0 LIMIT 1) AS extension_name
  FROM pg_catalog.pg_proc AS p
  JOIN app_namespaces AS n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
  WHERE p.prokind IN ('f', 'p', 'w')
),
app_relations AS (
  SELECT c.*, n.nspname,
         (SELECT em.extname FROM extension_members AS em
          WHERE em.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
            AND em.objid = c.oid AND em.objsubid = 0 LIMIT 1) AS extension_name
  FROM pg_catalog.pg_class AS c
  JOIN app_namespaces AS n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'i', 'I')
),
app_constraints AS (
  SELECT co.*, n.nspname
  FROM pg_catalog.pg_constraint AS co
  JOIN app_namespaces AS n ON n.oid = co.connamespace
),
app_policies AS (
  SELECT pol.*, c.relname, c.relnamespace, c.nspname
  FROM pg_catalog.pg_policy AS pol
  JOIN app_relations AS c ON c.oid = pol.polrelid
),
app_object_refs AS (
  SELECT 'pg_catalog.pg_namespace'::pg_catalog.regclass AS classid,
         n.oid AS objid FROM app_namespaces AS n
  UNION
  SELECT 'pg_catalog.pg_proc'::pg_catalog.regclass, p.oid FROM app_routines AS p
  UNION
  SELECT 'pg_catalog.pg_class'::pg_catalog.regclass, c.oid FROM app_relations AS c
  UNION
  SELECT 'pg_catalog.pg_constraint'::pg_catalog.regclass, co.oid
  FROM app_constraints AS co
  UNION
  SELECT 'pg_catalog.pg_attrdef'::pg_catalog.regclass, ad.oid
  FROM pg_catalog.pg_attrdef AS ad
  JOIN app_relations AS c ON c.oid = ad.adrelid
  UNION
  SELECT 'pg_catalog.pg_trigger'::pg_catalog.regclass, t.oid
  FROM pg_catalog.pg_trigger AS t
  JOIN app_relations AS c ON c.oid = t.tgrelid
  UNION
  SELECT 'pg_catalog.pg_policy'::pg_catalog.regclass, pol.oid FROM app_policies AS pol
  UNION
  SELECT 'pg_catalog.pg_type'::pg_catalog.regclass, ty.oid
  FROM pg_catalog.pg_type AS ty
  JOIN app_namespaces AS n ON n.oid = ty.typnamespace
  UNION
  SELECT 'pg_catalog.pg_rewrite'::pg_catalog.regclass, rw.oid
  FROM pg_catalog.pg_rewrite AS rw
  JOIN app_relations AS c ON c.oid = rw.ev_class
  UNION
  SELECT 'pg_catalog.pg_default_acl'::pg_catalog.regclass, da.oid
  FROM pg_catalog.pg_default_acl AS da
  JOIN app_namespaces AS n ON n.oid = da.defaclnamespace
),
app_dependencies AS (
  SELECT d.*,
    EXISTS (SELECT 1 FROM app_object_refs AS a
            WHERE a.classid = d.classid AND a.objid = d.objid) AS source_in_inventory,
    EXISTS (SELECT 1 FROM app_object_refs AS a
            WHERE a.classid = d.refclassid AND a.objid = d.refobjid) AS target_in_inventory
  FROM pg_catalog.pg_depend AS d
  WHERE EXISTS (SELECT 1 FROM app_object_refs AS a
                WHERE a.classid = d.classid AND a.objid = d.objid)
     OR EXISTS (SELECT 1 FROM app_object_refs AS a
                WHERE a.classid = d.refclassid AND a.objid = d.refobjid)
),
function_inventory AS (
  SELECT p.nspname || '.' || p.proname AS sort_name,
    pg_catalog.jsonb_build_object(
      'schema', p.nspname, 'name', p.proname,
      'identity_arguments', pg_catalog.pg_get_function_identity_arguments(p.oid),
      'identity_signature', p.oid::pg_catalog.regprocedure::text,
      'result_type', pg_catalog.pg_get_function_result(p.oid),
      'definition_md5', pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)),
      'kind', p.prokind, 'owner', pg_catalog.pg_get_userbyid(p.proowner),
      'language', p.lanname, 'security_definer', p.prosecdef,
      'leakproof', p.proleakproof, 'volatility', p.provolatile,
      'parallel', p.proparallel, 'extension', p.extension_name,
      'known_managed_public_name', p.nspname = 'public' AND p.proname = 'rls_auto_enable',
      'search_path_setting', (
        SELECT cfg FROM pg_catalog.unnest(p.proconfig) AS cfg
        WHERE cfg LIKE 'search_path=%' LIMIT 1
      ),
      'other_function_configuration_present', EXISTS (
        SELECT 1 FROM pg_catalog.unnest(p.proconfig) AS cfg
        WHERE cfg NOT LIKE 'search_path=%'
      ),
      'explicit_acl_is_null', p.proacl IS NULL,
      'acl', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'grantor', pg_catalog.pg_get_userbyid(a.grantor),
          'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                          ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
          'privilege', a.privilege_type, 'grantable', a.is_grantable
        ) ORDER BY a.grantee, a.privilege_type)
        FROM pg_catalog.aclexplode(
          COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
        ) AS a),
      'effective_api_execute', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'role', r.role_name, 'role_exists', r.oid IS NOT NULL,
          'execute', CASE WHEN r.oid IS NULL THEN NULL
                          ELSE pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE') END
        ) ORDER BY r.role_name) FROM api_roles AS r
      )
    ) AS item
  FROM app_routines AS p
),
relation_inventory AS (
  SELECT c.nspname || '.' || c.relname AS sort_name,
    pg_catalog.jsonb_build_object(
      'schema', c.nspname, 'name', c.relname, 'kind', c.relkind,
      'owner', pg_catalog.pg_get_userbyid(c.relowner), 'extension', c.extension_name,
      'rls_enabled', c.relrowsecurity, 'rls_forced', c.relforcerowsecurity,
      'row_estimate_not_exact_count', c.reltuples,
      'explicit_acl_is_null', c.relacl IS NULL,
      'acl', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'grantor', pg_catalog.pg_get_userbyid(a.grantor),
          'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                          ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
          'privilege', a.privilege_type, 'grantable', a.is_grantable
        ) ORDER BY a.grantee, a.privilege_type)
        FROM pg_catalog.aclexplode(COALESCE(c.relacl,
          pg_catalog.acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
                               c.relowner))) AS a),
      'view_definition_md5', CASE WHEN c.relkind IN ('v', 'm')
        THEN pg_catalog.md5(pg_catalog.pg_get_viewdef(c.oid, false)) ELSE NULL END,
      'view_security_options', (SELECT pg_catalog.jsonb_agg(opt ORDER BY opt)
        FROM pg_catalog.unnest(c.reloptions) AS opt
        WHERE opt LIKE 'security_invoker=%' OR opt LIKE 'security_barrier=%'),
      'index_definition_md5', CASE WHEN c.relkind IN ('i', 'I')
        THEN pg_catalog.md5(pg_catalog.pg_get_indexdef(c.oid)) ELSE NULL END,
      'columns', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'position', a.attnum, 'name', a.attname,
          'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
          'not_null', a.attnotnull, 'identity', a.attidentity,
          'generated', a.attgenerated, 'default_present', ad.oid IS NOT NULL,
          'default_definition_md5', CASE WHEN ad.oid IS NULL THEN NULL
            ELSE pg_catalog.md5(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid, false)) END,
          'column_acl_present', a.attacl IS NOT NULL
        ) ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute AS a
        LEFT JOIN pg_catalog.pg_attrdef AS ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
      'effective_api_privileges', CASE WHEN c.relkind IN ('i', 'I') THEN NULL ELSE (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'role', r.role_name, 'role_exists', r.oid IS NOT NULL,
          'select', CASE WHEN r.oid IS NULL THEN NULL
            WHEN c.relkind = 'S' THEN pg_catalog.has_sequence_privilege(r.oid, c.oid, 'SELECT')
            ELSE pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT') END,
          'insert', CASE WHEN r.oid IS NULL OR c.relkind = 'S' THEN NULL
            ELSE pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT') END,
          'update', CASE WHEN r.oid IS NULL THEN NULL
            WHEN c.relkind = 'S' THEN pg_catalog.has_sequence_privilege(r.oid, c.oid, 'UPDATE')
            ELSE pg_catalog.has_table_privilege(r.oid, c.oid, 'UPDATE') END,
          'delete', CASE WHEN r.oid IS NULL OR c.relkind = 'S' THEN NULL
            ELSE pg_catalog.has_table_privilege(r.oid, c.oid, 'DELETE') END,
          'truncate', CASE WHEN r.oid IS NULL OR c.relkind = 'S' THEN NULL
            ELSE pg_catalog.has_table_privilege(r.oid, c.oid, 'TRUNCATE') END,
          'references', CASE WHEN r.oid IS NULL OR c.relkind = 'S' THEN NULL
            ELSE pg_catalog.has_table_privilege(r.oid, c.oid, 'REFERENCES') END,
          'trigger', CASE WHEN r.oid IS NULL OR c.relkind = 'S' THEN NULL
            ELSE pg_catalog.has_table_privilege(r.oid, c.oid, 'TRIGGER') END,
          'sequence_usage', CASE WHEN r.oid IS NULL OR c.relkind <> 'S' THEN NULL
            ELSE pg_catalog.has_sequence_privilege(r.oid, c.oid, 'USAGE') END
        ) ORDER BY r.role_name) FROM api_roles AS r
      ) END
    ) AS item
  FROM app_relations AS c
),
constraint_inventory AS (
  SELECT co.nspname || '.' || co.conname AS sort_name,
    pg_catalog.jsonb_build_object(
      'schema', co.nspname, 'name', co.conname, 'kind', co.contype,
      'relation', CASE WHEN co.conrelid = 0 THEN NULL
                       ELSE co.conrelid::pg_catalog.regclass::text END,
      'referenced_relation', CASE WHEN co.confrelid = 0 THEN NULL
                       ELSE co.confrelid::pg_catalog.regclass::text END,
      'definition_md5', pg_catalog.md5(pg_catalog.pg_get_constraintdef(co.oid, false)),
      'validated', co.convalidated, 'deferrable', co.condeferrable,
      'initially_deferred', co.condeferred, 'no_inherit', co.connoinherit,
      'delete_action', co.confdeltype, 'update_action', co.confupdtype,
      'columns', (SELECT pg_catalog.jsonb_agg(a.attname ORDER BY k.ordinality)
        FROM pg_catalog.unnest(co.conkey) WITH ORDINALITY AS k(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid = co.conrelid AND a.attnum = k.attnum),
      'referenced_columns', (SELECT pg_catalog.jsonb_agg(a.attname ORDER BY k.ordinality)
        FROM pg_catalog.unnest(co.confkey) WITH ORDINALITY AS k(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid = co.confrelid AND a.attnum = k.attnum)
    ) AS item
  FROM app_constraints AS co
),
policy_inventory AS (
  SELECT pol.nspname || '.' || pol.relname || '.' || pol.polname AS sort_name,
    pg_catalog.jsonb_build_object(
      'schema', pol.nspname, 'relation', pol.relname, 'name', pol.polname,
      'command', pol.polcmd, 'permissive', pol.polpermissive,
      'roles', (SELECT pg_catalog.jsonb_agg(CASE WHEN pr.role_oid = 0 THEN 'PUBLIC'
          ELSE pg_catalog.pg_get_userbyid(pr.role_oid) END ORDER BY pr.role_oid)
        FROM pg_catalog.unnest(pol.polroles) AS pr(role_oid)),
      'using_present', pol.polqual IS NOT NULL,
      'using_md5', CASE WHEN pol.polqual IS NULL THEN NULL
        ELSE pg_catalog.md5(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid, false)) END,
      'check_present', pol.polwithcheck IS NOT NULL,
      'check_md5', CASE WHEN pol.polwithcheck IS NULL THEN NULL
        ELSE pg_catalog.md5(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid, false)) END
    ) AS item
  FROM app_policies AS pol
),
dependency_inventory AS (
  SELECT pg_catalog.jsonb_build_object(
    'dependency_type', d.deptype,
    'source_in_inventory', d.source_in_inventory, 'target_in_inventory', d.target_in_inventory,
    'source', pg_catalog.jsonb_build_object('type', src.type, 'schema', src.schema,
                                          'name', src.name, 'identity', src.identity),
    'target', pg_catalog.jsonb_build_object('type', dst.type, 'schema', dst.schema,
                                          'name', dst.name, 'identity', dst.identity),
    'source_extension', (SELECT em.extname FROM extension_members AS em
      WHERE em.classid = d.classid AND em.objid = d.objid AND em.objsubid = 0 LIMIT 1),
    'target_extension', (SELECT em.extname FROM extension_members AS em
      WHERE em.classid = d.refclassid AND em.objid = d.refobjid AND em.objsubid = 0 LIMIT 1)
  ) AS item
  FROM app_dependencies AS d
  CROSS JOIN LATERAL pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid) AS src
  CROSS JOIN LATERAL pg_catalog.pg_identify_object(d.refclassid, d.refobjid, d.refobjsubid) AS dst
),
default_acl_inventory AS (
  SELECT pg_catalog.jsonb_build_object(
    'schema', n.nspname, 'owner', pg_catalog.pg_get_userbyid(da.defaclrole),
    'object_kind', da.defaclobjtype,
    'acl', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'grantor', pg_catalog.pg_get_userbyid(a.grantor),
        'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                        ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
        'privilege', a.privilege_type, 'grantable', a.is_grantable
      ) ORDER BY a.grantee, a.privilege_type)
      FROM pg_catalog.aclexplode(da.defaclacl) AS a)
  ) AS item
  FROM pg_catalog.pg_default_acl AS da
  LEFT JOIN pg_catalog.pg_namespace AS n ON n.oid = da.defaclnamespace
  WHERE da.defaclnamespace = 0 OR n.nspname IN ('core', 'public')
),
schema_inventory AS (
  SELECT n.nspname,
    pg_catalog.jsonb_build_object(
      'schema', n.nspname, 'owner', pg_catalog.pg_get_userbyid(n.nspowner),
      'explicit_acl_is_null', n.nspacl IS NULL,
      'acl', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'grantor', pg_catalog.pg_get_userbyid(a.grantor),
          'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                          ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
          'privilege', a.privilege_type, 'grantable', a.is_grantable
        ) ORDER BY a.grantee, a.privilege_type)
        FROM pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) AS a),
      'api_roles', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'role', r.role_name, 'role_exists', r.oid IS NOT NULL,
          'usage', CASE WHEN r.oid IS NULL THEN NULL
                        ELSE pg_catalog.has_schema_privilege(r.oid, n.oid, 'USAGE') END,
          'create', CASE WHEN r.oid IS NULL THEN NULL
                         ELSE pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE') END
        ) ORDER BY r.role_name) FROM api_roles AS r)
    ) AS item
  FROM app_namespaces AS n
)
SELECT pg_catalog.jsonb_build_object(
  'scope', 'approved_sandbox_read_only_metadata_not_install_or_restore',
  'captured_at', pg_catalog.transaction_timestamp(),
  'database_name_not_project_identity', pg_catalog.current_database(),
  'server_version_num', pg_catalog.current_setting('server_version_num'),
  'transaction_read_only', pg_catalog.current_setting('transaction_read_only'),
  'transaction_isolation', pg_catalog.current_setting('transaction_isolation'),
  'actual_table_counts_included', false,
  'auth_identities_included', false,
  'function_bodies_included', false,
  'api_schema_exposure', pg_catalog.jsonb_build_object(
    'session_db_schemas', pg_catalog.current_setting('pgrst.db_schemas', true),
    'session_legacy_db_schema', pg_catalog.current_setting('pgrst.db_schema', true),
    'provider_exposed_schemas_verified', NULL,
    'core_exposed', NULL,
    'note', 'Session GUCs are observations only; missing values mean unknown. Verify actual Data API settings separately.'
  ),
  'auth_prerequisites', pg_catalog.jsonb_build_object(
    'users_relation_exists', pg_catalog.to_regclass('auth.users') IS NOT NULL,
    'uid_routine_exists', pg_catalog.to_regprocedure('auth.uid()') IS NOT NULL,
    'no_auth_principal_values_read', true
  ),
  'schemas', COALESCE((SELECT pg_catalog.jsonb_agg(item ORDER BY nspname)
                       FROM schema_inventory), '[]'::pg_catalog.jsonb),
  'functions', COALESCE((SELECT pg_catalog.jsonb_agg(item ORDER BY sort_name, item->>'identity_arguments')
                         FROM function_inventory), '[]'::pg_catalog.jsonb),
  'relations', COALESCE((SELECT pg_catalog.jsonb_agg(item ORDER BY sort_name)
                         FROM relation_inventory), '[]'::pg_catalog.jsonb),
  'constraints', COALESCE((SELECT pg_catalog.jsonb_agg(item ORDER BY sort_name)
                           FROM constraint_inventory), '[]'::pg_catalog.jsonb),
  'policies', COALESCE((SELECT pg_catalog.jsonb_agg(item ORDER BY sort_name)
                        FROM policy_inventory), '[]'::pg_catalog.jsonb),
  'catalog_dependencies_not_complete_body_dependency_graph',
    COALESCE((SELECT pg_catalog.jsonb_agg(item ORDER BY item::text)
              FROM dependency_inventory), '[]'::pg_catalog.jsonb),
  'default_acls_including_global', COALESCE((SELECT pg_catalog.jsonb_agg(item ORDER BY item::text)
                                            FROM default_acl_inventory), '[]'::pg_catalog.jsonb),
  'database_roles', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', r.rolname, 'superuser', r.rolsuper, 'inherit', r.rolinherit,
      'create_role', r.rolcreaterole, 'create_db', r.rolcreatedb,
      'can_login', r.rolcanlogin, 'replication', r.rolreplication,
      'bypass_rls', r.rolbypassrls
    ) ORDER BY r.rolname) FROM pg_catalog.pg_roles AS r),
  'catalog_api_role_membership_ancestors_not_set_role_authorization', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'api_role', pg_catalog.pg_get_userbyid(rr.seed_oid),
      'catalog_ancestor_role', pg_catalog.pg_get_userbyid(rr.reached_oid)
    ) ORDER BY rr.seed_oid, rr.reached_oid), '[]'::pg_catalog.jsonb) FROM role_reach AS rr),
  'api_role_membership_edges', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'member', pg_catalog.pg_get_userbyid(am.member),
      'granted_role', pg_catalog.pg_get_userbyid(am.roleid),
      'grantor', pg_catalog.pg_get_userbyid(am.grantor),
      'admin_option', am.admin_option, 'inherit_option', am.inherit_option,
      'set_option', am.set_option
    ) ORDER BY am.member, am.roleid, am.grantor), '[]'::pg_catalog.jsonb)
    FROM pg_catalog.pg_auth_members AS am
    WHERE EXISTS (SELECT 1 FROM role_reach AS rr WHERE rr.reached_oid = am.member)),
  'extensions', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', e.extname, 'version', e.extversion, 'schema', n.nspname,
      'owner', pg_catalog.pg_get_userbyid(e.extowner)
    ) ORDER BY e.extname)
    FROM pg_catalog.pg_extension AS e
    JOIN pg_catalog.pg_namespace AS n ON n.oid = e.extnamespace),
  'sequence_definitions_not_values', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'schema', c.nspname, 'name', c.relname,
      'type', pg_catalog.format_type(s.seqtypid, NULL),
      'start', s.seqstart, 'increment', s.seqincrement,
      'minimum', s.seqmin, 'maximum', s.seqmax, 'cache', s.seqcache, 'cycle', s.seqcycle
    ) ORDER BY c.nspname, c.relname), '[]'::pg_catalog.jsonb)
    FROM pg_catalog.pg_sequence AS s JOIN app_relations AS c ON c.oid = s.seqrelid)
) AS inspection;

ROLLBACK;
