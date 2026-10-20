# K12 — günlük zamanlayıcı kod teslimi

20 Ekim 2026 · Draft / kurulum yapılmadı. Dal: `feat/daily-ops-scheduler`; taban main `55806db`. Birleşme **K7 mutabakatı ve K12 kapanışından sonra**, Talip'te. Ortak personel sözleşmesi (#65) migration önkoşuludur; sıra 12 korunur.

## Sonuç ve kapsam

UTC dakikalık DB kontrolü, America/New_York yerel 07:00'de işletme/tarih/iş türüne tek kayıt açar. Atomik DB claim ve ayrı Clover claim ikinci uygulamayı reddeder. Dün aralığı yerel iki gece yarısından hesaplanır; DST'de 23/25 saat desteklenir. Kaçan dakika ve yarım kalan koşu uyarıdır; otomatik kör tekrar yoktur.

Önce Cloudflare'daki mevcut K7 `collectOrders` + `clover_order_ingest_v1` yolu; sonra aynı Ops okuyucuları çalışır. Sonuç her zaman `reconciled=false`: Ops başarısı K7 gün mutabakatı değildir. K7 manuel çekmesi ve Ops manuel/scheduled okumaları, OAuth ve sayfalar dahil her sağlayıcı isteğinden önce işletme/NY günü ortak 30 kotasından atomik hak alır. Mevcut Ops kotası migration'da korunur.

Makine uçları yalnız imzalı collect/pull sözleşmesini kabul eder. HMAC işletme/koşu/nonce/zaman ve Clover için claim/pencereye bağlıdır; iki amaç ayrı imzalanır. Personel JWT'si saklanmaz; ops-write çağrısı veya keyfi işlem/URL alanı yoktur. `daily-ops-run` kendi HMAC doğrulaması nedeniyle `verify_jwt=false`; mevcut `ops-collect` JWT ayarı değişmez. DB makine RPC'leri yalnız service_role, panel okuması ortak `ops.read` helper'ı ile 42501 sınırındadır.

Tenant ayarı varsayılan kapalıdır; panel plan, son koşu/Clover/Ops sonuçları, güvenli hata kodu ve günlük kotayı salt okunur gösterir. Duraklatma her dış çağrıdan önce denetlenir.

**Kapsam sınırı:** Zamanlama/claim/kota iki tenant ile testlidir. Mevcut Ops şeması ve bazı sağlayıcı hesapları hâlâ eski tek işletme sözleşmesindedir. Bu adaptörler başka tenant'a Nazar toplamı uygulamak yerine `scope_unavailable` ile durur; çok tenant'lı sağlayıcı toplamaları bu PR'ın kanıtı değildir. K7 hedef işletmesi Cloudflare sunucu ayarıyla eşleşmelidir. Kullanıcıdan hesap/endpoint alınmaz.

## Dosyalar

- `supabase/migrations/20261021000600_daily_scheduler.sql`: tenant ayarı, koşu, ortak kota; private tick ve service RPC'leri.
- `supabase/functions/daily-ops-run/index.ts`, `functions/api/internal/daily-clover-pull.ts`, `functions/_lib/dailySchedulerAuth.ts`: imzalı dar makine yolu.
- K7 yardımcı/manuel handler: kapalı gün penceresi ve ortak kota. Ops `collectSources` ayrı dosyaya çıkarıldı; mevcut personel handler'ı aynı okuyucuyu kullanır. Klaviyo `links.next` string tür daraltması API davranışını değiştirmez.
- `DailySchedulerStatus.tsx`, OpsView/StatusStrip/opsCopy: gerçek zamanlayıcı durumu ve açıklaması.
- `tools/test-env/daily-scheduler-install.sql`: ileride Talip'in kuracağı cron **inactive** başlar. Migration kendiliğinden cron, extension, secret veya tenant açmaz.

## Kanıt

| Kontrol | Sonuç |
|---|---|
| Node Ops/K7/makine testleri | 90/90; 0 atlanan. İmza/amaç, yanlış işletme, replay, kota, hata, mevcut regresyonlar. |
| Gerçek React/Chrome localhost testi | 1/1; salt okunur RPC, hata/kota uyarısı, tenant değişiminde eski durum temizlenir. |
| PostgreSQL 18.6 | Mart/Kasım 07:00, 23/25 saat; iki tenant izolasyonu; aynı gün tekrar; eşzamanlı 2 tick → tenant başına 1 dispatch; 2 start → 1 kabul; kota 29'da 2 rezervasyon → 1 kabul; pause/hata/42501/ACL. |
| Production derleme / parity | 212 dosyanın 209'u byte-eşit. Staff JS ve main/index hash bağlantıları değişti; main'de ayrıca yalnız bir Ops açıklaması değişti. Bu açıklama ve hash'ler normalize edilince main aynı. Public form handler'ları ve GA4 kaynağı aynı. İki build aynı Production hedefi ve aynı sentetik public değerlerle; hosted secret okunmadı. |

