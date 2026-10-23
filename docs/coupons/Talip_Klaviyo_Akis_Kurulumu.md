# Talip — Nazar VIP Welcome akışını hazırlama

Bu belge **taslak kurulum** içindir. Bu çalışma Klaviyo hesabını değiştirmedi, email göndermedi, anahtar oluşturmadı veya flow açmadı. Giriş, anahtar, hesap ve son Live işlemi yalnız Talip'te. Kod karşılığı: #77; mevcut kupon migration'ı M14 + yeni gönderim mutabakatı migration'ı **14a sıra önerisi**. Önce Sandbox kabulü, sonra ayrı Production uygulama kararı.

## 1. Doğru hesap ve taslak

1. Klaviyo'ya kendin giriş yap. Sol alttaki hesap menüsünde **Nazar Restaurant & Bakery** hesabını kontrol et. Başka işletmeye geçme.
2. Sol menü **Flows** → **Nazar VIP — Welcome**. Flow ve içindeki email kartı **Draft** kalmalı. **Review and turn on / Update action statuses / Live** seçilmez.
3. Tetik kartına bas. Beklenen: **Metric / Your metrics → Nazar Coupon Welcome Authorized**. Listedeki VIP aboneliği veya segment tetikleyici değildir; izin onayı ve K6 kapısı önce sunucuda tamamlanır.
4. Mevcut tetik farklıysa onu yerinde değiştirmeye çalışma: Klaviyo mevcut flow tetik türünü doğrudan değiştirmez. Aynı tür metric değişimi için **Clone** yolunu, liste→metric değişimi için **Create flow → Build your own** yolunu kullan; yeni taslağı **Nazar VIP — Welcome — gated** adıyla kaydet. Eski taslak kapalı kalır. Metrik görünmüyorsa sahte müşteri/olay gönderme; metrik ilk onaylı sentetik kabulde hazırlanır, bu adım açık kalır.
5. Tetik ayarları **Re-entry criteria → No re-entry → Save → Confirm and save**. Bu alan henüz hesabında yoksa eski **Has not been in this flow / over all time** koşulunu kullan. **Add past profiles / back-populate** çalıştırılmaz; bu işlem yeniden giriş sınırını aşabilir. Aynı kişiye bu Welcome mesajından ikinci gönderim hazırlama.

## 2. Tek email kartı

6. Tetiğin hemen altına yalnız bir **Email** ekle. Delay, SMS, ikinci email, A/B variation, webhook ile yeniden gönderim ve sonraki güne erteleme ekleme. Kartın durumu **Draft** olsun.
7. Email kartı → içerik düzenleme. Konu: **Welcome to Nazar VIP — your simit coupon**. Gönderici adı ve reply-to mevcut onaylı Nazar değerleri olur; bu belgede adres uydurulmaz.
8. HTML şablonu `welcome-email.html`, düz metin `welcome-email.txt`. Kod alanı `{{ event.coupon_code }}`, QR resim kaynağı `{{ event.coupon_qr_image_url }}`. Kupon kodu QR olmadan da okunmalı. Koşullar değişmez: onaylı mevcut kampanyanın sonraki uygun kendi-kanal siparişi; vergi/bahşiş hariç 3000 cent eşik, kişi başı bir kullanım. Ürün/teklif metni ayrı kampanya içeriğidir.
9. Şirket altbilgisi ve unsubscribe bağlantısını koru. Adres `{{ organization.full_address }}` üzerinden doğru işletme adresini göstermeli. Önizlemeyi **Preview** ile kontrol et; **Send test** de gerçek emaildir, bu hazırlığın kapsamında kullanılmaz.
10. Email **Settings / Additional filters**: güncel email marketing izni ve VIP liste üyeliği koşullarını koru. Unsubscribe/suppression atlanmaz; transactional mesaj olarak işaretlenmez. Smart Sending, K6'nın yerine geçmez; 168 saatlik ortak sınır veritabanındadır. Smart Sending'i testi geçsin diye kapatma. Skipped/Manual/Waiting kayıtları gönderildi sayılmaz.

## 3. Kimlikleri ve salt okunur gönderim kanıtını bağlama

