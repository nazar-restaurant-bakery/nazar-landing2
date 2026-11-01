# G13: Google Ads bağlantısı (`market.ad_reports`)

Faz 2 · Görev 13. Google Ads kampanya raporları API ile, kampanya × gün satırı olarak `market.ad_reports` tablosuna yazılır. Panelden dosya indirilmez. Business Profile bu işte yok.

- **Migration:** `supabase/migrations/20261031000300_market_ads.sql`. Önkoşul: G8 (`20261031000100`) ve G12 (`20261031000200`) canlıda.
- **Geri alma:** `supabase/rollbacks/20261031000300_market_ads_down.sql`
- **Edge fonksiyonu:** `supabase/functions/market-ads/`
- **Test:** `tests/marketAdsDb.test.mjs`. Yerel PostgreSQL 18.6 kullanır. Vault, pg_net, pg_cron, Google (OAuth ve Ads API) ve Resend sahte; Edge kodu gerçek.

## Ne çeker, nereye yazar
GAQL sorgusu:

```
SELECT campaign.id, campaign.name, segments.date, metrics.impressions, metrics.clicks,
       metrics.cost_micros, metrics.conversions
FROM campaign WHERE segments.date BETWEEN '<başlangıç>' AND '<bitiş>'
```

- **Dönem:** New York tarihiyle dün dahil, bugün hariç, son `p_days` gün. Dönemi veritabanı hesaplar.
- **Yeniden yazma:** Her çalıştırma bu dönemi baştan yazar. Satırlar `(business_id, platform, campaign_id, report_date)` ile güncellenir (`ON CONFLICT … DO UPDATE`), bu yüzden kopya oluşmaz. Bağlantı birkaç gün düşse bile sonraki çalıştırma aradaki günleri kendiliğinden doldurur.
- **Boş gün:** Google'ın satır döndürmediği gün yazılmaz; sıfır uydurulmaz. Boş rapor `succeeded` / `no_data` olarak kaydedilir.
- **Harcama:** `cost_micros / 1 000 000`, 2 haneye yuvarlanır. Para birimi `USD`, platform `google_ads`, kaynak `google_ads_api`.
- **Hesap denetimi:** Önce hesap okunur. Hesap Nazar hesabı (`6478477284`) değilse, para birimi `USD` değilse ya da saat dilimi `America/New_York` değilse hiçbir satır yazılmaz. Çalıştırma `failed` biter; kod `ads_account_mismatch`, `ads_currency_mismatch` ya da `ads_timezone_mismatch` olur.
- **İçe aktarma kaydı:** Her çalıştırma, kuru çalıştırma dahil, `market.imports` tablosuna bir satır yazar: `source='google_ads_api'`, `kind='ads_google'`, dönem, durum ve satır sayısı.

**Çağrı tavanı:** Varsayılan 10, en fazla 50. Normal çalıştırma 3 çağrı yapar: OAuth anahtarı, hesap denetimi ve rapor. Tavana ulaşılırsa çalıştırma `failed` / `call_cap_reached` olarak kaydedilir ve hiçbir satır yazılmaz.

**Erişim ve imza:**
- `market` şeması kapalı kalır. Edge fonksiyonu yalnız `public.market_ads_claim_v1`, `public.market_ads_finish_v1` ve `public.market_ads_alert_v1` fonksiyonlarını çağırır. Üçü de `SECURITY DEFINER`, `search_path=''` ve yalnız `service_role` tarafından çağrılabilir.
- Yeni bir imza anahtarı yok. Vault'taki `SCHEDULER_SIGNING_SECRET` kullanılır; imzaya `market_ads` amaç etiketi katılır, bu yüzden zamanlayıcının ve `market-places`'in imzası burada geçmez.
- Adres, Vault'taki `SCHEDULER_EDGE_URL` değerinden katı kalıpla türetilir: `…/daily-ops-run` → `…/market-ads`.
- İstek tek kullanımlıktır: nonce ve 15 dakikalık süre.
- Google Ads erişimi `ops-collect` ile aynıdır: v26, developer token yok. Gereken gizli değerler mevcut olanlar: `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` ve isteğe bağlı `GOOGLE_ADS_LOGIN_CUSTOMER_ID`.
- Gizli değer kayda, yanıta ya da e-postaya yazılmaz.

