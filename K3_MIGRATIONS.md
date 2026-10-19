# K3 migration inventory — yeni Supabase test project

K3, Talip'in oluşturacağı ayrı Supabase test project üzerinde tek sentetik Nazar-test kurulumu için hazırlanır. Mevcut Nazar project/business ayarları değişmez ve bu paket tarafından test edilmez. Yeni uygulama kodu yalnız yeni test project ve test business için verilen environment değerlerini kullanmalıdır. PR #52 ve #53 kendi dallarında bekler; Ops migration bu baseline'a dahil değildir.

Bu paket `origin/main` commit `aa53f6d5fb5c02f814cfbba13a1b57df08874e62` üzerindeki historical SQL kaynaklarını ve bağımlılıklarını kaydeder. SQL çalıştırmaz, database başlatmaz, bağlantı kurmaz veya secret okumaz. Canonical test migration zinciri henüz review edilmediği ve yeni test project runtime kontrolleri yapılmadığı için readiness **BLOCKED** durumundadır.

## Kaynaklar ve kapsam

- `database/` altında 18 incremental SQL dosyası vardır. Bunlar var olan foundation'ı bekler; repo tek başına tam clean `supabase db reset` zinciri içermez.
- [legacy/01_KURULUM.sql](tools/test-env/legacy/01_KURULUM.sql), çalışma klasöründeki `03_Nazar_Supabase_Kurulum/01_KURULUM.sql` dosyasının byte olarak aynı kopyasıdır. Orijinal SHA-256: `1a3da1c31f5dceb714b187b785ce471e6a705b7572f31936c1485168c738889b`. Historical reference olarak saklanır; yeni test project'e uygulanacak migration değildir. Line 9'daki human confirmation placeholder değiştirilmedi.
- Üç SQL test/rollback kaynağı migration değildir: `tests/fixtures/crmNoteAuthors.before.sql`, `tests/formErrorMonitoring.rollback.sql`, `tests/klaviyoOptout.rollback.sql`. PGlite testlerindeki inline minimal schema'lar da tam Supabase foundation yerine geçmez.
- Eski Anatolia reconciliation, marketing bridge, pg_cron veya arşivdeki site-order taslakları bu manifest'in kaynağı değildir. Başka projedeki DDL ve veriler kullanılmaz.
- PR #53'ün `supabase/migrations/20261018_ops_panel.sql`, commission fixture'ı ve Ops adapters bu K3 branch'ine taşınmaz. Baseline'da bulunmayan financial/offer setter kurulumları yapılmış gibi gösterilmez.
- Yeni additive `supabase/migrations/20261019000100_test_record_markers.sql`, businesses/customers/offers `is_test` alanlarını eklemek üzere hazırlanmıştır. Öncesinde reviewed canonical baseline gerekir; migration tek başına tam schema değildir. Bu pending kaynak ayrıca checksum ile izlenir.

Checksum kontrolünde yalnız CRLF → LF normalizasyonu yapılır. SQL metni, whitespace, project guards veya CHECK'ler dönüştürülmez. Manifest hem taşınabilir LF SHA-256 hem bu çalışma kopyasındaki raw-byte SHA-256 değerini kaydeder. Historical foundation ilk kopyada byte olarak aynıdır; Git'in line-ending dönüşümü ayrıca raporlanır.

## Historical dependency sırası

Bu sıra yeni test project'e uygulanacak SQL listesi değildir. Tarih/sözlük sırasının yerine gözlenen historical bağımlılıkları gösterir. `migration-manifest.json` içindeki bütün historical kaynaklar `executable:false` durumundadır.

| Sıra | Historical kaynak | Gerekli öncül / koşul |
|---|---|---|
| 0 | `01_KURULUM.sql` | Historical foundation; human project guard içerir |
| 1 | `20260923_form_intake_cutover.sql` | Foundation + `submit_signup`; cutover koşulları ayrı |
| 2 | `20261011_crm_staff_draft.sql` | Foundation + Supabase Auth |
| 3 | `20261012_crm_unified_view.sql` | Customers, signups, CRM staff |
| 4 | `20261012_signup_retry_idempotency.sql` | Foundation `submit_signup` |
| 5 | `20261013_crm_staff_authorized.sql` | CRM staff |
| 6 | `20261013_crm_follow_up_tasks.sql` | Customers + CRM staff |
| 7 | `20261013_catering_decision_queue.sql` | Catering + CRM staff |
| 8 | `20261013_catering_decision_owner_guard.sql` | Decision queue + CRM staff |
| 9 | `20261013_catering_decision_notifications.sql` | Decision queue; yalnız outbox kaydı |
| 10 | `20261013_catering_staff_notification.sql` | Signup request keys + catering + CRM staff |
| 11 | `20261013_test_record_exclusion.sql` | Signups/catering + CRM overview; test flags ekler |
| 12 | `20261015_form_error_monitoring.sql` | CRM staff + signup request keys |
| 13 | `20261015_form_error_setup_test.sql` | Form-error table ve named CHECK |
| 14 | `20261015_klaviyo_optout_return.sql` | Customers + consent events + CRM staff |
| 15 | `20261016_catering_assignee_whitespace.sql` | Exact prior `crm_update_catering` definition hash |
| 16 | `20261016_crm_follow_up_queue.sql` | Tasks + decisions + test flags; function henüz bulunmamalı |
| 17 | `20261016_crm_note_authors.sql` | Exact prior `crm_overview_v2` definition hash |
| Hariç | `20260923_form_intake_pause.sql` | Emergency rollback; normal replay'e eklenirse intake kapanır |

