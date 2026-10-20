-- =====================================================================
-- P3a — Commission engine (contract-locked formula)
-- Source of truth: Nazar_Marketing_Agreement_Commission_SIGN.docx §4(b)
--
--   QICR = (Clover/POS Qualified Sales − baseline) − Refunds/Chargebacks
--   Commission = rate × QICR,  and 0 if QICR ≤ 0
--   Each month independent; negative months are NOT netted.
--
--   Qualified Sales = net sales excl. tax & tips; Dine-in + Pickup +
--   Clover-delivery (incl. Clover–DoorDash). Uber Eats / Grubhub excluded
--   (they never touch Clover/POS, so Clover's own net-sales report already
--   excludes them).
--
--   baseline ($12,000) and rate (0.20) live in core.business_settings.
-- Applied 2026-08-12 via Supabase MCP.
-- =====================================================================

create or replace function core.compute_commission(
    p_business_id     uuid,
    p_period_month    date,
    p_qualified_sales numeric,
    p_refunds         numeric default 0,
    p_persist         boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_month      date := date_trunc('month', p_period_month)::date;  -- normalize to 1st of month
    v_baseline   numeric;
    v_rate       numeric;
    v_qsales     numeric := round(coalesce(p_qualified_sales, 0), 2);
    v_refunds    numeric := round(coalesce(p_refunds, 0), 2);
    v_qicr       numeric;
    v_commission numeric;
begin
    select bs.baseline_monthly, bs.commission_rate
      into v_baseline, v_rate
      from core.business_settings bs
     where bs.business_id = p_business_id;

    if not found then
        raise exception 'no business_settings row for business_id %', p_business_id
            using errcode = 'no_data_found';
    end if;
    if v_baseline is null or v_rate is null then
        raise exception 'baseline_monthly / commission_rate not set for business_id %', p_business_id;
    end if;

    -- Contract §4(b)
    v_qicr       := (v_qsales - v_baseline) - v_refunds;
    v_commission := round(greatest(0, v_qicr) * v_rate, 2);

    if p_persist then
        insert into core.commissions
            (business_id, period_month, qualified_sales, baseline, refunds, qicr, rate, commission_amount, computed_at)
        values
            (p_business_id, v_month, v_qsales, v_baseline, v_refunds, v_qicr, v_rate, v_commission, now())
        on conflict (business_id, period_month) do update
            set qualified_sales   = excluded.qualified_sales,
                baseline          = excluded.baseline,
                refunds           = excluded.refunds,
                qicr              = excluded.qicr,
                rate              = excluded.rate,
                commission_amount = excluded.commission_amount,
                computed_at       = now();
    end if;

    return jsonb_build_object(
        'business_id',       p_business_id,
        'period_month',      v_month,
        'qualified_sales',   v_qsales,
        'baseline',          v_baseline,
        'refunds',           v_refunds,
        'qicr',              v_qicr,
        'rate',              v_rate,
        'commission_amount', v_commission,
        'persisted',         p_persist,
        'computed_at',       now()
    );
end;
$fn$;

revoke all on function core.compute_commission(uuid, date, numeric, numeric, boolean) from public;

-- PostgREST-facing wrapper for future automation (n8n / Clover pull). Always
-- persists. service_role only — this is money, never anon/authenticated.
create or replace function public.record_commission(
    p_business_id     uuid,
    p_period_month    date,
    p_qualified_sales numeric,
    p_refunds         numeric default 0
)
returns jsonb
language sql
security definer
set search_path = ''
as $wrap$
    select core.compute_commission(p_business_id, p_period_month, p_qualified_sales, p_refunds, true);
$wrap$;

revoke all on function public.record_commission(uuid, date, numeric, numeric) from public;
revoke all on function public.record_commission(uuid, date, numeric, numeric) from anon;
revoke all on function public.record_commission(uuid, date, numeric, numeric) from authenticated;
grant  execute on function public.record_commission(uuid, date, numeric, numeric) to service_role;

notify pgrst, 'reload schema';

-- =====================================================================
-- MANUAL MONTHLY USE  (Nazar business_id = a358eba4-b197-4309-805b-46f43a718454)
-- =====================================================================
-- Each month, read two figures off the Clover MONTHLY report:
--   qualified_sales = Clover net sales (excl. sales tax & tips) for the month
--   refunds         = Clover refunds/chargebacks for the month (0 if none)
-- Uber Eats / Grubhub are NOT in Clover reporting, so nothing to exclude.
--
-- Record (saves + returns the calc):
--   select public.record_commission(
--     'a358eba4-b197-4309-805b-46f43a718454',  -- Nazar
--     '2026-09-01',                            -- any day in the month; normalized to the 1st
--     14500.00,                                -- Clover net sales
--     0);                                      -- refunds (optional, default 0)
--
-- Preview WITHOUT saving (dry-run):
--   select core.compute_commission(
--     'a358eba4-b197-4309-805b-46f43a718454','2026-09-01', 14500, 0, false);
--
-- Re-running the same month overwrites that month's row (upsert) — safe to correct.
--
-- Statement / history:
--   select period_month, qualified_sales, baseline, refunds, qicr, rate,
--          commission_amount
--   from core.commissions
--   where business_id='a358eba4-b197-4309-805b-46f43a718454'
--   order by period_month;
--
-- NOTE: only record months within the signed 12-month Term (>= Effective Date).
-- When the Clover API is wired later (P3b), public.record_commission is the same
-- entry point n8n/an Edge Function will call — no formula change.
-- =====================================================================
