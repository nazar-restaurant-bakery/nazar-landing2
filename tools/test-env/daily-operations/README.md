# Günlük toplama — Talip kurulum sırası

21 Ekim 2026 hazırlığı. Canlı kurulum yapılmadı. #71 ve #73'ün hedefi **main**; birleştirme Talip'te. SQL dosyalarının baytları değişmedi. Sıra 11 (K15) ve 13 (zamanlayıcı) aynı SHA/LF ve psql 18.6 ile uygulanır. Sıra 12 mevcut sırada kalır; 13 başlatıcısı 11/12 başarı kayıtları olmadan durur. K15 dry-run kapısı scheduler'a işletme adına yazma yetkisi vermez; makine yolu yalnız Clover okuma/yerel ingest + Ops toplamadır.

## 1. Yerel hazırlık ve migration

Paket `20_Yonetim/Teslim_Raporlari/DailyOperations_kanit/` konumuna kopyalanır. `Prepare-Targets.ps1 -WorkspaceRoot <çalışma klasörü>` yalnız önceki onaylı operatör hedeflerini yerel ayara aktarır; yeni proje kimliği kaynak koduna eklenmez. `-OfflineCheck` bağlantı/parola/yazma yapmaz: PASSED=0, WAITING=2, FAILED=1. Eksik başarı kaydı doldurulmaz.

1. Önce aynı hedefte **10b / K13b** başarı kaydı gerekir (`K13b_kanit/{sandbox|production}-success.json`, SHA ve `commission_channel_label` eşleşir); eski sıra 10 kaydı yeterli değildir. `Start-K15-Sandbox.ps1`, Sandbox gerçek JWT/403/dry-run kabulü; sonra `Start-K15-Production.ps1`. Varsayılan kill switch kapalı kalır.
2. Mevcut sıra 12 Sandbox → Production (ayrı K10 başlatıcıları).
3. `Start-DailyScheduler-Sandbox.ps1`; aşağıdaki Sandbox kabulü; sonra `Start-DailyScheduler-Production.ps1`. Her Production başlatıcısı kendi Sandbox SQL başarı kaydını ister. Tüm tenant ayarları kapalı başlar. Bu SQL hiçbir cron/extension/secret kurmaz.

## 2. Talip'in hesap ve bağlantı adımları

