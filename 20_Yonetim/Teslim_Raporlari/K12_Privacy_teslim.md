# K12 — /privacy Draft teslimi

22 Ekim 2026 · taban main `0ff9496`. Yalnız yeni /privacy rotası, İngilizce politika metni ve ortak footer'dan Privacy Policy bağlantısı. API, form, Ads/Meta adaptörü, personel rotası, secret ve DB değişikliği yok. Düz metin: `K12_Privacy_Taslak.md`; aynı metin PrivacyPage.tsx'te görünür.

## Talip onayı — tüzel ad yok kararı

22 Ekim Talip kararı: politika yalnız “Nazar Restaurant & Bakery” adıyla yayımlanır. Sayfada platform işletmecisinin veya restoranın yasal/tüzel unvanı ve “ayrı hizmet sağlayıcı” ifadesi bulunmaz; tüzel unvan ekleme şartı kaldırılmıştır. “Platform Ops Restaurants” yalnız Google raporlama uygulamasının adı olarak açıklanır; şirket unvanı değildir. Yücel onayı gerekmiyor; yayın/merge kararı Talip'te.

Who this covers, Sharing and protection ve Contact and changes bölümlerindeki ilgili hizmet sağlayıcı ifadeleri, ayrıca SEO açıklamasındaki ifade kaldırıldı. Sayfa ve K12_Privacy_Taslak.md eşitlendi. `ctnazarbakery@gmail.com` ve `39 Elm Street, Unit 1, West Haven, CT` korundu. Saklama/silme metni değişmedi; otomatik silme işi veya yeni uç nokta kurulmadı.

Google veri erişimi/kullanımı/paylaşımı, Limited Use, server-side credentials, erişim iptali ve kayıt silme ayrı açıklanır. Google Ads mevcut OAuth scope'u geniştir; fiili erişim Read-only Ads kullanıcısı ve raporlama adaptörüyle sınırlıdır. Meta paragrafı koşulludur: Meta bağlı gibi sunulmaz. `/privacy#data-deletion`, herkese açık silme talimatı bağlantısıdır; callback endpoint değildir. Meta uygulama sahipliği/inceleme sonucuna göre App Dashboard'da URL ve Data Deletion Instructions alanları Talip tarafından ayarlanır. Politika metni tek başına Google/Meta onayı garantisi değildir.

## Meta için sahiplik seçimi — beş satır

1. Nazar modeli: uygulama Nazar'ın Business Portfolio'sunda; Nazar yetkili yöneticisi, reklam hesabı ve varlık yetkilendirmelerini sahiplenir.
2. Nazar modeli kurulum: Marketing API, `ads_read`, sistem kullanıcısına yalnız View performance; privacy ve silme talimatı URL'leri. Kendi hesap erişiminde Standard Access yolu değerlendirilir.
3. Platform modeli: gerçek platform işletmecisinin Business Portfolio'su/unvanı; Nazar, reklam hesabını platforma partner erişimiyle yalnız raporlama için paylaşır.
4. Platform modeli kurulum: üçüncü taraf hesapları için `ads_read` Advanced Access/App Review; panelin istediği business verification/sağlayıcı doğrulamaları ve kullanım kanıtı hazırlanır.
5. Her iki modelde `ads_management`/`business_management` istenmez; sahiplik Talip kararı, başvuru /privacy onayı ve yayınından sonra, hesap/secret işlemleri Talip'te.

Meta kaynağı: [Meta'nın resmî Marketing API koleksiyonu — access levels](https://www.postman.com/meta/facebook-marketing-api/collection/0zr4mes/facebook-marketing-api-mapi). Business verification adımları nihai başvuru ekranında doğrulanacaktır; Meta doküman uçları bu kontrolde 429/erişim engeli verdi. Google kaynağı: [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy).

## Yerel doğrulama

TypeScript, değişen üç UI dosyasında lint, sentetik Production build geçti. Yerel tarayıcı **6/6**: doğrudan public rota/SEO, canonical, sekiz bölüm + deletion mailto, 375px taşma yok, VIP footer bağlantısı, dış trafik/runtime hatası yok. Kanıtlar `K12_Privacy_kanit/`. Canlı site/DB/Google/Meta/secret işlemi ve polling yapılmadı.

22 Ekim düzeltme doğrulaması: sayfa/düz metin birebir eşit, SEO dahil service provider ifadesi yok, uygulama adı ve iletişim bilgileri korundu. Tarayıcı testi yeniden **6/6** geçti; 375px/masaüstü kanıtları yenilendi.
