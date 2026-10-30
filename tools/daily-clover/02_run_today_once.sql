-- ILK CALISTIRMA: bugunun (New York 00:00 -> yarin 00:00) Clover siparislerini
-- zamanlayicinin imzali yoluyla bir kez ceker. Supabase SQL Editor'da (postgres)
-- calistirilir; uygulama rolleri bu fonksiyonu cagiramaz.
-- On kosul: 20261030000300 migration'i, Vault adlari, Edge daily-ops-run dagitimi,
-- Cloudflare Production degiskenleri ve ayar satirinin enabled=true olmasi.
-- Gunde bir kez; yalniz 'failed' ya da 'missed' biten kosu ayni gun tekrarlanabilir.
-- Sonucu 1-2 dakika sonra 01_status_readonly.sql ile kontrol et.
SELECT jsonb_pretty(core.daily_scheduler_run_today_v1('a358eba4-b197-4309-805b-46f43a718454'::uuid)) AS baslatildi;
