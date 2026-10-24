# K10 — tarihsel test başvurusu ve yeni gerçek DOI

Taban main 35e56d0. Ayrı ileri migration; sıra root/Talip kararına bırakıldı. Eski K5 ve SQL 23 baytları değişmez. Hosted/launcher/secret/provider/event/e-posta işlemi yok.

## Neden bu kapsam

K5 helper herhangi bir tarihsel test signup gördüğünde false üretir. K6 reserve/claim/context, bootstrap permit/preview ve receipt activation aynı helper'ı kullanır. Ayrı kupon helper'ı yalnız permit engelini çözmez; çok sayıda donmuş fonksiyonu değiştirmeyi gerektirir. Bu teslim yalnız ortak helper'ın tarihsel signup şartını genişletir. K5 profil senkronunun da aynı kanıtlı gerçek müşteriye açılması bilinçli kapsam etkisidir; mevcut latest-signup payload yalnız gerçek, kanıtla bağlı başvuruya dayanır.

## Yeni dar koşul

Test geçmişi yoksa eski yol aynen. Varsa alternatif yalnız aynı business/customer'a bağlı son non-test website VIP başvurusu + e-posta isteği + aynı request consent_event + immutable Klaviyo DOI kanıtıyla geçer. Kaynak, SUBSCRIBED, doubleOptIn, marketing izni, güncel e-posta SHA, ilgili tenant VIP listesi ve request≤confirmed≤checked≤şimdi zinciri zorunlu. Her diğer başvuru kesin olarak daha eski olmalı; eşit tarih, yeni test, yeni kanıtsız talep kapanır. Customer.is_test, test isim/e-posta filtreleri, suppression, unsubscribe ve herhangi bir olumsuz provider gözlemi korunur; pozitif DOI bunları aşmaz. Geçmiş test satırları/işaretleri silinmez veya yeniden sınıflandırılmaz.

## Somut teslim / kurulum sınırı

`supabase/migrations/20261024000300_doi_mixed_signup_eligibility.sql`

SHA256: `4fc76439f4956fa556e6ee6f5a9c2b5c8c600ae59dab3d616c94dcff9022d07e`.

Preflight mevcut helper prosrc MD5 `2e59cde921d93fa1b3f403369aa7d029` ister (root Production salt okunur kanıtıyla eşleşir); farklı tanım veya tekrar uygulama reddedilir. Migration yalnız guard + CREATE OR REPLACE FUNCTION, veri DML'si yok. ACL, SECURITY DEFINER/STABLE/search_path korunur. Manifest execution=false, reset dışında, sıra=null. Önerilen karar: önce bu PR/SQL incelemesi ve root'un uygulama sırası; ardından aynı LF/SHA ile Sandbox kabulü, sonra ayrı Talip Production kararı. Bu teslim kurulum izni veya otomatik çalışma değildir.

## Gerçek yerel kabul

40/40, fail0/skip0, PostgreSQL18.6 tam şema. Business/offer test-marker alanları Production gibi yokken forward SQL ve sonraki yollar geçti. Eski helper mixed history'yi reddediyor; yeni helper iki tarihsel test + gerçek DOI'yi kabul ediyor. Eksik/yanlış/future/önceki DOI, yanlış liste/hash/e-posta, yeni/eşzamanlı signup, test customer, suppression ve negatif gözlemler reddediliyor. Yanlış business/missing customer/yetkisiz roller kapalı. Aynı DOI ikinci coupon/job/permit oluşturmuyor (1/1/1).

K5 latest gerçek payload/enqueue; K6 reserve/claim/consuming-context ve sonradan gelen negative önceliği; receipt activation true→false, unknown finalize/idempotency ve pencere engeli gerçek SQL'de doğrulandı. Diğer bütün core/public fonksiyon tanımları ve helper ACL aynı. Native test RPC/uygulama tabloları gerçek PG nesneleridir; Auth/Storage platform yüzeyleri yerel fixture'dır. Yeni DOI fixture'ları sentetiktir; gerçek ağ yok. Geçen log ve dosya SHA'ları `K10_DOI_Karisik_Gecmis_kanit/` içinde.
