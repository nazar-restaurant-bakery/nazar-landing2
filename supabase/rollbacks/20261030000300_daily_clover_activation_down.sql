-- Geri alma: gunluk Clover cekimi etkinlestirme destegi. LF, psql 18.6.
-- Calisan/kuyruktaki 'manual_today' kosusu varsa durur. Biten 'manual_today'
-- kosu satirlari (yalniz calisma kaydi) silinir; core.orders/payments/refunds
-- ve diger veriler degismez. Nazar ayar satiri yalniz kapali ve bu migration'in
-- adresiyle duruyorsa silinir; acik ise once kapatilmasi gerekir.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('daily_clover_activation_v1',0));
DO $guard$ BEGIN
  IF pg_catalog.to_regprocedure('core.daily_scheduler_run_today_v1(uuid)') IS NULL
  THEN RAISE EXCEPTION 'DAILY_CLOVER_NOT_INSTALLED'; END IF;
  IF EXISTS(SELECT 1 FROM core.daily_scheduler_runs WHERE job_type='manual_today' AND status IN ('queued','running'))
  THEN RAISE EXCEPTION 'DAILY_CLOVER_MANUAL_RUN_ACTIVE'; END IF;
  IF EXISTS(SELECT 1 FROM core.daily_scheduler_settings WHERE business_id='a358eba4-b197-4309-805b-46f43a718454' AND enabled)
  THEN RAISE EXCEPTION 'DAILY_CLOVER_DISABLE_SCHEDULER_FIRST'; END IF;
END $guard$;
DROP FUNCTION core.daily_scheduler_run_today_v1(uuid);
DELETE FROM core.daily_scheduler_runs WHERE job_type='manual_today';
ALTER TABLE core.daily_scheduler_runs
  DROP CONSTRAINT daily_scheduler_runs_job_type_check,
  DROP CONSTRAINT daily_scheduler_runs_target_check,
  ADD CONSTRAINT daily_scheduler_runs_job_type_check CHECK (job_type='daily_collect'),
  ADD CONSTRAINT daily_scheduler_runs_check CHECK (target_date=local_date-1);
DELETE FROM core.daily_scheduler_settings
  WHERE business_id='a358eba4-b197-4309-805b-46f43a718454' AND NOT enabled
    AND clover_url='https://www.nazarrestaurantandbakery.com/api/internal/daily-clover-pull';
COMMIT;
