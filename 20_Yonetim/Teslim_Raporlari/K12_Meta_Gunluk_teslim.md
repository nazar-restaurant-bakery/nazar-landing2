# K12 — Meta günlük salt okuma

21 Ekim 2026 · `fix/ops-meta-daily-read` · taban main `2bbbcdf` · ayrı Draft, birleşme Talip'te.

Main'de Meta okuyucusu vardı: yedi günlük harcama/erişim/seçilen sonuç + kampanya sayısı. Gösterim ve tıklama yoktu; adında “Nazar” geçmesi kimlik kanıtı sayılıyordu. Yeni sürümde kimlik, ayardaki exact hesap ID + USD + America/New_York ile doğrulanır; hesap adı çekilmez. Dünün tek tamamlanmış New York günü için `spend_yesterday`, `reach_yesterday`, `impressions_yesterday`, `clicks_yesterday`, `results_yesterday`; API yanıtının date_start/date_stop'u da aynı gün olmalıdır. Panelde **Dün** etiketi vardır; eski yedi günlük sonuç günlük diye gösterilmez.

Kimlik: `META_ACCESS_TOKEN`; ayarlar `META_AD_ACCOUNT_ID` (yalnız rakam), `META_API_VERSION` (vN.0). Talip token'ı **sistem kullanıcısı, yalnız ads_read, hesaba View performance** ile açar; ads_management/business_management eklenmez. Kod yalnız GET account/insights/campaigns okur, Bearer header kullanır; izin oluşturma, yazma, gönderme veya token kapsamını artırma yolu yoktur. Token izinleri kod tarafından tahmin edilmez; gerçek grant/asset kontrolü Talip kurulumundadır. Eksik/boş veya geçersiz ayarda hiç çağrı yok; — ve neden. Ortak 30 istek kotası korunur; normal tek kampanya sayfasıyla üç GET, ek sayfalar aynı kotadan düşer.

**Sonuç tanımı:** mevcut isteğe bağlı `META_RESULT_ACTION_TYPE` seçilmediyse — / “Sonuç olayı seçilmedi.” gösterilir. Seçilmiş tek olayın sayısı alınır; purchase/lead/link-click gibi ilgisiz olaylar toplanmaz ve sonuç doğrulanmış satış sayılmaz. Seçili olay doğrulanamazsa diğer günlük metrikler korunur, sonuç — ve neden olur. Yeni secret değeri veya varsayılan lead/purchase kararı eklenmedi.

Test: `node --test tests/opsAdsDaily.test.mjs tests/opsMetaDaily.test.mjs tests/opsCollectors.test.mjs tests/opsUi.test.mjs tests/opsMetricVisibility.test.mjs tests/opsServer.test.mjs` **68/68**. Altı yeni grup: beş günlük ölçüm/GET/Bearer, Mart/Kasım DST/UTC sınırı, boş/yanlış config, yanlış hesap/timezone/tarih/bozuk veya negatif sayı, sonuç tanımı/duplicate ayrımı, 429 gizliliği ve kota. Gerçek CRM/Ops tarayıcı paketi **61/61**, 375px dahil. TypeScript/build/hedefli ESLint ve diff kontrolü geçti. Sentetik Production parity: **212/212**, **209 byte-eşit**, CSS aynı; form/Auth/GA4/main ortam koruması aynı. Kanıt `K12_Meta_Gunluk_kanit/`; `python tests/opsReadParity.py` ile tekrar edilebilir.

API alanları: [Meta'nın resmî Marketing API koleksiyonu](https://www.postman.com/meta/facebook-marketing-api/request/u38qbri/get-insight-details-from-an-adaccount-l4), [Insights belgesi](https://developers.facebook.com/docs/marketing-api/insights/). Belge sayfası bu kontrolde 429 verdi; kesin token/Review koşulu canlı hesapta doğrulanmış sayılmaz. Hiçbir Meta hesabına veya canlı DB'ye erişilmedi, anahtar okunmadı/değişmedi; migration/deploy yok. Ads PR #82 main’de; günlük Ads okuyucusu ve kutusu bu dalda aynen korunur.

## #82 sonrası güncelleme

#83, Ads #82 içeren main2bbbcdf üzerine yeniden temellendirildi. OpsView çakışmasında main’deki Ads günlük kutusu ile Meta günlük kutusu birlikte korundu; Ads okuyucu dosyası ve Ads kutu satırı main ile LF-byte eşit doğrulandı. Ortak parity yardımcısı Ads varsayılanını korur, Meta kanıtı için OPS_PARITY_EVIDENCE=K12_Meta_Gunluk_kanit seçilir.

Ads+Meta ve diğer Ops testleri68/68; TypeScript/build/hedefli ESLint ve yeni main Production parity yeniden doğrulandı. Güncel tarayıcı sonucu K12_Meta_Gunluk_kanit/browser/results.json içindedir. Canlı DB/dış hesap işlemi yok; #76 ve #78 değiştirilmedi/Draft kalır.
