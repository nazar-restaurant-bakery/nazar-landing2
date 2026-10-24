# K16 — Pickup takvim kısıtı — 23 Ekim 2026

Taban: main `308cab9`. Draft PR; merge Talip'te. Canlı form, ödeme, DB, hesap veya dağıtım işlemi yapılmadı.

## Değişiklik

`/catering` standart catering ödeme formunda tarih alanının `min` değeri, şimdi + 72 saatin **New York günü**. İlk seçim, sunucunun kabul edeceği ilk geçerli tarih ve tam/buçuk saat. 11:00–19:00 (19:00 dahil) dışı veya yeterli süre bırakmayan seçenekler seçilemez. Saat sınırı gönderimde yeniden değerlendirilir; sayfa açıkken zaman da güncellenir. Geçersiz tarih/saat için TR/EN/AR alan uyarısı ve alana odak verilir; ödeme isteği gönderilmez, genel ödeme hatası kullanılmaz.

**Mevcut sunucu süresi korunmuştur:** ödeme sonrası 72 saati korumak için checkout başlangıcında 72 saat + mevcut 20 dakika (15 dakika checkout + 5 dakika pay) aranıyor. İstemci de bu tamponu uygular; sunucunun süre/saat/yarım saat doğrulaması değiştirilmedi.

Yeni tek iş kuralı: `CATERING_CLOSED_WEEKDAY = 3` (Çarşamba, New York). Tek sabit `src/lib/cateringPickup.ts` içinde; sunucu aynı modülden kapalı gün kontrolünü kullanır. İleride işletme ayarına taşınabilir. Çarşamba istemcide pasif ve sunucuda reddedilir.

Yerel tarayıcı tarih seçicisi tek bir haftanın gününü pasifleştiremediğinden, `min` taşıyan salt okunur tarih alanının yanında erişilebilir düğmeli ay takvimi bulunur. Geçmiş/kapalı/uygun saati kalmayan tarihler pasif; ay geçişi ve klavye düğmeleri mevcut. Müşterinin cihaz saat dilimi pickup'ı kaydırmaz.

## Doğrulama

**18/18:** pickup sınır testleri 5, checkout 12, gerçek React yerel tarayıcı senaryosu 1 (EN/TR/AR, her biri 375px ve Tokyo cihaz saat dilimi). Tam 72 saat + korunmuş tampon sınırı / 1 ms öncesi, 19:00 kabul / 19:30 ret, 11:30 kabul / 11:15 ret, Çarşamba ret (farklı offset dahil), Mart/Kasım DST, ilk geçerli seçim ve açık formda yaşlanan slot doğrulandı. Çarşamba checkout isteği dış çağrıdan önce 400 alır; geçersiz istemci alanı submit'i sıfır POST ile durur. TypeScript, hedefli ESLint ve `git diff --check` geçti.

Ekran kanıtları yerel fixture'dır: `K16_Pickup_kanit/pickup-en-375.png`, `pickup-tr-375.png`, `pickup-ar-375.png`; gerçek müşteri/Turnstile/ödeme kullanılmadı. Mevcut checkout sentetik fixture'ı artık Çarşambaya düşerse ertesi günü kullanır.

Merge sonrası standart Pages Production dağıtımı gerekir. Yeni migration, secret veya Edge Function dağıtımı yok.