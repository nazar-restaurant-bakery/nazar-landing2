# K10 — işletme personel yönetimi

20 Ekim 2026 · [Draft PR #78](https://github.com/nazar-restaurant-bakery/nazar-landing2/pull/78). Dal `feat/staff-members-management`; taban **main, 5412eb9**. Birleşme Talip'te. Kaynak: Talip'in 22:53 kararı ve `Personel_Kapsam_Sozlesme.md` v1; yeni `staff.manage` işlemi için **önerilen v1.1 varsayımı**.

## Kapsam ve dosyalar

| Madde | Sonuç |
|---|---|
| Personel ekranı | `/staff/team`, CRM menüsünde Personel. Yalnız hedef işletmede aktif owner veya aktif platform operatörü + aktif üye görür. Diğer manager/staff ve platform-only göremez; doğrudan rota 403 gösterir. Üye adı/e-posta kendi işletmesinde açık, rol ve aktif/pasif görünür. |
| Davet | E-posta + owner/manager/staff; mevcut kullanıcı JWT'siyle prepare → atomik gönderim claim'i → sunucuda Auth daveti → üyelik finalize. Aktör istemciden alınmaz. Service role yalnız Edge Function'dadır. Mevcut Auth hesabıysa aynı kimlik işletmeye eklenir, yeniden hesap/e-posta oluşturulmaz; mevcut üyelik davetle değiştirilemez. |
| Üyelik değişimi | Rol ve aktiflik için beklenen eski değer karşılaştırılır; tüm owner değişimleri işletme satır kilidiyle seri çalışır. Kendi owner üyeliğini pasifleştirme ve son aktif owner'ı düşürme/pasifleştirme reddedilir. Silme/global Auth ban yoktur. |
| Belirsiz sonuç | Çift tıklama kilidi ve persisted idempotency. Auth timeout/5xx veya kayıp yanıt kör tekrar üretmez; unknown kayıt aynı e-postaya yeni daveti engeller. Yalnız durum okunur; Talip Auth kaydı/gönderimini uzlaştırır. Beş dakika geçen gönderim listede unknown görünür. Yetki claim'den sonra kaldırılırsa yeni üyelik verilmez. |
| Tenant ve audit | Yeni üç tablo business_id'lidir; aktör/hedef FK'leri `(business_id,staff_id)` → `core.business_staff`. RLS + doğrudan uygulama CRUD yetkisi yok. Audit kim/zaman/hedef/rol/aktiflik/sonuç içerir; e-posta, anahtar veya mesaj gövdesi içermez. Davet adresi yalnız private operasyon kaydında saklanır ve yetkili işletme listesinde gösterilir. |

Kaynaklar: `StaffShell.tsx`, yeni `StaffManagement.tsx`, `StaffManagementLink.tsx`, `src/lib/staffManagement.ts`; `supabase/functions/staff-manage-invite/index.ts`, function config ve aşağıdaki migration. Yeni bağımlılık veya custom secret yok; sunucunun mevcut `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` ortamları kullanılır. Auth davet yolu [Supabase Auth admin invite](https://supabase.com/docs/reference/javascript/auth-admin-inviteuserbyemail) ile uyumludur.

## Birleşik kapsam / Koordinasyon bağımlılığı

Koordinasyon'a `staff.manage` önerildi: **aktif owner evet; aktif platform+aktif işletme üyesi evet; platform-only, sıradan manager/staff, pasif ve yanlış işletme hayır**. Aktör yalnız `auth.uid()`; NULL ve bilinmeyen işletme false. Test fixture'ı aynı ortak fixture kimliklerini ve bu tek yeni allowlist dalını kullanır.

**21 Ekim: staff.manage önerisi yönlendirici tarafından onaylandı; kanonik sözleşme/helper için Koordinasyon'un ayrı PR'ı bekleniyor.** Koordinasyon'un öneriyi insan onayı saymadığı kaydedildi. Bu PR ortak helper'ı veya kanonik sözleşmeyi değiştirmez. v1 ile ekran/işlemler kapalı kalır; kendi `ops_write_staff` benzeri personel tablosu veya legacy fallback yoktur. Private service finalizer aktörü sadece JWT ile hazırlanmış ve aynı kullanıcı tarafından claim edilmiş kayıttan alır; service key + sahte aktör UUID'siyle yeni intent açılamaz.

## Migration

Önerilen sıra **15** (Koordinasyon sıra 14 kupon çekirdeğinden sonra): `20261021000900_staff_management.sql`.

SHA256: `1fac9f6ed72ed1d5992425d1eef87b8e00baa54523f099e49771d62bf3ea0a68` · UTF-8, BOM yok, **LF**. #65 helper önkoşulu; yardımcıya müdahale etmez. Veri/owner seed'i ve davet aktivasyonu yapmaz. `staff_management_settings.invite_enabled` varsayılan false; ayar satırı yokken de davet kapalıdır. `invite_redirect_url` işletme başına HTTPS `/staff/system` ile sınırlandırılır. Bu teslim migration'ı sandbox/Production'a uygulamadı.

## Test ve Production parity

- İlgili Node testleri **62/62**: 12 yeni Edge sınırı/davet testi + mevcut personel, CRM, Ops, preview/production izolasyonu. Auth/sağlayıcı istekleri sentetiktir; gerçek e-posta yoktur.
- Yerel PostgreSQL **18.6**, yeni boş owned loopback kümesinde gerçek migration/RPC: **10/10 kontrol grubu**. Ortak rol matrisi, 42501, yanlış tenant, doğrudan tablo erişimi, kendi/son owner, eşzamanlı iki owner düşürmede yalnız biri, stale snapshot, Auth kimliği korunarak pasifleştirme, tek davet gate'i, sahte kimlik/service bypass, idempotent finalize, unknown yeniden gönderme engeli ve claim sonrası yetki kaldırma. `tests/staffManagementPostgres.py`.
- Gerçek StaffPage/BrowserRouter + katı sentetik SDK ile tüm CRM/Ops tarayıcı paketi **75/75** (61 mevcut + 14 Personel); son ortak stil sınıfı değişiminden sonra Personel **14/14** yeniden geçti. Davet, çift tıklama, rol/pasif, owner kontrolleri, 403, platform kapsamı, kayıp yazma/davet yanıtı, çıkışta kişisel veri temizliği, bozuk tenant yanıtı ve **375px taşmasız** görünüm. Gerçek Auth/JWT/PostgREST entegrasyonu veya e-posta teslimi kanıtı yerine geçmez; bunlar sandbox kabulündedir.
- TypeScript, hedefli ESLint, build ve diff whitespace kontrolü geçti. Aynı sentetik Production public değişkenleriyle #65 tabanı ve aday **212/212** dosya, **209 byte-eşit**; ortak CSS byte-eşit. Beklenen fark personel JS, main chunk referansı/minifier ve index hash referansıdır. Form, Auth, public uygulama, Supabase ortam koruması ve GA4 kaynakları ayrıca güncel main **5412eb9** ile LF-byte eşittir. Hosted secret/değişken okunmadı veya yayın yapılmadı.

Kanıt: `K10_personel_kanit/postgres-synthetic.json`, `production-parity.json`, `synthetic-summary.json`, `browser/results.json` (75), `browser-final/results.json` (14), `browser-final/staff-members-375.png`. Yeniden üretim: `node --test tests/staffManagementEdge.test.mjs tests/staffUi.test.mjs tests/crmUi.test.mjs tests/opsUi.test.mjs tests/opsEnvironment.test.mjs tests/previewEnvironment.test.mjs tests/opsServer.test.mjs`; `python tests/staffManagementPostgres.py`; `node tests/browser/run.mjs --output 20_Yonetim/Teslim_Raporlari/K10_personel_kanit/browser`; `python tests/staffManagementParity.py` (aynı 5412eb9 base worktree + mevcut dependencies).

## Talip'in sonraki kurulum/kabul adımları

1. Önce Koordinasyon ile `staff.manage` v1.1 maddesini onayla ve #65'e aldır; bu tüketici Draft kalır. Yücel'in owner, Talip'in platform+üye kurulumu mevcut Auth kimlikleriyle ayrıca doğrulanır; ortak hesap açılmaz. #76 ile aynı StaffShell'e dokunduğu için birleşirken **Kupon ve Personel menü/rota blokları birlikte korunur**, ortak ekran testleri tekrar çalıştırılır.
2. Sıra 15 Koordinasyon tarafından kayda alındıktan sonra aynı LF/SHA dosyasını psql 18.6 ile önce sandbox, kabul sonrası Production'a uygula. Sandbox'ta iki sentetik işletme, owner/staff/platform-only ve davet için Talip'in kontrol ettiği ayrı test adresiyle kabul yap.
3. Auth URL ayarı: [sandbox Redirect URLs](https://supabase.com/dashboard/project/uxiseddbeszklkrvysxf/auth/url-configuration), [Production Redirect URLs](https://supabase.com/dashboard/project/khgczybubufouraqyrcj/auth/url-configuration). İşletmenin ortamına ait tam HTTPS `/staff/system` adresini allowlist'e ekle; Production adresi `https://www.nazarrestaurantandbakery.com/staff/system`. SMTP/davet kotası ve gönderen ayarını Talip doğrular. [Production Auth kullanıcıları](https://supabase.com/dashboard/project/khgczybubufouraqyrcj/auth/users). Davette personel kendi bağlantısını açar, kendi şifresini mevcut Sistem ekranında kaydeder.
4. İşletme ayarını doğrulanmış business_id ve ortamın redirect URL'siyle Talip ayrı kurulumda oluşturur; kabul hazır olunca `invite_enabled=true` yapar. Bu migration veya frontend bunu kendiliğinden açmaz. Fonksiyonu Talip önce sandbox'a `supabase functions deploy staff-manage-invite --project-ref uxiseddbeszklkrvysxf`, sonra kabul sonrası Production'a `supabase functions deploy staff-manage-invite --project-ref khgczybubufouraqyrcj` ile dağıtır. [Production function](https://supabase.com/dashboard/project/khgczybubufouraqyrcj/functions/staff-manage-invite/details) içinde **Enforce JWT Verification açık** kalır; yeni secret girilmez.
5. Normal frontend yayınından önce sandbox gerçek davet/403/owner korumasını kabul et; sonra Talip birleştirir ve yayınlar. Owner çalışanı pasifleştirdiğinde sadece bu işletme erişimi kesilir; başka işletme/Auth kimliği korunur. Davet belirsizse yeniden gönder düğmesi yoktur; Talip kayıt ve Auth gönderimini uzlaştırır.

Kapsamda kod ve sentetik test tamamlandı. Gerçek davet, veri/rol değişikliği veya deploy yapılmadı; başka kaleme geçilmedi.

21 Ekim güncellemesi: #65 main''e 5412eb9 ile birleşti; #78 dalı bu main üzerine yeniden temellendirildi. Clover webhook JWT ayarı korundu. Node 62/62, tarayıcı 75/75, yerel PG 10/10 ve Production parity yeniden geçti. Sözleşme değişikliği bu PR''a eklenmedi; sıra önerisi 15 ve migration SHA aynı.
