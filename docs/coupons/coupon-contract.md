# K10 kupon sözleşmesi v1 — çekirdek / kasa / hoş geldin

**20 Ekim 2026 · Talip’in K10_Kampanya_Kararlari.md ve son talimatı esas alınır.** Bu sözleşme Kol 2’nin kasa ekranının arayüzüdür. Hak VIP çift onayından kazanılır; sipariş yalnız kullanım koşuludur. Eski #72 sipariş-hak etiketi bu kuponun yerine geçmez. Kod/test teslimi ayrı PR’da #72/#65 üzerine; hosted migration, kampanya veya flow etkinleştirme bu teslim değildir.

## 1. Sabit davranış

- `signup_reward`: kişi başına kampanya boyunca **bir kupon, bir kullanım**, sipariş başına **bir sade simit**, vergi/bahşiş hariç **en az 3000 cent** (3000 dahil). Kendi kanalları: `dine_in`, `site_pickup`, `site_delivery`. Kanal/ürün eşlemesi ayardır; yeni sabit Nazar kimliği yoktur. Kart dağıtımı ancak kurulum ve canlı kabul sonrası Talip’in etkinleştirmesiyle başlar; migration kendiliğinden açmaz.
- Kampanya aktifken güvenilir, tarihli VIP çift onayı + yerel `subscribed` ve gönderim engeli olmaması kupon üretir. Aynı kanıt/yeniden abonelik ikinci kupon yaratmaz. Önceden doğrulanmış VIP için aynı kuralla idempotent telafi vardır; kanıtsız eski `subscribed` veya checkbox onay sayılmaz.
- Kazanılmış kupon ile sonradan pazarlama izni ayrıdır: unsubscribe/suppression e-postayı engeller, yeni kupon yaratmaz; daha önce kazanılmış kuponu tek başına harcamaz. Kampanya durdurulursa kullanım durur, geçmiş silinmez. Talip’in karar dosyasındaki iade kuralı: **kullanım void edilmez, hak geri verilmez**; eski K9 iade yolu da bunu aşamaz.

## 2. Private veri modeli

Tüm yeni tablolar `core` içinde RLS açık; PUBLIC/anon/authenticated/service_role doğrudan SELECT/INSERT/UPDATE/DELETE/TRUNCATE yetkisi yok. Dar SECURITY DEFINER RPC; boş `search_path`. İşletmeli FK’ler aynı işletmeyi zorlar. Gerçek kullanıcı/işletme tohumu yok.

| Nesne | Alan / kısıt |
|---|---|
| `core.campaigns` ileri ekleme | `campaign_kind text NOT NULL DEFAULT 'order_reward'` (`order_reward/signup_reward`); `signup_reward` item + subscribed_only + 3000 cent veya daha yüksek, tax/tip hariç, max_units_per_order=1, period=campaign, iki restore=false. Açık bitiş yalnız bu türde `ends_at=NULL`; `coupon_channels text[]`, `vip_list_id text`, `coupon_order_type_map jsonb` (Clover type ID → kendi kanal) ayarlı. İlk kupon sonrasında vaat edilmiş tür/ürün/eşik/kanal/tarih/iade parametreleri dondurulur; durdurma açıktır. Eski order_reward kuralları korunur. |
| `core.vip_confirmation_evidence` | `id,business_id,customer_id,signup_id,provider_profile_id,confirmed_at,checked_at,email_sha256,evidence jsonb,created_at`; append-only, aynı provider kanıtı tekrarında yeni rıza/kupon yaratmaz. Kanıt exact email/yerel VIP signup + gerçek double opt-in + doğru VIP listesi ile eşleşir. |
| `core.campaign_coupons` | `id,business_id,campaign_id,customer_id,confirmation_evidence_id,code,qr_token,issued_at,expires_at NULL,state(issued/redeemed),redeemed_at,redeemed_by,redemption_id,is_test`; UNIQUE(campaign_id,customer_id), UNIQUE(code), UNIQUE(qr_token), UNIQUE(redemption_id). Ayrı render tokenı CSPRNG 128 bit hex; QR resmi kuponu gösterdiğinden bu token da gizli bearer verisidir. Kod/sahip/kampanya/ihraç kanıtı değişmez; redeemed→issued yok. |
| `core.offer_redemptions` dar ekleme | `coupon_id NULL` + işletmeli FK. `order_id` yalnız kupona bağlı staff_mark için NULL olabilir; diğer K9 kayıtları yine gerçek sipariş ister. `source='staff_mark'`, aktör auth.uid(), dolu not/kanıt, units=1, campaign ömür boyu person period ve mevcut sayaç paylaşılır. |
| `core.coupon_welcome_outbox` | `id,business_id,coupon_id,message_key,event_unique_id,status,job_lease_id,lease_expires_at,message_reservation_id,provider_event_id,safe_code,created_at,updated_at`; UNIQUE(coupon_id), UNIQUE(message_key), UNIQUE(event_unique_id). Kuponla aynı transaction’da açılır; trigger ağ çağrısı yapmaz. Durumlar queued/claimed/provider_accepted/unknown/blocked. |

