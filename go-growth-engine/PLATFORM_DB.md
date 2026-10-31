# GO ↔ platform veritabanı

GO, Nazar-production'daki `core` tablolarına **doğrudan erişmez**. Tek giriş noktası
`src/lib/supabase-client.ts` içindeki `goRpc()`; yalnız `public.go_*_v1` fonksiyonlarını çağırır
(sıra 31 `supabase/migrations/20261030000400_go_platform_access.sql`; gönderim için sıra 32
`supabase/migrations/20261030000500_go_dispatch_smartlead.sql`).

Bu fonksiyonların ortak kuralları:
- `SECURITY DEFINER`, `search_path=''`.
- `EXECUTE` yalnız `service_role`'e açık; `anon` ve `authenticated` için kapalı.
- Her fonksiyon ayrıca `auth.role()='service_role'` kontrolü yapar.
- Veri okuyan ya da yazan her fonksiyon `p_business_id` ile sınırlıdır.
- Engel listesinden silme ya da kayıt kaldırma yapan bir fonksiyon yoktur.

Ortam değişkenleri: `GO_SUPABASE_URL`, `GO_SUPABASE_SERVICE_ROLE_KEY` (adlar değişmedi), `SMARTLEAD_API_KEY`,
`SMARTLEAD_WEBHOOK_SECRET`, `GO_UNSUBSCRIBE_SECRET`, `APOLLO_API_KEY`, `GO_SCHEDULER_ENABLED` (`"false"`).
`RESEND_API_KEY` ve `RESEND_WEBHOOK_SECRET` artık kullanılmıyor.
Yeni `sb_secret_` anahtarı yalnız `apikey` başlığında gönderilir.

## Veritabanına dokunan yerler (önce → sonra)

