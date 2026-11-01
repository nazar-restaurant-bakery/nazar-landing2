# G13: Business Profile raporu içe aktarma

Faz 2 · Görev 13. Google Business Profile Manager'dan indirilen "GMB insights Performance Report" CSV dosyası `market.business_profile_reports` tablosuna yazılır. Dosyanın içeriği SQL Editor'da tek bir fonksiyon çağrısına yapıştırılır. Site, `ops-collect` ve `daily-ops-run` değişmez.

- **Migration:** `supabase/migrations/20261031000400_market_business_profile_import.sql`. Önkoşul: G8 (`20261031000100`).
- **Geri alma:** `supabase/rollbacks/20261031000400_market_business_profile_import_down.sql`
- **Test:** `tests/marketBusinessProfileImportDb.test.mjs`. Yerel PostgreSQL 18.6 kullanır. Başlık ve veri satırı 31 Ekim'de indirilen gerçek dosyadan alındı.

## Dosya nasıl indirilir
1. https://business.google.com/locations adresini aç.
2. Nazar profilinin yanındaki kutuyu işaretle.
3. **Actions → Insights** yolunu izle.
4. Dönemi seç (ör. son 7 gün) ve **Download Report** ile indir.

Dosya adı şu biçimdedir: `GMB_insights_Performance_Report_-_2026-9-29_-_2026-10-28_-_<kod>.csv`. Dönem dosyanın içinde yoktur, yalnız adında bulunur. Bu yüzden **dosya adını değiştirmeden** kullan. Tarayıcının eklediği ` (1)` eki kabul edilir.

## Nasıl yüklenir
CSV'yi Not Defteri ile aç, içeriğin tamamını kopyala ve SQL Editor'da aşağıdaki kalıba yapıştır. Fonksiyonu yalnız `postgres` çağırabilir.

```sql
SELECT jsonb_pretty(market.business_profile_import_v1(
  'a358eba4-b197-4309-805b-46f43a718454'::uuid,
  '<dosya adı>',
  $csv$<dosya içeriği>$csv$));
```

Örnek sonuç:

```json
{
  "import_id": "…",
  "period_start": "2026-09-29",
  "period_end": "2026-10-28",
  "store_code": "02541028812905381025",
  "metrics_written": 12,
  "skipped": [],
  "file_sha256": "…"
}
```

## Ne yapar
- **Dönem:** Dosya adından okunur. Ad kalıba uymazsa, tarih geçersizse ya da bitiş başlangıçtan önceyse yükleme reddedilir.
- **Başlık:** İlk satırdaki sütun adları ve sırası birebir doğrulanır. Google biçimi değiştirirse yükleme reddedilir; sessizce yanlış yazılmaz.
- **Satırlar:** Açıklama satırı (ilk dört hücresi boş olan satır) ve boş satırlar atlanır. Tam bir veri satırı (tek işletme) bulunmalıdır.
- **Store code:** İlk yüklemede `market.business_profile_settings` tablosunda işletmeye bağlanır. Sonraki dosyalarda farklı bir kod gelirse yükleme reddedilir.
- **Göstergeler:** Her sayısal sütun bir gösterge satırı olur. `dimension` boş (`''`) bırakılır; kaynak `business_profile_csv`.

  | Sütun | Gösterge |
  |---|---|
  | Google Search - Mobile | `search_mobile_views` |
  | Google Search - Desktop | `search_desktop_views` |
  | Google Maps - Mobile | `maps_mobile_views` |
  | Google Maps - Desktop | `maps_desktop_views` |
  | Calls | `calls` |
  | Messages | `messages` |
  | Bookings | `bookings` |
  | Directions | `directions` |
  | Website clicks | `website_clicks` |
  | Food orders | `food_orders` |
  | Food menu clicks | `food_menu_clicks` |
  | Hotel bookings | `hotel_bookings` |

- **`***` ve boş değer:** Yazılmaz, sıfır uydurulmaz. Bu göstergeler sonuçtaki `skipped` listesinde görünür. Aynı dönemin önceki bir yüklemesinde değer varsa o değer korunur.
- **İçe aktarma kaydı:** `market.imports` tablosuna bir satır yazılır: `kind='business_profile_reports'`, dosya adı, içeriğin `sha256` değeri, dönem, gösterge sayısı ve durum.
  - Bütün göstergeler yazıldıysa durum `succeeded` olur.
  - Bazıları atlandıysa `partial` olur.
  - Hiçbiri yazılmadıysa `failed` olur.
- **Aynı dosya:** Aynı içerik ikinci kez yüklenirse `BUSINESS_PROFILE_FILE_ALREADY_IMPORTED: bu dosya zaten yuklenmis` hatası döner ve hiçbir şey yazılmaz.
- **Aynı dönem, farklı dosya:** Gösterge satırları yerinde güncellenir (`ON CONFLICT`), kopya oluşmaz.

## Hata kodları
| Kod | Anlamı |
|---|---|
| `BUSINESS_PROFILE_FILE_NAME_INVALID` | Dosya adı kalıba uymuyor ya da tarih geçersiz |
| `BUSINESS_PROFILE_PERIOD_INVALID` | Bitiş tarihi başlangıçtan önce |
| `BUSINESS_PROFILE_HEADER_MISMATCH` | Başlık satırı beklenen biçimden farklı |
| `BUSINESS_PROFILE_ROW_COUNT_INVALID` | Veri satırı yok ya da birden fazla |
| `BUSINESS_PROFILE_STORE_CODE_MISMATCH` | Store code bu işletmeye bağlı koddan farklı |
| `BUSINESS_PROFILE_VALUE_INVALID` | Bir sütunda sayı, `***` ya da boş dışında bir değer var |
| `BUSINESS_PROFILE_CSV_INVALID` | CSV bozuk (ör. kapanmayan tırnak) ya da çok büyük |
| `BUSINESS_PROFILE_FILE_ALREADY_IMPORTED` | Bu dosya zaten yüklenmiş |

## Sonuç nasıl okunur (salt okunur)
```sql
-- Yüklemeler
SELECT id, file_name, period_start, period_end, row_count, status, created_at
FROM market.imports WHERE source = 'business_profile_csv' ORDER BY created_at DESC LIMIT 10;

-- Göstergeler (dönem başına)
SELECT period_start, period_end, metric, value
FROM market.business_profile_reports
WHERE business_id = 'a358eba4-b197-4309-805b-46f43a718454' AND dimension = ''
ORDER BY period_end DESC, period_start DESC, metric;

-- Bağlı store code
SELECT store_code, bound_at FROM market.business_profile_settings;
```

## Geri alma
- Yalnız CSV'den yazılmış veri yokken çalışır. Veri varsa `G13_BP_ROLLBACK_DATA_PRESENT` hatasıyla durur.
- `market.business_profile_settings` tablosunu ve iki fonksiyonu kaldırır.
- G8, G12 ve G13 Ads kalır; `imports.kind` kuralı değişmez. `core` şemasına dokunmaz.
