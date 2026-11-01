# G20: Ölçüm etiketleri Google Tag Manager'da

Faz 2 · Görev 20. GA4 artık sayfaya doğrudan gtag.js ile yüklenmiyor. Ölçüm Google Tag Manager (`GTM-TJ67R6VZ`) üzerinden yapılıyor. Site olayları yalnız `dataLayer`'a yazar; GTM bunları GA4'e, satın almayı ayrıca Google Ads'e iletir. Sayfada `gtag` fonksiyonu yok; bu yüzden bir olay iki kez gönderilemez.

- **Konteyner dosyası:** `gtm/GTM-TJ67R6VZ.container.json` (GTM "Import Container" biçimi)
- **Sayfa:** `index.html` içinde önce izin varsayılanı, sonra GTM yükleyicisi. Önizleme ve test ortamları bu bloğu derlemede çıkarır (`tools/build/productionAnalytics.ts`).
- **Kod:** `src/lib/analytics.ts` (olaylar), `src/lib/consent.ts` (izin), `src/components/AdChoices.tsx` (sayfa altı bağlantısı)
- **Test:** `tests/gtmConsent.test.mjs`

## Olaylar
| Olay | Ne zaman | Parametreler |
|---|---|---|
| `catering_request_submitted` | Catering talebi kaydedildi | `form_name` |
| `vip_signup_submitted` | VIP kaydı kaydedildi | `form_name`, varsa `qr_source`/`qr_medium`/`qr_campaign` |
| `vip_confirmation_started` | Klaviyo onay sürecini başlattı | aynı |
| `clover_order_click` / `phone_click` / `directions_click` | Bağlantı tıklandı | `page_path` |
| `begin_checkout` | Catering ödeme formunda PAY kabul edildi, Clover ödeme sayfası açılıyor | yok |
| `purchase` | Ödeme dönüş sayfası sunucudan **ödenmiş** yanıtı aldı (`paid` ya da `needs_reschedule`) | `transaction_id` (sipariş kimliği), `value` (USD), `currency` = `USD` |

Olay adları ve parametreleri, önceki gtag gönderimiyle aynıdır. Her olay bu cihazda bir kez sayılır (bellek + sessionStorage). Ölçüm hatası formu ya da ödemeyi bozmaz. Önizleme ve test ortamında hiçbir olay gönderilmez. Kişi bilgisi (e-posta, telefon, ad, mesaj) hiçbir olaya girmez.

## Google Ads
- **Ana dönüşüm:** "Catering purchase (verified)", `18403364763` / `H7eeCN_l468dEJuftMdE`. Yalnız `purchase` olayında çalışır. Değer, para birimi ve sipariş kimliği `dataLayer`'dan alınır.
- **İzin şartı:** Etiketin izin ayarında "Require additional consent for tag to fire: `ad_storage`" bulunur. İzin yoksa etiket hiç çalışmaz.
- **Kapalı olanlar:** Enhanced conversions kapalıdır.
- **`catering_request_submitted`:** Google Ads'e GA4'ten aktarılmaya devam eder. Ayrı bir Ads etiketi yoktur, böylece çift sayım olmaz.

## İzin düzeni: ret hakkı
Opt-in pencere yok.

- **Varsayılan:** GTM yüklenmeden önce Consent Mode v2 varsayılanı gönderilir: `analytics_storage`, `ad_storage`, `ad_user_data` ve `ad_personalization` granted.
- **Ret durumu:** Tarayıcı Global Privacy Control gönderiyorsa (`navigator.globalPrivacyControl === true`) ya da ziyaretçi bu cihazda ret seçmişse, `ad_storage`, `ad_user_data` ve `ad_personalization` denied olur. `analytics_storage` granted kalır.
- **Sayfa altı:** Her sayfanın altında "Do not sell or share my personal information" bağlantısı vardır. Tıklanınca tercih bu cihazda saklanır (`localStorage`, anahtar `nazar-ad-opt-out-v1`) ve hemen `consent update` gönderilir. Aynı yerden "Undo" ile geri alınabilir. GPC açıksa bağlantı yerine bilgi notu görünür; GPC her zaman geçerlidir.
- **Gizlilik sayfası:** Gizlilik sayfasında "Your right to opt out of sale or sharing" bölümü vardır.

## GTM'e içe aktarma (Talip)
1. https://tagmanager.google.com adresinde `GTM-TJ67R6VZ` konteynerini aç.
2. **Admin → Import Container** yolunu izle.
3. **Choose container file** ile `gtm/GTM-TJ67R6VZ.container.json` dosyasını seç.
4. Workspace olarak **Existing → Default Workspace** seç.
5. **Merge** ve **Rename conflicting tags, triggers, and variables** seç. Önizlemede **11 etiket, 8 tetikleyici, 8 değişken** eklenecek görünmeli. **Confirm**.
6. Etiketleri kontrol et:
   - **Google tag - G-LK46HFY46G:** All Pages.
   - **Google Ads - Catering purchase (verified):** Advanced Settings → Consent Settings bölümünde `ad_storage` olmalı.

## Preview ile kontrol
1. GTM'de **Preview** düğmesine bas ve `https://www.nazarrestaurantandbakery.com` adresini gir. Bu kontrol, PR birleşip site yayınlandıktan sonra yapılır.
2. **Tag Assistant:** Sayfa açılışında "Google tag - G-LK46HFY46G" ve "Conversion Linker" **Fired** görünmeli. Consent sekmesinde varsayılan değerler granted olmalı.
3. **Tıklama olayı:** Telefon ya da yol tarifi bağlantısına tıkla. `phone_click` veya `directions_click` olayı ve ilgili "GA4 event" etiketi Fired görünmeli.
4. **GA4:** Admin → DebugView'da olaylar görünmeli.
5. **Satın alma:** Gerçek satın alma yalnız gerçek ödemeyle oluşur. Test 34'te ödeme dönüş sayfasında `purchase` olayı, GA4 etiketi ve Ads etiketi Fired görünmeli.

## Yayın
GTM'de **Submit** → sürüm adı ("G20 GTM + consent") → **Publish**.

Sıra:
1. PR birleşir ve site yayınlanır.
2. Hemen ardından konteyner yayınlanır.

Site yayınlanıp konteyner henüz yayınlanmamışsa, o aradaki ziyaretler GA4'e gitmez. Bu yüzden iki adım art arda yapılmalı.

## Ret düzeni nasıl denenir
- **GPC:** GPC'yi varsayılan olarak gönderen bir tarayıcıyla (Brave ya da DuckDuckGo) veya Firefox'ta `privacy.globalprivacycontrol.enabled = true` ile siteyi aç.
  - Tag Assistant → Consent: `ad_storage`, `ad_user_data` ve `ad_personalization` **Denied** görünmeli.
  - Sayfa altında "Global Privacy Control detected…" notu görünmeli.
  - `purchase` olayında Ads etiketi **Not Fired** olmalı; GA4 etiketi çalışmaya devam eder.
- **Sayfa altı bağlantısı:** Normal tarayıcıda "Do not sell or share my personal information" bağlantısına tıkla.
  - Consent sekmesinde **Update** satırında ad_* **Denied** görünmeli.
  - Sayfayı yenile: varsayılan değerler artık denied olarak gelmeli.
  - "Undo" ile geri al: değerler yeniden granted olmalı.
