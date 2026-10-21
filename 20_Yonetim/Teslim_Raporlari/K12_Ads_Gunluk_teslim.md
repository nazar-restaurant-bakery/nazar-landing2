# K12 — Google Ads günlük salt okuma

21 Ekim 2026 · `fix/ops-ads-daily-read` · taban main `0449e1e` · Draft, birleşme Talip'te.

Developer token zorunluluğu #64 ile main'den zaten kaldırılmıştı. [Google'ın resmî sunset belgesi](https://developers.google.com/google-ads/api/docs/api-policy/developer-token) 9 Eylül 2026 değişikliğini doğruluyor; yeni token veya header eklenmedi. Kimlik yalnız `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`; hedef ayar `GOOGLE_ADS_CUSTOMER_ID=6478477284` (tireli biçim de kabul). Cloud projesi production API erişimine, OAuth kullanıcısı hesapta Read-only rolüne sahip olmalı; Ads ayrı read-only OAuth scope sunmaz. İsteğe bağlı login-customer-id yönlendirmesi aynı kalır.

Önce yedi günlük harcama/tıklama/dönüşüm okunuyordu. Şimdi tek tamamlanmış New York günü için `spend_yesterday`, `impressions_yesterday`, `clicks_yesterday`, `conversions_yesterday` okunur ve Ops kutusunda **Dün** gösterilir. Account/USD/NY kimliği doğrulanır. Yalnız SELECT GAQL + OAuth yenileme vardır; mutate yok. Dört istek mevcut ortak 30 istek kotasından düşer. Eksik/boş kimlikte hiç istek yok, kutu **—** ve neden; boş rapor sıfır uydurmaz, bozuk istatistik/hata güvenli kod döndürür. Kampanya salt okuma sayımları korunur; dönüşüm doğrulanmış sipariş sayılmaz.

Test: `node --test tests/opsAdsDaily.test.mjs tests/opsCollectors.test.mjs tests/opsUi.test.mjs tests/opsMetricVisibility.test.mjs tests/opsServer.test.mjs` **62/62**. DST Mart/Kasım ve UTC gün sınırı, fractional conversions, eksik OAuth, eski developer-token yokluğu, malformed impressions, boş rapor ve 403 gövde gizliliği. Gerçek CRM/Ops tarayıcı paketi **61/61**, 375px dahil. TypeScript, build, hedefli ESLint geçti. İki aynı sentetik Production public ayarıyla main/adayı **212/212**, **209 byte-eşit**; CSS byte-eşit, form/Auth/GA4/ortam koruması kaynakları aynı. Kanıt `K12_Ads_Gunluk_kanit/`; yeniden üretim `python tests/opsReadParity.py` (ayrı main base worktree gerekir).

Migration/secret değeri, canlı hesap veya DB okunmadı/değişmedi. Talip birleşme sonrası normal frontend ve ops-collect yayınıyla kabul yapar. İkinci Meta işi bu PR'a dahil değildir.
