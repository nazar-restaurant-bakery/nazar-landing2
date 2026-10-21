# K10 — Ops kampanya kullanım ayrımı

Sipariş numarasız geçerli kupon kullanımını dışarıda bırakan K11 INNER JOIN giderildi. Ops kutusu Toplam kullanım, Siparişe bağlı, Personel beyanı gösterir; toplam iki alt sayının toplamıdır. Tekrar sipariş oranı yalnız siparişe bağlı, 30 günü dolmuş kullanımlardan hesaplanır; bu not kutuda görünür. Kasa ve isteğe bağlı Clover numarası değişmedi. applied durumundaki kullanımlar sayılır; eski void kayıtları uygulanan kullanım sayılmaz.

RPC imzası aynı: loyalty_metrics_v1(uuid,date,boolean). Kampanya item'ına order_linked/staff_attested sayıları eklendi. Yetki, tenant, ay/timezone, test filtresi, ACL, SECURITY DEFINER ve boş search_path korundu. NULL-order kullanım gerçek ölçüm kaynağı sayılır; repeat kohortunun mature/recent/uncertain/repeated hesaplarının her biri yalnız order_id dolu kayıtları kapsar. K7 kaynak siparişi FK ile aynı işletmededir; burada yeni sipariş eşlemesi veya Clover indirim satırı doğrulaması iddia edilmez. UI alt sayıları doğrular; tutarsız toplam/denominator reddedilir. Eski backend toplamı korur ama alt sayıları — ve güncelleme bekleniyor açıklamasıyla gösterir.

## Migration / sıra önerisi

**Sıra 16**, sıra 15 sonrasında önerilir; kesin sırayı Koordinasyon kaydeder. Yeni dosya: `supabase/migrations/20261021001000_ops_campaign_usage_split.sql`.

SHA256: `8eae6c4407bc33cbc710bb5c9e2ac56cfe1fb36f573b8be47fa0146871cf57e0` (UTF-8, LF).

Önceki K11 function gövdesinin MD5'i beklenmeyen sürümde veya tekrarda transaction'ı durdurur. CREATE OR REPLACE aynı imza/OID ve ACL'yi korur. K11 sıra 9, kupon 14/14a, personel 15 ve diğer uygulanmış migration dosyaları değiştirilmedi. Talip ancak inceleme/birleşme sonrası aynı LF/SHA ile önce sandbox sonra üretime standart psql 18.6 yoluyla uygular; bu teslim SQL çalıştırma veya kurulum başarısı değildir.

## Doğrulama

- 45/45 Node birim/native PostgreSQL testi; yeni gerçek kupon + K11 entegrasyonunda 7 grup: 1=0+1, 2=1+1, ikinci kullanım, test filtresi, yanlış tenant reddi, 1/2 tarihi sipariş kohortu, ACL ve migration replay reddi.
- 11/11 tarayıcı: 3=2+1, eski backend — ayrımı, not, 375px, tenant/test filtresi, 403, çıkış ve geç yanıt; dış istek yok.
- TypeScript ve hedefli ESLint geçti. Production mode / aynı sentetik public env ile main 4123b23 karşılaştırması: 213/213 dosya, 209 byte-eşit; CSS, public form, Auth ve GA4 kaynakları aynı. Hosted env/anahtar okunmadı.
- Kanıt: `K10_Ops_Kullanim_kanit/summary.json`, `native.json`, `browser/results.json`, `production-parity.json`.

Kuru test tarifi bu PR'a eklendi/güncellendi: ileri migration sonrası beklenen **1 toplam / 0 siparişe bağlı / 1 personel beyanı**, ikinci deneme ve $29.99 reddinde değişmez. Tekrar oranı bu yalnız beyanlı provada — kalır. Sandbox site linki ayrı nazar-catering-sandbox projesine yönlendirildi. Tarif hosted kabul sayılmaz.

Draft PR, taban main; birleştirme Talip'te. Canlı DB, dış hesap, e-posta, secret, kasa davranışı veya komisyon formülü değişmedi.
