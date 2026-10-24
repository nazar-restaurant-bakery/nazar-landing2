# K10 — bootstrap event doğrulama okuması

Taban main e4a2fc0. Runtime değişikliği yalnız bootstrapProvider.events ayrıntılı GET sorgusudur. Normal gönderim/normal receipt, SQL, yetki, matcher, event POST ve donmuş operatör paketi değişmez.

## Kanıt ve sınır

Root'un salt okunur UI metadata kontrolü receipt key kapsamını Accounts/Events/Metrics read olarak doğruladı; Profiles read yok. Basit event-scope probe include istemediği için geçebilir; ayrıntılı V include=metric,profile ile profile okuma izni gerektirir. Bu yetki uyuşmazlığı doğrulandı; gerçek sağlayıcının HTTP403 veya hata gövdesi bu incelemede görülmedi, hata nedeni olarak bunu kesin HTTP kanıtı gibi sunmuyoruz.

Resmi [Klaviyo anahtar/include açıklaması](https://help.klaviyo.com/hc/en-us/articles/7423954176283), ilişkili kaynak include edildiğinde onun okuma izninin de gerektiğini belirtir. [July2026 Get Events](https://developers.klaviyo.com/en/v2026-07-15/reference/get_events) ve [sabit resmi OpenAPI](https://raw.githubusercontent.com/klaviyo/openapi/930eb41fdc3917bc9ae3c69c04078341cd84fe68/openapi/stable/apis/get_events.json), fields[profile]=id ve fields[metric]=id,name,integration değerlerinin geçerli olduğunu gösterir; id sözdizimi hatası iddia edilmez. July spec SHA d81ec2b3fc30d79825f29e2b682261156579716f67056f7e01d6a3c024bff464.

## Dar düzeltme

Ayrıntılı GET'ten include ve ilişkili resource sparse fieldsets kaldırıldı; fields[event]=datetime,event_properties,uuid istendi. Mevcut profile/metric/datetime filtreleri, sayfa100, pinned revision, Accounts pacing ve GET-only davranış aynı. Metric kimliği/integration zaten inventory'de; verifier included kaynakları kullanmıyor. Primary event relationships.profile/metric linkage kontrolü aynen kalır. Resmi schema bu linkage alanlarını tanımlar ama relationships zorunlu değildir; eksik veya yanlış ilişki kanıtı kabul edilmez. Yetki genişletilmez; tarih/UUID/property/hash/eşsizlik ve tek olay kontrolleri gevşetilmez.

## Test ve teslim sınırı

Gerçek workerd 134/134, skip0: profiles read olmayan sentetik transport eski expansion sorgusunu403 reddeder, yeni GET ve gerçek verifier primary linkage ile geçer. Eksik/yanlış profile/metric linklerinde records0; event GET403 durumunda unknown/records0. Bu yeni doğrulama senaryolarında bütün provider çağrıları GET ve yerel interceptor içindedir. Official schema contract4/4; explicit Functions TSC ve yerel Functions build geçti. Normal couponDelivery/couponWelcome ve SQL23/24 dosyaları main ile aynı; public/src değişmedi. Kanıt log/SHA dosyaları K10_Bootstrap_Event_Read_kanit altında.

Merge/deploy sonrası yalnız mevcut permit'in V doğrulaması root/Talip'in ayrı kararıdır; I veya D tekrar edilmez. Bu teslimde authenticated provider, gerçek event/e-posta, hosted SQL, secret veya dağıtım yapılmadı.