11. Flow URL'sindeki **flow ID**'yi kaydet. Email kartı → **View details / View all analytics**; URL'deki **message ID**'yi kaydet. Bu tek email/flow eşlemesi daha sonra değiştirilirse önce yerel ayar ve kanıt sözleşmesi yeniden incelenir.
12. **Analytics → Metrics → Received Email**: URL'deki **metric ID**'yi kaydet. Bu, Klaviyo'nun kendi **Received Email** metriğidir; aynı isimli API/custom metrik kabul edilmez. Örnek olay ayrıntısında `$flow`, `$message`, profil ve tarih alanları incelenir. **Opened Email** veya bizim özel tetik olayımız teslimat kanıtı değildir.
13. Hesap **Settings → API keys → Create Private API Key**. Ad: **Nazar CRM — Coupon delivery read-only**. Özel scope'lar: **Accounts: Read, Events: Read, Metrics: Read**; yazma/abonelik/suppression scope'u yok. Anahtarı Bitwarden'a kendin kaydet; Cloudflare sunucu secret adı **COUPON_KLAVIYO_RECEIPT_KEY** (Preview'da TEST_ öneki). Key'i sohbete/README'ye/komut satırına yazma. Bu anahtar event gönderen anahtardan ayrı olur.
14. Codex, bu üç kimlik + mevcut hesap/business kimliğinden **kapalı** `core.coupon_delivery_settings` kurulum SQL'ini hazırlar; Talip inceler/uygular. `review_ref`, yalnız bu flow'un tek email ve yeniden girişsiz ayarının kanıtına işaret eder. Bu hazırlık hiçbir satır tohumlamaz. Eski profile/abonelik senkron anahtarları değiştirilmez.

## 4. Kontrollü kabul ve sonuç

15. Sandbox'ta taklit sağlayıcı + gerçek K4/K6/K10 SQL testleri ve yanlış hesap/kişi/mesaj/iki kullanım kontrolleri geçer. Production'da gerçek test emaili/sentetik profil yazımı için yöntem ve ücret/gönderim etkisi Talip tarafından ayrıca onaylanır; yerel testin `is_test=false` fixture'ı canlıya kopyalanmaz. Gerçek müşteri üzerinden deneme yapılmaz.
16. Onaylı canlı kabulde **yalnız Talip**, yalnız bu emaili Live yapar; sunucu bir K6 yetkisiyle bir event verir. `202` → **olay kabul edildi, teslimat bekleniyor**. Sonra dar sunucu komutu `{"action":"reconcile","businessId":"<ayar>","couponId":"<kupon UUID>"}` ile GET Events okunur. İşlem email göndermez. API key veya makine anahtarı normal terminal argümanına konmaz.
17. Eşleşme: doğru hesap + orijinal provider profil ID + gerçek Received Email metric ID + özel flow ID + tek email message ID + dispatch sonrasındaki tarih + **tam bir** olay. Sayfalama tamamlanmamışsa veya birden fazla aday varsa bekler. Tetik event'inin `unique_id` değerinin teslimat olayına kopyalandığı varsayılmaz; DB'deki kişi/flow/mesaj için tek kalıcı gönderim eşlemesi kullanılır.
18. Ancak gerçek GET kanıtı DB tarafından onaylanırsa `delivery_confirmed` döner. `activationReady:true` için güncel yerel izin, K6 ayarı, teslimat ayarı ve canlı okuma da açık olmalıdır. Bu sonuç Talip'in flow açma veya kampanya kabul kararının yerine geçmez. `202` veya mock tek başına `true` üretemez. Kart dağıtımı ve otomatik DOI→confirm bağlantısının kabulü ayrıca tamamlanır.

## 5. Belirsiz gönderim nasıl çözülür?

