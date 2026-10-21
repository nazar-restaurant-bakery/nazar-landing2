# K10 gönderim mutabakatı — sıra 14a önerisi

SQL/SHA/LF + psql18.6 + CA/helper pin + M14 aynı hedef başarı kaydı; Production kendi M14a Sandbox kaydını da ister. Varsayılan bağlantı/flow kapalı. Hesap/secret işlemi yok. M14/K6 uygulanmış dosyaları değişmez; eski pencere fonksiyonu MD5 kontrolünden sonra ileri migration ile genişletilir. Kalıcı message_log geçmişi değiştirilmez.

Paket `20_Yonetim/Teslim_Raporlari/CouponDelivery_kanit` konumuna kopyalanır. Önce `Prepare-Targets.ps1 -WorkspaceRoot <çalışma klasörü>` mevcut onaylı yerel hedefleri aktarır; kaynak koduna yeni proje kimliği girmez. Sıra 14a, Talip/Koordinasyon kabulünden sonra uygulama sırasına alınır; bugün uygulanmaz.

PowerShell7: `Start-CouponDelivery-Sandbox.ps1 -OfflineCheck`, gerçek sıra geldiğinde aynı komut parametresiz. Sandbox kabulünden sonra `Start-CouponDelivery-Production.ps1 -OfflineCheck`; kendi Sandbox kanıtı doğrulanınca gerçek çalıştırma. Parola yalnız Read-Host maskeli alandadır; dosya/argüman/log/receipt'e yazılmaz. Offline WAITING=2 eksik M14/own Sandbox kaydıdır; başarısız ön kontrol atlanmaz.

Şema kurulumu flow'u veya receipt ayarını açmaz. Talip ayar SQL'ini/kimlikleri ayrıca inceler. Tık tık Klaviyo belgesi: `docs/coupons/Talip_Klaviyo_Akis_Kurulumu.md`. Gerçek email/flow testi ayrıca onaylıdır; bu paket hiçbir mail göndermez.