**Kod:** CSPRNG ile 80 bit; 16 sembol, `XXXX-XXXX-XXXX-XXXX`; alfabe `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (32 sembol). DB UNIQUE + sınırlı çakışma tekrarı; ardışık kod/UUID kısaltması yok. Girişte yalnız boşluk/tire ve harf büyüklüğü normalize edilir; hatalı uzunluk/alfabe reddedilir. QR içeriği tam **`VIPCOUPON1:<tireli kod>`**; URL, email, isim, müşteri UUID’si yok. QR yerelde/aynı altyapıda üretilir, üçüncü taraf QR servisine kod gönderilmez; analitik/log payload’ına eklenmez.

## 3. Kol 2’nin tükettiği personel RPC’leri

Her ikisi önce `auth.role()='authenticated'` ve **`core.staff_authorized_v1(p_business_id,'campaign.staff_mark')`** denetler. Aktör parametresi yok. Yanlış işletmede üyelik yoksa **SQLSTATE 42501 / authenticated HTTP403**, hiçbir kupon/müşteri verisi dönmez. Platform-only operatör de üyelik olmadan kullanamaz. Çıkışta kod/taslak/sonuçlar temizlenir; bekleyen yazmada düğme kapalı; belirsiz yanıtta otomatik redeem tekrarı yok, önce lookup.

```sql
public.coupon_lookup_v1(p_business_id uuid, p_code text) RETURNS jsonb
public.coupon_redeem_v1(p_business_id uuid, p_code text,
                       p_clover_order_id text DEFAULT NULL,
                       p_note jsonb DEFAULT NULL) RETURNS jsonb
```

**lookup salt okunur:** `{status, valid, reason, customerNameMasked, campaign, couponId, expiresAt, redeemedAt}`. `status`: `valid / used / expired / inactive / wrong_business / not_found`. `valid` yalnız kazanılmış, harcanmamış, süresi geçmemiş ve kampanyası aktif kuponda true; siparişin 30 dolar/kanal koşulunun ayrıca doğrulanacağı gösterilir. `campaign`: `{id,name,benefitType:'item',minimumAmountCents,channels,units:1}`. İsim en fazla ilk harf + `***`; email/telefon/kimlik yok. Hedef işletmede yetkili kişinin başka işletmeye ait kodu için `wrong_business`; isim/kampanya/couponId NULL. Rastgele bulunamayan kod `not_found`; anonymous lookup yok. İstemci kodu ölçüm/console/URL query’ye koymaz.

**redeem:** başarılı `{redeemed:true,status:'used',code:'redeemed',couponId,redemptionId,redeemedAt}`. İkinci/eşzamanlı kaybeden `{redeemed:false,status:'used',code:'already_used',...}`; ikinci satır oluşmaz. Beklenen iş retleri `{redeemed:false,status,code}`; personel bunları hata yerine açıklama olarak gösterir.

**`p_note` v1 yapısı** (dört parametreli imza korunur; son alan yalnız serbest metin değildir):

```json
{"version":1,"text":"Fiş ve sipariş kontrol edildi",
 "channel":"dine_in","qualifyingAmountCents":3000,
 "receiptAt":"2026-10-22T12:30:00-04:00",
 "receiptRef":"fiziksel-fisin-tekrar-kullanilmayan-kimligi"}