1. Supabase test projesinde **Database → Extensions**: `pg_cron`, `pg_net`, `pgcrypto` ve Vault kullanılabilirliğini kontrol et. Eksikse Talip etkinleştirir. Aynısını Production için ayrıca yapar. Başlatıcı bu uzantıları kendiliğinden açmaz.
2. Sandbox ve Production için **farklı** rastgele en az 32 bayt sır oluştur ve Bitwarden'a kaydet. Her ortamda aynı değeri Supabase **Vault → `SCHEDULER_SIGNING_SECRET`**, **Edge Functions → Secrets → `SCHEDULER_SIGNING_SECRET`** ve o ortama ait Cloudflare **encrypted `SCHEDULER_SIGNING_SECRET`** alanına kendin gir. Değeri belgeye, komuta veya sohbete yazma. Cloudflare Preview ile Production ayrı kalır.
3. Vault'ta `SCHEDULER_EDGE_URL` = `https://<o ortamın ref'i>.supabase.co/functions/v1/daily-ops-run`. `scheduler-settings.example.json` dosyasını `scheduler-settings.json` olarak kopyala: mevcut business UUID ve o ortamdaki onaylı site `/api/internal/daily-clover-pull` adresi. Bu dosyada parola yoktur.
4. Güncel #73 paketiyle `supabase functions deploy daily-ops-run --project-ref <ref>` ve `supabase functions deploy ops-collect --project-ref <ref>`; mevcut #71 için `supabase functions deploy ops-write --project-ref <ref>`. Talip oturum açar. `daily-ops-run` HMAC nedeniyle `verify_jwt=false`; **ops-collect/ops-write true kalır**. Cloudflare sürümü internal uç ve manuel kota değişikliğini birlikte içermeli; M13 uygulanmadan yayınlanmaz.
5. `Configure-DailyScheduler.ps1 -Target Sandbox -Action Preflight`, sonra `-Action InstallInactive`. Ön kontrol uzantı/Vault/işletme eşleşmesini yalnız boolean ile döndürür; secret göstermez. Job **inactive**, işletme **enabled=false** kalır.
6. Sandbox'ta imzasız HTTP isteği 401; personel yetkisiz isteği 403; yalnız test merchant/test DB bağlaması; bir günlük çalışmada Clover → Ops sonucu ve ikinci denemede tekrar çalışmama doğrulanır. Sentetik testler tek başına hosted kabul sayılmaz. E-posta/kupon/provider yazması yoktur.
7. Sandbox kabulünden sonra Production'da 5. adımı tekrarla. Talip yayını ve dar makine kimliğini kabul edince `Configure-DailyScheduler.ps1 -Target Production -Action Enable`. **Kasım başında** açılır. Günlük çalışma **07:00 America/New_York**; 1 Kasım 2026 saat değişiminden sonra 12:00 UTC'dir. Dakikalık UTC cron yalnız bu yerel dakikada iş çıkarır.
8. İlk gerçek koşuda panel: hedef tarih dün, Clover/Ops terminal sonuçları, kaynak dönemleri, kota ve son başarılı gün. 202/cron OK tek başına tamamlandı değildir. Kısmi/hatalı gün düzeltilene kadar eksik sayılır. 2 Kasım'dan sonra kurulduysa 1 Kasım dahil önceki boş günler aşağıdaki araçla ayrıca tamamlanır.

## 3. Kutuların sınırı ve durdurma

Zamanlayıcı mevcut **Google Ads, GA4, Klaviyo aggregate, Places, site, Meta** okuyucularını çağırır. Yalnız anahtarı/erişimi olan kaynak dolar; bağlantısız kutu **Bağlantı bekliyor** kalır. Ads kutusu main #82 ile **önceki tamamlanmış günün** gösterim/tıklama/harcama/Ads dönüşümünü günlük yeniler; bunlar doğrulanmış satış değildir. Bu PR aylık muhasebe defteri eklemez. Clover siparişleri `core.orders`'a K7 idempotent yoluyla girer. İçe aktarım finansal mutabakat veya komisyon kapanışı değildir; K13b kanal düzeltmesi ayrı PR'dır.

Tüm manuel + scheduled + OAuth + sayfa + 429 denemeleri işletme/NY günü ortak **30 dış istek** sınırındadır. Kota ya da sağlayıcı erişimi yetmezse tamlık iddia edilmez; eski snapshot korunur. İlk hosted gerçek gün kapasitesi ayrıca ölçülür; bu hazırlık kotayı artırmaz.

Durdurma: `Configure-DailyScheduler.ps1 -Target Production -Action Disable`. Acil doğrudan SQL (Talip): hedef işletmede `daily_scheduler_settings.enabled=false`; yalnız `cron.job.jobname='platform-daily-ops'` için `active=false`. Diğer cron işleri/manuel toplama silinmez. Secret kaybında Vault kontrolünden bağımsız bu SQL kullanılabilir.

## 4. Kasım yedek çekimi — Aralık başı

`recovery-config.example.json` → `recovery-config.json`: mevcut public ayarlar ve açık hedef eşleşmesi; Sandbox için `APP_ENV=isolated-test`, TEST_* public konfigürasyon kullanılır. Secret dosyaya konmaz. Araç çalışırken Talip database password, o hedefin Supabase **server secret key** ve Clover **orders token** değerlerini üç ayrı maskeli alana girer. Hesap oluşturma/giriş işlemi yapılmaz.

Tek komut (çalışma klasöründeki paket):

```powershell
& '.\20_Yonetim\Teslim_Raporlari\DailyOperations_kanit\Start-Clover-Recovery.ps1' -RepoRoot '.\tmp\nazar-daily-scheduler' -Target Production -From '2026-11-01' -To '2026-11-30'
```

Önce aynı komuta `-OfflineCheck` eklenir. Kasım aralığı **1 Kasım 00:00 NY dahil → 1 Aralık 00:00 NY hariç** (721 saat). Eski 30 gün geriye bakış sınırına takılmaz; yalnız kapanmış ≤31 takvim günü / son 90 gün kabul edilir. 30 gün tek sağlayıcı aralığıyla sayfalanır, ortak kota her istekte denetlenir. Tam kaynak gelmeden ingest başlamaz; kapsam/429/kota/timeout'ta durur, otomatik tekrar yapmaz. Yeniden çalışma ancak hata incelenip Talip karar verdikten sonra; aynı Clover kimliği upsert edilir.

Ardından **30 ayrı günün** kaynak sipariş sayısı ve sıralı kimlik kümesi özeti DB ile karşılaştırılır; sıfır kaynaklı günler de açık satırdır. Eşleşmeden `PASSED` yazılmaz. Yalnız aggregate/digest kanıtı saklanır; müşteri içeriği/kod/parola yazılmaz. Sipariş oluşturma tarihinin tamlığı kanıtlanır; eski siparişe sonradan gelen ödeme/iade ve mali rapor mutabakatı ayrıca K7/K13 kontrolüdür. Önceki aya ait sonradan ödenen siparişler bu aralıkla kendiliğinden tamamlanmış sayılmaz.

Resmî kurulum kaynağı: [Supabase scheduled functions / Vault / pg_net](https://supabase.com/docs/guides/functions/schedule-functions). Gerçek kurulum ve secret girişi Talip'tedir.
