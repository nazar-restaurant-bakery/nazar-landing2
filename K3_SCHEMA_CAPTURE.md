# K3 — private schema capture ve sandbox recovery

Bu araç hazırlık ve evidence capture içindir. `capture-schema.py` hiçbir migration, reset, restore, DDL veya dış mesaj çalıştırmaz. Production’dan yalnız `core` / `public` schema tanımları ve PostgreSQL catalog metadata alınır; production satırı alınmaz. Sandbox modunda ayrıca tam dört reserved-email + TEST/VERIFY marker’lı catering order ve bir anonim staff kaydı için ayrı, açıkça sınırlandırılmış recovery export yapılır.

Gerçek bağlantı yerel masked GUI’de kullanıcı başlattığında açılır. Import, varsayılan CLI ve `--validate-config` yalnız yerel kontrol yapar. Bu değişiklikte testler DB bağlantısını mock eder; hosted capture veya gerçek restore kanıtı değildir.

## Yerel prerequisites

- Python 3 ve Tkinter; PostgreSQL `psql.exe`, `pg_dump.exe`, `pg_restore.exe`. `pg_dump` major sürümü source server’dan eskiyse işlem durur.
- Supabase dashboard’da doğrulanmış direct veya **session pooler** bağlantısı; port 5432, database `postgres`. Transaction pooler kabul edilmez.
- Resmi Supabase CA dosyası. Her bağlantı `verify-full` kullanır; TLS hatasında otomatik `require` / başka host fallback yoktur.
- Git dışında, mevcut iki özel output parent klasörü. Her capture yeni timestamp + UUID alt klasörüne yazılır; önceki capture üzerine yazılmaz. Windows’ta child klasörü oluşturulduktan sonra current user ve SYSTEM ACL sınırı kurulmadan hiçbir DB bağlantısı açılmaz.

Server target ve bütün dosya yolları environment üzerinden verilir; yeni source içinde proje ref, business UUID veya key değeri yoktur:

| Variable | Değerin amacı |
| --- | --- |
| `SCHEMA_PG_BIN` | Yerel PostgreSQL `bin` klasörünün mutlak yolu |
| `SCHEMA_PRODUCTION_PRIVATE_ROOT` | Private production schema parent klasörü |
| `SCHEMA_SANDBOX_PRIVATE_ROOT` | Private sandbox recovery parent klasörü |
| `SCHEMA_PRIVATE_ROOT` | Mode-specific root verilmediyse açıkça seçilen ortak root |
| `SCHEMA_PRODUCTION_PROJECT_REF`, `SCHEMA_SANDBOX_PROJECT_REF` | İki farklı dashboard project ref |
| `SCHEMA_PRODUCTION_HOST`, `SCHEMA_SANDBOX_HOST` | Dashboard direct / session-pooler host |
| `SCHEMA_PRODUCTION_PORT`, `SCHEMA_SANDBOX_PORT` | `5432` |
| `SCHEMA_PRODUCTION_USER`, `SCHEMA_SANDBOX_USER` | Direct için `postgres`; pooler için ilgili ref’e bağlı user |
| `SCHEMA_PRODUCTION_DATABASE`, `SCHEMA_SANDBOX_DATABASE` | `postgres` |
| `SCHEMA_PRODUCTION_SSLROOTCERT`, `SCHEMA_SANDBOX_SSLROOTCERT` | Güvenilen CA dosyasının mutlak yolu |
| `SCHEMA_STATUS_FILE` | İsteğe bağlı, Git dışı mevcut parent içindeki `capture-status.json`, `production-capture-status.json` veya `sandbox-capture-status.json` |

Environment içinde database password hazırlanmaz. GUI’de seçili database’in **mevcut database password**’ü girilir; Supabase web, CRM veya archive password istenmez. Password komut satırına, dosyaya, manifest’e veya status JSON’a yazılmaz. Yalnız ilgili child process environment’ına aktarılır; inherited bütün `PG*` ayarları temizlenir. Python immutable string belleği için forensic zeroing garantisi verilmez.

Environment hazırlandıktan sonra yerel kontroller:

```powershell
& $env:SCHEMA_PYTHON tools/test-env/capture-schema.py --validate-config PRODUCTION
& $env:SCHEMA_PYTHON tools/test-env/capture-schema.py --validate-config SANDBOX
& $env:SCHEMA_PYTHON tools/test-env/capture-schema.py --gui
```

`SCHEMA_PYTHON` yalnız launcher’ın seçtiği yerel Python executable yoludur; tool tarafından DB configuration olarak okunmaz. İlk iki komut DB’ye bağlanmaz. GUI kullanıcı düğmesine basılmadan DB’ye bağlanmaz. Seçim değişince password ve checkbox temizlenir. İş sürerken seçim, tekrar başlatma ve pencere kapatma engellenir. Sabit error category ve seçili database adı gösterilir; raw server yanıtı gösterilmez.

## Capture kapsamı ve provenance

`psql --no-psqlrc` ile sabit metadata sorgusu explicit read-only transaction içinde çalışır. Bütün DB child process’lerde ayrıca `default_transaction_read_only=on`, connection / statement / lock timeout ve TLS verification vardır. `pg_dump --schema-only --format=custom --schema=core --schema=public` data export etmez. `auth`, `storage`, Vault, realtime, migration history ve diğer managed schema tanımları alınmaz. Application tanımlarındaki Auth FK / function references source kanıtı olarak kalabilir; managed schema kopyalanması anlamına gelmez.

Her klasörde:

