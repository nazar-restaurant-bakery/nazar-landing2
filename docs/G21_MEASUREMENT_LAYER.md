# G21: Ölçüm katmanı (catering siparişleriyle sınırlı)

Faz 2 · Görev 21. Kampanya kaynağı (UTM + gclid), catering siparişi, Clover webhook ile doğrulanmış ödeme ve müşteri kaydı tek görünümde birleşir. Her kampanya için kaç müşteri ve ne kadar ciro getirdiği hesaplanır, sonuç müşteri kaydına işlenir ve forvet tek bir fonksiyonla okur.

- **Migration:** `supabase/migrations/20261101000100_measurement_layer.sql`. Önkoşullar: K16 site siparişleri ve iade migration'ı (`20261030000100`), G8 `market` şeması.
- **Geri alma:** `supabase/rollbacks/20261101000100_measurement_layer_down.sql`
- **Testler:** `tests/measurementLayerDb.test.mjs` (veritabanı), `tests/cateringCheckoutUtm.test.mjs` (ödeme isteği)

## Kaynak nasıl yazılır
1. Ziyaretçi UTM'li bir bağlantıyla gelir. `src/lib/utm.ts` kaynağı sekme oturumunda (sessionStorage) tutar.
2. Catering ödeme formu PAY'de bu bağlamı ödeme isteğine ekler. Yalnız kabul edilen anahtarlar gider; `referrer` asla gönderilmez.
3. `functions/api/catering/checkout.ts` bağlamı doğrular (`functions/_lib/siteOrderUtm.ts`) ve sipariş RPC'sine `p_utm` olarak gönderir.
   - **Kabul edilen anahtarlar:** `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `gclid`, `fbclid`, `ttclid`, `landing_page` (yalnız yol).
   - **Değerler:** 1–200 karakter metin, kontrol karakteri yok.
   - **Bilinmeyen anahtar ya da geçersiz değer:** Kaynak hiç yazılmaz ve sipariş kaynaksız oluşur. Ödeme hiçbir zaman bu yüzden durmaz.
   - **UTM yoksa:** RPC isteği öncekiyle birebir aynıdır.
4. `public.site_order_create_v1` fonksiyonu yeni bir isteğe bağlı parametre alır: `p_utm` (varsayılan `NULL`). Değer `core.site_orders.utm` sütununa yazılır; veritabanı aynı kuralı yeniden denetler.
   - Kaynak, istek özetine (request hash) dahil değildir.
   - Veritabanında `p_utm` henüz yoksa (404), sipariş aynı istek kimliğiyle `p_utm` olmadan bir kez daha oluşturulur.

Ödeme mantığı, tutar, Clover çağrıları, webhook ve `order-status` değişmedi.

## Kaynak sınıfları
| Sınıf | Kural |
|---|---|
| `google_ads` | `gclid` var, ya da `utm_source=google` ve `utm_medium=cpc` |
| `other_campaign` | `utm_source` var (yukarıdaki dışında) |
| `unknown` | Kaynak yok. **Kampanya başarısı olarak gösterilmez.** Raporda ayrı bir satırda (`unattributed`) yer alır. |

## Görünümler ve fonksiyonlar
`core` şeması dışarıya kapalıdır.

| Nesne | Kim okur | Ne verir |
|---|---|---|
| `core.measurement_catering_orders_v1` (görünüm) | yalnız postgres | Sipariş bazında: sipariş kimliği, müşteri kimliği, test mi, ödeme durumu (`verified` / `refunded` / `unverified`), doğrulama zamanı ve tutarı, iade tutarı, ciro, UTM alanları, `has_gclid`, kaynak sınıfı |
| `core.measurement_campaign_summary_v1(business, from, to)` | yalnız postgres | Kaynak + kampanya için sipariş, tekil müşteri, doğrulanmış ciro, iade edilen sipariş ve tutar, Google Ads harcaması |
| `core.customer_campaign_attribution` (tablo) | yalnız postgres | Müşterinin ilk ve son atfedilen kampanyası: sınıf, kaynak, kampanya, tarih, sipariş; atfedilen sipariş sayısı ve ciro |
| `public.measurement_report_v1(business, from, to)` | yalnız `service_role` (forvet) | Dönem raporu (en çok 366 gün). Önce müşteri kaydını günceller. |
| `public.crm_customer_attribution_v1(customer)` | yalnız `crm.read` yetkili personel | Personel CRM'inde müşteri kartındaki "Atfedilen kampanya" bölümü |

**Ciro kuralları:**
- **Ciroya giren:** Yalnız ödemesi Clover webhook ile doğrulanmış (`site_order_payments.status='verified'`) catering siparişleri.
- **Tam iade:** Ciroya girmez; `refunded_orders` / `refunded_cents` olarak ayrı gösterilir.
- **Kısmi iade:** Cirodan düşülür.
- **Dönem:** Ödeme doğrulama tarihine göre hesaplanır (New York saati).
- **Test kayıtları hariçtir:** Test işletmesi, mevcut test sınıflandırıcısı (`core.test_lead_reason_v1`) ya da `is_test` işaretli müşteri.

**Müşteri eşleşmesi:**
1. Önce Clover sipariş eşleşmesine bakılır (`core.orders.customer_id`, durumu `exact` ya da `staff_resolved`).
2. Bulunamazsa siparişteki e-postanın müşteri kimliğine (`email:<adres>`) bakılır.
3. Eşleşme yoksa müşteri boş kalır; yeni müşteri oluşturulmaz.

**Müşteri kaydı:**
- Yalnız doğrulanmış, iade edilmemiş, test olmayan ve kaynağı bilinen siparişler yazılır.
- Kaynağı bilinmeyen sipariş müşteriye kampanya olarak yazılmaz.
- Sonradan tam iade edilen siparişin tek atfı varsa kayıt silinir.
- Kayıt, forvet raporu okunurken ve personel müşteri kartını açarken güncellenir.

**Google Ads harcaması:**
- `utm_campaign` bir kampanya kimliğiyse (yalnız rakam), aynı dönemdeki `market.ad_reports` harcamasının toplamı yanına yazılır.
- Eşleşme yoksa harcama `null` olur; uydurulmaz.

## Okuma sorgusu (forvet)
```sql
-- service_role ile (PostgREST: POST /rest/v1/rpc/measurement_report_v1)
SELECT jsonb_pretty(public.measurement_report_v1('a358eba4-b197-4309-805b-46f43a718454', '2026-11-01', '2026-11-30'));
```
Örnek yanıt:
```json
{ "period_start": "2026-11-01", "period_end": "2026-11-30", "currency": "USD", "scope": "catering_site_orders",
  "campaigns": [ { "source_class": "google_ads", "utm_source": "google", "utm_medium": "cpc", "utm_campaign": "123456789",
                   "orders": 1, "customers": 1, "revenue_cents": 10000, "refunded_orders": 0, "refunded_cents": 0,
                   "ad_spend_usd": 65.5 } ],
  "unattributed": { "orders": 1, "revenue_cents": 7000 },
  "refunds": { "orders": 0, "refunded_cents": 0 },
  "attributed_customers": 1 }