```

`text` 1–1000 dolu karakter; `receiptRef` 1–120 dolu karakter; kanal üç ayarlı kendi kanaldan biri; tutar tam sayı cent, vergi/bahşiş hariç; `receiptAt` gerçek fişin tarih/saatidir (ISO8601, UTC/offset). **Sonraki sipariş:** fiş/sipariş zamanı kuponun `issued_at` anından önce olamaz, gelecekte olamaz. NULL Clover order senaryosunda bunlar **zorunlu personel beyanıdır**; aynı işletme+kampanyada receiptRef UNIQUE ile ikinci kuponun aynı beyanlı siparişte kullanımı engellenir. Bu, gerçek kasanın tutarını/kanalını/tarihini bağımsız kanıtlamaz; kullanıcıya `staff_attested` gösterilir. Aynı fiziksel fişe yanlış farklı referans verilmesini DB bilemez; personel gerçek fişi kontrol eder. Sahte K7 siparişi yaratılmaz.

Clover ID varsa yerel K7 işletme/sipariş/müşteri eşleşmesi, ödenmiş/iade durumu, net tutar, kupondan sonraki sipariş zamanı ve ayarlı kanal kanıtı kullanılır; eksik kanıtla personel beyanına sessiz düşülmez. `receiptRef` Clover ID’den normalize edilir; beyan kanalı/tutarı/tarihi kaynakla çelişirse reddedilir. Karar + coupon lock + redemption + mevcut quota + kuponu used yapma **tek transaction**; tutarlı kilit sırası, unique kısıtlar ve gerçek eşzamanlı test zorunlu. Eski `campaign_evaluate_v1` signup_reward’ı kuponsuz kullanamaz.

**Kodlar:** `redeemed,already_used,expired,campaign_inactive,wrong_business,not_found,below_minimum,channel_not_allowed,order_not_synced,order_unmatched,order_not_paid,order_before_coupon,amount_evidence_missing,order_already_rewarded,total_limit,attestation_required,attestation_mismatch`. Bozuk parametre **22023 / HTTP400**; yetki **42501 /403**; beklenmeyen DB/bağlantı hatası “doğrulanamadı”, başarı uydurulmaz. Kod araması/yazımı yalnız aktif yetkili personel oturumundadır; anonim arama yok, 80 bit tahmin edilemez kod kullanılır. Bu çekirdek teslimi ek gateway rate-limit kurulumu iddia etmez; tüm kod/QR değerleri loglarda redakte edilir.

## 4. Gerçek çift onay köprüsü ve ihraç

Mevcut kodda `submit_signup_once` pending_review yazar; `record_klaviyo_status_v1` confirmed yalnız gözlemdir ve kişiyi subscribed yapmaz. K5 izin vermez. Bu nedenle köprü açıkça eklenir:

```sql
public.coupon_record_confirmed_vip_v1(
 p_business_id uuid,p_customer_id uuid,p_signup_id uuid,
 p_provider_profile_id text,p_confirmed_at timestamptz,
 p_checked_at timestamptz,p_evidence jsonb) RETURNS jsonb -- service_role only
public.coupon_issue_confirmed_v1(p_business_id uuid,p_customer_id uuid)
 RETURNS jsonb -- service_role only, idempotent catch-up / same private issuer
public.coupon_confirmation_context_v1(p_business_id uuid,p_customer_id uuid,p_signup_id uuid)
 RETURNS jsonb -- service_role only; doğrulanacak yerel kimlik/list/signup snapshot'ı
public.coupon_qr_payload_v1(p_token text) RETURNS jsonb
 -- service_role only; {payload}; public GET yalnız GIF döndürür
public.coupon_record_negative_v1(p_business_id uuid,p_customer_id uuid,
 p_email text,p_status text,p_checked_at timestamptz) RETURNS jsonb
 -- service_role only; yeni provider iptal/suppression kanıtını yerelde korur