`decision_notifications` ve `decision_owner_guard` alfabetik olarak `decision_queue` önüne gelebilir; bu sıra geçersizdir. Dosyaların tamamını alfabetik sırayla çalıştıran bir komut hazırlanmadı.

## Canonical test migration stratejisi

1. Yeni, review edilebilir bir environment-neutral baseline hazırlanır. Historical foundation'ın table, grant ve public RPC sözleşmeleri kaynak olarak kullanılır; historical project declaration yeni test project'e kopyalanmaz. Manifest'teki canonical baseline path bu kaynak henüz mevcut olmadığı için `null` durumundadır.
2. Yeni test installation kaydı yeni project'i açıkça tanımlar. Historical SQL guards atlanmaz veya hosted test project'e mevcut project'in installation kimliği yazılmaz. Historical kaynaklar provenance olarak değişmeden kalır.
3. Güncel RPC davranışları canonical baseline'da açık DDL olarak tanımlanır. Hash-guarded historical patch'i uydurulmuş bir before-definition üzerinden geçirerek başarı üretme yolu kullanılmaz. Yeni test schema'nın kararları ve source karşılıkları ayrıca review edilir.
4. Businesses/customers/offers test flags'i ayrı additive migration ile görünürdür. Signup/catering test flags'i historical patch'te line 8–11'de tanımlıdır. Sadece bir test fixture'ına sütun eklemek schema migration kanıtı sayılmaz. Seed kayıtlarının tümü açıkça `is_test=true` olmalıdır.
5. `core` Data API exposed schema listesine eklenmez. Foundation'ın private schema, RLS ve dar public RPC sınırı korunur (historical foundation line 32–36, 250–265). Yeni test stack üzerinde anon ve unlisted/inactive staff erişim reddi, private tablo görünmezliği ve izinli RPC davranışları gerçekten kontrol edilir.
6. Yeni test project'e canonical zincir uygulanıp Auth/PostgREST/Storage kapsamı doğrulanmadan K3 tamamlandı işareti verilmez. Bu script yalnız provenance integrity raporlar; deployment veya runtime sonucu üretmez.

Yeni environment adları [K3_PREVIEW.md](K3_PREVIEW.md) içinde tanımlıdır:

- Browser: `VITE_APP_ENV=isolated-test`, `VITE_TEST_SUPABASE_URL`, `VITE_TEST_SUPABASE_ANON_KEY`, `VITE_TEST_BUSINESS_ID`, `VITE_TEST_TURNSTILE_SITE_KEY`.
- Server: `APP_ENV=isolated-test`, `TEST_SUPABASE_URL`, `TEST_BUSINESS_ID`, `TEST_SUPABASE_SECRET_KEY`, `TEST_TURNSTILE_SECRET_KEY`.

Secret değerleri manifest'e, SQL kaynaklarına veya test raporuna girmez.

## Kalan migration / deployment koşulları

- **Reviewed neutral baseline bekleniyor.** Historical foundation line 9, 13–15 ve 266–267 human project declaration bekler. Bu audit token doldurmaz, current installation kaydını kopyalamaz veya SQL uygulamaz.
- **Exact function patch bağlamı doğrulanmadı.** Assignee patch line 11, `pg_get_functiondef` MD5'inin `6964b069513cb32409e80319ce490131` olmasını ister. Note-author patch line 10–13 de exact before/already-applied hash'lerini kontrol eder. Bu dosyalar doğrudan yeni test project'in canonical zinciri olarak kullanılamaz; güncel sözleşmelerin açık DDL karşılığı review edilmelidir.
- **Yeni Supabase runtime doğrulaması yapılmadı.** Auth, PostgREST, Storage, exposed schemas ve JWT/role davranışları ayrı test project üzerinde kontrol gerektirir. Local PostgreSQL/PGlite veya SDK mock sonucu bu hosted kapsamın yerine geçmez.

Ayrı bir native compatibility probe raporu varsa kullanılan simulated metadata ve local fixture kapsamı açıkça belirtilir. Bu kanıt, canonical migration veya hosted test project kurulumu olarak sunulmaz.

## Tekrarlanabilir kaynak kontrolü

```text
node tools/test-env/audit-migrations.mjs --json
node tools/test-env/audit-migrations.mjs --integrity-only --json
node --test tests/testEnvMigrations.test.mjs
```

İlk komut `readiness: BLOCKED` ve exit code `2` verir. İkinci komut checksum/order kapsamı doğruysa exit code `0` verebilir; JSON içindeki readiness yine BLOCKED kalır. Testler checksum değişimini, unutulan SQL'i, emergency pause'un replay'e alınmasını, bozuk dependency sırasını, unsafe path'leri ve metadata düzenleyerek yanlış hazır sonucu üretme girişimini kontrol eder. SQL, Auth veya provider çağrısı çalıştırmaz.
