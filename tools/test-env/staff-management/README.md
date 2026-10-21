# Sıra 15 — Personel yönetimi başlatıcıları

PR #78'in `20261021000900_staff_management.sql` dosyası, kaynak `de2fe689b427d7215881257108d4b76350076043`, LF SHA256 `1fac9f6ed72ed1d5992425d1eef87b8e00baa54523f099e49771d62bf3ea0a68`. SQL değiştirilmedi; `sql/` dosyası incelenmiş operatör kopyasıdır, ikinci bir kanonik migration değildir. Kaynak paket #73 dalındadır; #78 kodunun kabulünün yerine geçmez.

Yerel kopya `20_Yonetim/Teslim_Raporlari/StaffManagement_kanit/`. Önce `Prepare-Targets.ps1 -WorkspaceRoot <çalışma-klasörü>`; yalnız mevcut onaylı hedefleri yerel, Git dışı `targets.json` içine alır. Yeni sabit proje ref'i eklenmez.

PowerShell 7: `Start-StaffManagement-Sandbox.ps1 -OfflineCheck`. Kurulum sırası gelince aynı komutu anahtarsız Talip çalıştırır; ardından `Start-StaffManagement-Production.ps1`. Her hedef kendi **14b** `StaffManage_kanit/receipts/14b-{sandbox|production}-success.json` kaydını; Production ayrıca bu **15** SQL'inin kendi Sandbox kaydını ister. Eski 14 kaydı yeterli değildir. Eksik kayıt WAITING/exit2; bozuk kayıt FAILED/exit1; çevrimdışı uygunluk PASSED/exit0. Offline yol parola/helper/DB açmaz.

SHA/LF/BOM, psql18.6 binary, CA ve K7 süreç yardımcısı pini; TLS verify-full, maskeli parola, özel ACL altında dondurulmuş SQL ve son anda tekrar receipt hash denetimi korunur. 30 ön kontrol, 89 nesne/ACL/RLS/helper/boş başlangıç denetimi. Davet varsayılan kapalıdır; üyelik/owner tohumu veya e-posta gönderimi yok. Üretim öncesi kendi Sandbox kabulü gerekir.

Gerçek postcheck sonrası `receipts/15-{sandbox|production}-success.json`: sıra/hedef/SHA/psql/zaman/checkCount/password_recorded:false ve önceki receipt bayt hash bağı. Var olan başarı kaydı üzerine yazılmaz; kayıtlı migration otomatik yeniden uygulanmaz. Auth daveti, function dağıtımı ve ayar etkinleştirmesi bu komutların dışındadır.

`tests/Test-Offline.ps1` yalnız `synthetic:true` fixture kullanır; gerçek receipt yazmaz. Gerçek SQL ve tüm ön/son kontrol ifadeleri ayrıca sahipliği kayıtlı loopback PG18.6 testinde sınanır; hosted proje kabulü değildir.
