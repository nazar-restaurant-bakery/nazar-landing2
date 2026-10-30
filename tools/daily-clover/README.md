# Günlük Clover çekimi — açma, ilk çalıştırma, doğrulama

Tasarım değişmedi (K12): `pg_cron` her dakika `core.daily_scheduler_tick()` çalıştırır;
07:00 New York'ta önceki günün koşusunu açar, Vault'taki `SCHEDULER_SIGNING_SECRET` ile
imzalayıp `pg_net` ile Supabase Edge `daily-ops-run`'a gönderir. Edge, ikinci bir imzayla
Cloudflare `/api/internal/daily-clover-pull`'u çağırır; o da Clover'dan siparişleri çekip
`clover_order_ingest_v1` ile `core.orders/payments/refunds` defterine yazar.

| Dosya | Ne yapar | Yazar mı? |
|---|---|---|
| `01_status_readonly.sql` | Uzantı, Vault adı, cron, ayar, son koşular, Edge yanıtı, defter sayıları | Hayır |
| `02_run_today_once.sql` | Bugünün aralığını aynı imzalı yoldan bir kez çeker | Bir koşu satırı + Edge çağrısı |
| `03_enable_disable.sql` | Tenant'ı aç, cron'u kapalı kur, sonra aç; acil durdurma | Evet (Talip) |

`core.daily_scheduler_run_today_v1` yalnız veritabanı sahibi (SQL Editor) tarafından çağrılabilir;
`anon`, `authenticated` ve `service_role` çağıramaz. Günde bir kez çalışır; yalnız `failed`
ya da `missed` biten koşu aynı gün tekrar başlatılabilir.

Gizli değerler hiçbir dosyada yoktur. Gerekli adlar: Vault `SCHEDULER_SIGNING_SECRET`,
`SCHEDULER_EDGE_URL`; Edge secret `SCHEDULER_SIGNING_SECRET`; Cloudflare Production
`SCHEDULER_SIGNING_SECRET`, `CLOVER_MERCHANT_ID`, `CLOVER_ORDERS_ACCESS_TOKEN`,
`CLOVER_ONLINE_ORDER_TYPE_IDS`, `SUPABASE_SECRET_KEY`, `VITE_SUPABASE_ANON_KEY`,
`TURNSTILE_SECRET_KEY`. Üç yerdeki `SCHEDULER_SIGNING_SECRET` aynı değerdir.

Sonradan yapılan iptal/iade: zamanlanmış çekim, hedef günde oluşturulan siparişlere ek olarak
daha önce oluşturulup hedef günde **değişmiş** (`modifiedTime`) siparişleri de çeker. Clover,
`createdTime` filtreli aramaları son 90 günle sınırlar. İptal/iadenin siparişin `modifiedTime`
değerini güncellediği Clover belgesinde yazmıyor; sandbox'ta doğrulanmalıdır.
