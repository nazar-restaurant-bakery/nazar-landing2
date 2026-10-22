# K10 — DOI → kişisel kupon teslimi · 22 Ekim 2026

**Draft PR: bağlantı hazırlanıyor; hedef main**, taban `0ff9496` (#87/#88). Klaviyo Flow webhook → dar Cloudflare alıcı → mevcut `confirmCouponVip` salt okunur DOI kanıtı → mevcut onay RPC/trigger → tek kişisel kupon. Yeni alıcı **email/event gönderemez**. Welcome/K6, public form, staff, GA4 ve günlük zamanlayıcı davranışı korunur. Varsayılan kapalı; Flow oluşturma/Live, anahtar, dağıtım ve hosted SQL yapılmadı.

**Free plan:** [Free otomasyon](https://www.klaviyo.com/pricing), [Free'da Flow özellikleri](https://help.klaviyo.com/hc/en-us/articles/1260805595309), [standart Flow / ücretli KDP ayrımı](https://help.klaviyo.com/hc/en-us/articles/18622300908955) ve [Flow webhook şartları](https://developers.klaviyo.com/en/docs/how_to_add_a_webhook_action_to_a_flow) birlikte belgelendi. Flow yolu için Advanced KDP satın alınmaz; MFA ve Owner/Admin/Manager gerekir. Hesaba özel kart/plan erişimi UI'da bu teslimde denenmedi; Upgrade görülürse kurulum durur, ücret onayı varsayılmaz. Kaynak değerlendirmesi `docs/coupons/doi-flow-webhook.md` içinde; tek bir resmî “Free Flow webhook” fiyat satırı uydurulmadı.

**Migration sıra 19:** `20261022000200_vip_doi_webhook.sql`, LF, SHA256 `863dd37b0a8a39840747607f638f43bd8d700f3d4944373114304e34712e71a5`. İki private append-only audit/receipt tablosu + üç service-only RPC; suppression kaldırma, yeni izin/kupon trigger'ı veya cron yok. K16 #90 önce hazır olduğundan **sıra 18 önkoşul**; canonical K16 SQL'i bu PR'a alınmadı. Yerel test fixture'ı pinli aynı baytlardır. Main'de eksik 15/16/17 envanteri de kaynak SQL değiştirilmeden kaydedildi.

**Kanıt:** 128/128 hedefli Node; gerçek yerel PostgreSQL18.6 üzerinde 11/11 senaryo (iki eşzamanlı çağrı→bir kupon/receipt; onaysızlık/ret/yanlış işletme/RLS; değişmemiş eski issuer); başlatıcı negatif/çevrimdışı testleri 26/26, ön/son katalog 4/28. TypeScript ve hedefli ESLint geçti. Production env: APP_ENV/TEST_* yok; iki build başarılı, **209/213 bayt aynı; yalnız üç asset adı ve literal referansları normalize edilince 213/213 aynı**. Form/staff/GA4/K5/K6/Welcome/scheduler kaynakları değişmedi. Ayrıntı `K10_DOI_Webhook_kanit/`.

**Talip sırası:** #90 + sıra18 aynı hedefte kabul → bu Draft inceleme/kabul → sıra19 Sandbox kurulumu → Sandbox kuru test → ayrı Production migration/dağıtım ve tek gerçek DOI kabulü. Flow adımları `K10_Talip_Klaviyo_Akis_Kurulumu.md` bölüm6'ya ve repo `docs/coupons/Talip_Klaviyo_Akis_Kurulumu.md` bölüm6'ya eklendi. Hosted mock olumlu DOI uydurmaz; yerel enjekte edilmiş sağlayıcı kanıtı gerçek email/Flow kabulü değildir. Welcome Live ayrı karardır. Polling yok. Açık karar sorusu yok.

**Başlatıcılar (yerel teslim):**

- `C:\Users\Talip\Nazar Restaurant & Bakery growth plan\20_Yonetim\Teslim_Raporlari\VipDoiWebhook_kanit\Start-VipDoiWebhook-Sandbox.ps1`
- `C:\Users\Talip\Nazar Restaurant & Bakery growth plan\20_Yonetim\Teslim_Raporlari\VipDoiWebhook_kanit\Start-VipDoiWebhook-Production.ps1`

İkisi de şu an **WAITING**: sıra18 gerçek kayıtları beklenir; Production ayrıca kendi sıra19 Sandbox kaydını ister. Gerçek başarı kaydı üretilmedi. SHA/LF/psql18.6/CA/TLS/maskeli parola K7 kalıbı korunur. Bu dosya kalemi veya canlı DOI bağlantısını kapanmış saymaz; PR ve kurulum kararı Talip'tedir.