**Takılı çalıştırma:** 15 dakikayı geçmiş `queued` ya da `running` kayıtlar, her yeni çalıştırmadan önce `failed` / `expired` olarak kapatılır. Bağlı içe aktarma kaydı da `failed` olur. Böylece takılı bir kayıt yeni çalıştırmayı engellemez.

## Günlük otomatik çalıştırma
- **İş:** pg_cron'da ayrı bir iş olarak `market-ads-daily`, `30 * * * *`, `SELECT market.ads_cron_tick_v1();`. Mevcut cron işlerine ve `daily_scheduler`'a dokunulmaz.
- **Saat:** pg_cron UTC ile çalışır. Tick yalnız New York saatiyle 08:30–08:59 arasında ve o gün henüz otomatik çalıştırma yoksa iş üretir. Bu, Clover çekiminden (07:00) sonradır ve yaz/kış saati değişiminden etkilenmez.
- **Kapsam:** 30 gün, tavan 10.
- **Açma/kapama:** Otomatik çalıştırma `market.ads_settings.daily_enabled` ayarıyla açılıp kapatılır. Elle çalıştırma bu ayardan bağımsızdır.

```sql
-- Otomatik çalıştırmayı durdur / yeniden aç:
UPDATE market.ads_settings SET daily_enabled=false, updated_at=now() WHERE business_id='a358eba4-b197-4309-805b-46f43a718454';
UPDATE market.ads_settings SET daily_enabled=true,  updated_at=now() WHERE business_id='a358eba4-b197-4309-805b-46f43a718454';
```

## Uyarı e-postası
Çalıştırma `failed` biterse Resend ile `ctnazarbakery@gmail.com` adresine kısa bir uyarı gider. OAuth reddi (`oauth_invalid_grant` vb.) de bu kapsamdadır.

- **Konu:** "Nazar Go Growth · Google Ads bağlantısı durdu"
- **Gövde:** New York tarihi, güvenli hata kodu ve yeniden bağlama için yapılacak işin bir cümlesi.
- **Gönderen:** `Nazar Go Growth <notifications@mail.nazarrestaurantandbakery.com>`. Mevcut işlem e-postası alanı kullanılır; `functions/` altındaki işlem e-postalarına dokunulmaz.
- **Sıklık:** Aynı hata kodu için New York günü başına en çok bir e-posta gider (`market.ads_alerts`). Aynı gün tekrarlayan hata `already_sent_today` olarak kaydedilir.
- **Anahtar:** Supabase secret **`RESEND_ALERTS_API_KEY`** (Talip girer). Anahtar yoksa uyarı atlanır ve kayda `alert_not_configured` yazılır; çalıştırma yine biter. Bu durum da o günün o kod için hakkını kullanır.
- **Sonuç:** Uyarının sonucu `market.ads_runs.alert_status` alanında tutulur: `sent`, `not_accepted`, `provider_error`, `alert_not_configured` ya da `already_sent_today`.

Edge fonksiyonuna hiç ulaşılamayan durumda uyarı gitmez; örneğin fonksiyon yayınlanmamışsa ya da pg_net isteği düşmüşse. Bu kayıt 15 dakika sonra `expired` olur ve aşağıdaki okuma sorgusunda görünür.

## Yayın (Talip)
1. **Migration:** SQL Editor'da yalnız `supabase/migrations/20261031000300_market_ads.sql` uygulanır. G8 ve G12 zaten canlıda. Migration `market-ads-daily` cron işini de kurar.
2. **PR birleşir.**
3. **Fonksiyon yayını:** Edge fonksiyonu ana daldan yayınlanır:
   ```
   cd C:\Users\Talip\nazar-go-growth\nazar-growth; git checkout main; git pull --ff-only; npx supabase functions deploy market-ads --project-ref khgczybubufouraqyrcj --use-api
   ```
   `supabase/config.toml` içinde `[functions.market-ads] verify_jwt = false` ayarı bulunur. Bu ayar gereklidir, çünkü çağrı pg_net ile JWT olmadan, yalnız `X-Scheduler-Signature` ile gelir. Kimlik denetimi fonksiyonun içindeki imza kontrolüyle yapılır.
   Uyarı için Supabase'e `RESEND_ALERTS_API_KEY` secret'ı eklenir; bu adım isteğe bağlıdır.
