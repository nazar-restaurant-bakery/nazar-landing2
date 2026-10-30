# GO ↔ platform veritabanı

GO, Nazar-production'daki `core` tablolarına **doğrudan erişmez**. Tek giriş noktası
`src/lib/supabase-client.ts` içindeki `goRpc()`; yalnız `public.go_*_v1` fonksiyonlarını çağırır
(migration `supabase/migrations/20261030000400_go_platform_access.sql`, sıra 31).

Bu fonksiyonların ortak kuralları:
- `SECURITY DEFINER`, `search_path=''`.
- `EXECUTE` yalnız `service_role`'e açık; `anon` ve `authenticated` için kapalı.
- Her fonksiyon ayrıca `auth.role()='service_role'` kontrolü yapar.
- Veri okuyan ya da yazan her fonksiyon `p_business_id` ile sınırlıdır.
- Engel listesinden silme ya da kayıt kaldırma yapan bir fonksiyon yoktur.

Ortam değişkeni adları değişmedi: `GO_SUPABASE_URL`, `GO_SUPABASE_SERVICE_ROLE_KEY`.
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
| `src/modules/outreach/email-sequencer.ts` `countSentToday` | `message_log` sayım (`status in reserved,sent`, `created_at`) | okuma | **Görev 6/7** — şimdilik 503 `dispatch_not_migrated` |
| `src/modules/outreach/email-sequencer.ts` `sendNextStep` | `b2b_leads` okuma; RPC `check_and_reserve_dispatch_gate_v2`; `message_log` update (`status`, `payload`, `sent_at`, `provider_message_id`); `b2b_leads` update (`status`, `sequence_step`, `next_step_at`) | okuma+yazma | **Görev 6/7** — şimdilik `dispatch_not_migrated`, veritabanına dokunmaz |
| `src/modules/outreach/email-sequencer.ts` `runDue` | `b2b_leads` okuma (zamanı gelenler) | okuma | **Görev 6/7** — şimdilik lead seçmez |
| `src/modules/webhooks/resend-webhook.ts` | `message_log` okuma (`provider_message_id`); `b2b_leads` okuma (`email`) | okuma | **Görev 7** — bounce/complaint 503 (Resend yeniden dener) |
| `scripts/create-api-key.ts` | `api_keys` insert; `api_key_businesses` insert; hata olursa `api_keys` delete | yazma | `go_api_key_create_v1` (tek işlem, silme yok) |
| `scripts/revoke-api-key.ts` | `api_keys` okuma (`id, name`, `key_prefix`); `api_keys` update (`revoked_at`) | okuma+yazma | `go_api_key_revoke_v1` |
| `scripts/import-apollo-csv.ts` | `businesses` (`id`) | okuma | `go_business_check_v1` |
| `scripts/import-apollo-csv.ts` | `email_suppressions` (`email`) | okuma | `go_suppressed_emails_v1` |
| `scripts/import-apollo-csv.ts` | `b2b_leads` okuma (`id, email, metadata`, doldurulabilir alanlar) | okuma | `go_leads_by_email_v1` |
| `scripts/import-apollo-csv.ts` | `b2b_leads` insert / update (boş alanlar, eksik metadata anahtarları) | yazma | `go_leads_insert_v1` / `go_lead_fill_v1` |
| *(yeni)* `POST /api/growth/platform/verify`, `npm run platform:verify` | — | okuma | `go_platform_verify_v1` |

Gönderim kapısı (168 saat) ve gönderim kaydı Görev 6/7'de taşınacak. Platformdaki `core.message_log`,
GO'nun kullandığı `campaign_type`, `payload` ve `provider_message_id` sütunlarını içermiyor.
`GO_SCHEDULER_ENABLED` kapalı kalır. Apollo demo modu ve sahte Apify modülü değişmedi.
`src/lib/mailer.ts` (Resend) değişmedi.

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
npm test                   # GO birim testleri (sahte RPC; ağ ya da gizli değer yok)
npx tsc --noEmit -p .
# depo kökünde, yerel PostgreSQL 18.6:
node --experimental-strip-types --test tests/goPlatformAccessDb.test.mjs
```
