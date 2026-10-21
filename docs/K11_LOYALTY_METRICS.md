# K11 — Sadakat, davet ve gözlenen platform ölçüleri

Bu teslim kod ve sentetik prova içindir. Migration 9. sıradadır; K7 kapanmadan ve K9 #65 birleştirilmeden uygulanmaz. Migration canlı kural, müşteri, davet, kapsam veya mesaj satırı eklemez; gönderici, görev, cron, izin ve sağlayıcı yazısı yoktur.

## Veri ve işletim sözleşmesi

- `core.loyalty_rules`: tenant başına artan sürüm; varsayılan **kapalı**, öneri sipariş başına bir ziyaret. Talip etkinleştirme değerini kararlaştırdıktan sonra yetkili operatör ayrı bir sürüm ekler. Eski sürümler güncellenmez/silinmez. Geçmiş siparişleri otomatik geriye dönük doldurmaz.
- `core.loyalty_ledger`: `earn/redeem/adjust`, imzalı `units`, kural sürümü ve sipariş bağlantısı. Güncelleme/silme/truncate engellenir. Ödül harcama yolu bu kapsamda yoktur.
- K7'nin tam ingest işleminin sonunda ertelenmiş order/payment/refund trigger'ları aynı çekirdek işlemciyi çağırır; K8'in K7'ye yazan yolu da kapsanır. Eski SQL dosyaları ve K7 fonksiyonları değiştirilmez. Aynı sipariş satır kilidiyle seri işlenir; tekrar çağrı ikinci earn üretmez.
- Uygunluk yalnız `core.clover_order_status_v1` sonucunda `paid` ve K7 eşleşmesinde `exact` olan sipariştir. Kural sürümü ve ölçüm ayı, sipariş oluşturma tarihinden değil tutarı pozitif ilk başarılı ödemenin kanıtlı zamanından seçilir; böyle bir ödemede tarih eksikse tarih uydurulmaz, ziyaret ve o kişinin ilk-sipariş sınıflandırması bekler. K7 `refunded` döndürürse, kısmi iade dahil, önceki ziyaret yeni bir `adjust` ile geri alınır. Bu finansal durumu yeniden yorumlayan bir ikinci motor değildir. Geri dönüşte aynı ziyaret yeni adjust ile düzeltilir; tarihçe kalır. Kimlik eşleşmesi izin oluşturmaz.
- `core.referrals`: tenant içinde tek kullanımlık benzersiz davet kodu, davet eden, kesin eşleşen davet edilen ve ilk gözlenen ödenmiş sipariş. Bekleyen kod operatör tarafından hazırlanabilir; dağıtım yoktur. Yalnız order snapshot'ındaki açık `referralCode`, kendi kendini davet etmeyen ve daha eski gözlenen ödenmiş siparişi olmayan kesin müşteriyle tamamlanır. Belirsiz eşleşme tamamlanmaz. Sonraki iade, geçmişteki eşleşme kaydını silmez; ziyaret ledger'ı düzeltilir.
- Tüm yeni tablolar private `core` içinde, RLS açık ve aynı tenant'ı zorlayan bileşik dış anahtarlıdır. Authenticated/service rolünün doğrudan tablo yetkisi yoktur. Okuma, ortak personel sözleşmesindeki `core.staff_authorized_v1(business_id,'loyalty.read')` ile denetlenir: hedef işletmenin aktif `core.business_staff` üyesi veya aktif `core.platform_operators` operatörü okuyabilir. Platform-only operatör bu okuma sayesinde işletme adına yazamaz; eski `crm_staff` üyeliği tek başına yetki vermez. K11 ayrı yetki tabloları ve gerçek kimlik tohumu oluşturmaz. Bu teslim mevcut global RPC'lerin yetkisini değiştirmez.

## Uçlar

`public.loyalty_order_process_v1(p_business_id uuid,p_order_id uuid)` yalnız `service_role`; dönüt `ok, order_id, status, earned_units, net_units, referral_completed, reason`. Normal ingest trigger'ları nedeniyle düzenli çağırıcı eklemek gerekmez; bu uç kontrollü tekrar işlemesi içindir.

`public.loyalty_metrics_v1(p_business_id uuid,p_month date,p_include_tests boolean=false)` yalnız yetkili `authenticated`; yetkisiz/diğer tenant `42501` (REST 403). Ay ilk gün olarak verilir; sınırlar tenant'ın mevcut `businesses.timezone` ayarından türetilir. JSON:

```text
version:1, business_id, month:YYYY-MM-01, timezone, include_tests, generated_at,
coverage:"observed_ingested_orders",
customer_counts:{known,new,repeat,reason},
campaigns:{known,items:[{campaign_id,name,applied,
  repeat_30d:{known,numerator,denominator,rate,reason}}],reason},
messages:{known,sent,reason}, attribution:{known,orders,reason}
```

`known=false` sayıları JSON null'dır. Sipariş verisi yokluğu sıfır satış diye gösterilmez. Kaynak **yalnız içe alınmış gözlenen kayıtlar**; K7 gün mutabakatı veya tüm geçmişin eksiksizliğini bu RPC onaylamaz. İlk gözlenen ödenmiş siparişi bu ay olan kişi yeni; bu ay sonraki ödenmiş siparişi olan kişi tekrar sayılır. Aynı ay iki sipariş veren kişi iki grupta da bulunabilir; bu iki sayı toplanarak tekil müşteri toplamı üretilmez. Daha önce iade edilmiş ödenmiş sipariş, ilk-sipariş geçmişinden silinmez.

Kampanya sayısı yalnız K9 `applied` kullanım satırlarıdır; siparişin eski ayda oluşturulması bu ayki kullanım kaydını gizlemez. 30 günlük oran yalnız en az 30 gün önceki kullanım kohortunda hesaplanır; olgunlaşmamış kohort ayrıca neden koduyla belirtilir, olgun kohort yoksa oran null'dır. Olası tekrar siparişinin ödeme zamanı eksikse, sıfır tekrar varsayılmadan etkilenen oran bilinmiyor kalır. Bu gözlenen kayıt oranıdır; kaynak kapsamı veya nedensellik kanıtı değildir.

Gönderim yalnız K6 `message_log.status=sent` sayılır; rezervasyon gönderim değildir. Mesaj→sipariş için order snapshot'ında `messageAttribution.messageId` ile gerçek aynı-tenant/müşteri `sent` satırı ve `messageAttribution.campaignCode` ile o satırın `message_key` değeri açıkça eşleşmelidir; sipariş gönderimden sonraki 30 gün içindedir. Bu eşleştirmeyi taşıyan canlı bağ henüz yoksa kutu **—** gösterir. Zaman yakınlığı, e-posta benzerliği veya kampanya adından bağ uydurulmaz. Hiçbir uç kişisel iletişim alanını veya mesaj içeriğini döndürmez.

## Test ve uygulama sırası

Yerel fixture iki sentetik tenant ve personel kapsamlarıyla sınanır; bu, üretimde çok kiracılık devreye alındı anlamına gelmez. Üretime bağlantı/SQL uygulama/gönderim bu teslimde yapılmaz. Talip K7 ve #65 sonrasında PR'ı kabul eder; aynı LF migration önce testte, ardından üretimde mevcut pinlenmiş PowerShell 7 + psql yöntemiyle uygulanır. Personel kapsamı ve sadakat kuralı kendiliğinden etkinleşmez; operatör bunları ayrı doğrulanmış girdilerle hazırlar. Canlı kapanış için K7/K10 gerçek sipariş ve kullanım kanıtı beklenir.
