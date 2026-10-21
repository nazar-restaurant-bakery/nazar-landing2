# Personel kapsamı — ortak sözleşme v1.1

**20 Ekim 2026 · Talip’in 17:37 kabulü.** Temel #65 / migration sıra 8’de kurulur; #70 ve #71 bu sözleşmeyi tüketir. Migration eşleme tohumu, gerçek Auth UUID’si veya yeni sabit işletme kimliği içermez. Hosted uygulama ve PR birleşmesi Talip’tedir.

**21 Ekim 2026 · `staff.manage` sözleşme eki, yönlendirici/Talip onaylı.** #65, `5412eb9f0326259e183d76b1ca54887a94921074` ile main'e birleşti. Bu sürüm ayrı Draft PR'da yalnız sözleşmeyi genişletir; uygulanmış sıra 8 SQL'i ve SHA'sı değiştirilmez. Mevcut helper bilinmeyen `staff.manage` için false döndürür; bu belge çalışma zamanı desteği veya canlıya uygulama kanıtı değildir. Destek, ayrıca gözden geçirilecek ileri migration ile eklenmeden #78'in yönetim yolu etkinleştirilmez. Sözleşmenin repo kopyası: `docs/Personel_Kapsam_Sozlesme.md`.

## 1. Tek veri kaynağı

```sql
core.business_staff (
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  staff_id uuid NOT NULL REFERENCES auth.users(id),
  role text NOT NULL CHECK (role IN ('owner','manager','staff')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (business_id, staff_id)
)
core.platform_operators (
  staff_id uuid PRIMARY KEY REFERENCES auth.users(id),
  active boolean NOT NULL DEFAULT true
)
```

FK silmeleri RESTRICT/NO ACTION; geçmiş aktör bağlantıları için üyelik silinmek yerine pasifleştirilir. İki tablo private `core` içinde RLS açık, PUBLIC/anon/authenticated/service_role doğrudan erişimi kapalıdır; SECURITY DEFINER denetimleri dar RPC’lerden yapılır. `core` Data API’ye açılmaz. `crm_staff` geçmiş/uyumluluk için kalır; işletme veya platform yetkisi vermez. Eski aktif kayıt yeni üyeliğin yerine geçmez; `legacy OR new` yoktur.

## 2. Tek private yetki yardımcısı

```sql
core.staff_authorized_v1(p_business_id uuid, p_operation text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
```

Aktör yalnız `auth.uid()`; aktör parametresi yoktur. NULL aktör, eksik/pasif üyelik, bilinmeyen işlem veya yanlış işletme **false** döndürür (NULL değil). `platform.read` dışında NULL işletme reddedilir; bilinmeyen işletme reddedilir. Yardımcıya doğrudan EXECUTE tüm uygulama rollerinden kaldırılır; RPC sahibi çağırır.

| İşlem (tam metin, allowlist) | Aktif owner / manager / staff | Aktif platform operatörü, işletme üyeliği yok |
|---|---|---|
| `crm.read`, `orders.read`, `ops.read`, `loyalty.read` | Hedef işletmede evet | Salt okuma evet |
| `crm.write`, `consent.restore`, `orders.match`, `campaign.staff_mark`, `ops.write` | Hedef işletmede evet | **Hayır** |
| `platform.read` (işletme NULL) | Hayır | Evet |

Roller bu geçişte mevcut personel işlerini daraltmaz; owner etiketi platform yetkisi üretmez. Mevcut iş kuralları ayrıca korunur: örneğin rıza kanıtı/onayı, karar sorusunun mevcut karar-verici şartı, kampanya notu ve K15 kill switch / beş dakika / tek kullanım. Bunlar yeni işletme üyeliğini ikame etmez.

### 2.1 `staff.manage` — personel yönetimi

Yeni tam işlem adı `staff.manage` olur; genel okuma/yazma grubuna eklenmez. Aynı `core.staff_authorized_v1(uuid,text)` ve `public.staff_business_authorized_v1(uuid,text)` sarmalayıcısı kullanılır; ikinci personel/rol tablosu veya legacy yetki kaçışı oluşturulmaz. Aktör yine yalnız `auth.uid()` olur.

Hedef işletme mevcut ve dolu, aktör dolu ve o işletmede aktif `business_staff` üyeliği varsa, aşağıdakilerden en az biriyle izin verilir: **üyeliğin rolü `owner`**, veya **aktörün aktif `platform_operators` kaydı**. Platform operatörlüğü tek başına işletme adına yazma yetkisi vermez; aktif hedef üyeliği zorunlu kalır. Manager/staff rolü tek başına personel yönetim hakkı vermez. Ayrı platform operatörü yetkisi olan üye, bu işlemde platform operatörü olarak değerlendirilir.

| Aktörün hedef işletmedeki durumu | `staff.manage` |
|---|---|
| Aktif `owner` | true |
| Sıradan aktif `manager` veya `staff`; aktif platform operatörü değil | **false** |
| Aktif platform operatörü + hedef işletmede aktif üyelik | true |
| Aktif platform operatörü, hedef işletmede üyelik yok/pasif | **false** |
| Pasif platform operatörü + sıradan manager/staff üyeliği | **false** |
| Pasif owner üyeliği, yalnız legacy crm_staff veya yanlış işletme | **false** |
| NULL aktör/işletme, bilinmeyen işletme | **false** |

Owner yetkisi platform operatörlüğünden bağımsızdır; pasif bir platform kaydı aktif owner üyeliğini iptal etmez. Platform salt okuma izni personel yönetimine yükseltilmez. Korunan yönetim RPC'leri başarısız kontrolde SQLSTATE `42501` / authenticated istekte HTTP `403` üretir; yetkisiz kişiye boş başarı listesi dönmez. Service key, istemciden gelen staff UUID veya tarayıcı menüsünü görmek yetki kanıtı değildir.