Kanıtlar: `K12_Zamanlayici_kanit/{synthetic-summary,postgres-synthetic,production-parity}.json`. Test komutları: `node --test tests/ops*.test.mjs tests/dailyScheduler.test.mjs tools/test-env/k7-clover-pull.test.mjs` (PGLITE_MODULE yerel paket yolu), `node --test tests/dailySchedulerPanel.test.mjs`, `python tests/dailySchedulerPostgres.py`; uygulama tsc/Vite build ve hedefli TypeScript/ESLint geçti.

Yerel PostgreSQL gerçek motordur; pg_net/Vault için sentetik sözleşme fixture'ı kullanılmıştır. Gerçek hosted extension, cron dispatch, gateway ve sağlayıcı kabulü henüz doğrulanmadı. Canlı sağlayıcı çağrısı, hosted veri/ayar değişikliği yoktur.

## Migration ve gelecekte Talip kurulum sırası

Sıra **12**: `20261021000600_daily_scheduler.sql` (LF), SHA256 **b54b4a5b5786133d63e2567c6a9724125f230948a794b8cfa509f6673edb6793**. Koordinasyon'a sıra kaydı için bildirilir; K7/Finalize dosyaları ve ortak sıra dosyası değiştirilmez.

Bu liste kurulum planıdır; bugün uygulanmaz:

1. K7 gün mutabakatı + K12 kapanışı ve #65 önkoşulu sonrası Talip Draft PR'ı birleştirir. Aynı LF/SHA migration psql 18.6 ile önce sandbox, kanıttan sonra Production'a uygulanır. Tüm tenant'lar kapalı kalır.
2. Supabase Database Extensions'da pg_cron/pg_net ve Vault kullanılabilirliği doğrulanır. Vault'a `SCHEDULER_SIGNING_SECRET` ve `SCHEDULER_EDGE_URL` Talip ekler. Production URL: `https://khgczybubufouraqyrcj.supabase.co/functions/v1/daily-ops-run` (sandbox kendi projesi).
3. Aynı rastgele en az 32 baytlık HMAC sırrını Talip Edge secret ve Cloudflare encrypted binding olarak **SCHEDULER_SIGNING_SECRET** adıyla kaydeder. Değer sohbete, dosyaya veya komut argümanına yazılmaz. Clover'ın mevcut sunucu kimliği yerinde kalır; Edge'e taşınmaz. Personel JWT'si gerekmez.
4. `supabase functions deploy daily-ops-run --project-ref khgczybubufouraqyrcj` ve `supabase functions deploy ops-collect --project-ref khgczybubufouraqyrcj`; Cloudflare sürümü yeni internal endpoint + manuel K7 kota değişikliğiyle birlikte yayınlanır. Sandbox'ta önce kendi ref'i kullanılır. Yeni function'da HMAC yetkisiz/replay testleri, mevcut ops-collect'te JWT açık kontrolü yapılır.
5. İşletmeye ait `daily_scheduler_settings` kaydı doğru site `/api/internal/daily-clover-pull` URL'siyle **enabled=false** eklenir. `tools/test-env/daily-scheduler-install.sql` inactive cron kurar. Sandbox kabulü sonrası, tüm manuel yollar ortak kotaya geçtiğinde, Talip ilgili tenant ve cron'u açar. Eski ölçülmeyen K7 istekleri geriye dönük bilinmediğinden ilk planlı gün yeni NY günü olmalıdır; geçiş sırasında eski manuel çekme kullanılmaz.
6. 07:00 koşusunda Clover → Ops sonucu, 30 sınırı ve panel uyarıları kontrol edilir. Büyük bir Clover günü kotaya sığmazsa tam çekim/mutabakat denmez. Kapatma: tenant enabled=false + yalnız ilgili cron job active=false; gerekirse HMAC sırrı döndürülür. Diğer cron işleri ve personel toplama korunur.

Kurulum ekranları: [Production Extensions](https://supabase.com/dashboard/project/khgczybubufouraqyrcj/database/extensions), [Vault](https://supabase.com/dashboard/project/khgczybubufouraqyrcj/integrations/vault/overview), [Edge Secrets](https://supabase.com/dashboard/project/khgczybubufouraqyrcj/functions/secrets), [Cron](https://supabase.com/dashboard/project/khgczybubufouraqyrcj/integrations/cron/overview). Kaynak: [Supabase zamanlanmış Edge çağrısı](https://supabase.com/docs/guides/functions/schedule-functions), [Cron](https://supabase.com/docs/guides/cron).

## Açık kabul kapısı

Draft teslimdir; etkinleştirme ve birleşme Talip'te, K7 + K12 kapanışı sonrası. Hosted sandbox kabulü ve tek işletmeli mevcut Ops adaptörü sınırı raporlandı. Gerçek sağlayıcı yazımı, K15, yeni dış okuma anahtarı ve mevcut secret değerlerine dokunulmadı.
