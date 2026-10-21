# K10 — çift onay köprüsü ve Draft hoş geldin hazırlığı

Bu teslim provider hesabına yazmaz, flow açmaz, timer veya otomatik tetik kurmaz. Yeni `/api/internal/coupon-welcome` yolu varsayılan kapalıdır; açık personel sayfası veya public form bu yolu çağırmaz. Salt okunur sağlayıcı kanıtını alan `confirm` komutu ile outbox işleyen `welcome` komutu ayrı, kimliği doğrulanmış makine çağrılarıdır. Gerçek çalışan onay tetik bağlantısı ve gönderim kabulü etkinleştirme öncesi kurulup ayrıca kanıtlanmalıdır.

## Ortam adları — değerler bu belgeye yazılmaz

Production adları aşağıdadır; izole Preview aynı adların **TEST_** önekli biçimini kullanır. Mevcut `APP_ENV`, `TEST_SUPABASE_URL`, `TEST_BUSINESS_ID`, `TEST_SUPABASE_SECRET_KEY` izolasyonu korunur; Preview'da Production'a geri dönüş yoktur.

| Ad | Amaç |
|---|---|
| `COUPON_PROCESS_ENABLED` | Yalnız tam `true` işleyiciyi açmaya adaydır; eksik/false kapalı. |
| `COUPON_PROCESS_MODE` | Production `live`; izole Preview `mock`. Varsayılan `disabled`. |
| `COUPON_PROCESS_KEY` | Ayrı, en az 32 rastgele URL-safe karakterli makine anahtarı; browser'a konmaz. |
| `COUPON_KLAVIYO_ACCOUNT_ID` | İki anahtarın da salt okunur Accounts yanıtında birebir eşleşmesi gereken hesap. |
| `COUPON_KLAVIYO_READ_KEY` | Ayrı anahtar; `accounts:read`, `profiles:read`, `lists:read`. |
| `COUPON_KLAVIYO_EVENT_KEY` | Farklı anahtar; yalnız `accounts:read`, `events:write`. Profil/izin yazma kapsamı verilmez. |
| `COUPON_KLAVIYO_RECEIPT_KEY` | Ayrı salt okunur anahtar: `accounts:read`, `events:read`, `metrics:read`. Live için zorunlu; event yazma anahtarıyla aynı olamaz. |
| `COUPON_QR_ORIGIN` | Güvenilir kendi HTTPS origin'i; QR resmi `/api/coupon-qr/<128-bit-opaque-token>.gif`. |
| `COUPON_QR_ENABLED` | QR resim yolu yalnız tam `true` ile açılır; eksik/false kapalı. Preview adı `TEST_COUPON_QR_ENABLED`. Resim okumak kupon kullanmaz. |
| `COUPON_LIVE_APPROVAL_ID` | Canlı işleme için açık kabul kaydının kimliği; eksikse kapalı. |

Supabase bağlantısı mevcut ortam çözümleyicisinden gelir. Anahtarlar server-only'dir. HTTP hata yanıtları hesap kişisi, kupon, kod, email veya sağlayıcı hata gövdesi içermez. Mock HTTP adaptörü pozitif izin uydurmaz; kanıt yokken kapalı kalır. Happy-path sentetik adaptör test dosyasına enjekte edilir; bu gerçek doğrulanmış müşterinin yerine geçmez.

İlk email şablonu yalnız onaylı **3000 cent eşik + üç kendi kanalın tamamı** için hazırlanmıştır. SQL daha yüksek eşik/kanal alt kümesi kabul edebilse de bu adapter o kuponlarda provider çağrısından önce kapanır; farklı şartlar için farklı, gözden geçirilmiş şablon gerekir. Email açıkça **sonraki** uygun sipariş der. Fiziksel adres uydurulmaz: `{{ organization.full_address }}` Klaviyo'nun yapılandırılmış işletme adresinden gelir ve kabul öncesi denetlenir ([resmi kişiselleştirme etiketleri](https://help.klaviyo.com/hc/en-us/articles/4408802648731)).

## Dar makine istekleri

Yalnız JSON POST, `Authorization: Bearer <COUPON_PROCESS_KEY>`, `Origin` başlığı olmadan. Gövdeler tam bu alanlarla sınırlıdır; işletme yapılandırılmış işletmeyle aynı olmalıdır. Bunlar çalıştırma talimatı değil, entegrasyon sözleşmesidir; gizli değer terminal komutuna yazılmaz.

```json
{"action":"confirm","businessId":"<uuid>","customerId":"<uuid>","signupId":"<uuid>"}
```

Sunucu özel RPC'den güncel email, yerel VIP talebi ve ayarlı listeyi okur. Provider hesabını, listenin double opt-in ayarını, exact email ve profile/list üyeliğini; `SUBSCRIBED`, `can_receive_email_marketing=true`, `double_optin=true`, tarihli ve kayıt talebinden sonraki consent'i doğrular. Negatif/eksik/kararsız sonuç rıza oluşturmaz. DB kanıtı tekrar denetler; K4 unsubscribe/suppression koruması aşılmaz. Onay + kupon + outbox DB transaction'ında; ağ çağrısı trigger içinde yoktur.

```json
{"action":"welcome","businessId":"<uuid>","couponId":"<uuid veya null>"}
```

Outbox claim → K6 reserve/claim → her iki anahtarın hesap kontrolü + sağlayıcı güncel izin okuması → son outbox context → K6 tüketilen context → **tek event POST**. K6 son context'ten önce güncel negatif sağlayıcı sonucu yerel güvenli negatif RPC'ye işlenir ve gönderim engellenir. Olaya yalnız email kimliği ve değişmez kupon snapshot'ı yazılır. Profil, abonelik, liste üyeliği, suppression veya flow yazısı yoktur. Önceki public VIP çift onay isteği bu modüle taşınmaz.

