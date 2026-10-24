# K10 — bootstrap hesap kontrolü aralığı

Taban: main 8cefe03. Yalnız bootstrap provider instance; SQL 23 değişmez.

## Bulgu

Dispatch hesap GET sırası: inventory/receipt → currentProvider/read → currentProvider/event → permit claim ve K6 reserve/claim → welcome/read → welcome/event → bind inventory/receipt → tek event POST.

İlk üç hesap GET'inde 429: `bootstrap_unconfirmed/unknown`; claim çağrısı yok, permit reviewed/attempts=0. Son üç hesap GET'inde 429: K6/outbox unknown ile finalize, bootstrap finish blocked/attempts=1; event POST yok. İkinci dispatch bootstrap_not_claimable. SQL durum geçişleri kaynakla karşılaştırıldı; bu testte RPC deposu bellekte taklit edilir, gerçek PostgreSQL entegrasyon kanıtı değildir.

## Dar düzeltme

Altı hesap GET'i üç credential arasında aynı kuyruğu kullanır. İlk istekte ve önceki hesap yanıtı tamamlandıktan sonra en az 4.2 saniye bekler. Normal welcome sağlayıcısı değişmez. Ağın 5 saniyelik AbortSignal'ı bekleme bittikten sonra oluşturulur. Sonuç/kimlik doğrulama cache edilmez; 429 dahil hatalar yeniden denenmez; event otomatik tekrar edilmez. İlk bekleme başka süreçlerin/operatörlerin hesap trafiğiyle küresel koordinasyon garantisi değildir. Deneme sırasında paralel hesap sorgusu yapılmamalı.

Altı hesap için bekleme toplamı en az 25.2 saniye; claim sonrası üç bekleme en az 12.6 saniye. K6 dispatch süresi iki dakika, outbox lease beş dakika; mevcut süre/yetki kontrolleri korunur. Bekleme asenkron zamanlayıcıdır, CPU busy-loop yok; HTTP istemcisi tamamlanana kadar bağlantı açık kalmalıdır. Yavaş gerçek ağ veya başka trafik yine reddedilebilir; kör tekrar yapılmaz.

## Kanıt

Gerçek workerd: 128/128, skipped=0. Üç claim öncesi ve üç claim sonrası 429; her birinde event=0, hesap tekrar=0. Başarılı sentetik zincir: hesap sanal saatleri 4200/8400/12600/16800/21000/25200 ms, altı doğru credential kontrolü, event=1, ikinci dispatch reddi. Ayrıca gerçek workerd zamanlayıcısıyla eşzamanlı iki hesap çağrısı seri çalıştı, ilk bekleme ve aralık ≥4.2s, iki transport sinyali de başlarken açık. Diğer testler kontrollü sanal saatle çalışır. Tüm dış transport sentetik interceptor'da sonlanır.

Functions explicit TypeScript ve yerel Pages Functions build geçti; mevcut envanter/transport/bütçe testleri 29/29 skip0 geçti. İlk build yeni worktree node_modules bağlantısı yokken qrcode-generator çözemedi; mevcut bağımlılık junction kurulunca aynı build geçti (kod sorunu değil). Log ve SHA özetleri aynı adlı kanıt klasöründe. Gerçek ağ/secret/hosted SQL/permit/event/e-posta/dağıtım yok.
