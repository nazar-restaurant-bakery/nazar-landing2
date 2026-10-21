# K10 — Sandbox uçtan uca kuru test (Talip)

21 Ekim 2026 · Kaynak: main `4123b23` (#78 dahil), K10_Kampanya_Kararlari.md ve K10_Kupon_Sozlesme.md. **Bu belge tarif; hosted test yapılmadı.** Talip çalıştırır. Production, Klaviyo hesabı, gerçek e-posta ve Clover POS üzerinde işlem yok. Yeni migration veya rol değişikliği yok.

## 1. Doğru site ve oturum

1. [Sandbox Cloudflare Pages projesini](https://dash.cloudflare.com/50a358ead900374fd545df744bd28bef/pages/view/nazar-catering-sandbox) aç → **Deployments** → sandbox dağıtımı → **Visit site**. Sandbox site adresi [https://nazar-catering-sandbox.pages.dev](https://nazar-catering-sandbox.pages.dev); aşağıda `SANDBOX_SITE` bunu ifade eder. Dağıtım #78 ve bu Ops düzeltmesinin birleşmiş kodunu içermeli. Eski `9c1d7257` form kanıtı yeni kasa/Personel ekranı dağıtımı değildir. Pages projesinin kendi Production/Preview etiketini gerçek müşteri Production ortamıyla karıştırma: bu projenin her bağlamı yalnız sandbox'a yönlenmeli.
2. Bu sandbox dağıtımına uygulanan **Settings → Variables and Secrets** bölümünde yalnız okuyarak hedefi kontrol et: browser `VITE_APP_ENV=isolated-test`, `VITE_TEST_SUPABASE_URL=https://uxiseddbeszklkrvysxf.supabase.co`, `VITE_TEST_BUSINESS_ID`; server `APP_ENV=isolated-test`, `TEST_SUPABASE_URL` aynı, `TEST_BUSINESS_ID` aynı UUID. Sandbox publishable/secret ve test Turnstile ayarları K3 tarifindeki gibi hazır olmalı. Değerleri sohbete kopyalama; Production değişkenlerini taşıma.
3. `SANDBOX_SITE/staff` aç → kendi **sandbox** personel hesabınla giriş yap. **Kupon**, **Personel**, **Ops** görünmeli. Auth e-posta bağlantısı yerine mevcut parola girişini kullan; bu test için yeni Auth kullanıcısı/davet açma. Giriş/403/eksik ekran varsa dur; yanlış projeye geçerek aşma. Eski K3 belgesindeki Preview staff kapalı bilgisi tarihsel; güncel `getStaffSupabase()` yapılandırılmış sandbox client'ını kullanır. Harici sağlayıcı rotaları yine kapalı kalır.
4. [Sandbox SQL Editor](https://supabase.com/dashboard/project/uxiseddbeszklkrvysxf/sql/new) aç → proje adını/URL ref'ini kontrol et → **New query**. Şu salt okunur sorguyu **Run** ile çalıştır:

```sql
SELECT declared_project_ref FROM core.installation;
SELECT id,name FROM core.businesses ORDER BY id;
-- BUSINESS_UUID: Preview ayarındaki test işletmesi
SELECT 'scheduler' AS gate,enabled FROM core.daily_scheduler_settings WHERE business_id='BUSINESS_UUID'
UNION ALL SELECT 'coupon_delivery',enabled FROM core.coupon_delivery_settings WHERE business_id='BUSINESS_UUID'
UNION ALL SELECT 'message_send',enabled FROM core.message_send_settings WHERE business_id='BUSINESS_UUID';
```

Beklenen kurulum ref'i yalnız `uxiseddbeszklkrvysxf`; işletme UUID'si Preview'daki iki business ayarıyla aynı. Etkinleştirme sorgusunda satır olmaması veya enabled=false beklenir; true varsa otomatik iş/gönderim durumu önce ayrı incelensin, bu provaya başlama. Boş/çelişkili kurulum ref’i varsa dur; bu tarif kurulum kaydını veya personel rolünü düzeltmez. Aşağıdaki SQL'lerde `BUSINESS_UUID` yerine bu UUID'yi yaz. Her yazma bloğu installation guard ile yanlış kurulumu reddeder; guard'ı kaldırma.

## 2. SIMIT / kanal ayarı ve yalnız sentetik kampanya

**Teklifler ekranında bu ayarları düzenleyen form yok.** Sandbox SQL Editor'da aşağıdaki hazırlık bloğunu çalıştır. Yalnız `is_test=true` yeni bir teklif/kampanya açar; mevcut kampanyayı değiştirmez. Aynı isim veya bu işletmede başka aktif test signup_reward varsa işlem durur; mevcut kayıtları silerek/kuralları gevşeterek devam etme. Yeni deneme için benzersiz bir kampanya adı ve iki yeni `.invalid` adresini belge boyunca birlikte değiştir.

Ürün adı **SIMIT**, fayda 1 sade simit, liste fiyatı $2.49; eşik vergi/bahşiş hariç $30; kişi başı kampanya boyunca 1, sipariş başı 1; açık bitiş; iade ile hak geri gelmez. `target_clover_item_id` **isim değil Clover ürün ID'sidir**. Gerçek sandbox katalog eşlemesi varsa SIMIT'in ID'sini; `order_type_ids` ve `coupon_order_type_map` içine sandbox dine-in / kendi site pickup / kendi site delivery type ID'lerini gir. İsimden ID tahmin etme; Production katalog ID'sini kopyalama. Marketplace türleri eşlenmez. Karar dosyasında marketplace hariçliği Talip teyidi bekleyen not olarak duruyor; canlı açılışta teyit edilir.

Aşağıdaki `K10SIMIT01`, `K10DINE001`, `K10PICK001`, `K10DELV001` **uydurulmuş açık sentetik fixture ID'leridir**; bu provadaki Clover no boş/personel beyanı yolu içindir. Clover kataloğuna bağlandığını kanıtlamaz ve Clover'da ürün/sipariş oluşturmaz. Gerçek ID'lerle prova istenirse bunları **kupon oluşmadan önce** değiştir; ilk kupondan sonra ürün/kanal vaadi kilitlenir. `SYNTHETIC_VIP_K10` da gerçek Klaviyo listesi değildir.

```sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $dryrun$
DECLARE b uuid := 'BUSINESS_UUID'; o uuid := gen_random_uuid();
BEGIN
 IF (SELECT count(*) FROM core.installation)<>1 OR
    (SELECT declared_project_ref FROM core.installation LIMIT 1) IS DISTINCT FROM 'uxiseddbeszklkrvysxf'
 THEN RAISE EXCEPTION 'SANDBOX_ONLY'; END IF;
 IF NOT EXISTS(SELECT 1 FROM core.businesses WHERE id=b) THEN RAISE EXCEPTION 'BUSINESS_NOT_FOUND'; END IF;
 IF EXISTS(SELECT 1 FROM core.campaigns WHERE name='INTERNAL TEST K10 DRY RUN 20261021') OR
    EXISTS(SELECT 1 FROM core.campaigns WHERE business_id=b AND is_test AND campaign_kind='signup_reward' AND status='active')
 THEN RAISE EXCEPTION 'EXISTING_TEST_CAMPAIGN_REVIEW_REQUIRED'; END IF;
 INSERT INTO core.offers(id,business_id,name,starts_at,ends_at,active,is_test)
 VALUES(o,b,'INTERNAL TEST K10 DRY RUN 20261021',current_date-1,current_date+30,true,true);
 INSERT INTO core.campaigns(business_id,offer_id,name,benefit_type,target_clover_item_id,benefit_code,
 min_amount_cents,include_tax,include_tip,order_type_ids,starts_at,ends_at,tz_name,eligibility,
 max_units_per_order,period,max_total_units,status,is_test,campaign_kind,coupon_channels,coupon_order_type_map,vip_list_id)
 VALUES(b,o,'INTERNAL TEST K10 DRY RUN 20261021','item','K10SIMIT01','SIMIT',
 3000,false,false,ARRAY['K10DINE001','K10PICK001','K10DELV001'],clock_timestamp()-interval '1 hour',NULL,'America/New_York','subscribed_only',
 1,'campaign',NULL,'active',true,'signup_reward',ARRAY['dine_in','site_pickup','site_delivery'],
 '{"K10DINE001":"dine_in","K10PICK001":"site_pickup","K10DELV001":"site_delivery"}'::jsonb,'SYNTHETIC_VIP_K10');
END $dryrun$;
COMMIT;
```

Beklenen **Success**; bu yalnız sandbox test kampanyasını aktifleştirir, gerçek kampanya/gönderim açılmaz. SQL hata verirse transaction geri alınır; **ROLLBACK** çalıştır, hata adını bildir ve dur. Gerçek e-posta akışını/worker'ı/scheduler'ı etkinleştirme; hiçbir provider key gerekmez. Test kuponları welcome context'te reddedilir.

## 3. Kart QR'si → VIP formu (iki sentetik kişi)

1. Telefonla sandbox kayıt kartının QR'sini okut. QR hedefi tam `SANDBOX_SITE/vip` olmalı; canlı alan adına gidiyorsa gönderme. Kart QR'si yoksa aynı adresi elle aç; rapora **QR yönlendirmesi denenmedi, form elle açıldı** yaz. Kayıt QR'si ile kişisel kupon QR'si farklıdır.
2. Formda ad **INTERNAL TEST K10 A**, e-posta **k10-dryrun-a-20261021@nazar-test.invalid** gir; telefon isteğe bağlıysa boş bırak; e-posta izin kutusunu işaretle → formun kayıt düğmesine **bir kez** bas.
3. Beklenen: **Internal test saved. No marketing subscription or confirmation email was requested.** Bu başarı onay/kupon anlamına gelmez. Gerçek mailbox açma veya e-posta bekleme. Hata/timeout varsa tekrar tekrar gönderme; aşağıdaki okuma ile kayıt oluştu mu bak.
4. Aynı işlemi yeni formda **INTERNAL TEST K10 B**, **k10-dryrun-b-20261021@nazar-test.invalid** ile yap. B, $30 altı red ve üç kanal kontrolü için kullanılmamış kupondur.
5. SQL Editor'da oku:

```sql
SELECT c.email,c.is_test,c.email_status,s.source,s.consent_email,s.is_test AS signup_is_test,
       (SELECT count(*) FROM core.campaign_coupons cp WHERE cp.customer_id=c.id) AS coupons
FROM core.customers c JOIN core.signups s ON s.customer_id=c.id AND s.business_id=c.business_id
WHERE c.business_id='BUSINESS_UUID' AND c.email IN
 ('k10-dryrun-a-20261021@nazar-test.invalid','k10-dryrun-b-20261021@nazar-test.invalid')
ORDER BY c.email,s.created_at;
```

Beklenen her kişi için bir VIP signup; her iki test işareti true, consent_email true, kaynak website_vip_page (veya website_vip_form), onay öncesi kupon **0**. Onay durumu subscribed olmamalı. Kayıt yoksa Preview hedef/Turnstile ayarını incele; farklı projede arama. Çift kayıt/önceden onay varsa yeni benzersiz adresle ayrı koşu planla; izin durumunu elle UPDATE etme.

## 4. Çift onayın sandbox simülasyonu → kupon

Gerçek DOI e-postası gönderilmedi; bu adım **gerçek DOI teslim/tıklama testi değildir**. SQL Editor operatörü yalnız yukarıdaki iki `.invalid`, `is_test=true` kişi ve VIP talebi için tarihli sentetik sağlayıcı kanıtını gerçek service-only RPC'ye verir. `source=klaviyo` sözleşmenin zorunlu enum'udur; `simulation=true` ve sentetik profile/list bunun gerçek sağlayıcı gözlemi olmadığını kaydeder. Formdan gelen checkbox tek başına onay sayılmaz. Bu bloğu yalnız sandbox'ta çalıştır:

```sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $dryrun$
DECLARE b uuid := 'BUSINESS_UUID'; r record; t timestamptz; result jsonb; n integer:=0;
BEGIN
 IF (SELECT count(*) FROM core.installation)<>1 OR
    (SELECT declared_project_ref FROM core.installation LIMIT 1) IS DISTINCT FROM 'uxiseddbeszklkrvysxf'
 THEN RAISE EXCEPTION 'SANDBOX_ONLY'; END IF;
 IF (SELECT count(*) FROM core.campaigns WHERE business_id=b AND name='INTERNAL TEST K10 DRY RUN 20261021'
     AND campaign_kind='signup_reward' AND is_test AND status='active' AND vip_list_id='SYNTHETIC_VIP_K10')<>1
 THEN RAISE EXCEPTION 'TEST_CAMPAIGN_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM core.campaigns WHERE business_id=b AND is_test AND campaign_kind='signup_reward'
    AND status='active' AND name<>'INTERNAL TEST K10 DRY RUN 20261021') THEN RAISE EXCEPTION 'OTHER_ACTIVE_TEST_CAMPAIGN'; END IF;
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 FOR r IN SELECT c.id,c.email,c.is_test,c.email_status,s.id AS signup_id,s.is_test AS signup_is_test
 FROM core.customers c JOIN core.signups s ON s.customer_id=c.id AND s.business_id=c.business_id
 WHERE c.business_id=b AND c.email IN
 ('k10-dryrun-a-20261021@nazar-test.invalid','k10-dryrun-b-20261021@nazar-test.invalid')
 LOOP
  IF NOT r.is_test OR NOT r.signup_is_test OR r.email_status='subscribed' OR
     EXISTS(SELECT 1 FROM core.campaign_coupons WHERE customer_id=r.id)
  THEN RAISE EXCEPTION 'FRESH_SYNTHETIC_ONLY'; END IF;
  t:=clock_timestamp();
  result:=public.coupon_record_confirmed_vip_v1(b,r.id,r.signup_id,'synthetic-k10-'||r.id::text,t,t,
   jsonb_build_object('source','klaviyo','listId','SYNTHETIC_VIP_K10',
    'emailSha256',encode(sha256(convert_to(lower(btrim(r.email)),'UTF8')),'hex'),
    'doubleOptIn',true,'canReceiveEmailMarketing',true,'consent','SUBSCRIBED','simulation',true));
  IF result->>'confirmed' IS DISTINCT FROM 'true' OR (result->>'issued')::integer<>1
  THEN RAISE EXCEPTION 'SYNTHETIC_CONFIRMATION_FAILED'; END IF;
  n:=n+1;
 END LOOP;
 IF n<>2 THEN RAISE EXCEPTION 'EXPECTED_EXACTLY_TWO_SIGNUPS'; END IF;
END $dryrun$;
COMMIT;
```

Beklenen **Success**; iki kupon üretilir. `customer_blocked` / FRESH_SYNTHETIC_ONLY / uyuşmazlık varsa **ROLLBACK**, dur; suppression kaldırma veya subscribed UPDATE ile aşma. Yeniden çalıştırma yeni test oluşturmaz; bu tarif taze iki kaydı şart koşar. Kuyruktaki kayıt “email gönderildi” değildir.

Kodları yalnız bu sandbox SQL sonucunda gör ve kendi test ekranına kopyala (sohbete/rapora QR tokenı veya kod koyma):

```sql
SELECT c.email,cp.code,cp.issued_at,cp.state,
       'VIPCOUPON1:'||cp.code AS local_qr_payload,w.status AS welcome_status
FROM core.campaign_coupons cp JOIN core.customers c ON c.id=cp.customer_id AND c.business_id=cp.business_id
JOIN core.campaigns ca ON ca.id=cp.campaign_id AND ca.business_id=cp.business_id
LEFT JOIN core.coupon_welcome_outbox w ON w.coupon_id=cp.id
WHERE cp.business_id='BUSINESS_UUID' AND cp.is_test AND ca.name='INTERNAL TEST K10 DRY RUN 20261021'
AND c.email IN('k10-dryrun-a-20261021@nazar-test.invalid','k10-dryrun-b-20261021@nazar-test.invalid')
ORDER BY c.email;
```

Beklenen A ve B için birer issued; welcome queued (gönderim yok). Satır yok/fazlaysa dur. Onay öncesi 0 → sonrası 2 farkını kanıta yalnız sayı olarak yaz.

## 5. Kasa: geçerli → kullanıldı → ikinci red

1. `SANDBOX_SITE/staff/coupons` → **Kupon kodu** alanına A kodunu yaz → **Kuponu kontrol et**. Beklenen **Geçerli**, maskeli müşteri `I***`, test kampanyası ve $30 eşiği. “Geçerli” sipariş koşullarının sağlandığını tek başına göstermez.
2. Kamera seçeneği: **QR okut** → kamera iznini ver → kişisel payload `VIPCOUPON1:<A kodu>` içeren yerelde üretilmiş QR'yi başka ekrandan göster → kod alana gelir → **Kuponu kontrol et**. Dış QR web servisine payload yükleme. Elde yerel kişisel QR yoksa **yazma yolu geçti, kamera bu koşuda denenmedi** kaydet; kayıt kartı QR'si kupon QR'si yerine kullanılamaz. İzin reddinde yazma yolu çalışmalı.
3. **Clover sipariş no** boş; **Kanal: Restoranda**; **Vergi/bahşiş hariç tutar: 30.00**; fiş tarihi/saatini **kupon üretiminden sonraki, gelecekte olmayan** test anı olarak seç (dakika alanı için sonraki dakikayı bekle); **Gerçek fiş referansı: K10-DRY-A-20261021**; not **INTERNAL TEST — sentetik fiş, gerçek satış yok**; kontrol kutusunu işaretle. Bu yalnız sandbox'ta sentetik personel beyanı provasıdır; gerçek fiş veya satış kanıtı sayılmaz.
4. **Kullanıldı olarak işaretle**'ye bir kez bas. Beklenen **Kullanım kaydedildi**, **Kullanılmış**, New York zamanı ve **staff_attested; K7 sipariş doğrulaması değildir** açıklaması. Clover POS'a gerçek sipariş/indirim girme. Canlı kasa talimatı ayrıca şöyledir: **SIMIT satırına %100 ayrı indirim; ürünün $2.49 liste fiyatı korunur.** Bu prova o gerçek indirim satırını doğrulamaz.
5. Aynı A kodunu yeniden **Kuponu kontrol et** → **Kullanılmış**, ilk zaman aynı, kullanım düğmesi yok. İkinci uygulama oluşmamalı. İki ayrı cihazla yarış testi istenirse aynı taze kuponla ancak ayrı planlanır; kullanılmış A ile tekrar satış yapma.
6. Ağ sonucu belirsizse **Kullanıldı**'ya tekrar basma. **Durumu yeniden oku**; used ise tamam, doğrulanamıyorsa dur. 403 ise hesabın işletme/aktif üyeliği kontrol edilir; bu tarif rol genişletmez. Bulunamadı/yanlış işletme durumunda proje, business ayarı ve kodu kontrol et.

## 6. $30 altı ve kanal seçimi

1. B kodunu **Kuponu kontrol et** → **Geçerli**. Fiş referansı **K10-DRY-B-20261021**; kupondan sonraki zaman; kanal **Restoranda**; tutar **29.99**; not sentetik; kontrol kutusu açık.
2. Beklenen **Kullanıldı olarak işaretle pasif**; hiçbir kullanım isteği gitmez. Sayfayı yeniden açıp B'yi kontrol et → hâlâ **Geçerli**. Bu UI sınırı testidir; gerçek SQL `below_minimum` sınırı yerel native testte ayrıca doğrulanmıştır. Tarayıcıdan butonu zorlayarak API denemesi yapma.
3. Tutarı **30.00** yap; **Kanal** menüsünde **Restoranda / Site pickup / Site delivery** bulunmalı; marketplace bulunmamalı. Üçünde de buton koşullar sağlanınca açılmalı. B'yi şimdilik harcama. Her kanalda gerçek tek kullanımı göstermek istenirse üç ayrı taze sentetik kişi/kupon gerekir; bir kuponu sıfırlama. Bu iki kişilik koşu yalnız A/dine_in kullanımı ve üç kanal seçimini kanıtlar.

## 7. Ops kutusu ve sayısal mutabakat — ileri düzeltme sonrası

1. `SANDBOX_SITE/staff/ops` → **Internal tests** kutusunu aç → **Yenile**. Harici API'leri çağıran **Şimdi topla** düğmesine basma; kampanya ölçümü yerel `loyalty_metrics_v1` okumasıdır.
2. **Kampanya kullanımı** kutusunda test kampanyasını ara. Tekrar oranı için 30 gün dolmadığından “—” normaldir; mesaj gönderimi veya dönüşüm uydurulmaz.
3. Bu PR birleşip **20261021001000_ops_campaign_usage_split.sql** iki ortamda Talip tarafından uygulandıktan sonra beklenen test kampanyası: **Toplam kullanım: 1 / Siparişe bağlı: 0 / Personel beyanı: 1**. A'nın ilk kullanımından sonra 1; ikinci deneme ve B'nin 29.99 denemesinden sonra aynı. Toplam iki satırın toplamıdır. Kutuda **tekrar sipariş oranının yalnız siparişe bağlı ve 30 günü tamamlayan kullanımlardan hesaplandığı, personel beyanlarının dahil edilmediği** notu görünür. Bu provada yalnız personel beyanı var; oran **—** olmalı, %0 başarı sonucu uydurulmaz. Önceki NULL-order sayım engeli bu ileri migration ile giderilir; kaynak dosyalarına uygulanmış gibi yazılmaz.

Eski backend / migration yoksa toplam eski davranışta olabilir; yeni ayrım satırları **—** ve ölçüm güncellemesi bekleniyor notu gösterilir. Bu durumda kabul verme, migration/UI sürümünü Koordinasyon ile doğrula; kuponu tekrar kullanma veya sahte Clover siparişi ekleme.
4. SQL Editor'da yalnız iki sentetik kişinin durumunu say:

```sql
SELECT count(*) AS coupons,
 count(*) FILTER(WHERE cp.state='redeemed') AS used,
 count(*) FILTER(WHERE cp.state='issued') AS unused,
 count(r.id) AS redemptions,
 count(r.id) FILTER(WHERE r.order_id IS NULL) AS staff_attested_without_order
FROM core.campaign_coupons cp JOIN core.customers c ON c.id=cp.customer_id AND c.business_id=cp.business_id
JOIN core.campaigns ca ON ca.id=cp.campaign_id AND ca.business_id=cp.business_id
LEFT JOIN core.offer_redemptions r ON r.coupon_id=cp.id AND r.business_id=cp.business_id
WHERE cp.business_id='BUSINESS_UUID' AND cp.is_test AND ca.name='INTERNAL TEST K10 DRY RUN 20261021'
AND c.email IN('k10-dryrun-a-20261021@nazar-test.invalid','k10-dryrun-b-20261021@nazar-test.invalid');
```

Beklenen **2 / 1 / 1 / 1 / 1**. İkinci kullanım ve 29.99 denemesi sonrası aynı kalmalı. Farklıysa dur, kodu/kimliği paylaşmadan sayıları ve güvenli hata adını bildir.

## 8. Bitiriş / kabul kaydı

Yalnız bu test kampanyasını durdur; kupon/onay/kullanım geçmişi append-only, silinmez veya kullanılmamışa çevrilmez. SQL Editor'da aşağıdakini çalıştır; scheduler, gerçek kampanyalar ve diğer testler değişmez:

```sql
BEGIN;
DO $dryrun$ BEGIN
 IF (SELECT count(*) FROM core.installation)<>1 OR
    (SELECT declared_project_ref FROM core.installation LIMIT 1) IS DISTINCT FROM 'uxiseddbeszklkrvysxf'
 THEN RAISE EXCEPTION 'SANDBOX_ONLY'; END IF;
 UPDATE core.campaigns SET status='stopped'
 WHERE business_id='BUSINESS_UUID' AND is_test AND name='INTERNAL TEST K10 DRY RUN 20261021' AND campaign_kind='signup_reward';
END $dryrun$;
COMMIT;
```

Açık test personel oturumundan çık. Kısa kanıt: site/deploy commit'i, sandbox ref, saat, form 2 kayıt, DOI **simüle**, kupon 2, kullanım 1, ikinci deneme red, 29.99 UI red, kanal seçenekleri, kamera geçti/denenmedi, Ops gerçek gözlemi ve **1 toplam / 0 siparişe bağlı / 1 personel beyanı**. Kod/QR/token/şifre yok. Gerçek DOI/mail, Clover ürün/indirim satırı ve ileri migration sonrası Ops uyumu tamamlanmadan bu kuru test **canlı kampanya açılış onayı değildir**.


## Tarifi hazırlarken yapılan yerel kontrol

21 Ekim: Sahip olunan loopback PostgreSQL 18.6 ve gerçek kupon migration fixture'ı üzerinde bu belgedeki hazırlık, onay, kod okuma, sayım ve durdurma SQL blokları çalıştırıldı. Production ref'i ilan edilmiş fixture'da hazırlık reddedildi; sandbox ilanında iki sentetik onay → iki kupon, ilk kullanım → bir kayıt, ikinci kullanım reddi, 2999 cent SQL reddi ve sonuç **2/1/1/1/1** doğrulandı. Hazırlık/onay SQL'i hosted ortamda çalıştırılmadı; bu kontrol sandbox site/form/Auth/kamera kabulü veya gerçek DOI kanıtı değildir. Ops INNER JOIN sınırlaması kaynak kod incelemesidir; hosted sonuç gözlemi değildir.


Güncelleme: Ops ayrımı düzeltme PR’ı sonrası beklenen sonuç yazıldı; bu dosya hâlâ tarif, hosted kabul değildir. Önceki yerel SQL provası yeni Ops migration’ının uygulanmış olduğunu iddia etmez.