- Gerçek Received Email varsa kayıt, eski `message_log` satırı değiştirilmeden ek kanıt tablosuna bağlanır. 168 saat **gerçek teslimat tarihinden** hesaplanır; 167 saatte engel, 169 saatte yeni uygun mesaj mümkün olur. Aynı Welcome işi yeniden kuyruğa alınmaz.
- Email görünmüyorsa **yeniden event veya email gönderme**. Flow'un tek email kartında **View details → Recipient activity** ile **Waiting / Needs review / Sent / Skipped** durumuna bak. Kayıt/404/boş event sonucu tek başına “gönderilmedi” kanıtı değildir.
- Gönderilmediği ve sağlayıcıdaki bekleyen işin iptal edildiği kesinleştirilirse Talip, flow'u Draft'a alıp ilgili Waiting/Needs review işinin artık gönderilemeyeceğini sağlayıcı ekranından doğrular; kanıt dosyasının özeti + kayıt referansı ile `coupon_review_not_sent_v1` için sınırlı inceleme kaydı hazırlar. Ekranda iptal/çıkarma yolu yoksa destekten yazılı terminal durum alınır; bulunmayan Delete düğmesi varsayılmaz. Yalnız aktif platform operatörü **ve** hedef işletme üyeliği olan Talip bu istisnayı onaylayabilir; personel veya platform-only hesap yapamaz.
- İnceleme sonrası da **168 saat muhafazakâr bekleme** vardır. Böylece çözülen kayıt süresiz kilit oluşturmaz; otomatik zaman aşımıyla belirsizlik silinmez. Sonradan gerçek teslimat kanıtı gelirse en yeni teslimatın sınırı yine uygulanır. Kanıt yoksa durum açık kalır; gönderildi/gönderilmedi uydurulmaz.

