# K16 — Pickup takvim kısıtı — 23 Ekim 2026

Taban: main `308cab9`. [Draft PR #101](https://github.com/nazar-restaurant-bakery/nazar-landing2/pull/101); merge Talip'te. Canlı form, ödeme, DB, hesap veya dağıtım işlemi yapılmadı.

## Değişiklik

`/catering` standart catering ödeme formunda tarih alanının `min` değeri, şimdi + 72 saatin **New York günü**. İlk seçim, sunucunun kabul edeceği ilk geçerli tarih ve tam/buçuk saat. 11:00–19:00 (19:00 dahil) dışı veya yeterli süre bırakmayan seçenekler seçilemez. Saat sınırı gönderimde yeniden değerlendirilir; sayfa açıkken zaman da güncellenir. Geçersiz tarih/saat için TR/EN/AR alan uyarısı ve alana odak verilir; ödeme isteği gönderilmez, genel ödeme hatası kullanılmaz.

**Mevcut sunucu süresi korunmuştur:** ödeme sonrası 72 saati korumak için checkout başlangıcında 72 saat + mevcut 20 dakika (15 dakika checkout + 5 dakika pay) aranıyor. İstemci de bu tamponu uygular; sunucunun süre/saat/yarım saat doğrulaması değiştirilmedi.

Yeni tek iş kuralı: `CATERING_CLOSED_WEEKDAY = 3` (Çarşamba, New York). Tek sabit `src/lib/cateringPickup.ts` içinde; sunucu aynı modülden kapalı gün kontrolünü kullanır. İleride işletme ayarına taşınabilir. Çarşamba istemcide pasif ve sunucuda reddedilir.

Yerel tarayıcı tarih seçicisi tek bir haftanın gününü pasifleştiremediğinden, `min` taşıyan salt okunur tarih alanının yanında erişilebilir düğmeli ay takvimi bulunur. Geçmiş/kapalı/uygun saati kalmayan tarihler pasif; ay geçişi ve klavye düğmeleri mevcut. Müşterinin cihaz saat dilimi pickup'ı kaydırmaz.

## Doğrulama

**18/18:** pickup sınır testleri 5, checkout 12, gerçek React yerel tarayıcı senaryosu 1 (EN/TR/AR, her biri 375px ve Tokyo cihaz saat dilimi). Tam 72 saat + korunmuş tampon sınırı / 1 ms öncesi, 19:00 kabul / 19:30 ret, 11:30 kabul / 11:15 ret, Çarşamba ret (farklı offset dahil), Mart/Kasım DST, ilk geçerli seçim ve açık formda yaşlanan slot doğrulandı. Çarşamba checkout isteği dış çağrıdan önce 400 alır; geçersiz istemci alanı submit'i sıfır POST ile durur. TypeScript, hedefli ESLint ve `git diff --check` geçti.

Ekran kanıtları yerel fixture'dır: `K16_Pickup_kanit/pickup-en-375.png`, `pickup-tr-375.png`, `pickup-ar-375.png`; gerçek müşteri/Turnstile/ödeme kullanılmadı. Mevcut checkout sentetik fixture'ı artık Çarşambaya düşerse ertesi günü kullanır.

Merge sonrası standart Pages Production dağıtımı gerekir. Yeni migration, secret veya Edge Function dağıtımı yok.
## Yönlendirici devri — mevcut PR kontrolü ve sandbox kabul tarifi

Devir kaynağı: `20_Yonetim/Codex_Yonlendirici_Devir_2026-10-23.md`. Bu teslim Kol 2 raporudur; Talip'e doğrudan adım verilmez. Yönlendirici, hesap/secret/dağıtım ve merge kararlarını kendi akışında ele alır.

GitHub salt okunur kontrolü: mevcut **#101 açık, Draft, hedef main**. Kontrol edilen PR kod SHA'sı **`ee803330db20fea10ae41882dc9b69301897b53a`**, taban **`308cab975c8629b669af573b2b52097690367ff3`**. Bu kontrol sonrası yalnız bu rapora ek yapılır; son belge commit'i teslim mesajında ayrıca belirtilir. Yeni/mükerrer PR yok. 18/18 yerel test yeniden çalıştırıldı; canlı veya sandbox hosted çağrı yapılmadı.

### Sandbox doğrulama tarifi — yönlendirici için, henüz uygulanmadı

1. **Kaynak önkoşulu:** mevcut `tmp/nazar-sandbox-staff-client` kaynağı, Talip #101'i birleştirdikten sonra pickup değişikliğini içeren main'e Koordinasyon tarafından eşitlenmeli. #92 DOI webhook'u ve #99 staff izolasyonu da korunmalı. Eski checkout kaynağı veya yalnız `dist` dağıtımı kullanılmaz; mevcut `Deploy-K16Customer-Sandbox.ps1` Functions bundle yolunu içeren tarif esas alınır. Bu rapor yeni dağıtım/bayrak değişikliği yetkisi vermez.
2. **Güvenli UI kontrol ortamı:** yalnız `nazar-catering-sandbox.pages.dev`, Supabase `uxiseddbeszklkrvysxf`; mevcut test anahtarları ve sentetik tenant. Formu göstermek için onaylı sandbox build'de `VITE_CATERING_CHECKOUT_ENABLED=true` gerekir. Sunucu `CATERING_CHECKOUT_ENABLED=false` kalabilir; bu takvim kabulü ödeme/sipariş gerektirmez. Production iki bayrağı false kalır. Kurulum girdilerini/değerlerini Kol 2 değiştirmez.
3. **Ekran:** `https://nazar-catering-sandbox.pages.dev/catering` içinde fiyatlı standart tepsi seçilince ödeme formunda ilk uygun gün/saat dolu olmalı. Minimum tarih, o andan 72 saat sonrasının New York günü olmalı; müşterinin cihaz saat dilimi bunu değiştirmemeli. Kalan 20 dakika checkout payı nedeniyle ilk seçilebilir saat, düz 72 saatten sonraki ilk slot olmayabilir.
4. **Takvim:** takvim düğmesiyle ay açılır; minimumdan önceki günler ve tüm Çarşambalar pasif olmalı. İleri ayda Çarşamba kontrolü tekrar edilir. Süresi yeterli açık günde 11:00/11:30/18:30/19:00 seçilebilir; 19:30 seçeneği yoktur. Minimum günde eşikten önceki saatler pasiftir. Önceki/sonraki ay düğmeleri ve klavye Tab/Enter çalışır; 375px'de yatay taşma olmaz.
5. **Dil ve hata:** EN/TR/AR ayrı kontrol edilir. Sayfa açıkken seçili slot geçersizleşirse ilgili alanın 72 saat uyarısı görünür; genel ödeme hatası olmamalı. Tam sınır/1 ms öncesi, sahte 11:15/19:30 girdisi ve Çarşamba sunucu reddi deterministik yerel testte doğrulanır; hosted endpoint'e sahte/gerçek sipariş gönderilmez. **Continue to secure payment basılmaz.**
6. **Kanıt/kapatma:** dağıtım SHA'sı, sandbox URL, kontrol anı ve New York minimum/ilk seçim, üç dil/375px ekranları ile pasif Çarşamba sonucu aynı rapora eklenir. Form test için açıldıysa mevcut kapatma tarifiyle sandbox build bayrağı önceki duruma döndürülür (yönlendirici/Talip akışı). Herhangi bir yanlış proje, eski kaynak, beklenmeyen tarih veya genel hata görülürse kabul verilmez; ödeme denenmez. Bu aşamada sandbox canlı kabulü **bekliyor**.
## 24 Ekim — main #103 entegrasyonu / merge hazırlığı

Mevcut #101, **main `69d4b0df528a77e946d7eea8513466de3970b550`** üzerine çakışmasız taşındı; bu rapor eki öncesi birleşik kod head'i `868be0dd41aceed95d6165cee2c04bff0cfcca0b`. Yeni PR yok; kapsam aynı sekiz dosya. 72 saat + korunmuş 20 dakika checkout payı, New York 11:00–19:00 tam/buçuk saat ve Çarşamba yasağı aynen korundu. Checkout bayrağı/kapısı, ayar veya secret değiştirilmedi.

**Yeni main üzerinde tekrar doğrulama:** 18/18 test, skip 0 (12 checkout, 5 pickup sınırı, 1 EN/TR/AR 375px gerçek React tarayıcı senaryosu); proje TypeScript, sunucu pickup modülünün ayrı type kontrolü, hedefli ESLint ve `git diff --check` geçti. Vite Production-mode build **166 modül** ile geçti. Browserslist yaş ve >500 kB chunk uyarıları engelleyici değildir; bağımlılık/chunk kapsamı değiştirilmedi.

**Önceki kanıtın geçerliliği:** dört pickup kaynak dosyası ve üç test dosyasının Git blob'ları önceki #101 head `0286d3b` ile birebir aynı. Sabit saatli yerel fixture, üç dil, 375px/Tokyo saat dilimi ve sentetik checkout girdileri değişmedi; önceki yerel ekranlar bu davranış için geçerli, ayrıca birleşik dalda testler yeniden geçti. Main #102/#103 signup değişiklikleri pickup kaynak/test girdilerini değiştirmedi. Ancak bu raporun önceki sandbox bölümü zaten **henüz uygulanmadı / hosted kabul bekliyor** durumundadır; eski K16 ödeme veya yerel ekran kanıtı bu yeni deployment'ın hosted takvim kabulü sayılmaz.

**Yenileme hazırlığı:** yukarıdaki sandbox tarifinin kaynak önkoşulu artık #101'i içeren bu main entegrasyonudur. Sonraki yetkili sandbox dağıtımında kaynak SHA + Functions bundle, New York min/ilk seçim, pasif Çarşamba/erken saatler ve üç dil/375px ekranları yeniden kaydedilmelidir. Bu hazırlık hiçbir kapıyı açmaz, ödeme başlatmaz ve Talip'e doğrudan adım vermez. Hosted/SQL/secret/dağıtım/main push/merge yapılmadı. Mevcut PR Draft kalır; son head teslim mesajı ve PR açıklamasındadır.