4. **Elle çalıştırma:** Önce kuru çalıştırma yapılır, ardından ilk gerçek çalıştırma 90 günle yapılır (aşağıda).

Migration, fonksiyon yayınından önce uygulanırsa aradaki sabah 08:30'da otomatik çalıştırma fonksiyona ulaşamaz. Kayıt `expired` olur ve bir sonraki çalıştırma eksik günleri doldurur.

## Elle çalıştırma
SQL Editor'da çalıştırılır; yalnız `postgres` çağırabilir. İmza: `market.ads_run_v1(business_id, p_days DEFAULT 30, p_dry_run DEFAULT false, p_max_calls DEFAULT 10)`. Dönen değer yalnız kimlik ve sayıdır: `run_id`, `days`, `dry_run`, `max_calls`, `request_id`.

```sql
-- Kuru çalıştırma: Google'a HİÇ çağrı yapılmaz; yalnız dönem ve planlanan çağrı (3) kaydedilir.
SELECT market.ads_run_v1('a358eba4-b197-4309-805b-46f43a718454', 90, true);
-- İlk gerçek çalıştırma: son 90 gün (en fazla 90).
SELECT market.ads_run_v1('a358eba4-b197-4309-805b-46f43a718454', 90);
-- Sonraki elle çalıştırmalar: son 30 gün.
SELECT market.ads_run_v1('a358eba4-b197-4309-805b-46f43a718454');
```

Açık bir çalıştırma varsa, yani son 15 dakikada başlatılmış ve henüz bitmemişse, yeni çalıştırma `MARKET_ADS_RUN_ACTIVE` hatasıyla reddedilir.

## Sonuç nasıl okunur (salt okunur)
```sql
-- Son çalıştırmalar: tetikleyici, durum, kod, dönem, çağrı, yazılan satır, uyarı
SELECT trigger, dry_run, status, safe_code, period_start, period_end, calls_used, max_calls,
       rows_written, alert_status, created_at, finished_at
FROM market.ads_runs ORDER BY created_at DESC LIMIT 10;

-- Kampanya × gün (son 30 gün)
SELECT report_date, campaign_name, impressions, clicks, spend, conversions
FROM market.ad_reports
WHERE platform = 'google_ads' AND report_date >= (now() AT TIME ZONE 'America/New_York')::date - 30
ORDER BY report_date DESC, campaign_name;

-- Gönderilen uyarılar
SELECT alert_date, safe_code, created_at FROM market.ads_alerts ORDER BY created_at DESC LIMIT 10;

-- Cron işi
SELECT jobname, schedule, command, active FROM cron.job WHERE jobname = 'market-ads-daily';
```

Edge kayıtları: https://supabase.com/dashboard/project/khgczybubufouraqyrcj/functions/market-ads/logs. `market_ads_result` satırları şu alanları içerir: `run_id`, `status`, `safe_code`, dönem, `calls_used`, `rows_written` ve `alert`. Gizli değer içermez.

## Geri alma
- Yalnız Ads verisi yokken çalışır. Bu durumda `ads_runs` kaydı, `ads_google` içe aktarması ve `google_ads_api` kaynaklı `ad_reports` satırı bulunmaz. Veri varsa `G13_ROLLBACK_DATA_PRESENT` hatasıyla durur.
- Yalnız `market-ads-daily` cron işi kaldırılır; diğer cron işlerine dokunulmaz.
- G8 ve G12 kalır; `imports.kind` kuralı G12 haline döner.
- `core` şemasına dokunmaz.
