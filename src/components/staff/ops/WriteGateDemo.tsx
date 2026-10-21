import { useState } from "react";
import { staffClient } from "../../../lib/crmData";
type Action={id:string;target_id:string;preview_hash:string;expires_at:string;status:string;safe_result_code:string};
export default function WriteGateDemo({businessId}:{businessId:string}) {
 const [action,setAction]=useState<Action|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const [blocked,setBlocked]=useState(false);
 async function call(operation:string,params:Record<string,unknown>={}) {
  if(!staffClient)throw new Error("unavailable");
  const result=await staffClient.functions.invoke("ops-write",{body:{operation,business_id:businessId,...params},timeout:15000});
  if(result.error||!result.data?.action)throw new Error("unknown");
  return result.data.action as Action;
 }
 async function preview(){setBusy(true);setMessage("");try{setAction(await call("preview",{target_id:crypto.randomUUID(),idempotency_key:crypto.randomUUID()}));setBlocked(false);}catch{setMessage("Önizleme alınamadı. Kapı kapalı veya yetki yok.");}finally{setBusy(false);}}
 async function run(){if(!action)return;setBusy(true);setBlocked(true);try{
  const args={action_id:action.id,target_id:action.target_id,preview_hash:action.preview_hash};
  const approved=await call("approve",args);setAction(approved);
  if(approved.status!=="approved"){setMessage("Onay geçerli değil; yeni önizleme gerekir.");return;}
  const result=await call("execute",args);setAction(result);setBlocked(false);setMessage(result.status==="succeeded"?"Dry-run tamamlandı. Dış sistem değişmedi.":"İşlem tamamlanmadı.");
 }catch{setMessage("Sonuç belirsiz veya işlem reddedildi. Tekrar çalıştırmadan önce Durumu kontrol et.");}finally{setBusy(false);}}
 async function refresh(){if(!action)return;setBusy(true);try{const result=await call("status",{action_id:action.id});setAction(result);setBlocked(!["succeeded","failed","expired"].includes(result.status));setMessage(`Durum: ${result.status} · ${result.safe_result_code}`);}catch{setMessage("Durum alınamadı; yeniden çalıştırılmadı.");}finally{setBusy(false);}}
 return <section aria-label="İşlem kapısı denemesi" className="ops-section">
  <h2>İşlem kapısı denemesi</h2><p>Bu örnek dış sistemlere yazmaz.</p>
  <button disabled={busy||blocked} onClick={()=>void preview()}>Dry-run önizle</button>
  {action&&<div role="group" aria-label="Dry-run önizleme">
   <p>Önce: Örnek işlem uygulanmadı</p><p>Sonra: Yalnız dry-run tamamlanacak; dış sistem değişmez</p>
   <p>Hedef: {action.target_id} · Son kullanma: {new Date(action.expires_at).toLocaleString("tr-TR")}</p>
   <button disabled={busy||blocked||action.status!=="previewed"||Date.parse(action.expires_at)<=Date.now()} onClick={()=>void run()}>Çalıştır</button>
   <button disabled={busy} onClick={()=>void refresh()}>Durumu kontrol et</button>
  </div>}
  <p role="status">{message}</p>
 </section>;
}
