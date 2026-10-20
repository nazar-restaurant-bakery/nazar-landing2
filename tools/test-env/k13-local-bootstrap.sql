-- Disposable local-only fixture after k7-local-bootstrap + exact K7 migration.
INSERT INTO core.businesses VALUES ('22222222-2222-4222-8222-222222222222','Second synthetic tenant');
CREATE TABLE core.business_settings(business_id uuid PRIMARY KEY,
 baseline_monthly numeric NOT NULL,commission_rate numeric NOT NULL);
INSERT INTO core.business_settings VALUES
 ('11111111-1111-4111-8111-111111111111',12000,0.20),
 ('22222222-2222-4222-8222-222222222222',12000,0.20);
CREATE TABLE core.commissions(business_id uuid,period_month date,qualified_sales numeric,
 baseline numeric,refunds numeric,qicr numeric,rate numeric,commission_amount numeric,
 computed_at timestamptz,UNIQUE(business_id,period_month));
CREATE TABLE core.ops_csv_imports(action_id uuid PRIMARY KEY,business_id uuid NOT NULL,
 fingerprint text,file_name text,period_start date,period_end date,qualified_sales numeric,
 imported_rows integer,is_complete boolean,collected_at timestamptz NOT NULL);
CREATE TABLE core.ops_metrics(business_id uuid NOT NULL,source text,collector text,
 collected_at timestamptz,period_start date,period_end date,metric text,value_num numeric);
