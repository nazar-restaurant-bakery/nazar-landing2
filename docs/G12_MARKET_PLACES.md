# G12: Places bağlantısı (`market` şeması)

Faz 2 · Görev 12. Google Places (New) ile bölgedeki şirketler ve rakipler çekilir ve Görev 8'de kurulan `market` şemasına yazılır.

- **Migration:** `supabase/migrations/20261031000200_market_places.sql` (Migration_Sirasi sıra 34). Önkoşul: sıra 26 (G4) ve sıra 33 (G8).
- **Geri alma:** `supabase/rollbacks/20261031000200_market_places_down.sql`
- **Edge fonksiyonu:** `supabase/functions/market-places/`
- **Test:** `tests/marketPlacesDb.test.mjs`. Yerel PostgreSQL 18.6 kullanır. Places, Vault ve pg_net sahte; Edge kodu gerçek.

## Bölge ayarı
Bölge koddan değil, `market.area_settings` tablosundan okunur. Her konu için bir satır vardır:

| Konu | Mod | Başlangıç | Yazıldığı yer |
|---|---|---|---|
| `catering` | `county` (ilçe listesi, eyalet `CT`) | `['New Haven County']` | Bölgedeki şirketler → `market.area_businesses`; catering yapan rakipler → `market.competitors` |
| `restaurant` | `radius` (Nazar'ın konumu merkezli) | 5 mil | Restoran, fırın ve paket servis rakipleri → `market.competitors` |

Nazar'ın kendi Places kaydı (`supabase/functions/ops-collect/tenant-settings.json` içindeki `place_id`) hiçbir listeye yazılmaz. Bir yer iki konuya da girebilir; bu bilgi `topics` alanında tutulur.

### Ayar nasıl değişir
Supabase SQL Editor'da tek satır çalıştırılır. Fonksiyonu yalnız `postgres` çağırabilir; `service_role` çağıramaz.

```sql
-- Catering bölgesine Fairfield ve Middlesex ilçelerini ekle:
SELECT market.area_settings_set_v1('a358eba4-b197-4309-805b-46f43a718454','catering',
  ARRAY['New Haven County','Fairfield County','Middlesex County'],NULL);
-- Restoran yarıçapını 7 mil yap (sınır 0–25 mil):
SELECT market.area_settings_set_v1('a358eba4-b197-4309-805b-46f43a718454','restaurant',NULL,7);
-- Bir konuyu kapat (ayar korunur):
SELECT market.area_settings_set_v1('a358eba4-b197-4309-805b-46f43a718454','restaurant',NULL,5,false);
```

İlçe adları `… County` biçiminde olmalı. `catering` konusu yalnız ilçe listesi, `restaurant` konusu yalnız yarıçap kabul eder; aksi halde kısıt hatası verilir.

## Nasıl tarar
**Alan maskesi:** `id`, `displayName`, `formattedAddress`, `types`, `rating`, `userRatingCount`, `location`, `websiteUri`, `addressComponents`. Metin aramasında sayfalama için `nextPageToken` da istenir. Telefon ve kişi verisi istenmez, yazılmaz.

**İlçe modu:**
- Her kasaba için dört metin araması yapılır:
  - `catering in <kasaba>, CT` (rakipler)
  - `corporate office`, `law firm`, `medical office` (bölgedeki şirketler)
- Kasaba listesi New Haven, Fairfield ve Middlesex ilçeleri için kodda var. Listesi olmayan bir ilçe tek parça aranır.
- Sonuçlar `addressComponents` içindeki ilçeye ve eyalete göre süzülür. Connecticut adreslerinde ilçe yerine planlama bölgesi gelebildiği için ilçenin kasaba listesi yedek ölçüttür. İlçe dışındaki kayıt yazılmaz; veritabanı da reddeder.

**Yarıçap modu:**
- Önce Nazar'ın konumu okunur (1 çağrı).
- Yarıçap küçük dairelerden oluşan bir ızgarayla taranır: `restaurant`, `bakery` ve `meal_takeaway` türleri için Nearby Search, en yakın 20 sonuç.
- Yarıçap dışındaki yerler yazılmaz.

**Çağrı tavanı:** Çalıştırma başına varsayılan 150, en fazla 500. Önce bütün ilk sayfalar çekilir, ek sayfalar tavandan kalan çağrılarla alınır. Tavana ulaşılırsa çalıştırma `partial` / `call_cap_reached` olarak kaydedilir.

| Tarama | Planlanan çağrı |
|---|---|
| New Haven County | 108 |
| 5 mil yarıçap | 112 |
| Üç ilçe birlikte | 260 (`p_max_calls` gerekir, ör. 300) |

**Yazma:**
- Kayıtlar `place_id` ile güncellenir (`ON CONFLICT`); kopya oluşmaz.
- Her çalıştırma, kuru çalıştırma dahil, `market.imports` tablosuna bir satır yazar: `source='places_api'`, `kind`, `status`, `row_count`.

**Apollo eşleştirmesi:**
- `area_businesses.b2b_lead_id` yalnız normalize edilmiş şirket adı ve şehir tam eşleşirse ve tek aday varsa doldurulur; belirsizse `NULL` kalır.
- Normalleştirmede büyük/küçük harf, noktalama ve `Inc`/`LLC`/`Corp` gibi ekler yok sayılır.
- `core.b2b_leads` tablosuna yazılmaz.

**Erişim:**
- `market` şeması kapalı kalır.
- Edge fonksiyonu yalnız `public.market_places_claim_v1` ve `public.market_places_finish_v1` fonksiyonlarını çağırır. İkisi de `SECURITY DEFINER`, `search_path=''` ve yalnız `service_role` tarafından çağrılabilir.

**İmza:**
- Yeni bir gizli değer yok. Vault'taki `SCHEDULER_SIGNING_SECRET` kullanılır; imzaya `market_places` amaç etiketi katılır, bu yüzden zamanlayıcı imzası burada geçmez.
- Adres, Vault'taki `SCHEDULER_EDGE_URL` değerinden katı kalıpla türetilir: `…/daily-ops-run` → `…/market-places`.
- İstek tek kullanımlıktır: nonce ve 15 dakikalık süre.
- Edge tarafında gereken gizli değerler mevcut olanlar: `GOOGLE_PLACES_API_KEY`, `SCHEDULER_SIGNING_SECRET`.

## Yayın (Talip)
1. Önce sıra 33'ü (G8), sonra sıra 34'ü SQL Editor'da uygula.
2. Edge fonksiyonunu yayınla:
   ```
   cd C:\Users\Talip\nazar-go-growth\nazar-growth; git checkout main; git pull --ff-only; npx supabase functions deploy market-places --project-ref khgczybubufouraqyrcj --use-api
   ```

## Çekim nasıl başlatılır
SQL Editor'da çalıştırılır; yalnız `postgres` çağırabilir. Dönen değer yalnız kimlik ve sayıdır: `run_id`, `topic`, `dry_run`, `max_calls`, `request_id`.

```sql
-- Kuru çalıştırma: Places'e HİÇ çağrı yapılmaz, yalnız planlanan çağrı sayısı kaydedilir.
SELECT market.places_run_v1('a358eba4-b197-4309-805b-46f43a718454','catering',true);
SELECT market.places_run_v1('a358eba4-b197-4309-805b-46f43a718454','restaurant',true);
-- Gerçek çekim (varsayılan tavan 150):
SELECT market.places_run_v1('a358eba4-b197-4309-805b-46f43a718454','catering',false);
SELECT market.places_run_v1('a358eba4-b197-4309-805b-46f43a718454','restaurant',false);
-- Üç ilçe için tavanı yükselt:
SELECT market.places_run_v1('a358eba4-b197-4309-805b-46f43a718454','catering',false,300);
```

Aynı konu için açık bir çalıştırma varsa, yani son 15 dakikada başlatılmış ve henüz bitmemişse, yeni çalıştırma `MARKET_PLACES_RUN_ACTIVE` hatasıyla reddedilir.

## Sonuç nasıl okunur (salt okunur)
```sql
-- Son çalıştırmalar: durum, kod, planlanan ve kullanılan çağrı, yazılan kayıt, eşleşen aday
SELECT topic, dry_run, status, safe_code, planned_calls, calls_used, max_calls,
       competitors_written, area_businesses_written, leads_matched, created_at, finished_at
FROM market.places_runs ORDER BY created_at DESC LIMIT 10;

-- Rakipler ve bölgedeki şirketler
SELECT name, city, county, topics, rating, review_count, website FROM market.competitors ORDER BY name;
SELECT a.name, a.city, a.county, l.company_name AS apollo_lead
FROM market.area_businesses a LEFT JOIN core.b2b_leads l ON l.id = a.b2b_lead_id ORDER BY a.name;
```

Edge kayıtları: https://supabase.com/dashboard/project/khgczybubufouraqyrcj/functions/market-places/logs. `market_places_result` satırları şu alanları içerir: `run_id`, `topic`, `status`, `safe_code`, `planned_calls`, `calls_used` ve yazılan kayıt sayıları. Gizli değer içermez.

## Geri alma
- Yalnız Places verisi yokken çalışır. Bu durumda `places_runs`, `places_*` içe aktarmaları ve `topics`, `city`, `county` dolu satırlar bulunmaz. Veri varsa `G12_ROLLBACK_DATA_PRESENT` hatasıyla durur.
- G8 şeması ve tabloları kalır; `imports.kind` kuralı eski haline döner.
- `core` şemasına dokunmaz.