| Dosya | Önce (doğrudan, `core` şeması) | Tür | Sonra |
|---|---|---|---|
| `src/index.ts` `requireBusinessId` | `businesses` (`id`) | okuma | `go_api_key_authorize_v1` |
| `src/lib/api-key.ts` `findActiveApiKeyId` | `api_keys` (`id`, `key_hash`, `revoked_at`) | okuma | `go_api_key_authorize_v1` |
| `src/lib/api-key.ts` `isApiKeyBoundToBusiness` | `api_key_businesses` (`api_key_id`, `business_id`) | okuma | `go_api_key_authorize_v1` |
| `src/lib/business-settings.ts` `getBusinessSettings` | `business_settings` (`business_id`, `outreach_*`, `enrichment_*_credit_limit`) | okuma | `go_outreach_settings_get_v1` (platformda `core.outreach_settings`) |
| `src/lib/business-settings.ts` `listBusinessSettings` | `business_settings` (tümü, `business_id` sırası) | okuma | `go_outreach_business_ids_v1` + `go_outreach_settings_get_v1` |
| `src/modules/apollo/b2b-miner.ts` | `b2b_leads` upsert (`business_id,apollo_person_id` çakışmada yok say) | yazma | `go_leads_insert_v1` |
| `src/modules/apollo/enricher.ts` `getRemainingCredits` | `enrichment_log` (`credits_used`, `created_at`, `business_id`) | okuma | `go_enrichment_credits_used_v1` |
| `src/modules/apollo/enricher.ts` `enrichLeads` | `b2b_leads` (`id, email, apollo_person_id, metadata`; `status='enrichment_pending'`) | okuma | `go_leads_enrichment_pending_v1` |
| `src/modules/apollo/enricher.ts` `enrichOne` | `enrichment_log` insert (`business_id, b2b_lead_id, apollo_person_id, credits_used, result`) | yazma | `go_enrichment_log_v1` |
| `src/modules/apollo/enricher.ts` `enrichOne` (API hatası) | `b2b_leads` update (`metadata`, `updated_at`; pending iken) | yazma | `go_lead_enrichment_note_v1` |
| `src/modules/apollo/enricher.ts` `enrichOne` (kopya kontrolü) | `b2b_leads` okuma (`id`; aynı `email`) | okuma | `go_lead_enrichment_found_v1` |
| `src/modules/apollo/enricher.ts` `enrichOne` (bulundu) | `b2b_leads` update (`email`, `status='new'`, `updated_at`) | yazma | `go_lead_enrichment_found_v1` |
| `src/modules/apollo/enricher.ts` `markFailed` | `b2b_leads` update (`status='enrichment_failed'`, `metadata`, `updated_at`) | yazma | `go_lead_enrichment_fail_v1` |
| `src/modules/outreach/lead-importer.ts` | `b2b_leads` okuma (`id, email, contact_name, title, company_name`) | okuma | `go_leads_by_email_v1` |
| `src/modules/outreach/lead-importer.ts` | `b2b_leads` insert | yazma | `go_leads_insert_v1` |
| `src/modules/outreach/lead-importer.ts` | `b2b_leads` update (boş `contact_name/title/company_name`) | yazma | `go_lead_fill_v1` |
| `src/modules/outreach/unsubscribe.ts` `suppressEmail` | `email_suppressions` upsert (çakışmada yok say) | yazma | `go_suppress_email_v1` |
| `src/modules/outreach/unsubscribe.ts` `suppressEmail` | `b2b_leads` update (`status`, `updated_at`; aynı `email`) | yazma | `go_suppress_email_v1` |
| `src/modules/outreach/unsubscribe.ts` `isEmailSuppressed` | `email_suppressions` (`email`) | okuma | `go_suppressed_emails_v1` |
| `src/modules/outreach/email-sequencer.ts` `countSentToday` | `message_log` sayım (`status in reserved,sent`, `created_at`) | okuma | `go_dispatch_quota_v1` (sıra 32) |
| `src/modules/outreach/email-sequencer.ts` `sendNextStep` / `runDue` | `b2b_leads` okuma; RPC `check_and_reserve_dispatch_gate_v2`; `message_log` update (`status`, `payload`, `sent_at`, `provider_message_id`); `b2b_leads` update (`status`, `sequence_step`, `next_step_at`) | okuma+yazma | `go_dispatch_due_v1` → `go_dispatch_reserve_v1` (tek 168 saat kapısı) → Smartlead → `go_dispatch_result_v1` |
| `src/modules/webhooks/resend-webhook.ts` (kaldırıldı) | `message_log` (`provider_message_id`); `b2b_leads` (`email`) | okuma | yerine `src/modules/webhooks/smartlead-webhook.ts`: `go_smartlead_business_v1` + `go_smartlead_event_v1` |
| `scripts/create-api-key.ts` | `api_keys` insert; `api_key_businesses` insert; hata olursa `api_keys` delete | yazma | `go_api_key_create_v1` (tek işlem, silme yok) |
| `scripts/revoke-api-key.ts` | `api_keys` okuma (`id, name`, `key_prefix`); `api_keys` update (`revoked_at`) | okuma+yazma | `go_api_key_revoke_v1` |
| `scripts/import-apollo-csv.ts` | `businesses` (`id`) | okuma | `go_business_check_v1` |
| `scripts/import-apollo-csv.ts` | `email_suppressions` (`email`) | okuma | `go_suppressed_emails_v1` |
| `scripts/import-apollo-csv.ts` | `b2b_leads` okuma (`id, email, metadata`, doldurulabilir alanlar) | okuma | `go_leads_by_email_v1` |
| `scripts/import-apollo-csv.ts` | `b2b_leads` insert / update (boş alanlar, eksik metadata anahtarları) | yazma | `go_leads_insert_v1` / `go_lead_fill_v1` |
| *(yeni)* `POST /api/growth/platform/verify`, `npm run platform:verify` | — | okuma | `go_platform_verify_v1` |

## Gönderim (Görev 6 + 7)

