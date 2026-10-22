# DOI → kişisel kupon — sıra 19, varsayılan kapalı

Bu PR yalnız onayın DB'ye güvenilir aktarımını tamamlar; Welcome göndermez, cron/polling kurmaz, consent/suppression API'sine yazmaz. Ayrı **Nazar VIP — DOI → Kupon** Flow'u tek webhook adımı içerir. Mevcut **Nazar VIP — Welcome** yalnız K6'dan geçmiş özel mesaj olayıyla çalışır; DOI Flow'una email konmaz.

## Free plan için belge dayanağı (22 Ekim 2026)

Nazar hesabının Free olduğu Talip'in verdiği bilgidir; bu PR hesap/Billing ayarı okumaz veya değiştirmez. Standart **Flow webhook** yolu kullanılır:

- [Klaviyo Free plan açıklaması](https://www.klaviyo.com/pricing): Free plan FAQ, otomasyon kurulabildiğini belirtir; gönderim/profil limitleri ayrıca geçerlidir.
- [Free'a geçiş açıklaması](https://help.klaviyo.com/hc/en-us/articles/1260805595309): Free'a geçiş özellikleri açık tutar; örnek olarak Flow'ların çalışması açıklanır. Bu, iptal edilmiş hesapla aynı durum değildir.
- [Webhook türleri](https://help.klaviyo.com/hc/en-us/articles/18622300908955): ücretli **Advanced KDP webhook / Code** ayrı özelliktir; standart Flow webhook, Flow action'ıdır.
- [Flow webhook kurulum şartları](https://developers.klaviyo.com/en/docs/how_to_add_a_webhook_action_to_a_flow): Manager/Admin/Owner ve MFA gerekir; Advanced KDP aboneliği şartı bu Flow yolu için yoktur. Custom Authorization header ve otomatik X-Klaviyo-Flow-ID desteklenir.

**Belge değerlendirmesi:** Free'ın standart Flow otomasyonu + Flow webhook adımı bu kurulumun yoludur; Advanced KDP satın alınmaz. Kaynaklar birlikte değerlendirilmiştir; resmî belgede tek başına “Free Flow webhook” isimli bir fiyat satırı olduğu iddia edilmez. Hesaba özel eski/kapalı plan veya yetki istisnası canlı arayüzde denenmedi. Talip'in kurulum adımında webhook kartı kilitli/Upgrade isterse **kaydetme, ödeme/plan değiştirme, bildirim ver**. Bu PR'ın webhook'u email/SMS göndermediği için kendi başına gönderim kotası tüketen bir mesaj açmaz; DOI emaili ve sonraki Welcome'ın mevcut kotaları yine geçerlidir.

## Yol ve güvenlik

`POST /api/webhooks/vip-doi`, HTTPS, redirect olmadan; server-only ayrı `Authorization: Bearer <VIP_DOI_WEBHOOK_KEY>`, exact `X-Klaviyo-Flow-ID`. Body yalnız:

```json
{"version":1,"email":"<normalized profile email>","listId":"<configured VIP list>"}
```

Webhook rıza kanıtı değildir. Hedef business/db/account/list env'den gelir. Yerel exact email için **tek** gerçek VIP signup eşleşir; yanlış işletme, test kayıtları ve belirsiz geçmiş reddedilir. Mevcut `confirmCouponVip` dört GET ile hesap, double-opt-in liste, exact profil/güncel izin/tarihli DOI ve liste üyeliğini okur. Son kayıt çağrısı yeni dar wrapper'dan mevcut `coupon_record_confirmed_vip_v1` fonksiyonuna gider. Mevcut K4 engelleri, trigger ve UNIQUE(campaign,customer) korunur; kanıt, kupon/outbox ve webhook receipt aynı transaction'da yazılır. Tekrarda 2. kupon yoktur. Unsubscribe/suppression kaldırılmaz.

200 + `confirmation_recorded`: güvenilir kanıt DB tarafından kaydedildi; email gönderildi veya kampanya aktif diye okunmaz (aktif uygun kampanya yoksa kupon sayısı 0 olabilir). 200 + unmatched/ambiguous/blocked: kalıcı iş reddi, güvenli audit kaydı. 503: DB/API/kanıt henüz doğrulanmadı, başarı ACK verilmez. [Klaviyo tekrar davranışı](https://developers.klaviyo.com/en/docs/understanding_webhook_status_codes) aynı işlemi tekrar teslim edebilir; bu polling değildir. Sonsuz scheduler/retry eklenmedi. Retry bütçesi bittiğinde Talip hata kaydını inceler; sonuç kaybında yeni müşteri veya kupon yaratılmaz.

Raw body/email, anahtar, profil cevabı ve kupon kodu log/receipt'e konmaz. Private audit yalnız hash, güvenli durum/kod ve zaman içerir. `X-Klaviyo-Flow-ID` tek başına kimlik doğrulaması değildir; ayrı bearer ve API readback gereklidir. System webhook HMAC başlıklarının Flow webhook'ta bulunduğu varsayılmaz.

## Sunucu ayarları — Talip girer

Production Cloudflare `nazar-restaurant-website / Production`; izole hedefte aynı adların **TEST_** öneki (mevcut APP_ENV/TEST_SUPABASE izolasyonu korunur):

| Ad | Tür / kaynak |
|---|---|
| `VIP_DOI_ENABLED` | Text, ilk kurulum **false**; yalnız kabul sonrası true |
| `VIP_DOI_MODE` | Text, Production live; izole hedef yalnız mock; eksikse kapalı |
| `VIP_DOI_WEBHOOK_KEY` | Secret; ayrı 32–200 URL-safe rastgele karakter, yalnız Talip oluşturur/kaydeder |
| `VIP_DOI_FLOW_ID` | Text; yalnız DOI Flow URL'sindeki ID; Welcome ID'si değil |
| `VIP_DOI_LIST_ID` | Text; mevcut çift onaylı VIP listesinin ID'si; source/browser listedeki hedefle eşleşmeli |
| `VIP_DOI_APPROVAL_ID` | Text; Production için Talip'in gerçek tarihli kabul referansı, 8–120 karakter `A-Za-z0-9_.:-` |
| `COUPON_KLAVIYO_ACCOUNT_ID` | Mevcut Nazar hesap ID'si; API Accounts readback ile exact eşleşir |
| `COUPON_KLAVIYO_READ_KEY` | Mevcut ayrı read-only key: Accounts/Profiles/Lists Read; yeni event/profil/abonelik yazma scope'u verilmez |

Mevcut hedef Supabase server secret kullanılır. Event key, QR key, K6 gönderim anahtarı bu alıcı için gerekmez. Welcome'ın ayarları değişmez. Değerler VITE/browser veya Git'e konmaz.

## Test ve uygulama sırası

K16 #90 / **sıra 18 önce**, bu migration **sıra 19 sonra**, aynı hedef başarı kaydıyla. Uygulanmış SQL'ler değişmez. Yeni SQL: `20261022000200_vip_doi_webhook.sql`. İki private audit tablosu, üç service-only RPC; yeni rıza/kupon trigger'ı veya cron yok. Sıra numarası K16 önce hazır olduğu için bu şekilde ayrıldı; #90'ın SQL'i bu PR'a canonical migration olarak kopyalanmaz. Test fixture'ı aynı pinli baytların ayrı, local-only kopyasıdır.

Yerel gerçek PostgreSQL 18.6 + taklit sağlayıcıyla HTTP alıcı→mevcut doğrulayıcı→SQL zinciri test edilir; yerel unmarked sentetik kayıtlar canlıya taşınmaz. **Hosted mock pozitif DOI uydurmaz**: Sandbox alıcı yanlış/eksik kimliği ve şemayı reddeder; gerçek API yokken 503 verir. Eski SQL ile sentetik onay kuru testi DB üretimini gösterebilir, gerçek Flow/DOI teslimi kabulü sayılmaz. Gerçek Klaviyo akışı için Talip'in ayrı tek kişi kabulü gerekir; bu PR'da hesapta Flow oluşturma/Live, email, gerçek profil yazısı veya hosted migration yapılmaz.

Talip'in tıklama adımları: [Flow kurulum belgesi, bölüm 6](Talip_Klaviyo_Akis_Kurulumu.md#6-doi--kupon-ayrı-flow-webhook--22-ekim-2026).

Kapatma: yalnız DOI webhook kartını **Draft** yap; Cloudflare `VIP_DOI_ENABLED=false`, güncel onaylı sürümü yeniden dağıt. DB kanıt/kupon/audit geçmişi silinmez, SQL geri alınmaz. Mevcut Welcome/K6 kararları ayrı kalır.
