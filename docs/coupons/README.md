# K10 — kayıtla kazanılan kişisel kupon

Kod ve sentetik prova teslimidir; canlı kampanya, anahtar, migration veya flow kurulumu değildir. Varsayılan kapalı yeni makine yolu mevcut formu, personel girişini, GA4'ü veya K5 profil senkronunu değiştirmez.

- [Çekirdek/kasa sözleşmesi](coupon-contract.md): Kol 2'nin lookup/redeem imzaları ve JSON sonuçları.
- [Onay ve hoş geldin işleyicisi](welcome-processor.md): ortam adları, K6 kapısı, sağlayıcı kanıtı ve etkinleştirme engelleri.
- [Draft flow kontrol listesi](welcome-flow-draft.json): resmi API import dosyası değildir; mevcut Klaviyo hesabına uygulanmadı.
- [Talip için adım adım Klaviyo kurulumu](Talip_Klaviyo_Akis_Kurulumu.md): tek taslak email, kimlikler, salt okunur receipt anahtarı ve belirsiz sonuç incelemesi.
- [HTML e-posta](welcome-email.html) / [düz metin](welcome-email.txt): kupon kodu, kendi altyapısından QR ve abonelikten ayrılma altbilgisi.

## Migration ve işletme ayarları

İleri migration: `supabase/migrations/20261021000800_signup_reward_coupons.sql`. Global sıra 14; K4/K5/K6, birleşik personel kapsamlı K9 ve K10 hak kontrolünün ardından aynı incelenmiş LF dosyası/psql aracıyla önce test, sonra ayrıca onaylanan üretim. Eski migration dosyaları değiştirilmez. Envanter girdisi hosted reset/otomatik uygulamaya kapalıdır.

Migration kampanya açmaz veya gerçek personel tohumu yüklemez. Kampanya satırında `campaign_kind='signup_reward'`, gerçek ürün, doğru VIP listesi, kendi kanal eşlemesi, başlangıç ve Talip'in onayladığı parametreler ayrıca hazırlanır. Bitiş açık olabilir. İlk kupondan sonra vaat edilmiş koşullar değiştirilemez; durdurma mümkündür.

İleri SQL, eski K9 sipariş değerlendirmesini private eski gövdeye yönlendiren korumalı sarmalayıcı ekler: `signup_reward` kuponsuz kullanılamaz. Redemption guard yalnız kupon için dar istisnayı kabul eder ve iade ile tekrar açılmasını engeller. Eski #72 sipariş-hak listesinden `signup_reward` ayrılır; kupon hakkı eski etiketten çıkarılmaz. Tarihsel migration dosyaları aynı kalır; bu davranış farkları yeni SQL uygulanınca devreye girer.

Hak güvenilir çift onayla kazanılır; kullanım sonraki vergi/bahşiş hariç en az $30 siparişte, kampanya boyunca bir kez olur. Sonradan pazarlama izni iptali kazanılmış kuponu tüketmez; e-postayı engeller. İadede kullanım void edilmez ve hak geri verilmez. Clover kaydı olmayan kasada tutar/kanal/tarih/fiş personel beyanıdır; doğrulanmış Clover siparişi gibi gösterilmez.

## Etkinleştirme kabulü

1. Gerçek çift onayı doğrulayan `confirm` çağrısının güvenilir tetikleyiciye bağlanması ve uçtan uca kanıtlanması. Yeni makine uç noktası hazırdır; timer/webhook/form bağlantısı kurulmadı.
2. Gönderim mutabakatının kodu yeni `20261021000825_coupon_delivery_reconciliation.sql` ile hazırdır (14a sıra önerisi). `202` halen yalnız olay kabulüdür. Kalıcı kişi/flow/mesaj eşlemesi ve gerçek native Received Email GET kanıtı ile çözülür; eski `message_log` satırı değiştirilmez. Yalnız canlı doğrulanmış receipt + güncel yerel kapılar `activationReady:true` üretebilir. Mock/202 bunu yapamaz. Hosted kimlikler, read-only receipt key, ayar ve canlı kabul henüz uygulanmadı. Gönderilmediği kanıtlanmış/sağlayıcı kuyruğundan iptal edilmiş iş için Talip'e audit'li inceleme + 168 saat muhafazakâr bekleme yolu vardır; kanıtsız otomatik temizleme yoktur.

Bu koşullar çözülmeden `live` işleyici veya **Nazar VIP — Welcome** flow'u açılmaz. Bu teslimde gerçek Klaviyo profili/olayı/e-postası oluşturulmaz. Kasa arayüzü Kol 2'nin ayrı işidir; bu PR yalnız sözleşme ve çekirdeği sağlar.

## Yerel sentetik kontrol

```text
node --test tests/couponWelcome.test.mjs tests/couponQr.test.mjs
node --test tests/couponDelivery.test.mjs
node --test tests/couponDeliveryDb.test.mjs
node --test --test-concurrency=1 tests/signupRewardCouponsDb.test.mjs tests/couponWelcomeDbIntegration.test.mjs
node --test tests/testEnvMigrations.test.mjs
```

DB testleri yerel PostgreSQL 18.6 gerektirir (`K9_PG_BIN` yalnız yerel program klasörü içindir). Her koşu kendi rastgele loopback portu/DB'sini açar ve kapatır; hosted adres, DB password veya gerçek sağlayıcı anahtarı okumaz. Auth UID/rol talepleri sentetik SQL oturumudur; hosted Auth/REST testi olduğu iddia edilmez. K4/K5/K6 ve K7/K9/#72 gerçek migration gövdeleri, incelenen sınırlı yerel başlangıç şeması üzerinde uygulanır. Tam hosted şema provası ayrıca gerekir. Sağlayıcı yalnız test adaptörüdür; gerçek email veya API yazısı yoktur.