```

SQL Editor'da (postgres) sipariş bazında kontrol:
```sql
SELECT site_order_id, customer_id, revenue_state, revenue_cents, refunded_cents, source_class, utm_source, utm_campaign, verified_at
FROM core.measurement_catering_orders_v1 WHERE NOT is_test ORDER BY ordered_at DESC LIMIT 20;
```

## Test 33 akışı
1. Gizli pencerede şu adresi aç: `https://www.nazarrestaurantandbakery.com/catering?utm_source=google&utm_medium=cpc&utm_campaign=<kampanya kimliği>`
2. Sitede başka bir sayfaya geçip catering'e dön; kaynak sekme boyunca korunur.
3. Gerçek bilgilerle bir tepsi seç, PAY'e bas ve Clover'da öde.
4. Ödeme dönüş sayfasında "Payment received" mesajını gör.
5. SQL Editor'da yukarıdaki sipariş sorgusunu çalıştır. Son sipariş için şunlar görünmeli:
   - `revenue_state='verified'`
   - `source_class='google_ads'`
   - `utm_campaign` = kampanya kimliği
   - `revenue_cents` = ödenen tutar
   - `customer_id` müşteri kaydıyla eşleşmiş; e-posta kimliği ya da Clover eşleşmesiyle, eşleşme yoksa boş
6. Forvet sorgusunu bugünün tarihiyle çalıştır. İlgili kampanya satırında `orders=1`, `revenue_cents` ve varsa `ad_spend_usd` görünmeli.
7. Personel CRM'inde müşteriyi aç. "Atfedilen kampanya" bölümünde "İlk" ve "Son" satırlarında Google Ads kampanyası görünmeli.
8. Test siparişi iade edilirse aynı sorgularda `revenue_state='refunded'` görünmeli; ciro düşer ve müşteri kaydındaki atıf kalkar.

## Google Ads önerisi: hesap düzeyi Final URL suffix
Google Ads → Admin → Account settings → Tracking → Final URL suffix:

```
utm_source=google&utm_medium=cpc&utm_campaign={campaignid}
```

Bu ayarla her reklam tıklaması kampanya kimliğiyle gelir. Kimlik, `market.ad_reports.campaign_id` ile aynı olduğu için harcama ve ciro yan yana çıkar. Ayar yapılmazsa yalnız `gclid` ile gelen siparişler `google_ads` sınıfında kampanyasız görünür.

## Yayın sırası
1. Migration `20261101000100` uygulanır. G20 PR'ının birleşmesinden bağımsızdır, ancak bu PR'dan önce uygulanmalıdır.
2. PR birleşir ve site yayınlanır. Kod sırası ters olsa da ödeme durmaz (404'te `p_utm` olmadan yeniden deneme), ama o arada kaynak yazılmaz.

## Geri alma
- Siparişlere UTM yazılmışsa `G21_ROLLBACK_DATA_PRESENT` hatasıyla durur; veri kaybı olmaz.
- Veri yoksa ölçüm katmanını kaldırır ve `site_order_create_v1` fonksiyonunu K16'daki özgün haline (`p_utm` yok) döndürür.
- Test, döndürülen fonksiyon gövdesinin K16'dakiyle aynı olduğunu doğrular.