```

Güvenilir sunucu adaptörü doğru ayarlı hesap/listeden exact profile email + `SUBSCRIBED`, `can_receive_email_marketing=true`, **double_optin=true**, liste üyeliği ve tarihli consent kanıtını salt okunur doğrular. `p_evidence`: `{source:'klaviyo',listId,emailSha256,doubleOptIn:true,canReceiveEmailMarketing:true,consent:'SUBSCRIBED'}` + kanıt referansı/özeti. DB pending VIP signup talebi, tarih, email hash, list/config ve negatif yerel/provider gözlem sınırını yeniden denetler. İstemciden gelen boolean onay sayılmaz; public form veya tarayıcı bu RPC’yi çağıramaz.

İlk kez pending_review/not_subscribed→subscribed yalnız bu kanıtla; yeni kanıt append-only kaydedilir. `unsubscribed` veya suppression kaldırılmaz; K4’ün özel onay yolu aynen gerekir, eski negatif gözlem yok sayılmaz. Pozitif geçiş ve kupon/outbox aynı transaction’dadır; doğrudan subscribed UPDATE tek başına kupon vermez. Daha sonra aktif kampanya için kanıtlı mevcut kişiler idempotent issuer ile alınabilir. Kupon ancak aktif yapılandırmaya ve test/gerçek ayrımına uyarsa oluşur; izin satırı kampanya yok diye başarısız olmaz.

## 5. Hoş geldin / K6 entegrasyon sözleşmesi

Kupon outbox hizmet RPC’leri (yalnız service_role):

```sql
public.coupon_welcome_claim_v1(p_business_id uuid,p_coupon_id uuid DEFAULT NULL) RETURNS jsonb
public.coupon_welcome_context_v1(p_job_id uuid,p_job_lease_id uuid) RETURNS jsonb
public.coupon_welcome_finish_v1(p_job_id uuid,p_job_lease_id uuid,
 p_outcome text,p_message_reservation_id uuid DEFAULT NULL,
 p_provider_event_id text DEFAULT NULL,p_safe_code text DEFAULT NULL) RETURNS jsonb
