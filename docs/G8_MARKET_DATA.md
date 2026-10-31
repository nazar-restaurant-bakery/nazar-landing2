# G8: Pazar verisi alanı (`market` şeması)

Faz 2 · Görev 8. Müşteri kaydının yanında, **kişiye ait olmayan** pazar verisi için ayrı bir alan açılır. Bu alana şu kaynaklar yazar:
- Google Places
- Google Ads
- Google Business Profile
- Daha sonra Apify ve Meta

Bu görev yalnız alanı kurar. Veri yazan bağlantılar Görev 12 ve 13'te gelir.

- Migration: `supabase/migrations/20261031000100_market_data_area.sql` (Migration_Sirasi sıra 33)
- Geri alma: `supabase/rollbacks/20261031000100_market_data_area_down.sql`
- Test: `tests/marketDataAreaDb.test.mjs` (yerel PostgreSQL 18.6)

## Erişim
Erişim düzeni `core` şemasıyla aynı:
- `anon`, `authenticated` ve `service_role` rollerinin `market` şemasında `USAGE` yetkisi ve herhangi bir tablo izni yok.
- Bütün tablolarda RLS açık.
- Okuma ve yazma ileride yalnız `service_role`'ün çağırabildiği fonksiyonlarla yapılacak. Bu fonksiyonlar `SECURITY DEFINER` ve `search_path=''` ile tanımlanacak ve `business_id` ile sınırlı olacak. Bu görevde fonksiyon yok.
- `market` şeması Supabase Data API'de (Exposed schemas) **açılmaz**.

**Kişisel veri:** Müşteri bilgisi, e-posta, telefon ve kişi adı bu şemaya girmez. Rakip yorumlarında yorumcunun adı ya da kişisel bilgisi için kolon da yoktur.

## Ortak alanlar
| Alan | Açıklama |
|---|---|
| `business_id` | `core.businesses(id)`; `NOT NULL` |
| `source` | Verinin kaynağı: `places_api`, `google_ads_api`, `business_profile_api`, `csv`, `apify` … (küçük harf ve alt çizgi) |
| `observed_at` | Gözlem zamanı |
| `import_id` | Uygunsa `market.imports` kaydına bağ. Bağ, `(business_id, import_id)` ile kurulur; başka bir işletmenin içe aktarmasına bağlanılamaz. `imports` tablosunda bu alan yoktur. |
| `is_test` | Varsayılan `false` |
| `created_at` | Kaydın oluşturulma zamanı |

## Tablolar ve tekil anahtarlar
| Tablo | İçerik | Tekil anahtar |
|---|---|---|
| `market.imports` | Her içe aktarma ya da çekim: `source`, `kind`, `file_name`, `file_sha256`, `period_start`, `period_end`, `row_count`, `status` | `(business_id, file_sha256)`: aynı dosya iki kez yüklenemez. API çekimlerinde dosya olmadığından `file_sha256` NULL kalır; NULL değerler birbirini engellemez. |
| `market.competitors` | Rakipler: `place_id`, ad, adres, türler, puan, yorum sayısı, konum, web sitesi | `(business_id, place_id)` |
| `market.competitor_menu_items` | Rakip menüsü ve fiyatları: ürün, kategori, fiyat, para birimi, kaynak bağlantısı | `(business_id, competitor_id, item_name, category, observed_at)`. Aynı gözlemde aynı ürün bir kez yazılır; sonraki gözlemler fiyat geçmişini oluşturur. |
| `market.competitor_reviews` | Rakip yorumları: dış kimlik, puan, metin, yayın tarihi. Yorumcu bilgisi yok. | `(business_id, competitor_id, external_id)` |
| `market.competitor_ads` | Rakip reklamları: platform, dış kimlik, ilk görülme, son görülme, metin, açılış bağlantısı | `(business_id, platform, external_id)` |
| `market.area_businesses` | Bölgedeki şirketler: `place_id`, ad, adres, türler, puan, yorum sayısı, konum. Eşleşen GO adayı için `b2b_lead_id` → `core.b2b_leads(id)`; boş geçilebilir. Aday silinirse bağ `NULL` olur. | `(business_id, place_id)` |
| `market.ad_reports` | Reklam raporu, günlük satır: `platform` (`google_ads` ya da `meta`), kampanya, tarih, gösterim, tıklama, harcama, dönüşüm, para birimi | `(business_id, platform, campaign_id, report_date)`. Aynı gün ikinci kez gelirse `ON CONFLICT … DO UPDATE` ile güncellenir; kopya oluşmaz. |
| `market.business_profile_reports` | Business Profile göstergeleri: `period_start`, `period_end`, `metric`, `dimension` (örneğin arama terimi; boyutsuz göstergede `''`), `value` | `(business_id, metric, dimension, period_start, period_end)` |

**Ek kurallar:**
- Rakibe bağlı satırlar (menü, yorum, reklam), rakibe `(business_id, competitor_id)` ile bağlanır; başka bir işletmenin rakibine bağlanamaz.
- `area_businesses.b2b_lead_id` yalnız aynı işletmenin adayına bağlanabilir. Bu kural `market.area_business_lead_scope_v1` tetikleyicisiyle uygulanır. Fonksiyon `search_path=''` ile tanımlıdır ve hiçbir rol tarafından çağrılamaz.
- `core` şemasında hiçbir tablo ya da fonksiyon değişmez. Tek etki, iki yabancı anahtarın `core.businesses` ve `core.b2b_leads` tablolarını göstermesidir.

## Uygulama (Talip)
1. Önkoşul: G4 (`20261029000100_go_outreach_tables.sql`) uygulanmış olmalı, çünkü `core.b2b_leads` gerekiyor.
2. Supabase SQL Editor'da (Nazar-production, postgres rolüyle) migration dosyasını çalıştır. Beklenen sonuç: `Success`.
3. Dosya zaten uygulanmışsa `G8_ALREADY_APPLIED` hatasıyla durur ve hiçbir şeyi değiştirmez.
4. Salt okunur teyit:
   ```sql
   SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace='market'::regnamespace AND relkind='r' ORDER BY 1;
   SELECT has_schema_privilege('service_role','market','USAGE');
   ```
   Beklenen: 8 tablo, hepsinde `relrowsecurity = true`; ikinci sorgu `false` döner.

## Geri alma
`supabase/rollbacks/20261031000100_market_data_area_down.sql`:
- Yalnız `market` tablolarının hepsi boşken çalışır. Veri varsa `G8_ROLLBACK_DATA_PRESENT` hatasıyla durur.
- Tabloları, tetikleyici fonksiyonunu ve şemayı kaldırır. Şemayı `CASCADE` kullanmadan kaldırdığı için beklenmeyen bir nesne kalmışsa durur.
- `core` şemasına dokunmaz.
- Migration hiç uygulanmamışsa `G8_NOT_APPLIED` hatasıyla durur.
