# Günlük zamanlayıcı — güncel main hazırlığı (21 Ekim)

#73 ve bağımlı #71, main **2bbbcdf** (#81 + #82) üzerine taşındı; PR hedefi main. Birleştirme/kurulum Talip'te. Mevcut Clover batch/429/closed-day düzeltmeleri ve ortak personel yetkisi korundu. Migration sıra 11 SHA `0796c2fd…fbbca`, sıra 13 SHA `b54b4a5b…b6793` değişmedi.

**Yapıldı:** 07:00 America/New_York → dünün Clover siparişleri → mevcut Ops okuyucuları; ortak 30 çağrı/gün, nonce/claim/replay/pause, başarısız gün uyarısı. SHA/LF/psql18.6/CA/maskeli parola/önceki sıra ve Production'a kendi Sandbox kanıtı isteyen başlatıcılar eklendi. Sıra 11: 45, sıra 13: 70 nesne/yetki/RLS kontrolü; henüz hosted koşulmadı. Kasım yedek çekimi kapalı 1–30 Kasım aralığını sayfalar; her 30 gün için kaynak sayı+kimlik özeti DB ile karşılaştırılmadan tamlık yazmaz.

**Kanıt:** 122/122 Node; iki panel 1/1 + 1/1; PostgreSQL18.6 DST (Mart/Kasım), eşzamanlı claim/kota ve 30 günlük recovery karşılaştırması geçti. Başlatıcı negatif/çevrimdışı testleri 34/34. TypeScript ve hedefli lint geçti. Güncel main Production karşılaştırması ayrı kanıt klasöründe saklanır.

**Talip adımları:** önce #71 kabulü; M11 Sandbox → gerçek JWT/dry-run kabulü → Production. Mevcut M12; sonra M13 Sandbox → Production. Talip ayrı ortam HMAC/Vault/Cloudflare bağlantılarını girer, function/site paketini dağıtır, inactive cron kurar; Sandbox kabulü sonrası Kasım başında Production'ı açar. Sıra13 bugün 11/12 kanıtlarını bekler; eksik kayıt uydurulmadı. Tam komutlar `tools/test-env/daily-operations/README.md`, yerel kopya `DailyOperations_kanit/README.md`.

**Sınır:** Kurulum ve ilk gerçek gün kanıtı olmadan günlük otomasyon çalışıyor denmez. Ads/diğer kutular mevcut okuyucu ve erişimle dolar; bağlantısız kaynak bekler, Ads #82 ile önceki tamamlanmış günün gösterim, tıklama, harcama ve Ads dönüşümünü yeniler; gerçek sipariş anlamına gelmez. Sipariş aktarımı ödeme günü/finansal mutabakat değildir; kanal etiketi ayrı K13b işidir. Kota yetmezse partial/stop, otomatik kör tekrar yok. Canlı DB/secret/deploy/gönderim değişikliği yapılmadı. Açık karar sorusu yok.

Güncel kod adayları: #71 `50ada0c`, #73 `b8d526b`; taban `2bbbcdf` (#82 dahil). Production karşılaştırması ikisinde **209/212** bayt eşit; normalize public main/index eşit, form/Auth/GA4/K5 kaynakları aynı. Birlikte gzip farkı **+1.226 bayt**. Yalnız private staff bileşenleri/kota/makine yolları kasıtlı farktır. #71 25/25, #73 122/122 + birleşim 25/25; #82 sonrası ek hedefli set 50/50, iki React paneli geçti. Birleşme, migration, secret ve cron açma yapılmadı.
