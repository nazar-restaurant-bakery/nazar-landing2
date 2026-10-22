import {useEffect,useState} from 'react';
import {staffClient} from '../../../lib/crmData';
import {loyaltyMonth} from '../../../lib/loyaltyMetrics';
import {validQrFunnel,type QrVipFunnel as Funnel} from '../../../lib/qrVipFunnel';
export default function QrVipFunnel({businessId,identity,includeTests,revision=0}:{businessId:string;identity:string;includeTests:boolean;revision?:number}) {
 const [tick,setTick]=useState(0),[record,setRecord]=useState<{key:string;data:Funnel|null;state:string}|null>(null);
 const month=loyaltyMonth(),key=[businessId,identity,includeTests,month,revision,tick].join(':');
 useEffect(()=>{
  let active=true;
  const timer=window.setTimeout(()=>{if(active){active=false;setRecord({key,data:null,state:'Ölçüm zaman aşımı; yeniden okuyun.'});}},18000);
  if(staffClient)void Promise.resolve(staffClient.rpc('qr_vip_funnel_v1',{p_business_id:businessId,p_month:month,p_include_tests:includeTests})).then(r=>{
   if(!active)return;
   const state=r.error?.code==='42501'?'403 · Huni okuma yetkisi yok.':r.error||!validQrFunnel(r.data,businessId,month,includeTests)?'Huni kaynağı bekleniyor veya doğrulanamadı.':'ready';
   setRecord({key,data:state==='ready'?r.data as Funnel:null,state});window.clearTimeout(timer);
  },()=>{if(active){setRecord({key,data:null,state:'Huni okunamadı; yeniden okuyun.'});window.clearTimeout(timer);}});
  return()=>{active=false;window.clearTimeout(timer);};
 },[key,businessId,month,includeTests]);
 const view=record?.key===key?record:null,f=view?.data;
 const count=(v:number|null|undefined)=>typeof v==='number'?v.toLocaleString('tr-TR'):'—';
 return <section className="staff-panel min-w-0 space-y-3 p-4" aria-label="QR kart → VIP → Simit hunisi" data-testid="qr-vip-funnel">
  <h2 className="text-lg font-semibold">QR kart → VIP → Simit</h2>
  <p className="text-xs text-stone-600">Basılı P kartı · qr / offline / qr_paket. GA4 oturumu fiziksel tarama veya tekil kişi sayısı değildir.</p>
  {!f?<p role="status">{view?.state||'Huni okunuyor…'}</p>:<>
   <p className="text-xs">{month.slice(0,7)} · {f.timezone} · {includeTests?'Test kayıtları dahil; gerçek GA4 oturumları gösterilmez.':'Test kayıtları hariç'}</p>
   <dl className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
    <div><dt>Kart ziyaretleri (GA4 oturum)</dt><dd>{count(f.sessions)}</dd></div>
    <div><dt>VIP kaydı (kişi)</dt><dd>{count(f.registrations)}</dd></div>
    <div><dt>E-posta onayı (kişi)</dt><dd>{count(f.confirmed)}</dd></div>
    <div><dt>Simit kuponu kullanımı</dt><dd>{count(f.used)}</dd><p>Siparişe bağlı: {count(f.order_linked)}</p><p>Personel beyanı: {count(f.staff_attested)}</p></div>
    <div><dt>30 günde tekrar</dt><dd>{f.repeat_30d.known?`${(f.repeat_30d.rate!*100).toLocaleString('tr-TR')}% (${f.repeat_30d.numerator}/${f.repeat_30d.denominator})`:'—'}</dd></div>
   </dl>
   {f.sessions===null&&<p className="text-xs">QR oturum raporu yok, dönem uyuşmuyor veya kaynak doğrulanamıyor; sıfır varsayılmadı.</p>}
   <p className="text-xs text-stone-600">Kayıt penceresi ay başından {new Date(f.cohort_end_exclusive).toLocaleDateString('tr-TR',{timeZone:f.timezone})} gününe kadar (bu gün hariç). Onay ve kullanım bu kayıt kohortuna bağlı, son okuma anına kadar izlenir. Simit kapsamı: signup_reward / SIMIT. Tekrar oranı yalnız siparişe bağlı, 30 günü tamamlayan kullanımların gözlenen ödenmiş siparişlerinden hesaplanır; personel beyanları dahil değildir. Oturum ile müşteri eşleştirilmez; nedensel dönüşüm oranı değildir.</p>
  </>}
  <button className="staff-button staff-secondary" onClick={()=>setTick(t=>t+1)}>Huniyi yenile</button>
 </section>;
}