Dayanaklar: [tetik değişimi](https://help.klaviyo.com/hc/en-us/articles/115002775052), [yeniden giriş / past profiles](https://help.klaviyo.com/hc/en-us/articles/360003040052), [Draft/Manual/Live](https://help.klaviyo.com/hc/en-us/articles/115002774932), [GET Events, revision 2026-07-15](https://developers.klaviyo.com/en/v2026-07-15/reference/get_events), [native Received Email alanları](https://developers.klaviyo.com/en/v1-2/reference/klaviyo-metrics-attributes). Received Email için ücretli KDP webhook'u kurulmaz; mevcut Events API salt okunur kullanılır.


## 6. DOI → kupon: ayrı Flow webhook — 22 Ekim 2026

Bu bölüm **Nazar VIP — DOI → Kupon** adlı ayrı, **yalnız webhook içeren** Flow içindir. Yukarıdaki **Nazar VIP — Welcome** email Flow'u değiştirilmez. Şimdiki teslim Draft PR'dır; bu tarifi hazırlamak Flow/anahtar/Live veya gerçek email işlemi yapmaz. **Sıra 18 K16 → sıra 19 DOI** aynı hedefte kabul edilmeden alıcı açılmaz. [Teknik sözleşme ve Free plan belge dayanağı](https://github.com/nazar-restaurant-bakery/nazar-landing2/blob/feat/vip-doi-coupon-webhook/docs/coupons/doi-flow-webhook.md).

### A. Önce hesap, izin ve sunucu hazırlığı

1. Klaviyo'ya kendin giriş yap. Hesap adını **Nazar Restaurant & Bakery**, Billing planını **Free** olarak kontrol et. Bu adım plan değiştirmez. **Advanced KDP → Webhooks / Code** ekranına gitme; bu iki özellik ücretli ürünün ayrı yoludur.
2. Kendi kullanıcı hesabında **MFA / two-step authentication** açık ve rolün Owner/Admin/Manager olmalı. Giriş, doğrulama ve hesap işlemlerini yalnız sen yaparsın; password/kod paylaşılmaz. [Resmî Flow webhook şartları](https://developers.klaviyo.com/en/docs/how_to_add_a_webhook_action_to_a_flow).
3. **Audience → Lists & segments → mevcut Nazar VIP listesi → Settings → Consent / Opt-in process**. **Double opt-in** olmalı. Aynı listenin ID'sini URL'den kaydet; yeni liste açma. Native signup yolundaki mevcut listeyle aynı olmalı. Farklıysa devam etme; bu tarif suppression kaldırma veya single opt-in'e geçirme yolu değildir.
4. Codex teslimindeki `docs/coupons/doi-flow-webhook.md` ayar tablosunu aç. Talip'in onayladığı kurulumda Cloudflare **nazar-restaurant-website / Production** için başlangıçta `VIP_DOI_ENABLED=false`; hedef proje, liste/hesap ID'si ve mevcut Accounts/Profiles/Lists **Read** anahtarı girilir. Bu alıcı event key veya abonelik yazma scope'u istemez. Sandbox'ta yalnız TEST_ önekli adlar ve `mock` kullanılır; Production kimlik bilgileri taşınmaz.
5. Bitwarden'da ayrı **Nazar — DOI Flow webhook** kaydı oluştur. En az 32 URL-safe rastgele karakterli makine anahtarı üret. Aynı değeri yalnız Cloudflare Secret **VIP_DOI_WEBHOOK_KEY** ve aşağıdaki Authorization header'a gir. Bu API key veya staff/database password değildir. Sohbete, JSON body'ye, URL'ye veya Git'e yazma.

### B. Yeni taslağı kur — bir adım, bir işlem

6. **Flows → Create flow → Build your own / Create from scratch**. Ad: **Nazar VIP — DOI → Kupon**. **Draft** olarak oluştur.
7. Trigger türünü **Added to list / List** seç; 3. adımda doğruladığın **mevcut Nazar VIP listesi**ni seç → **Save / Confirm trigger**. Listeye katılım yalnız uyandırma sinyalidir; sunucu her seferinde gerçek DOI tarihini/üyeliği yeniden doğrular.
8. **Re-entry criteria → No re-entry** varsa seç → **Save**. **Add past profiles / back-populate** kullanma. Aynı kuponun tekrarına DB ayrıca engel olur; eski aboneleri bu kurulumla topluca işleme.
9. Trigger'ın hemen altına tek **Webhook** action sürükle. **Email, SMS, profile update, delay, ikinci webhook veya Welcome emaili ekleme.** Webhook kartı görünmüyor, kilitli veya **Upgrade** istiyorsa kaydetme/plan değiştirme; durumu bildir. Free uygunluğu için belge zinciri: [Free özellikleri](https://help.klaviyo.com/hc/en-us/articles/1260805595309), [Free otomasyon](https://www.klaviyo.com/pricing), [Flow / ücretli KDP ayrımı](https://help.klaviyo.com/hc/en-us/articles/18622300908955). Hesaba özel UI erişimi bu PR hazırlığında denenmiş sayılmaz.
10. Webhook **Destination URL** alanına gelecekte kabul edilmiş Production alıcısı için tam adresi gir: **https://www.nazarrestaurantandbakery.com/api/webhooks/vip-doi**. Sonuna query/anahtar ekleme, başka siteye yönlendirme kullanma. Draft henüz yayın yapmaz; bu adres kodun dağıtıldığını kanıtlamaz.
11. **Add Headers → Name: Authorization → Value: Bearer** ve ardından **bir boşluk + Bitwarden'daki makine anahtarı**. Header adı `Authorization`; Value `Bearer …` biçimindedir. **Content-Type = application/json** ekle. Klaviyo otomatik **X-Klaviyo-Flow-ID** gönderir; bunu tek başına güvenlik anahtarı sanma.
12. **Body / JSON** alanına aşağıdaki yapıyı gir. `VIP_LIST_ID` yerine 3. adımdaki gerçek liste ID'sini yaz; JSON'da yer tutucu kalmasın. `email` satırındaki şablon değişkenini gerçek bir müşteri emailiyle değiştirme. **View profile properties** panelinden Email değişkeninin `person.email` olduğunu kontrol et; `lower` normalizasyonudur.

```json
{"version":1,"email":"{{ person.email|lower }}","listId":"VIP_LIST_ID"}
```

13. Body'ye **businessId, customerId, signupId, subscribed=true, kupon kodu, API key veya consent_timestamp ekleme**. Hedef işletme env'den; kimlik/DOI tarihi API ve yerel kayıt eşleşmesinden gelir. Alan eklenirse alıcı isteği reddeder.
14. **Save** ile ayarları kaydet; kart/Flow durumu **Draft** kalmalı. Arayüz Save'in webhook'u Live yapacağını söylüyorsa bu aşamada basma. **Review and turn on / Live / Test webhook / Send test** kullanılmaz. Welcome Flow'u da Draft kalır. Flow URL'sindeki ID'yi kaydet; Cloudflare **VIP_DOI_FLOW_ID** değeri bu DOI Flow ID'sidir, Welcome ID'si değildir.

### C. Kabul sırası — bu PR tesliminde çalıştırılmaz

15. Önce PR inceleme ve **sıra 18 → sıra 19 Sandbox kurulumu**. Yerel sentetik sağlayıcı + gerçek PostgreSQL testi otomatik kuponu ve eşzamanlı tekrar güvenliğini kanıtlar. Hosted Sandbox **mock** alıcı olumlu DOI uydurmaz: geçerli dış kanıt olmayınca 503, yanlış kimlikte 403 beklenir. Mevcut sentetik SQL onay kuru testi, gerçek Klaviyo DOI/Flow kabulünün yerine geçmez. Sadece TEST modunu live'a çevirerek veya `is_test` işaretini silerek bu sınırı aşma.
16. Talip ayrı Production kabulü verdiğinde: aynı migration üretime uygulanır, onaylı kod dağıtılır, ayrı DOI ayarları girilir; **VIP_DOI_ENABLED=false** başlangıcı doğrulanır. Free profil/gönderim kotasında gerçek tek gönüllünün DOI emaili için yer olduğu kontrol edilir; plan/ücret değişimi gerekiyorsa durulur. Bu Flow'da mesaj yok; Welcome kapalı kalır.
17. Sunucu hazır ve Talip açılışı onayladıysa **yalnız DOI webhook action'ını Live** yap. Sonra Cloudflare `VIP_DOI_MODE=live`, gerçek tarihli **VIP_DOI_APPROVAL_ID**, `VIP_DOI_ENABLED=true` → doğru güncel onaylı sürümü yeniden dağıt. Doğru DOI Flow/liste/hesap ID'sini son kez kontrol et. Welcome/email action'ı Live yapılmaz.
18. Talip veya onaylı gerçek gönüllü yeni VIP talebini bir kez gönderir ve gelen gerçek DOI bağlantısını kendisi onaylar. Sonra **Flows → DOI Flow → Webhook → View all activity**: 200 ve `confirmation_recorded` aranır. Bu yalnız DB onayıdır; email gönderimi veya kampanya aktifliği değildir. DB'de aktif uygun kampanyayla aynı kişiye **bir confirmation evidence + bir kupon + bir outbox** ve tekil receipt doğrulanır; kupon kodu/kişisel veri rapora kopyalanmaz. **message_log'a bu alıcıdan gönderim yazılmaz.** Kuponun emaille teslimi ayrı K6/Welcome kabulüdür.
19. **503 / Waiting to retry** görülürse yeni form veya ikinci email gönderme; Klaviyo'nun sınırlı otomatik tekrar teslimi aynı işlemi güvenle yeniden dener. **200 / local_request_ambiguous / unmatched / recipient_blocked** kupon başarısı değildir; önce yerel kayıt/izin incelenir. E-posta/anahtar/API cevabı paylaşmadan yalnız güvenli kod ve saati kaydet. Retry bütçesi sonunda başarısızsa Talip'in denetim/elle tekrar kararı gerekir; polling veya günlük kupon zamanlayıcısı eklenmez.
20. Acil kapatma: DOI webhook action **Draft**; Cloudflare **VIP_DOI_ENABLED=false** → aynı onaylı kodu yeniden dağıt. Mevcut kupon/kanıt/audit geçmişi silinmez. Welcome ve K6 ayrı kalır. Sistemi durdurmak için unsubscribe/suppression veya müşterinin izni değiştirilmez.

**Kuru test koşulu:** PR'ın Sandbox sürümü ve migration kabulü olmadan müşteri kayıt/onay provası başlamaz. Gerçek DOI onayı Klaviyo'da, kanıt ve kupon gerçeği bizim DB'de tutulur; webhook bu iki sistemi bağlar.
