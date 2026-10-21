import {useCallback,useEffect,useRef,useState} from 'react';
import {staffClient} from '../../lib/crmData';
import {channels,couponLabels,couponReasons,forbidden,normalizeCoupon,receiptNote,redemptionResult,validCoupon,type Coupon,type Receipt} from '../../lib/couponCheckout';
import CouponCamera from '../../components/staff/CouponCamera';

const emptyReceipt=():Receipt=>({orderId:'',text:'',channel:'',amount:'',receiptAt:'',receiptRef:'',checked:false});
const time=(value:string)=>new Date(value).toLocaleString('tr-TR',{timeZone:'America/New_York'});
export default function CouponCheckout({businessId}:{businessId:string}) {
  const [access,setAccess]=useState<'checking'|'allowed'|'denied'|'unavailable'>('checking');
  const [code,setCode]=useState(''),[coupon,setCoupon]=useState<Coupon|null>(null),[receipt,setReceipt]=useState(emptyReceipt);
  const [camera,setCamera]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[uncertain,setUncertain]=useState(false);
  const alive=useRef(false),pending=useRef(false),generation=useRef(0),uncertainRef=useRef(false),currentCode=useRef('');
  useEffect(()=>{
    alive.current=true;const epoch=++generation.current;
    if(staffClient)void Promise.resolve(staffClient.rpc('staff_business_authorized_v1',{p_business_id:businessId,p_operation:'campaign.staff_mark'}))
      .then(r=>{if(alive.current&&epoch===generation.current)setAccess(forbidden(r)||r.data===false?'denied':!r.error&&r.data===true?'allowed':'unavailable');},()=>{if(alive.current&&epoch===generation.current)setAccess('unavailable');});
    else queueMicrotask(()=>{if(alive.current)setAccess('unavailable');});
    // Mutable request generation, not a captured DOM ref. Invalidate all late replies.
    return()=>{alive.current=false;generation.current++;currentCode.current='';}; // eslint-disable-line react-hooks/exhaustive-deps
  },[businessId]);
  const acceptCode=useCallback((next:string)=>{
    if(pending.current||uncertainRef.current)return;
    generation.current++;currentCode.current=next;setCode(next);setCoupon(null);setReceipt(emptyReceipt());setMessage('');setCamera(false);
  },[]);
  function deny(){generation.current++;setAccess('denied');setCode('');currentCode.current='';setCoupon(null);setReceipt(emptyReceipt());setCamera(false);setMessage('');}
  async function lookup(manual=true){
    if(!staffClient||access!=='allowed'||pending.current)return;
    const normalized=normalizeCoupon(currentCode.current);
    if(!normalized){setMessage('16 sembollü kupon kodunu kontrol edin.');return;}
    pending.current=true;setBusy(true);setCamera(false);setCoupon(null);
    const epoch=++generation.current;
    try{
      const r=await staffClient.rpc('coupon_lookup_v1',{p_business_id:businessId,p_code:normalized});
      if(!alive.current||epoch!==generation.current)return;
      if(forbidden(r)){deny();return;}
      if(r.error||!validCoupon(r.data))throw Error();
      setCoupon(r.data);setCode(normalized);currentCode.current=normalized;
      if(manual){uncertainRef.current=false;setUncertain(false);setMessage('');}
    }catch{if(alive.current&&epoch===generation.current)setMessage('Kupon durumu doğrulanamadı. Kullanımı işaretlemeyin; durumu yeniden okuyun.');}
    finally{if(alive.current&&epoch===generation.current){pending.current=false;setBusy(false);}}
  }
  async function redeem(){
    if(!staffClient||pending.current||uncertainRef.current||access!=='allowed'||!coupon?.valid)return;
    const normalized=normalizeCoupon(currentCode.current),note=receiptNote(receipt,coupon);
    if(!normalized||!note){setMessage('Gerçek fişin kanal, tutar, tarih ve referansını doldurup fiş kontrolünü onaylayın.');return;}
    pending.current=true;setBusy(true);setMessage('');const epoch=++generation.current;
    try{
      const r=await staffClient.rpc('coupon_redeem_v1',{p_business_id:businessId,p_code:normalized,p_clover_order_id:receipt.orderId.trim()||null,p_note:note});
      if(!alive.current||epoch!==generation.current)return;
      if(forbidden(r)){deny();return;}
      if(r.error||!redemptionResult(r.data))throw Error();
      if(r.data.status==='used')setCoupon({...coupon,status:'used',valid:false,redeemedAt:r.data.redeemedAt||null});else setCoupon(null);
      setMessage(r.data.redeemed?`Kullanım kaydedildi.${r.data.evidenceMode==='staff_attested'?' Personel beyanı (staff_attested); K7 sipariş doğrulaması değildir.':''}`:couponReasons[r.data.code]||'Kullanım doğrulanamadı.');
      setReceipt(emptyReceipt());
    }catch{
      if(!alive.current||epoch!==generation.current)return;
      uncertainRef.current=true;setUncertain(true);setCoupon(null);setReceipt(emptyReceipt());
      setMessage('Sonuç belirsiz. Yeniden işaretleme kapalı; kupon durumu salt okunur kontrol ediliyor.');
      // Exactly one readback; never retry the write after a lost response.
      try{
        const r=await staffClient.rpc('coupon_lookup_v1',{p_business_id:businessId,p_code:normalized});
        if(!alive.current||epoch!==generation.current)return;
        if(forbidden(r)){deny();return;}
        if(!r.error&&validCoupon(r.data))setCoupon(r.data);
      }catch{/* A failed readback cannot prove the write failed. */}
    }finally{if(alive.current&&epoch===generation.current){pending.current=false;setBusy(false);}}
  }
  const update=(field:keyof Receipt,value:string|boolean)=>setReceipt(previous=>({...previous,[field]:value}));
  if(access!=='allowed')return <section className="staff-panel mx-auto max-w-2xl p-4" aria-label="Kupon">
    <h1 className="text-xl font-semibold">Kupon</h1><p role="status">{access==='checking'?'Yetki kontrol ediliyor…':access==='denied'?'403 · Bu işletmede kupon kullanımı için yetkiniz yok.':'Kupon bağlantısı veya yetki doğrulanamadı. Sayfayı yenileyin.'}</p>
  </section>;
  return <section className="staff-panel mx-auto grid max-w-2xl min-w-0 gap-4 p-4" aria-label="Kupon kasa ekranı">
    <header><h1 className="text-xl font-semibold">Kupon</h1><p className="mt-2 text-sm">Clover’da siparişe Sade Simit ekle → yalnız o satıra %100 indirim (ayrı indirim kalemi); sipariş vergi/bahşiş hariç $30 ve üzeri olmalı.</p></header>
    <form className="grid min-w-0 gap-3" onSubmit={event=>{event.preventDefault();void lookup();}} autoComplete="off">
      <label className="staff-label">Kupon kodu<input aria-label="Kupon kodu" name="coupon-private-code" autoComplete="off" spellCheck={false} autoCapitalize="characters" className="staff-input mt-1" maxLength={40} value={code} disabled={busy||uncertain} onChange={e=>acceptCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" /></label>
      <div className="flex flex-wrap gap-2"><button className="staff-button" disabled={busy}>{busy?'Kontrol ediliyor…':uncertain?'Durumu yeniden oku':'Kuponu kontrol et'}</button>
        <button type="button" className="staff-button staff-secondary" disabled={busy||uncertain} onClick={()=>setCamera(value=>!value)}>QR okut</button></div>
    </form>
    {camera&&<CouponCamera onCode={acceptCode} onClose={()=>setCamera(false)} />}
    {message&&<p role="status" className="break-words rounded-lg bg-amber-50 p-3 text-sm">{message}</p>}
    {uncertain&&<p role="alert" className="text-sm">Kör tekrar yapılmadı. Yeniden işlemden önce “Durumu yeniden oku” ile güncel sonucu doğrulayın.</p>}
    {coupon&&<section aria-label="Kupon sonucu" className="min-w-0 rounded-lg border border-brand-border p-3">
      <h2 className="text-lg font-semibold">{couponLabels[coupon.status]}</h2>
      {coupon.customerNameMasked&&<p>Müşteri: {coupon.customerNameMasked}</p>}
      {coupon.campaign&&<p className="break-words">Kampanya: {coupon.campaign.name}</p>}
      {coupon.redeemedAt&&<p>Kullanım zamanı (New York): {time(coupon.redeemedAt)}</p>}
      {coupon.expiresAt&&<p>Son kullanım (New York): {time(coupon.expiresAt)}</p>}
      {coupon.valid&&<><p className="mt-2 text-sm">Kupon geçerli; sipariş tutarı, kanal ve kupondan sonraki gerçek fiş zamanı ayrıca kontrol edilir. Kampanya eşiği: ${(coupon.campaign!.minimumAmountCents/100).toFixed(2)}; sipariş başına 1 sade simit.</p>
        <fieldset disabled={busy||uncertain} className="mt-4 grid min-w-0 gap-3"><legend className="mb-2 font-semibold">Gerçek fiş / sipariş kontrolü</legend>
          <label className="staff-label">Clover sipariş no (isteğe bağlı)<input aria-label="Clover sipariş no (isteğe bağlı)" autoComplete="off" className="staff-input" maxLength={32} value={receipt.orderId} onChange={e=>update('orderId',e.target.value)} /></label>
          <p className="text-xs">Clover no yoksa personel beyanı (staff_attested) kaydedilir. Numara varsa K7 kanıtıyla eşleşmelidir; eksik eşleşmede beyana düşülmez.</p>
          <label className="staff-label">Kanal<select aria-label="Kanal" className="staff-input" value={receipt.channel} onChange={e=>update('channel',e.target.value)}><option value="">Seçin</option>{coupon.campaign!.channels.map(channel=><option key={channel} value={channel}>{channels[channel]}</option>)}</select></label>
          <label className="staff-label">Vergi/bahşiş hariç tutar ($)<input aria-label="Vergi/bahşiş hariç tutar ($)" className="staff-input" inputMode="decimal" maxLength={12} value={receipt.amount} onChange={e=>update('amount',e.target.value)} /></label>
          <label className="staff-label">Fiş tarih / saat (bu cihazın yerel saati)<input aria-label="Fiş tarih / saat" type="datetime-local" className="staff-input" value={receipt.receiptAt} onChange={e=>update('receiptAt',e.target.value)} /></label>
          <label className="staff-label">Gerçek fiş referansı<input aria-label="Gerçek fiş referansı" autoComplete="off" className="staff-input" maxLength={120} value={receipt.receiptRef} onChange={e=>update('receiptRef',e.target.value)} /></label>
          <label className="staff-label">Not (isteğe bağlı)<textarea aria-label="Not (isteğe bağlı)" autoComplete="off" className="staff-input" rows={2} maxLength={1000} value={receipt.text} onChange={e=>update('text',e.target.value)} /></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={receipt.checked} onChange={e=>update('checked',e.target.checked)} />Gerçek fişi, tutarı, kanalı ve sipariş başına tek simit koşulunu kontrol ettim.</label>
          <button type="button" className="staff-button w-full" disabled={busy||uncertain||!receiptNote(receipt,coupon)} onClick={()=>void redeem()}>Kullanıldı olarak işaretle</button>
        </fieldset></>}
    </section>}
  </section>;
}
