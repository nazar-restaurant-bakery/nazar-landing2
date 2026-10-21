# staff.manage — ileri migration ve korumalı operatör

Sıra önerisi **14b**: K13 ve kampanya/kupon PR'larından sonra, #78 Personel'in sıra 15 SQL'inden önce. Ayrı Draft PR; hosted uygulama ve birleşme Talip'te. Eski sıra 8 dosyası değişmez. Bu paket hesap, üyelik, davet veya e-posta işlemi yapmaz; yalnız private yardımcıya yeni işlem dalını ekler.

## Kurulum ve kullanım

İncelenen paketin yerel kopyası `20_Yonetim/Teslim_Raporlari/StaffManage_kanit/` altında hazırlanmıştır. Repo kopyası bu klasördedir. Proje ref'leri kaynakta sabitlenmez; mevcut onaylı operatörden yalnız yerel `targets.json` oluşturulur, Git'e girmez. Temiz kopyada `Prepare-Targets.ps1 -WorkspaceRoot <çalışma-klasörü>` kullanılır. Mevcut operatörün pini değiştiyse inceleme için durur.

Talip PowerShell 7'de önce `Start-StaffManage-Sandbox.ps1 -OfflineCheck`, uygulama zamanı geldiğinde aynı komutu anahtarsız çalıştırır; Sandbox PASSED sonrasında Production eşini çalıştırır. Kurulu klasörden tam yol kullanılır. İlk teslimde iki OfflineCheck **WAITING** beklenir: sıra 14 gerçek başarı kaydı henüz yoktur; bu eksikliği atlamak için receipt üretilmez.

Korumalar: SQL/plan/runner SHA256, LF/BOM kontrolü, sabit PostgreSQL 18.6 binary pini, K7 süreç yardımcısı pini, CA pini ve `verify-full`, aynı hedef sıra 14 başarı kaydı; Production ayrıca aynı 14b SQL'inin Sandbox başarı kaydını ister. Önceki receipt baytları son anda tekrar hash'lenir. İlgili bağımlılık sıraları da merkezi sıra dosyasıyla karşılaştırılır. Parola maskeli alınır, yalnız alt sürecin geçici ortamına verilir; kayda/komuta yazılmaz. Otomatik tekrar ve başarı kaydı üzerine yazma yoktur. Yeni receipt bu paketin `receipts/14b-{sandbox|production}-success.json` yoluna çıkar; sıra 15 operatörü buna bağlanmalıdır.

Ön kontrol eski helper gövde hash'ini, 21 koşulla private ACL/RLS ve public wrapper sınırını doğrular. Son kontrol yeni gövde hash'ini ve aynı 20 güvenlik koşulunu doğrular. Şema/private erişim veya önceki helper beklenenden farklıysa uygulamaz. Bu değişiklik `staff.manage` yetkisini açar; üyelik yönetimi RPC'leri sıra 15'te gelir. Dağıtım sırası migration sürümünden bağımsız olarak **14 → 14b → 15** olmalıdır.

## Yerel doğrulama

`node --test tests/staffManageDb.test.mjs` ayrı, sahipliği kayıtlı loopback PostgreSQL 18.6 kümesi açar/kapatır. Gerçek hesap/customer verisi, hosted URL veya key kullanmaz. #78 SQL'i sabit commit/SHA ile yalnız `tests/fixtures/staffManagementConsumer.sql` içinde test bağımlılığıdır; bu dosya migration/operatör uygulama envanterine girmez. Son owner ve kendi-owner korumaları tüketiciyle entegre sınanır; sıra 14b'nin tek başına bu RPC'leri kurduğu iddia edilmez. #78 SQL'i değişirse entegrasyon tekrar koşmalıdır.

`tests/Test-Offline.ps1` bozuk SHA/LF, yanlış hedef/sıra/statü/zaman/psql, parola kaydedilmiş receipt ve eksik önkoşulları sentetik dosyalarla reddeder. `targets.json` hazırlanmış kurulu kopyadan çalıştırılır. Offline test başarı kayıtları yalnız `tests/fixtures/` altında ve `synthetic:true` olur; gerçek receipt değildir.

## Geri dönüş

Ön uygulama incelemesinde sorun bulunursa PR/kurulum bekletilir. Uygulama sonrasında sorun olursa otomatik SQL geri alma yapılmaz; yeni bir forward migration ile eski helper tanımı inceleme/test sonrası geri konur. Böylece Personel yönetimi yeniden kapalı kalır. Uygulanmış sıra 8 dosyası veya başarı kayıtları değiştirilmez.
