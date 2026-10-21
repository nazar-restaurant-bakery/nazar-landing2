-- Disposable local-only fixture after k7-local-bootstrap + exact K7 migration.
INSERT INTO core.businesses VALUES ('22222222-2222-4222-8222-222222222222','Second synthetic tenant');
INSERT INTO core.businesses VALUES ('a358eba4-b197-4309-805b-46f43a718454','Nazar engine seed fixture');
CREATE TABLE core.ops_csv_imports(action_id uuid PRIMARY KEY,business_id uuid NOT NULL,
 fingerprint text,file_name text,period_start date,period_end date,qualified_sales numeric,
 imported_rows integer,is_complete boolean,collected_at timestamptz NOT NULL);
CREATE TABLE core.ops_metrics(business_id uuid NOT NULL,source text,collector text,
 collected_at timestamptz,period_start date,period_end date,metric text,value_num numeric);
