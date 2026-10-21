# K10 — personel kupon kasa ekranı

20 Ekim 2026 · [Draft PR #76](https://github.com/nazar-restaurant-bakery/nazar-landing2/pull/76) · Dal: `feat/staff-coupon-checkout`; **Draft**, taban main (`0449e1e`). Yalnız personel ekranı; kupon çekirdeği / ihraç / e-posta Koordinasyon'dadır. Kaynak: `K10_Kupon_Sozlesme.md` v1, `K10_Kampanya_Kararlari.md`.

## Kapsam ve dosyalar

| Madde | Sonuç |
|---|---|
| Menü, mobil, sorgu | CRM menüsünde **Kupon**, `/staff/coupons`. Kod yazma ve cihaz kamerasıyla QR; kamera reddinde yazma yolu açık. Geçerli / Kullanılmış (New York zamanı) / Süresi dolmuş / Durdurulmuş kampanya / Yanlış işletme / Bulunamadı ayrılır. Yalnız maskeli ad; yanlış işletmede kimlik/kampanya gösterilmez. |
| Kullanım | Yalnız geçerli sonuçta tek **Kullanıldı olarak işaretle** düğmesi. Clover no ve serbest not isteğe bağlı. Sözleşmedeki zorunlu fiş kanalı, net tutar, tarih ve referans + açık kontrol onayı alınır; `p_note` tam v1 JSON'dur. Boş serbest not, personelin açık fiş onayına bağlı “Fiş ve sipariş kontrol edildi” metnine dönüşür. Clover no varsa aynı fiş beyanı K7 kanıtıyla çekirdekte karşılaştırılır; sessiz beyan fallback'i yoktur. |
| Tek kullanım / belirsizlik | Eşzamanlı çift tıklama için senkron kilit; iki cihazda çekirdeğin `already_used` sonucu gösterilir. Kayıp yanıt yalnız bir lookup başlatır, redeem tekrarı yoktur. Readback hâlâ geçerliyse bile yazma kilitli kalır; personel önce açıkça yeniden lookup yapar. |
| Kasa talimatı | “Clover’da siparişe Sade Simit ekle → yalnız o satıra %100 indirim (ayrı indirim kalemi); sipariş vergi/bahşiş hariç $30 ve üzeri olmalı.” Kampanyanın daha yüksek eşiği varsa ayrıca gösterilir. Clover'a indirim/sipariş yazan API yoktur. |
| Yetki / tenant / gizlilik | Yapılandırılmış business_id + mevcut personel SDK oturumu. `staff_business_authorized_v1(...,'campaign.staff_mark')` kapısı, ardından tam `coupon_lookup_v1` / dört parametreli `coupon_redeem_v1`. Aktör parametresi/anahtarı yok; platform-only kapsam false, RPC 42501/403 reddi ekranı temizler. Çıkış/tenant key değişimi ve geç yanıtlar eski kod/sonucu geri getirmez. Kod/fiş/kamera verisi log, analitik, URL, localStorage veya sessionStorage'a yazılmaz. |

Değişen kaynaklar: `StaffShell.tsx`; yeni `CouponCheckout.tsx`, `CouponCamera.tsx`, `src/lib/couponCheckout.ts`. `package.json` / lock: **jsqr 1.4.0** sabit runtime bağımlılığı, yalnız kamera açılınca yüklenen yerel çözücü. [jsQR kaynak/API](https://github.com/cozmo/jsQR): video kareleri canvas'tan cihaz içinde çözülür; QR servisi/görüntü yükleme yoktur. Core teslimindeki jsqr dev bağımlılığıyla birleşirken runtime bağımlılığı korunmalıdır.

**Migration / secret / Edge Function eklenmedi.** Sıra bildirimi gerekmiyor; çekirdeğin sıra 14 migration'ı bu PR'ın parçası değildir. Yeni sabit Nazar işletme/ürün/kanal kimliği eklenmedi. Kampanya ve kupon üretimi/abonelik/e-posta/deploy yapılmadı.

## Test ve Production parity

- `node --test tests/couponCheckout.test.mjs tests/staffUi.test.mjs tests/crmUi.test.mjs tests/crmQueue.test.mjs tests/campaignEligibilityUi.test.mjs tests/campaignEligibilityRegression.test.mjs tests/opsUi.test.mjs`: **112/112**, sıfır atlanan. İçinde 19 yeni kod/maske/fiş sözleşme kontrolü ve yerel PostgreSQL 18.6 üzerinde mevcut K9/#72 regresyonu var.
- `node tests/couponCheckout.browser.mjs`: **16/16** gerçek React/Chrome kontrolü; geçerli→işaretle, ikinci kullanım, çift tıklama, iki cihaz, kayıp yanıt + geçerli/used readback, Clover no/not, gerçek jsQR ile sentetik video QR'ı, kamera reddi/geç izin yanıtı, yanlış işletme/expiry/inactive, lookup ve redeem HTTP403, platform-only ve çıkışta geç yanıt temizliği, 375px taşma/gizlilik.
- `node tests/browser/run.mjs --output 20_Yonetim/Teslim_Raporlari/K10_kasa_kanit/staff-regression`: **64/64**; gerçek StaffPage + BrowserRouter içinde yeni Kupon menüsü/doğrudan rota/yetki ve mevcut CRM/Ops regresyonu. TypeScript, hedefli ESLint ve Vite build geçti.
- İki aynı Production hedefli build: #72/#65 tabanı **212**, aday **213** dosya; tabandaki **209** dosya byte-eşit. Mevcut CSS byte-eşit; yeni jsQR lazy paketi, personel JS, main JS'deki CJS interop/minifier ve hash referansları beklenen farktır. Main JS'nin yalnız hash normalize edilince eşit olduğu iddia edilmez. Normalize index HTML aynı. Ayrıca güncel main `e5c11e5` ile public sayfalar, form, Auth, GA4 ve K5 kaynakları LF-byte eşit doğrulandı. Gerçek hosted ortam değişkeni/secret okunmadı; iki build aynı sentetik public yer tutucularla yapıldı. Yeniden üretim: `python tests/couponCheckoutParity.py` (önceden derlenmiş ayrı base klasörü).

Kanıt: `K10_kasa_kanit/{browser-summary,synthetic-summary,production-parity}.json`, `staff-regression/results.json`; `coupon-valid-375.png`, `coupon-valid-desktop.png`, `staff-regression/coupon-shell-375-synthetic.png`.

**Test sınırı:** İki gerçek React cihazı ortak atomik **sentetik RPC** ile çalıştı; bu, yeni kupon çekirdeğinin PostgreSQL kilit/unique kanıtının yerine geçmez. Burada yeniden çalışan native DB testi mevcut #72/K9 içindir. Kupon çekirdeğinin gerçek eşzamanlı redeem ve canlı JWT/PostgREST kabulü Koordinasyon'un çekirdek teslimi ve sonraki sandbox kabulündedir. Gerçek telefonda donanım kamera kabulü yapılmadı; gerçek decoder sentetik video akışıyla çalıştırıldı. Canlı müşteri/kupon veya sağlayıcı kullanılmadı.

## Talip adımları

1. Draft ekran PR'ını #72/#65 ve Koordinasyon'un kupon çekirdeğiyle birlikte incele; yalnız ekran PR'ı yeni migration/secret gerektirmez. #72 birleşince ekran PR'ının hedefi main'e alınır. Birleşme Talip'te.
2. Çekirdek migration / `campaign.staff_mark` ve lookup/redeem hazırlandıktan sonra sandbox'ta kendi sentetik kuponuyla yazma, ikinci cihaz/403 ve mobil kamera kabulünü yap. Çekirdek olmadan “bağlantı/yetki doğrulanamadı” güvenli kapalı durumdur.
3. Kabul sonrası Talip normal frontend yayınını yapar; HTTPS `/staff/coupons` ekranında kamera izni ve yazılı kod yolu kontrol edilir. Bu teslim kampanya, kupon dağıtımı, Welcome flow veya gerçek e-posta etkinleştirmez.

Tariften sapma yok. Ek açık karar sorusu yok; çekirdek bağımlılığı ve donanım/sandbox kabulü yukarıda ayrıldı. Bitirildi; sonraki kaleme geçilmedi.

## 21 Ekim — main rebase kabulü

#76 yalnız iki ekran commitini güncel main 0449e1e üzerine taşıdı; hedef main, Draft korunur. Güncel seçilmiş birim paketi 47/47 (couponCheckout, staffUi, crmUi, crmQueue, opsUi), gerçek kasa/QR/kamera paketi16/16 ve StaffPage CRM/Ops64/64 geçti. Önceki112/112 tarihsel teslim paketidir; #72 dalına ait testler bu main tabanına dahil değildir. TypeScript, hedefli ESLint, Production build/parity yeniden geçti:212→213 dosya,209 byte-eşit, CSS ve korunan form/Auth/GA4/K5 kaynakları aynı. Güncel tekrar: python tests/couponCheckoutBuildParity.py ardından python tests/couponCheckoutParity.py.

SQL/migration eklenmedi veya değiştirilmedi; çekirdek #72/#77 bağımlılığı ayrıdır. /staff/coupons ve Kupon menüsü korundu. #78 de ayrı main tabanına taşındı; birleşimde /staff/team Personel menüsüyle birlikte korunacak. Canlı DB/hesap işlemi yok.

## 21 Ekim — kurulum sonrası ilk main güncellemesi

#76, #71/#72 ve Ads/Meta içeren main45e9c37 üzerine yeniden temellendirildi. package.json ve package-lock.json eşleşiyor; jsqr1.4.0 runtime bağımlılığı ve lock kaydı dev=false korunuyor. İlk tur:112/112 birim/yerel K9-hak kontrolü,16/16 kasa/QR,64/64 CRM/Ops; TypeScript/build/Production parity ve hedefli ESLint geçti.212→213 dosya,209 byte-eşit; ortak CSS,public form/Auth/GA4/K5 aynı. SQL değişmedi, canlı işlem yok.

Bu yalnız ilk güncellemedir: #73 ve #77 main’e girdikten sonra güncel main üzerinde bir tur daha ve gerçek sıra14+14a kupon RPC lookup/redeem/hata eşlemesi entegrasyonu beklenir. Mevcut16/16 UI testi sentetik RPC kullanır; gerçek kupon SQL entegrasyonu sayılmaz. #78 için #80 main sonrası aynı tekrar ve14b→15 sırası korunur. #76 Draft kalır.
