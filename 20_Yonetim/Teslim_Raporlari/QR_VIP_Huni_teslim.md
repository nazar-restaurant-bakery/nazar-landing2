# QR kart → VIP → Simit ölçüm zinciri

21 Ekim 2026 · Draft PR · taban main d6a4bef. Canlı DB, Klaviyo, e-posta ve dış hesap değişikliği yok.

## Basılı hedef ve canlı açılış

GotPrint 30805504: kabul edilmiş stok 2.500 P kartı; T/masa tasarımı basılmadı. Kaynaklar: `Claude_Teslimleri/K1_Musteri_Yolu_ve_QR.md` Ek B, `Claude_Teslimleri/B_Kolu_13_07_QR_Kaynak_Takibi_2026-10-16.md` ve 13 Ekim fiziksel tarama kabulü. Ödeme/sipariş belgesi kopyalanmadı.

Arka VIP QR: https://www.nazarrestaurantandbakery.com/vip?utm_source=qr&utm_medium=offline&utm_campaign=qr_paket . Bu oturumda canlı tarayıcıda VIP Club ve form açıldı; nihai adresin üç etiketi de aynı kaldı. Ara yönlendirme zinciri kaydedilmedi; form gönderilmedi. `qr_card/simit_vip` bu stoğun etiketi değil.

Ön QR Google yorum ekranına gider (place ID ChIJKTmeJADZ54kRvLZoaDaB9J4); önceki fiziksel tarama kabulü mevcut, bu çalışmada Google hesabı/yorum ekranı yeniden açılmadı. VIP hunisine sayılmaz. Basılı statik QR değiştirilemez: gelecekte VIP hedef değişikliği gerekirse bizim `/vip` yolunda sorguyu koruyan yönlendirme yapılabilir; bugün gerekmediği için eklenmedi. Google'a doğrudan giden ön QR bizim siteden yönlendirilemez.

## Bulgu ve değişiklik

| Halka | Önce | Bu PR |
| --- | --- | --- |
| Kaynak → VIP kaydı | UTM sessionStorage, API p_utm ve core.signups.utm mevcut | Mevcut yol korunur; API transport testi eklendi |
| Müşteri geçmişi | signup.customer_id ilişkisiyle kaynak korunur | Müşteride tek kaynak alanına ezilmez; mevcut SQL yolu incelendi, yeni canlı sorgu yok |
| GA4 VIP olayı | form_name; özel QR etiketi yok | VIP saved/confirmation_started olaylarına yalnız sabit qr_source/qr_medium/qr_campaign etiketleri; PII yok |
| Kart ziyareti | K11/#85'te QR kohortu yok | GA4 native sessionSource/sessionMedium/sessionCampaignName filtresi; ay başı–dün oturumları |
| Kayıt/onay/kupon | K11 genel kampanya, #85 tüm kullanım ayrımı | Ayrı QR kohortu RPC/kutusu; signup_reward/SIMIT, gerçek confirmation evidence, bağlı/beyanı ayrımı |
| 30 gün tekrar | K11 siparişe bağlı genel ölçüm | Yalnız bu kohortun olgunlaşan siparişe bağlı kullanımları; personel beyanı paydaya girmez |

GA4 oturumu fiziksel tarama/tekil kişi değildir; GA4 ile müşteri eşleştirilmez, nedensel dönüşüm oranı verilmez. VIP kaydı ve onay kişi; kullanım kupon adedidir. Kayıt penceresi tamamlanmış yerel günlerdir; o kohortun sonraki onay/kullanımları son okuma anına kadar izlenir. `confirmation_started` çift onayın tamamlanması değildir; onay sayısı yalnız DB kanıtından gelir. Kampanya yapılandırmasında benefit_code=SIMIT gerekir; bu PR ayar/veri yazmaz.

GA4 toplam 7 günlük raporu korunur; QR için +1 bütçeli rapor, OAuth aynı token ile paylaşılır. Kota/HTTP400/örnekleme/eşik/eksik rapor toplamı bozmaz, QR bilinmiyor olur; sahte sıfır yok. Ek secret veya GA4 custom dimension kurulumu gerekmez: huni yerel session boyutlarından okur. QR olay parametreleri yalnız ileriye dönüktür; eski olaylar geri doldurulmaz. Aylık snapshot 26 saatten eskiyse veya dönemi uymuyorsa bilinmiyor; test görünümü gerçek GA4 sayısını ödünç almaz.

## Kurulum önerisi ve kanıt

Koordinasyon sıra önerisi **17**, sıra 16 sonrası: `20261021001100_qr_vip_funnel.sql`. SHA256 `15477a8c7bef56854af9cec9c01cc9e79189295396cea2e306ca1f722b369722`. Salt okunur SECURITY DEFINER RPC; authenticated + işletmeye bağlı loyalty.read, tenant/test filtresi. Canlıya uygulanmadı; birleştirme, migration kurulumu ve ops-collect/site dağıtımı Talip'te. Pages dağıtımı Finalize'ın mevcut çözümünü izler; ayrı dağıtım yolu üretilmedi. Sonrasında tek toplama ve Yenile ile canlı kabul gerekir; burada canlı huni sayısı doğrulanmadı.

Yerel sentetik doğrulama: 95/95 birim (72 kaynak/GA4 + 23 Ops sunucu/Ads/Meta regresyonu); gerçek PostgreSQL migration/RPC zinciri 1/1 (7 kanıt maddesi); yeni ekran 6/6 ve 375px; mevcut CRM/Ops/personel 78/78; TypeScript ve değişen UI dosyaları lint geçti. Production-mode iki yerel build: 213 dosya, 209 aynı; CSS ve tüm statik public dosyalar aynı, HTML yalnız giriş JS hash'i değişik. GA4 loader, API, form ve giriş kaynakları korunur; GA4 etiket eki bilinçli farktır. Çalışma ortamı değerleri sentetik; canlı secret okunmadı.

Kanıtlar `QR_VIP_Huni_kanit/`: live-target.json, live-vip-ax.txt/png, native.json, browser-results.json, staff-regression.json, production-parity.json, build logları ve sentetik 375px/masaüstü görüntüleri. Testler: qrVipFunnel.test.mjs, qrVipFunnelDb.test.mjs, browser/qrVipFunnel.browser.mjs, previewEnvironment.test.mjs; parity: qrVipFunnelParity.py.