- **Tek kapı:** Her e-posta `go_dispatch_reserve_v1` ile platformdaki `core.message_log` ve
  `core.message_send_settings` (168 saat) üzerinden ayrılır. Kapı şunları kontrol eder:
  - adayın kendi geçmişi ve aynı adrese giden her mesaj (müşteri dahil),
  - günlük sınır (`outreach_settings.daily_send_limit`),
  - engel listesi,
  - aday durumu (`on_hold`, `replied`, `unsubscribed` ve `bounced` gönderilmez).
- **Smartlead:** Her dizi adımı ayrı, tek adımlı bir kampanyadır: adım 1 = gün 1, adım 2 = gün 8, adım 3 = gün 15.
  - GO konu ve gövdeyi hazırlar ve adayı adım kampanyasına ekler.
  - Gövdede fiziksel adres ve GO'nun abonelikten çıkma bağlantısı bulunur.
  - Kayıt, Smartlead'den `EMAIL_SENT` olayı gelince `sent` olur; sonraki adım 7 gün sonra yine kapıdan geçer.
- **Olaylar** (`POST /webhooks/smartlead/<SMARTLEAD_WEBHOOK_SECRET>`):
  - `EMAIL_REPLY` diziyi durdurur (`replied`).
  - `EMAIL_BOUNCE` ve `LEAD_UNSUBSCRIBED` adresi engel listesine ekler.
  - Eşleşmeyen olaylar da kaydedilir.
- **Doğrulanmış adres:** Adrese yalnız Apollo `verified` sonucu ya da CSV'de `Email Status = Verified` ile e-posta yazılır (değişmedi).
- **Kaldırılanlar:** Resend soğuk e-posta parçaları (`mailer.ts`, Resend webhook'u, `/api/growth/email/test`) ve Apollo demo modu (anahtar yoksa 503).
- **Değişmeyenler:** Sahte Apify modülü. `GO_SCHEDULER_ENABLED` kapalı kalır.

### Smartlead panelinde (Talip)
Üç kampanya açılır; adım 1, 2 ve 3 için birer tane. Her birinde:
1. **Sequence:** tek adım, gecikme 0 gün, konu `{{go_subject}}`, gövde `{{go_body}}`.
2. **Ayarlar:** cevapta dur (*stop on reply*); açılma ve tıklama izleme kapalı.
3. **Posta kutuları ve takvim:** gönderen posta kutuları bağlanır; gönderim takvimi `outreach_settings` penceresiyle aynı olur.
4. **Webhook:** `https://<go-growth-engine adresi>/webhooks/smartlead/<SMARTLEAD_WEBHOOK_SECRET>`. Olaylar: `EMAIL_SENT`, `EMAIL_REPLY`, `EMAIL_BOUNCE`, `LEAD_UNSUBSCRIBED`.

Sonra kampanya kimlikleri platforma yazılır:
`npm run smartlead:setup -- --business <uuid> --campaigns <adım1>,<adım2>,<adım3> --commit`
Komut kampanyaları yalnız okur; Smartlead'e yazmaz.

## Doğrulama (salt okunur)

```bash
npm ci
npm run platform:verify -- --business a358eba4-b197-4309-805b-46f43a718454
```

Beklenen sonuç: 85 aday (38 `new`, 10 `contacted`, 36 `on_hold`, 1 `unsubscribed`), 8 engel kaydı, 1 `outreach_settings` satırı.
Aynı sonuç, işletmeye bağlı bir GO API anahtarıyla `POST /api/growth/platform/verify` ucundan da alınabilir.
Gövde: `{"business_id":"a358eba4-b197-4309-805b-46f43a718454"}`.

## Testler

```bash
npm test                   # GO birim testleri (sahte RPC ve sahte Smartlead; ağ ya da gizli değer yok)
npx tsc --noEmit -p .
# depo kökünde, yerel PostgreSQL 18.6:
node --experimental-strip-types --test tests/goPlatformAccessDb.test.mjs tests/goDispatchSmartlead.test.mjs
```