```

Claim/context: `{allowed,code,jobId,jobLeaseId,couponId,businessId,customerId,messageKey,eventUniqueId,recipient,properties}`; context aynı lease ve güncel izin/negatif gözlem/aktif kampanyayı yeniden denetler. Hassas context yalnız sunucuda; testler sentetik taşıyıcı kullanır. Outbox kuyruğu ve hazır sunucu işleyici teslim edilir; canlı tetik/schedule/secret kurulumu ve hesabın flow etkinleştirmesi Talip’in kabul adımlarıdır.

Gönderim yolu: outbox claim → K6 **reserve → claim → consuming context** → son consent/context okuması → tek Klaviyo custom event POST → finalize. `message_kind='flow'`, sabit `message_key='coupon-welcome:<coupon UUID>'`, aynı provider `unique_id`; payload hash snapshot’a bağlı. K6 reddinde sağlayıcı çağrısı yok; unsubscribe/suppression her zaman kazanır. Profil/abonelik/suppression endpoint’leri çağrılmaz.

Klaviyo **“Nazar VIP — Welcome” Draft** yalnız **`Nazar Coupon Welcome Authorized`** özel olayından başlatılacak şekilde hazırlanır; listeye katılma/native signup tetikleyicisi K6’yı aşamaz. Tek email, gecikmesiz, yeniden giriş kapalı; güncel subscription/suppression gönderim filtreleri. Olay özellikleri `coupon_code,coupon_qr_payload,coupon_qr_image_url,campaign_id,coupon_id,minimum_amount_cents,channels,expires_at,message_key` değişmez snapshot’tan gelir; mutable profile alanı kupon gerçeği değildir. QR resmi aynı altyapıda, kişisel veri içermeyen ayrı tahmin edilemez render tokenıyla sunulur; dış QR hizmeti kullanılmaz.

İlk e-posta şablonu onaylı **tam $30 + üç kendi kanal** koşulunu anlatır. Bu ilk sürümün işleyicisi farklı eşik veya kanal alt kümesini sağlayıcıya göndermeden reddeder; kampanya ayarı ile e-posta vaadi çelişmez. Başka koşullu kampanya için ayrıca ona uygun şablon/işleyici kabulü gerekir.

**202 = event kabulü, gönderilmiş email değil.** Outbox `provider_accepted`; K6 `unknown` ile güvenli biçimde kapatılır ve belirsiz gönderim penceresi açılmaz. **Mevcut K6 terminal unknown kaydı yalnız 168 saat geçmesiyle çözülmez; sonraki pazarlama mesajlarını da engeller.** Sent Email sağlayıcı kanıtı ve ayrıca incelenmiş çözüm/reconciliation yolu olmadan canlı Welcome açılmaz (`activationReady=false`). Timeout/kayıp yanıt `unknown`, yeni unique_id/otomatik tekrar yok. Kanıtsız `sent` veya uydurma sağlayıcı korelasyonu yoktur. Native asenkron flow’da DB kararı ile gerçek email gönderimi atomik değildir. Bu teslimde gerçek hesap/profil/event/email yazısı ve flow aktivasyonu yok; hazır Draft yapılandırma/şablon ve sentetik kapı kanıtı teslimdir.

## 6. Sentetik kabul ve sıra

Gerçek PostgreSQL: doğrulanmış onay→bir kupon/outbox; onaysız/kanıtsız/negatif kayıt→yok; mevcut kanıtlı abone telafisi; tekrar onay→aynı kupon; null ve kaynaklı sipariş; 3000 dahil/2999 ret; üç kendi kanal; ikinci kullanım; aynı fiş/sipariş iki kupon; yanlış işletme/legacy/platform-only 403; iki backend redeem→biri; iade eski K9 yolundan dahi hakkı açmaz. K6 167/169 saat ve negatif son kontrol; yalnız sentetik event; 202≠sent; belirsiz sonuç yeniden gönderilmez. Production form/Auth/GA4/K5 parity.

Yeni ileri migration adı **`20261021000800_signup_reward_coupons.sql`**, önceki dosyalar değiştirilmez. Koordinasyon için **sıra 14** ayrılır; önceki 12 (#72) ve 13 (#73) değişmez. Uygulama hücreleri boş kalır; iki ortamda aynı LF/SHA/psql, önce test. Canlı kampanya/flow, ürün/kanal eşlemesi ve gerçek gönderim kabulü Talip’te; sentetik teslim bu işletme etkinleştirmesi sayılmaz.

## 7. Anatolia emsali — Nazar uyarlaması (Talip’in sözleşme eki)

Talip’in aktardığı Anatolia spec 06 §13 (M-9) emsali: eski sitedeki **Founding Members** kayıt sayfası → n8n **FM Signup → Code Pipeline** → kişiye özel kod → e-posta. Bu emsalin kayıt, tek kullanım ve indirim izleme ilkeleri alınır; Anatolia hesabı veya spec’i bu çalışma kapsamında ayrıca incelenmiş sayılmaz.

1. **Kayıtla hak kazanma / n8n yok:** Nazar’da basılı kartın QR’si site VIP formuna götürür. Çift onay tamamlandığında kod, signup/consent akışının sonunda Supabase tarafında üretilir. Kişisel kupon QR’si basılı kayıt QR’sinden ayrıdır. E-posta mevcut K6/Klaviyo yolundan gider; n8n eklenmez.
2. **Liste fiyatı korunur:** Kupon kodu ile uygulanan indirim siparişte ayrı izlenir. Clover’da simit satırına **%100 indirim ayrı indirim kalemi** olarak uygulanır; ürünün liste fiyatı değiştirilmez.
3. **Kullanım kanıtı:** Kaynakta erişilen Clover sipariş kimliği, ilgili simit satırı, indirim kalemi referansı ve uygulanan indirim tutarı redeem kanıtına bağlanır. K7 çekiminde ilgili indirim satırı kupon/siparişle eşleştirilebiliyorsa otomatik eşleşme kullanılır; görünmüyorsa **personel işareti tek kullanım kaynağıdır**. İkisi aynı kullanımı iki kez saymaz. Mevcut NULL Clover kimlikli personel beyanı yolu kaldırılmaz; bulunmayan kimlik veya tutar uydurulmaz, eksik bağlantı açık gösterilir.
4. **Aylık görünürlük / komisyon aynı:** Ops/finans aylık özetinde ve K13 karşılaştırma ekranında **“Kupon kullanımları ve indirim tutarı”** bilgi satırı bulunur. Kupon maliyeti **müşteri edinim maliyeti — kayıtlı istisna** olarak sınıflanır. Komisyon formülü değişmez: Clover net satışı indirimi zaten düşer; bilgi satırı ikinci bir indirim/komisyon kesintisi yaratmaz. Bilinmeyen tutar sıfır sayılmaz; doğrulanmış tutarla personel beyanı ayrılır.
5. **Müşteri başına bir kez:** Bu signup_reward kampanyasında mevcut bir kupon/bir kullanım sınırı aynen kalır; başka kanaldan sipariş ikinci hak doğurmaz.

**Bu ek yalnız sözleşme güncellemesidir.** İndirim referansı/tutarının doğrulanması ve otomatik eşleştirilmesi ile K13 aylık bilgi satırı mevcut #77 kodunda henüz uygulanmış değildir. Bugünkü `clover_verified` etiketi sipariş/tutar/kanal kanıtıdır; kuponun Clover indirim satırının doğrulandığı anlamına gelmez. RPC imzaları, migration/SHA, gönderim kapısı ve komisyon hesabı bu ekle değiştirilmez; yeni uygulama işi başlatılmaz.
