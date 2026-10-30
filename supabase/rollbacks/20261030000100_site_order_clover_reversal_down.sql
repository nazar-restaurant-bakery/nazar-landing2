-- Geri alma: Clover iptal/iade -> site siparisi tetikleyicileri. LF, psql 18.6.
-- Tetikleyiciler ve fonksiyonlar kaldirilir; bundan sonra iptal/iade site
-- siparisine donmez. Daha once donmus siparis, odeme, fis ve olay kayitlari
-- degistirilmez (bunlar gercekte olmus iadelerdir). Kayit tablosu bos ise
-- silinir; dolu ise denetim kaydi olarak korunur.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('site_order_clover_reversal_v1',0));
DO $guard$ BEGIN
  IF pg_catalog.to_regclass('core.site_order_clover_reversals') IS NULL THEN
    RAISE EXCEPTION 'SITE_ORDER_REVERSAL_NOT_INSTALLED';
  END IF;
END $guard$;
DROP TRIGGER site_order_clover_void_reversal ON core.payments;
DROP TRIGGER site_order_clover_refund_reversal ON core.refunds;
DROP FUNCTION public.site_order_clover_reversal_review_v1(uuid);
DROP FUNCTION core.site_order_clover_void_trigger_v1();
DROP FUNCTION core.site_order_clover_refund_trigger_v1();
DROP FUNCTION core.site_order_clover_reversal_failed_v1(uuid,text,text,text,bigint,text);
DROP FUNCTION core.site_order_clover_reversal_apply_v1(uuid,text,text,text,text,bigint,bigint,jsonb);
DO $keep$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM core.site_order_clover_reversals) THEN
    DROP TABLE core.site_order_clover_reversals;
  ELSE
    RAISE NOTICE 'core.site_order_clover_reversals kayit iceriyor; denetim icin korundu';
  END IF;
END $keep$;
NOTIFY pgrst,'reload schema';
COMMIT;
