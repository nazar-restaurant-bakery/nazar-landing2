-- Talip, SQL Editor (postgres). Her blok ayri calistirilir; gizli deger icermez.

-- A) Tenant'i ac (cron isi hala kapali: yalniz elle tek seferlik calistirmaya izin verir).
UPDATE core.daily_scheduler_settings SET enabled=true
 WHERE business_id='a358eba4-b197-4309-805b-46f43a718454'
   AND clover_url='https://www.nazarrestaurantandbakery.com/api/internal/daily-clover-pull';

-- B) Dakikalik cron isini KAPALI kur (tools/test-env/daily-scheduler-install.sql ile ayni).
SELECT cron.schedule('platform-daily-ops','* * * * *','SELECT core.daily_scheduler_tick();');
UPDATE cron.job SET active=false WHERE jobname='platform-daily-ops';

-- C) Ilk calistirma dogrulandiktan sonra cron'u ac. Her gun 07:00 New York'ta
--    onceki gunu ceker; diger dakikalarda is uretmez.
UPDATE cron.job SET active=true
 WHERE jobname='platform-daily-ops' AND schedule='* * * * *' AND command='SELECT core.daily_scheduler_tick();';

-- ACIL DURDURMA (ikisi birlikte):
-- UPDATE core.daily_scheduler_settings SET enabled=false WHERE business_id='a358eba4-b197-4309-805b-46f43a718454';
-- UPDATE cron.job SET active=false WHERE jobname='platform-daily-ops';
