# Personel kendi parolası — dar düzeltme

Taban main c6f9b838730168be941d9683a44e1a5949f14e02. İlgili çalışma ağacında ve üst workspace/tmp dizinlerinde uygulanabilir AGENTS.md bulunmadı. Ayrı dal, Draft PR; merge/dağıtım root/Talip'te.

**Davranış:** Mevcut davet oturumuyla /staff/tasks'e gelen restoran personeli, menüdeki **Parolam** üzerinden /staff/password ekranına gider. Yalnız kendi hesabı için mevcut StaffPassword kullanılır; yeniden davet, reset, yeni kullanıcı veya admin işlemi gerekmez. Bu yeni ekran mevcut session + CRM yetkisi + görünüm rolü doğrulamasının içindedir. Sistem, Profil senkronu ve Personel platform grubunda kalır; staff.manage değişmez. StaffPassword her iki kullanımında session.user.id ile anahtarlı; çıkış/hesap değişimi ve eski gecikmiş yanıt yeni forma taşınmaz.

StaffSignIn.tsx/StaffPassword handler'ı main ile aynı baytlardır: auth.updateUser yalnız password nesnesi alır; 12 karakter, tekrar, busy, alan temizliği ve güvenli belirsizlik mesajları korunur. Yeni secret, servis anahtarı, RPC, migration, Auth UUID/rol güncelleme veya kayıt/gönderim yok.

## Kanıt

- **17/17** doğrudan parola tarayıcı senaryosu; gerçek StaffPage/BrowserRouter, sentetik SDK, yalnız localhost. Staff/manager/owner kişisel yol, 375px, oturumsuz/yetkisiz/rolü doğrulanamamış erişim reddi; platform URL yönlendirmeleri; yalnız password parametresi; 12/tekrar; 401/ağ hatasında güvenli uyarı/temizlik/tekrar yok; busy tek çağrı; çıkış ve hesap değişiminde geç yanıt temizliği; mevcut platform Sistem yolu.
- Koordinasyon ayrı incelemesi **23/23** (17+6 ek güvenlik vakası), kritik bulgu yok. İncelenen kaynak LF hash'leri son adayla eşleşti. Bu bağımsız yerel testtir, canlı Auth kabulü değildir.
- Gerçek owned-loopback PostgreSQL18.6 tam baseline ve mevcut14b/15 DDL ile **8/8**. staff_members_list_v1 staff/manager/platform-only/inactive/wrong-business için SQLSTATE42501; owner/platform+üye mevcut yetkisi korunur. Bu hosted REST403 testi değildir. Auth tablo sütunları yerel platform facade'dır; uygulama tabloları/RPC'ler gerçek migration'lardır.
- Görünürlük birim testi **2/2**; uygulama TypeScript, kapsam lint'i ve Vite üretim derlemesi geçti. Derleme mevcut bundle-size/Browserslist uyarıları verir; hata yok.

## Geniş testin dürüst sonucu

Tam eski tarayıcı fixture'ı bütün halinde yeşil değildir. Aynı fixture/config ile yalnız değişen üç uygulama modülü main sürümüyle değiştirilerek A/B alındı: **main53/78**, **aday70/95**. Ortak78 vakanın pass/fail sonuçları aynı; aynı25 eski başarısızlık var, yeni regresyon0, yeni17 vaka geçiyor. Eski başarısızlıklar platform-role okuma çağrısını saymayan eski denied/coupon beklentileri ve güncel Ops bileşenlerinin modellenmemiş SDK çağrıları/genel Yenile seçicileridir. İlgisiz Ops/izin kodu düzeltilmedi ve tam paket PASS iddia edilmedi. İlk önbelleği paylaşan denemede ayrıca18 numaralı test timeout verdi; koşu önbelleği ayrıldıktan sonra main ve adayda geçti. Son A/B bu temiz iki koşudur.

Test fixture değişiklikleri yeni parola vakaları, hassas değer yerine çağrı şekli kaydı ve main'de zaten kullanılan platform.read RPC modelidir. Geçici main kaynak substitüsyon runner'ı, cache'ler, dist ve çalışma logları PR'a alınmaz. Kanıt json/logları Staff_OwnPassword_kanit altında; 375px ekran görüntüsü de sentetik, boş parola formuna aittir.

## Kalan kabul

Root/Koordinasyon son commit/diff incelemesi → kabul edilen adayın Sandbox'a dağıtımı → mevcut aynı staff oturumunda Parolam ekranı ve kullanıcının parolayı kendisinin kaydetmesi → çıkış ve Sandbox'ta yeni parola ile ayrı giriş → Personel listesinin kapalı kalması. Magic-link oturumu, yeni parolayla giriş kanıtı sayılmaz. Bu canlı adımlar yapılmadı; Production aktivasyonu veya gerçek davet kabulü iddia edilmez. Hosted veri, gerçek Auth parolası, davet/e-posta veya dağıtım işlemi yok.
