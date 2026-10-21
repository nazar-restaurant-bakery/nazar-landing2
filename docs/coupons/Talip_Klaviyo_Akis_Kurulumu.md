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
