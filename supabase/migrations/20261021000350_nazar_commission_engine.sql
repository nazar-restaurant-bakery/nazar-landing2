-- Nazar commission engine. Install after K11 and before K13.
-- Derived from 02_Referans/Teknik_Gecmis/P3a_commission_engine.sql.
BEGIN;

DO $guard$
BEGIN
  IF to_regclass('core.businesses') IS NULL
     OR to_regclass('core.business_settings') IS NOT NULL
     OR to_regclass('core.commissions') IS NOT NULL
     OR to_regprocedure('core.compute_commission(uuid,date,numeric,numeric,boolean)') IS NOT NULL
     OR to_regprocedure('public.record_commission(uuid,date,numeric,numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'NAZAR_COMMISSION_ENGINE_PRECONDITION' USING ERRCODE='55000';
  END IF;
END;
$guard$;

CREATE TABLE core.business_settings (
  business_id uuid PRIMARY KEY REFERENCES core.businesses(id) ON DELETE CASCADE,
  baseline_monthly numeric(12,2) NOT NULL CHECK (baseline_monthly >= 0),
  commission_rate numeric(5,4) NOT NULL CHECK (commission_rate BETWEEN 0 AND 1),
  clover_merchant_id text,
  effective_date date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE CASCADE,
  period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  qualified_sales numeric(12,2) NOT NULL DEFAULT 0,
  baseline numeric(12,2) NOT NULL DEFAULT 0,
  refunds numeric(12,2) NOT NULL DEFAULT 0,
  qicr numeric(12,2) NOT NULL DEFAULT 0,
  rate numeric(5,4) NOT NULL DEFAULT 0.20,
  commission_amount numeric(12,2) NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, period_month)
);

ALTER TABLE core.business_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.commissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE core.business_settings, core.commissions FROM PUBLIC, anon, authenticated;

-- Only the approved Nazar baseline and rate are seeded here. No tenant ID is
-- hard-coded in the calculation, persistence path, or staff wrappers.
INSERT INTO core.business_settings (business_id, baseline_monthly, commission_rate)
VALUES ('a358eba4-b197-4309-805b-46f43a718454', 12000.00, 0.20);

CREATE FUNCTION core.compute_commission(
  p_business_id uuid,
  p_period_month date,
  p_qualified_sales numeric,
  p_refunds numeric DEFAULT 0,
  p_persist boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_month date := date_trunc('month', p_period_month)::date;
  v_baseline numeric;
  v_rate numeric;
  v_qsales numeric := round(coalesce(p_qualified_sales, 0), 2);
  v_refunds numeric := round(coalesce(p_refunds, 0), 2);
  v_qicr numeric;
  v_commission numeric;
BEGIN
  SELECT bs.baseline_monthly, bs.commission_rate
    INTO v_baseline, v_rate
    FROM core.business_settings bs
   WHERE bs.business_id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no business_settings row for business_id %', p_business_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_baseline IS NULL OR v_rate IS NULL THEN
    RAISE EXCEPTION 'baseline_monthly / commission_rate not set for business_id %', p_business_id;
  END IF;

  -- Contract formula; each month stands alone.
  v_qicr := (v_qsales - v_baseline) - v_refunds;
  v_commission := round(greatest(0, v_qicr) * v_rate, 2);

  IF p_persist THEN
    INSERT INTO core.commissions
      (business_id, period_month, qualified_sales, baseline, refunds, qicr, rate, commission_amount, computed_at)
    VALUES
      (p_business_id, v_month, v_qsales, v_baseline, v_refunds, v_qicr, v_rate, v_commission, now())
    ON CONFLICT (business_id, period_month) DO UPDATE
      SET qualified_sales = EXCLUDED.qualified_sales,
          baseline = EXCLUDED.baseline,
          refunds = EXCLUDED.refunds,
          qicr = EXCLUDED.qicr,
          rate = EXCLUDED.rate,
          commission_amount = EXCLUDED.commission_amount,
          computed_at = now();
  END IF;

  RETURN jsonb_build_object(
    'business_id', p_business_id,
    'period_month', v_month,
    'qualified_sales', v_qsales,
    'baseline', v_baseline,
    'refunds', v_refunds,
    'qicr', v_qicr,
    'rate', v_rate,
    'commission_amount', v_commission,
    'persisted', p_persist,
    'computed_at', now()
  );
END;
$fn$;

CREATE FUNCTION public.record_commission(
  p_business_id uuid,
  p_period_month date,
  p_qualified_sales numeric,
  p_refunds numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $wrap$
  SELECT core.compute_commission(p_business_id, p_period_month, p_qualified_sales, p_refunds, true);
$wrap$;

REVOKE ALL ON FUNCTION core.compute_commission(uuid,date,numeric,numeric,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION core.compute_commission(uuid,date,numeric,numeric,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.record_commission(uuid,date,numeric,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_commission(uuid,date,numeric,numeric) TO service_role;

DO $check$
BEGIN
  IF (SELECT count(*) FROM core.business_settings) <> 1 THEN
    RAISE EXCEPTION 'NAZAR_COMMISSION_SETTINGS_COUNT' USING ERRCODE='55000';
  END IF;
END;
$check$;

COMMIT;