Personel listesi ve değişiklikleri yalnız hedef işletmeye aittir. Kendi owner üyeliğini pasifleştirme ve son aktif owner'ı pasifleştirme/rol düşürme, yönetim RPC'sinde işletme kilidi altında atomik olarak engellenir. Davet/hesap/e-posta işlemleri bu sözleşme PR'ında çalıştırılmaz.

**Dış sınır:** Yetki isteyen public RPC başarısız denetimde `RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'` üretir; authenticated PostgREST isteğinde HTTP **403**. Oturumsuz isteğin Auth katmanında 401 olması ayrıdır. Liste RPC’leri yetkili kişinin yalnız izinli işletme satırlarını döndürür; yetkisiz hesaba boş listeyle başarı uydurulmaz. `public.staff_business_authorized_v1(p_business_id uuid,p_operation text) RETURNS boolean` authenticated personel adaptörleri için aynı yardımcının dar sarmalayıcısıdır; private tablo erişimi vermez. Parametresiz `crm_staff_authorized_v1()` yalnız tek eski işletme belirlenebiliyorsa `crm.read` ile oturum/menü ön kontrolüdür; genel işletme yetkisi değildir. Configurable provider işlemleri hedef işletme/işlem sarmalayıcısını kullanır; eski sabit okuma yolları da tek işletme kapsamı belirsizse kapalı kalır.

## 3. Tüketiciler ve aktör zinciri

- **K9 / #65:** `staff_mark` hedef kampanyanın işletmesinde `campaign.staff_mark`; `p_staff_actor = auth.uid()` + dolu not. Evaluator service_role-only kalır; yalnız service key, NULL sub veya istemcinin gönderdiği UUID personel kanıtı değildir. Güvenilir JWT taşıyan adaptör ayrı önkoşuldur.
- **Legacy CRM / #65:** Kayıt işletmesi DB’den çözülür, yazmadan önce denetlenir; listeler satır işletmesiyle süzülür. Provider adaptörleri kendi ortamındaki business_id için dar sarmalayıcıyı denetler. İşletme alanı olmayan eski sistem hata/bildirim yolları yalnız DB’de tek işletme varsa o işletmeye bağlanır; birden fazla işletmede kapsam belirsizdir ve erişim reddedilir. Yeni sabit kimlik eklenmez.
- **K11 / #70:** `loyalty_staff_scopes` ve `loyalty_platform_operators` oluşturulmaz; `loyalty_metrics_v1` hedef işletmede `loyalty.read` kullanır. Platform okuması işletme adına yazma iznine dönüşmez.
- **K15 / #71:** `ops_write_staff` oluşturulmaz; bileşik aktör FK’leri `(business_id,staff_id)` ile `business_staff`’a gider. Personel başlatma/onay ve yürütme yetkisi `ops.write`; aktör JWT’den gelir. Service-only claim/finalize’da `p_staff_id` tek başına yetki kanıtı olamaz: doğrulanmış kullanıcı JWT’sini taşıyan yol ile persisted onay/claim eşleşmesi birlikte korunur. Salt service key altında NULL `auth.uid()` geçmez; bu zincir uyarlanmadan canlı kabul verilmez.
- **Personel / #78:** kişi listesi, üyelik yönetimi ve davet yetkisi hedef işletmede `staff.manage` ile denetlenir. Sıradan manager/staff erişemez. Public sarmalayıcı ve yönetim RPC'leri aynı private yardımcıya dayanır; v1.1 çalışma zamanı desteği yokken kapalı kalır. Sözleşme PR'ı main'e birleşince #78 onun üzerine yeniden temellendirilir; Kupon ve Personel menü/rotaları birlikte korunur.

## 4. Ortak sentetik fixture ve kurulum

Fixture manifesti: `{ businesses: { a: UUID, b: UUID }, users: { platformOnly: UUID, platformMember: UUID, ownerA: UUID, managerA: UUID, staffA: UUID, inactiveA: UUID, staffB: UUID, legacyOnly: UUID } }`. UUID’ler testte üretilir; minimal `auth.users(id)` kayıtları ve aynı biçimde business_staff/platform_operators satırları yüklenir. Gerçek hesap/kimlik kullanılmaz. Trusted test oturumunda `request.jwt.claim.sub` ve `request.jwt.claim.role` ayarlanır; bu yerel fixture, canlı JWT adaptörü kanıtı sayılmaz.

Zorunlu kontroller: tüm rollerin kendi işletmesi, yanlış işletme, pasif üyelik/operatör, bilinmeyen işlem, NULL aktör/işletme, platform-only okuma fakat yazma reddi, platform+üye yazması, legacy-only reddi, sahte aktör ve doğrudan tablo erişimi; RPC denial SQLSTATE 42501. #65 ardından ayrı kurulumda **Talip = platform operatörü + Nazar üyeliği (rolü kurulumda Talip doğrular), Yücel = Nazar owner**; Auth UUID’lerini Talip doğrular. Migration’a seed eklenmez.

V1.1 fixture bu mevcut aktörleri kullanır; gerçek kimlik eklenmez. `staff.manage` için owner true; sıradan manager/staff false; platform+aktif hedef üyelik true; platform-only/pasif üyelik/yanlış veya NULL işletme/NULL aktör false kanıtlanır. Platform kaydı pasifken sıradan manager/staff false ve bağımsız aktif owner true ayrı test edilir. Public helper false, korunan RPC 403/42501 ayrımı korunur. Son owner'ı eşzamanlı iki işlemle kaldırma ve kendi owner üyeliğini pasifleştirme ayrıca reddedilir. Bunlar ileri uygulamanın kabul koşullarıdır; bu belge testlerin çalıştığı iddiası değildir.
