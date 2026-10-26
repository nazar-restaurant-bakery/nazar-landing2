# Personel parola hata ayrımı — 25 Ekim 2026

Temel main: `2de355cb784f68728435b553481862749d9aa3a6` (#110). Ayrı Draft; merge/deploy/hosted işlem yok. Production paketi bağımsız byte doğrulaması yapılmadı. Gerçek SDK ve lock: 2.112.3.

StaffPassword sunucu hatalarının tamamını unknown olarak gösteriyordu. Sabit izin listesiyle oturum reddi, ek kimlik doğrulama, aynı/zayıf parola, limit, genel red ayrıldı. Ham hata/mesaj/JWT/kimlik log veya ekrana çıkmaz. `insufficient_aal` (HTTP401) genel401'den önce reauthentication olarak ele alınır; bağımsız P2 bulgusu giderildi. SDK'nın HTTP403/session_not_found'ı AuthSessionMissingError/status400 biçimine dönüştürmesi gerçek SDK + tamamen sentetik fetch ile test edildi.

Form PUT öncesi Auth getUser ve beklenen kullanıcı eşleşmesini denetler; kontrol başarısızsa veya kontrol sırasında hesap değişirse parola gönderilmez. PUT en çok bir kez; otomatik refresh/tekrar/e-posta yok. 12 karakter, tekrar alanı, busy koruması ve alan temizliği sürer. GET200 sonradan iptal edilmeye karşı garanti değildir; yanlış tarayıcıdaki eski oturumu yenisiyle birleştirmez.

Root'un canlı kanıtı: yeni giriş GET200, sonraki PUT403 ve yeni auth.sessions satırı mevcut. Aynı session_id kullanıldığı kanıtlanmadı; Chrome magiclink sekmesi ile uygulama içi tarayıcıdaki eski form karışması güçlü ihtimal, kesin kök neden değil. Kullanıcıdan parola işlemini tekrarlaması istenmedi. Marketing istemcisi ayrı key/no-session; staff singleton/default SDK depolama kullanıyor. StaffShell mevcut signOut global varsayılanı ayrı revocation riski, olaya neden olduğu kanıtlanmadı; bu PR'da değiştirilmedi.

Doğrulama: helper + kurulu gerçek SDK sentetik taşıma 17/17; yeni insufficient_aal tarayıcı regresyonu 1/1. Önceki son UTF-8 aday browser koşusu 21/22; ilk navigasyon6000ms timeout senaryosu ayrı koşuda1/1 geçti. Tek final23/23 koşusu iddia edilmez. TypeScript/scoped ESLint exit0; whitespace kontrolü PASS. Eski log/artifact dosyaları PR'a alınmadı; seçili iki yeni kanıt dosyası eklendi. Yetki/rol/secret/Auth ayarı değişmedi.
