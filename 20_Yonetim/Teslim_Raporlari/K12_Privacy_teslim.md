# K12 — /privacy Draft teslimi

22 Ekim 2026 · taban main `0ff9496`. Yalnız yeni /privacy rotası, İngilizce politika metni ve ortak footer'dan Privacy Policy bağlantısı. API, form, Ads/Meta adaptörü, personel rotası, secret ve DB değişikliği yok. Düz metin: `K12_Privacy_Taslak.md`; aynı metin PrivacyPage.tsx'te görünür.

## Talip + Yücel onayı

Bu PR bir politika taslağıdır; yayın/merge Talip'te. Platform, Nazar'dan ayrı hizmet sağlayıcıdır; “Platform Ops Restaurants” bir uygulama adıdır, hukuki şirket unvanı olarak sunulmaz. Yayından önce platform işletmecisinin gerçek hukuki unvanı/iletişim bilgisini, Nazar adına hizmet kapsamını ve `ctnazarbakery@gmail.com` adresinin privacy/deletion taleplerini karşılayacağını doğrulayın; unvan belli olunca ilk paragrafta açıkça adlandırın. Saklama/silme beyanının manuel operasyonla nasıl yerine getirileceği Talip + Yücel tarafından kabul edilmelidir; bu PR otomatik silme işi veya yeni uç nokta kurmaz. Kesin gün sayısı/yanıt süresi uydurulmadı.

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
