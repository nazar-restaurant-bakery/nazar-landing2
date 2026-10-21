# Sıra 11 / 15 — başlatıcı teslimi · 21 Ekim 2026

**Yapıldı:** K15 (sıra 11) artık aynı hedefteki **10b** `K13b_kanit/{target}-success.json` kaydını SHA256/psql18.6/UTC/`commission_channel_label` ile doğrular; eski sıra 10 geçerli değildir. Değişen plan/runner ve dört bağlı wrapper pini yenilendi. Kaynak ve yerel kurulu paket aynı baytlardır.

**Sıra 15:** PR #78'in `20261021000900_staff_management.sql` dosyası gerçek PR blob'undan LF SHA256 `1fac9f6ed72ed1d5992425d1eef87b8e00baa54523f099e49771d62bf3ea0a68` ile doğrulandı; SQL değişmedi. `StaffManagement_kanit/Start-StaffManagement-Sandbox.ps1` ve `Start-StaffManagement-Production.ps1` hazır. Aynı hedef **14b** başarı kaydı, Production'a ayrıca kendi **15 Sandbox** kaydı zorunlu. 30 ön kontrol (3 bağlantı + 27 nesne/yetki), 89 son kontrol; varsayılan davet kapalı. SHA/LF/BOM/psql/CA/helper pinleri, TLS verify-full, maskeli parola, özel ACL altında dondurulan SQL ve receipt bayt hash bağı K7 kalıbındadır. Yeniden uygulama ve receipt üzerine yazma reddedilir.

**Kanıt:** K15 çevrimdışı **37/37**; sıra 15 **24/24**. Eski önkoşulun yetmemesi, yanlış hedef/SHA/sıra/statü/zaman/psql, eksik Sandbox, SQL/LF bozulması reddedildi. Migration envanteri **19/19**. Yerel PostgreSQL18.6: gerçek 14b + #78 SQL'iyle 27 plan ön koşulu, 89 son kontrol ve 5 kontrol grubu geçti; RLS/grant bozulması yakalandı, helper/Auth/üyelik/platform kayıtları korundu. Geçici küme kapatıldı.

**Talip:** Sıra 10b sonrası K15 Sandbox → Production. Sıra 14b sonrası sıra 15 Sandbox → Production; her komuta önce `-OfflineCheck` eklenebilir. Güncel yerel kontrolde K15 Sandbox OFFLINE PASSED; K15 Production kendi Sandbox kaydını, sıra 15 ise 14b kayıtlarını bekler. Bu durumlar canlı uygulama başarısı değildir. 14a onaylı ve 15 sıra kaydı işlendi. Kaynak operatör paketleri #73 dalında; #78 uygulama koduna veya canonical SQL'ine müdahale edilmedi. Soru/sapma yok; canlı DB/hesap/e-posta/Production dağıtımı yapılmadı.

Ayrıntılar: `Sequence_Operators_kanit/summary.json`, iki offline sonuç dosyası ve native kontrol JSON'u. Kurulu paketler `DailyOperations_kanit/` ve `StaffManagement_kanit/`.