## Gönderim kanıtı ve etkinleştirme engeli

**202 = olay kabul edildi; e-posta gönderildi anlamına gelmez.** Outbox `provider_accepted`; K6 `unknown` olur. Dönen sonuç `activationReady:false`, `pending_delivery_receipt_reconciliation` taşır. Timeout, kayıp yanıt, hatalı receipt veya sağlayıcı hatasında otomatik ikinci gönderim yoktur. Sabit `unique_id` ve kupon/message tekillikleri korunur.

Yeni ileri migration 14a önerisi, immutable K6 geçmişini koruyup ek kanıt tabloları getirir. Live dispatch öncesinde gözden geçirilmiş kapalı varsayılan ayar ve kişi/flow/message için tek kalıcı eşleme gerekir; setup yoksa K6 rezervasyonu ve provider POST yapılmaz. Yeni dar `reconcile` komutu native **Received Email** metriğini GET ile okur: hesap, orijinal provider profil ID, metric ID, flow ID, message ID ve dispatch sonrası tarih eşleşmeli; tek sonuç ve tamamlanmış sayfa gerekir. Özel tetik olayının `unique_id` değerinin teslimata taşındığı varsayılmaz. Başarılı kanıtın özeti/ID/tarihi ayrı tabloya yazılır; `message_log` unknown satırı değişmez. 168 saat gerçek teslimat tarihinden hesaplanır. `activationReady:true` ancak canlı GET eşleşmesi, DB acknowledgement ve halen açık güncel yerel kapılarla döner; flow'u kendiliğinden açmaz.

`{"action":"reconcile","businessId":"<ayar>","couponId":"<uuid>"}` aynı maskeli makine kimliğiyle çağrılır; farklı işletme/browser Origin ve ek alanlar reddedilir. Reader yalnız Accounts/Metric/Events GET yapar; profil/abonelik/suppression/event yazısı yoktur. Bu komut yeni gönderim başlatmaz. Okuma/ack kaybı veya boş/ambiguous/sayfası eksik sonuç bekler; ikinci event POST yapılmaz.

Gönderilmediği ve sağlayıcı kuyruğunun kapandığı dış kanıtla doğrulanırsa, yalnız aktif platform operatörü + işletme üyeliği olan Talip `coupon_review_not_sent_v1` ile immutable inceleme kaydı bırakabilir. Kanıt referansı ve SHA gerekir; boş event sonucu kanıt sayılmaz. Sonrasında da tenant'ın 168 saatlik muhafazakâr beklemesi vardır. Sonradan gerçek teslimat gelirse onun sınırı uygulanır. Böylece kanıtla çözülmüş unknown süresiz kilit olmaz; kanıtsız belirsizlik otomatik silinmez. Ayrıntı: [Talip adımları](Talip_Klaviyo_Akis_Kurulumu.md).

## Talip'in etkinleştirme öncesi kontrol sırası

1. Aynı ileri migration'ı testte uygulayıp DOI/kupon/K6 ve kasa sentetik kabulünü tamamla; Production uygulaması ayrı kabul.
2. Kaynak hesap/liste, doğru ürün, kendi kanal eşlemeleri ve gerçek DOI kanıtını okuyan güvenilir `confirm` tetik bağlantısını doğrula; mevcut kanıtlı müşteriler için issuer idempotent telafi kullanır.
3. M14a ileri migration ve receipt ayar/anahtarını Sandbox'ta kabul et; sonra ayrı Production kararı. Gönderim eşleştirmesinin gerçek provider kabulü olmadan flow açılmaz. Başlatıcılar `tools/test-env/coupon-delivery/` altında; sıra 14a öneridir.
4. `welcome-flow-draft.json` içindeki ayarları mevcut **Nazar VIP — Welcome** taslağına geçir: özel metric tetik, liste/segment tetik yok; tek gecikmesiz email, yeniden giriş yok. Her email'in Draft olduğu ayrıca kontrol edilir. Bu JSON resmi Flow API import payload'u değildir.
5. HTML/text şablonunu, gönderici alanını ve zorunlu şirket altbilgisini Klaviyo'da denetle. QR GIF kendi altyapısından gelir; `COUPON_QR_ENABLED=true` yalnız doğru ortamda ayrıca ayarlanır ve resim yüklenmesi salt okunur kanıtlanır. Kod okunabilir metin olarak da bulunur. Harici QR servisi ve analitik takibi yoktur.
6. Flow dışındaki campaign/flow yollarının K6'yı aşmadığını doğrula; ayrı onaylı gerçek kabulden sonra yalnız Talip etkinleştirir. Kartlar ancak bundan sonra dağıtılır.

Resmi dayanaklar: [DOI veri alanları](https://developers.klaviyo.com/en/v2026-01-15/docs/collect_email_and_sms_consent_via_api), [Events API/idempotency](https://developers.klaviyo.com/en/reference/events_api_overview), [GET List](https://developers.klaviyo.com/en/reference/get_list), [Draft ve gönderim durumları](https://help.klaviyo.com/hc/en-us/articles/115002774932), [akış filtreleri](https://help.klaviyo.com/hc/en-us/articles/115002779051). `opt_in_process` normal liste alanıdır; `additional-fields[list]` yalnız `profile_count` içindir. Alan dönmezse DOI varsayılmaz.
