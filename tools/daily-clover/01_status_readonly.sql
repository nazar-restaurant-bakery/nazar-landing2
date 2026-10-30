-- SALT OKUNUR. Supabase SQL Editor'da calistirilir; hicbir sey yazmaz.
-- Gizli degerleri gostermez: Vault icin yalniz ad, uzunluk ve URL bicimi.
-- Kurulum oncesi, ilk calistirmadan sonra ve her sabah ayni sorgu kullanilir.
SELECT jsonb_pretty(jsonb_build_object(
 'uzantilar', (SELECT jsonb_agg(extname ORDER BY extname) FROM pg_extension
   WHERE extname IN ('pg_cron','pg_net','pgcrypto','supabase_vault')),
 'hmac_hazir', to_regprocedure('extensions.hmac(text,text,text)') IS NOT NULL,
 'vault', CASE WHEN to_regclass('vault.decrypted_secrets') IS NULL THEN NULL ELSE (SELECT jsonb_build_object(
   'imza_anahtari_var', bool_or(name='SCHEDULER_SIGNING_SECRET' AND length(decrypted_secret)>=32),
   'edge_url_gecerli', bool_or(name='SCHEDULER_EDGE_URL'
     AND decrypted_secret='https://khgczybubufouraqyrcj.supabase.co/functions/v1/daily-ops-run'))
   FROM vault.decrypted_secrets WHERE name IN ('SCHEDULER_SIGNING_SECRET','SCHEDULER_EDGE_URL')) END,
 -- cron/pg_net tablolari uzanti acik degilse yoktur; sorgu yalniz varsa calisir.
 'cron_isi', CASE WHEN to_regclass('cron.job') IS NULL THEN NULL ELSE query_to_xml(
   $q$SELECT jobname AS ad,schedule AS takvim,command AS komut,active AS aktif FROM cron.job WHERE jobname='platform-daily-ops'$q$,
   false,false,'')::text END,
 'ayar', (SELECT jsonb_agg(jsonb_build_object('business_id',business_id,'enabled',enabled,'clover_url',clover_url))
   FROM core.daily_scheduler_settings),
 'son_kosular', (SELECT jsonb_agg(jsonb_build_object('tur',job_type,'gun',local_date,'hedef',target_date,
   'durum',status,'clover',clover_status,'ops',ops_status,'kod',safe_code,'request_id',request_id,
   'baslangic',started_at,'bitis',finished_at) ORDER BY created_at DESC)
   FROM (SELECT * FROM core.daily_scheduler_runs ORDER BY created_at DESC LIMIT 5) r),
 'edge_yaniti', CASE WHEN to_regclass('net._http_response') IS NULL THEN NULL ELSE query_to_xml(
   $q$SELECT h.id AS request_id,h.status_code AS http,h.error_msg AS hata,h.created AS zaman FROM net._http_response h
      WHERE h.id IN (SELECT request_id FROM core.daily_scheduler_runs WHERE request_id IS NOT NULL ORDER BY created_at DESC LIMIT 5)
      ORDER BY h.created DESC$q$,false,false,'')::text END,
 'bugun_dis_istek', (SELECT jsonb_agg(jsonb_build_object('gun',day_ny,'istek',requests))
   FROM core.daily_external_budget WHERE day_ny>=(clock_timestamp() AT TIME ZONE 'America/New_York')::date-1),
 'defter', jsonb_build_object(
   'siparis',(SELECT count(*) FROM core.orders),
   'odeme',(SELECT count(*) FROM core.payments),
   'iade',(SELECT count(*) FROM core.refunds),
   'iptal_edilmis_odeme',(SELECT count(*) FROM core.payments WHERE upper(coalesce(payment_status,''))='VOIDED'),
   'son_gorulme',(SELECT max(last_seen_at) FROM core.orders),
   'bugun_olusan_siparis',(SELECT count(*) FROM core.orders WHERE created_at>=
     ((clock_timestamp() AT TIME ZONE 'America/New_York')::date::timestamp AT TIME ZONE 'America/New_York')),
   'iadesi_dogrulanmamis_siparis',(SELECT count(*) FROM core.orders WHERE raw_response->>'refundsVerified'='false')),
 'site_siparis_iade_donusu', CASE WHEN to_regclass('core.site_order_clover_reversals') IS NULL THEN NULL ELSE query_to_xml(
   $q$SELECT outcome AS sonuc,count(*) AS adet FROM core.site_order_clover_reversals GROUP BY outcome ORDER BY outcome$q$,
   false,false,'')::text END,
 'clover_uygulama_webhook', jsonb_build_object(
   'aktif_merchant_baglantisi',(SELECT count(*) FROM core.clover_merchant_bindings WHERE active),
   'olay_sayisi',(SELECT count(*) FROM core.clover_webhook_events),
   'son_olay',(SELECT max(received_at) FROM core.clover_webhook_events))
)) AS durum;