- `catalog.json`: yalnız object metadata; function body / müşteri satırı içermez. `pg_depend.deptype='e'` olan extension-owned nesneler application candidate catalog’dan çıkarılır.
- `raw-schema.dump`: private schema-only custom archive.
- `raw-toc.list`: archive TOC. TABLE DATA, MATERIALIZED VIEW DATA, SEQUENCE SET ve large-object data descriptor görülürse işlem durur.
- `schema.sql`: `pg_restore --schema-only --file=...` ile **yalnız yerel dosyaya** çıkarılan raw review girdisi. Bu alt süreçten bütün `PG*` değerleri kaldırılır; hiçbir `--dbname` / restore connection yoktur.
- `allowlist-review.json`: exact catalog OID eşleşen `core` / `public` application adayları, dışlanan nesneler ve çözülmemiş ACL / dependency entry’leri. Bütün `include` değerleri başlangıçta `false` ve `review_complete=false` olur.
- `capture-manifest.json` ve `source-proof.json`: timestamp, source ref, server/tool sürümü, SHA256 hash’ler, kapsam, `replay_ready=false`. Production `data_exported=false`; başarılı sandbox recovery için dört marker-classified order ve bir anonymous staff export ayrıca belirtilir. Synthetic free-form contents review otomatik kabul edilmez.

Raw `public` schema içinde extension’a ait olmayan platform routine’leri bulunabilir. Bu nedenle raw dump / raw `schema.sql` **allowlist uygulanmış canonical baseline değildir**. Şablonun candidate listesinde görünmesi approval anlamına gelmez. Tool reviewed migration üretmez veya uygulamaz.

## Sandbox recovery için ek gate

Sandbox modunda tek sabit read-only sorgu, aynı statement snapshot’ında toplam order=4, her order için reserved `example.com/net/org` veya `.invalid` email **ve** TEST/VERIFY name marker, staff=1 koşullarını kontrol eder. Sayı / sınıflandırma değişirse order payload döndürülmez ve export durur. Production modunda bu sorgu hiç çağrılmaz.

`catering-orders.json` server’ın `jsonb_agg(... ORDER BY id)::text` sonucunun exact UTF-8 bytes’ıdır; yeniden serialize edilmez. Server SHA256 ile dosya SHA256 eşleşmeden kabul edilmez. `staff-anonymous.json` yalnız pseudonym, active, auth_linked ve bilinmeyen role için `null` içerir. Auth UUID, email, gerçek staff adı, Auth satırı veya session export edilmez.

`recovery-source-proof.json` başlangıçta `markerClassificationPassed=true`, `allRowsReviewedSynthetic=false`, `freeFormReviewPending=true`, `localRestoreProof=false` bırakır. Marker’lar preparation note, tray JSON, checkout identifier veya başka alanın içeriğinin güvenli/synthetic olduğunu tek başına kanıtlamaz. Codex'in tam içerik incelemesi kayda geçmeden recovery validator fail closed kalır. Hiçbir source capture adımı başarılı restore iddiası üretmez.

## Review → canonical baseline → reset gate

1. Private capture manifest / file hash’lerini doğrula; raw içerikleri Git’e, PR’a veya public rapora kopyalama.
2. Object allowlist’i tek tek incele: `core` application tables/types/sequences/functions; `public` yalnız uygulamanın kullandığı RPC / gerekli view’lar. Extension-owned, platform ve ilgisiz nesneleri dışarıda tut. Synthetic TOC ID’li ACL, DEFAULT, ROW SECURITY ve dependency entry’lerini ilgili onaylı nesneyle eşleştirmeden alma.
3. Function / view / default / CHECK / comment / ACL tanımlarını private ortamda incele. Schema-only dump içinde gömülü production ref, business UUID, URL, email, provider token veya secret bulunabilir. Otomatik regex değiştirmeyi reviewed canonical migration yerine kullanma; historical SQL dosyalarını değiştirme. Cross-schema dependency, grants, owner, `SECURITY DEFINER`, `search_path`, RLS ve public RPC imzalarını ayrıca doğrula.
4. Yalnız onaylı, nötrleştirilmiş uygulama baseline’ını ayrı dosya olarak hazırla; exact raw capture hash’ine provenance bağla. Isolated replay ve sandbox recovery testinin gerçek sonuçları ayrı evidence olmalı. Inventory / capture tamamlandı diye K3’ü tamamlandı sayma.
5. Reset ayrı gate’tir. Bu araç reset gerçekleştiremez. Talip'in verdiği koşullu reset onayı ancak ilk dört adımın kanıtı tamamlanınca kullanılır: sağlık raporu, doğrulanmış recovery, Talip'in eski sandbox bağlantılarını ayırması ve reviewed application baseline. Bu koşullar tamamlanmadan reset komutu çalıştırılmaz. Supabase managed Auth / storage / extensions platform yapısı korunur.

## Test çıktısı

```powershell
& $env:SCHEMA_PYTHON -B -m unittest discover -s tests -p test_schema_capture.py -q
```

20 isolated test: configuration / host-ref-user bağı, transaction-pooler reddi, CA/Git-root guard, temiz child environment, schema-only / file-only args, metadata-only production sorgusu, exact TOC allowlist, data-entry reddi, fixed safe error classification, atomic safe status, mocked capture, sandbox exact-byte hash / count / anonymous identity gate ve Windows temporary-folder ACL kontrolü. DB bağlantısı / hosted restore yapılmaz; ACL testi yalnız yeni local fixture klasörünü kullanır. Windows sandbox izinleri gerçek ACL değiştirmeyi engellerse bu yerel test ayrı approved execution bağlamında çalıştırılmalıdır; test kapsamı remote erişime genişletilmez.
