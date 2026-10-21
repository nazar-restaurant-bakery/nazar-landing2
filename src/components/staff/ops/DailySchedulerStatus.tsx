import {useEffect,useState} from 'react';
import {staffClient} from '../../../lib/crmData';
type Run={status:string;safe_code:string;local_date:string;target_date:string;clover_status:string;ops_status:string};
type State={enabled:boolean;last_run:Run|null;requests_today:number};
export default function DailySchedulerStatus({businessId}:{businessId?:string}){
 const [state,setState]=useState<State|null>(null),[error,setError]=useState(false),[busy,setBusy]=useState(false);
 async function read(){
  if(!staffClient||!businessId)return;
  setBusy(true);
  try{const r=await staffClient.rpc('daily_scheduler_status',{p_business_id:businessId});if(r.error)throw Error();setState(r.data as State);setError(false);}catch{setState(null);setError(true);}finally{setBusy(false);}
 }
 useEffect(()=>{let active=true;
  if(staffClient&&businessId)void staffClient.rpc('daily_scheduler_status',{p_business_id:businessId}).then(r=>{if(active){setState(r.error?null:r.data as State);setError(!!r.error);}},()=>{if(active){setState(null);setError(true);}});
  return()=>{active=false;};
 },[businessId]);
 const run=state?.last_run;
 const warning=!!run&&['failed','partial','missed'].includes(run.status);
 return <section className="staff-panel p-4" aria-label="Günlük zamanlayıcı">
  <h2 className="text-sm font-semibold">Günlük zamanlayıcı</h2>
  <p>{error?'Kurulum veya yetki kontrolü bekliyor':state?.enabled?'Etkin · Her gün 07:00 New York':'Duraklatıldı · Varsayılan kapalı'}</p>
  <p>Önce dünün Clover siparişleri, sonra Ops toplama. Yaz/kış saati otomatik uygulanır.</p>
  {state&&<p>Bugünkü dış istek: {state.requests_today} / 30</p>}
  {run?<div role={warning?'alert':undefined}><p>Son koşu: {run.local_date} · {run.status}</p><p>Clover: {run.clover_status} · Ops: {run.ops_status}</p><p>{run.safe_code}</p>{warning&&<p>İşlem eksik veya başarısız. Otomatik tekrar yapılmadı.</p>}</div>:<p>Henüz koşu kaydı yok.</p>}
  <p>Ops başarısı Clover gün mutabakatı değildir.</p>
  <button disabled={busy||!businessId} onClick={()=>void read()}>Zamanlayıcı durumunu yenile</button>
 </section>;
}
