import {useEffect,useRef,useState} from 'react';
import {staffClient} from '../../lib/crmData';
import {inviteCode,managementDenied,managementMessages,roleName,staffRoles,validMemberList,type Member,type MemberList,type StaffRole} from '../../lib/staffManagement';

export default function StaffManagement({businessId,onScopeChange}:{businessId:string;onScopeChange:()=>void}){
 return <Content key={businessId} businessId={businessId} onScopeChange={onScopeChange}/>;
}
function Content({businessId,onScopeChange}:{businessId:string;onScopeChange:()=>void}){
 const [phase,setPhase]=useState<'checking'|'allowed'|'denied'|'unavailable'>('checking'),[data,setData]=useState<MemberList|null>(null);
 const [email,setEmail]=useState(''),[role,setRole]=useState<StaffRole>('staff'),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[blocked,setBlocked]=useState(false);
 const [editing,setEditing]=useState<Member|null>(null),[editRole,setEditRole]=useState<StaffRole>('staff'),[editActive,setEditActive]=useState(true);
 const alive=useRef(false),generation=useRef(0),pending=useRef(false),requestKey=useRef<string|null>(null);
 const callbacks=useRef(onScopeChange);useEffect(()=>{callbacks.current=onScopeChange;},[onScopeChange]);
 function clearDenied(){setData(null);setEmail('');setEditing(null);requestKey.current=null;setPhase('denied');callbacks.current();}
 async function read(manual=false){
  if(!staffClient||pending.current)return;pending.current=true;setBusy(true);const epoch=++generation.current;
  try{
   const allowed=await staffClient.rpc('staff_business_authorized_v1',{p_business_id:businessId,p_operation:'staff.manage'});
   if(!alive.current||epoch!==generation.current)return;
   if(managementDenied(allowed)||!allowed.error&&allowed.data===false){clearDenied();return;}
   if(allowed.error||allowed.data!==true)throw Error();
   const r=await staffClient.rpc('staff_members_list_v1',{p_business_id:businessId});if(!alive.current||epoch!==generation.current)return;
   if(managementDenied(r)){clearDenied();return;}if(r.error||!validMemberList(r.data,businessId))throw Error();
   setData(r.data);setPhase('allowed');if(manual){setBlocked(false);setEditing(null);requestKey.current=null;setMessage('Liste güncellendi. Belirsiz davetler tekrar gönderilmez.');}
  }catch{if(alive.current&&epoch===generation.current){setData(null);setPhase('unavailable');}}
  finally{if(alive.current&&epoch===generation.current){pending.current=false;setBusy(false);}}
 }
 useEffect(()=>{
  alive.current=true;queueMicrotask(()=>{if(alive.current)void read();});
  // Invalidate request generations and all drafts when the keyed session unmounts.
  // Monotonic request generation is intentionally invalidated at cleanup; it is not a DOM ref.
  return()=>{alive.current=false;generation.current++;requestKey.current=null;}; // eslint-disable-line react-hooks/exhaustive-deps
 // read is deliberately mount-only; refresh is an explicit operator action.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 async function invite(event:React.FormEvent){
  event.preventDefault();if(!staffClient||pending.current||blocked||!data?.inviteEnabled||phase!=='allowed')return;
  const target=email.trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)||target.length>254)return;
  pending.current=true;setBusy(true);setMessage('');const epoch=++generation.current;
  requestKey.current??=crypto.randomUUID();let refresh=false;
  try{
   const r=await staffClient.functions.invoke('staff-manage-invite',{body:{businessId,email:target,role,requestId:requestKey.current}});
   if(!alive.current||epoch!==generation.current)return;if(managementDenied(r)){clearDenied();return;}
   const code=await inviteCode(r);if(!alive.current||epoch!==generation.current)return;if(!code)throw Error();setMessage(managementMessages[code]);refresh=true;
   if(['invited','existing_account_added','member_exists','invite_rejected','expired'].includes(code)){setEmail('');requestKey.current=null;}
  }catch{if(alive.current&&epoch===generation.current){setBlocked(true);setMessage('Davet sonucu doğrulanamadı. Yenile ile kayıtları okuyun; yeniden e-posta gönderilmedi.');refresh=true;}}
  finally{if(alive.current&&epoch===generation.current){pending.current=false;setBusy(false);if(refresh)void read();}}
 }
 async function save(){
  if(!staffClient||pending.current||blocked||!editing||phase!=='allowed')return;
  pending.current=true;setBusy(true);setMessage('');const epoch=++generation.current;let refresh=false;
  try{
   const r=await staffClient.rpc('staff_member_update_v1',{p_business_id:businessId,p_target_staff_id:editing.staffId,p_role:editRole,p_active:editActive,p_expected_role:editing.role,p_expected_active:editing.active});
   if(!alive.current||epoch!==generation.current)return;if(managementDenied(r)){clearDenied();return;}
   const code=(r.data as {code?:string}|null)?.code;if(r.error||!code||!Object.hasOwn(managementMessages,code))throw Error();
   setMessage(managementMessages[code]);setEditing(null);callbacks.current();refresh=true;
  }catch{if(alive.current&&epoch===generation.current){setBlocked(true);setEditing(null);setMessage('Üyelik sonucu belirsiz. Yenile ile güncel durumu okuyun; değişiklik tekrarlanmadı.');refresh=true;}}
  finally{if(alive.current&&epoch===generation.current){pending.current=false;setBusy(false);if(refresh)void read();}}
 }
 const owners=data?.members.filter(m=>m.role==='owner'&&m.active).length||0;
 return <section aria-label="Personel yönetimi" className="staff-panel mx-auto grid min-w-0 max-w-4xl gap-4 p-4">
  <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">Personel</h1><p className="text-sm">Her çalışan kendi hesabıyla giriş yapar. Yalnız bu işletmenin üyeleri gösterilir.</p></div><button className="staff-button staff-secondary" disabled={busy} onClick={()=>void read(true)}>Personel listesini yenile</button></header>
  {phase==='checking'&&<p role="status">Yönetim yetkisi kontrol ediliyor…</p>}
  {phase==='denied'&&<p role="alert">403 · Bu işletmede personel yönetimi yetkiniz yok.</p>}
  {phase==='unavailable'&&<p role="alert">Personel listesi doğrulanamadı. Bağlantıyı veya sözleşme kurulumunu kontrol edip yenileyin.</p>}
  {message&&<p role="status" className="break-words rounded-lg bg-amber-50 p-3 text-sm">{message}</p>}
  {blocked&&<p role="alert">Belirsiz işlem yeniden gönderilmez. Devam etmeden önce Personel listesini yenile.</p>}
  {phase==='allowed'&&data&&<>
   <form aria-label="Personel daveti" autoComplete="off" onSubmit={e=>void invite(e)} className="grid gap-3 rounded-lg border border-brand-border p-3">
    <h2 className="font-semibold">Personel davet et</h2><label className="staff-label">E-posta<input className="staff-input" aria-label="Davet e-postası" type="email" autoComplete="off" required maxLength={254} disabled={busy||blocked} value={email} onChange={e=>{setEmail(e.target.value);requestKey.current=null;}}/></label>
    <label className="staff-label">Rol<select className="staff-input" aria-label="Davet rolü" disabled={busy||blocked} value={role} onChange={e=>{setRole(e.target.value as StaffRole);requestKey.current=null;}}>{staffRoles.map(r=><option key={r} value={r}>{roleName[r]}</option>)}</select></label>
    {!data.inviteEnabled&&<p role="status">Davet kurulumu henüz etkin değil.</p>}
    <button className="staff-button" disabled={busy||blocked||!data.inviteEnabled}>Davet gönder</button>
   </form>
   <section aria-label="İşletme üyeleri" className="grid gap-3"><h2 className="font-semibold">İşletme üyeleri</h2>{data.truncated&&<p role="alert">İlk 200 üye gösteriliyor; tam liste için Talip ile görüşün.</p>}
    {!data.members.length&&<p>Bu işletmede üye kaydı yok.</p>}
    {data.members.map(member=><article key={member.staffId} className="min-w-0 rounded-lg border border-brand-border p-3" aria-label={member.email||member.name||'Personel kaydı'}>
     <p className="break-words font-semibold">{member.name||'Ad henüz eklenmedi'}{member.isSelf?' · Siz':''}</p><p className="break-all text-sm">{member.email||'E-posta yok'}</p>
     <p className="text-sm">{roleName[member.role]} · {member.active?'Aktif':'Pasif'}</p>
     {editing?.staffId===member.staffId?<fieldset disabled={busy||blocked} className="mt-3 grid gap-3"><legend>Rol ve aktiflik</legend>
      <label className="staff-label">Yeni rol<select className="staff-input" aria-label="Yeni rol" value={editRole} onChange={e=>setEditRole(e.target.value as StaffRole)}>{staffRoles.map(r=><option key={r} value={r} disabled={member.role==='owner'&&member.active&&owners===1&&r!=='owner'}>{roleName[r]}</option>)}</select></label>
      <label className="flex items-center gap-2 text-sm"><input aria-label="Üyelik aktif" type="checkbox" checked={editActive} disabled={member.role==='owner'&&member.active&&(member.isSelf||owners===1)} onChange={e=>setEditActive(e.target.checked)}/>Üyelik aktif</label>
      {member.role==='owner'&&member.isSelf&&<p className="text-sm">Kendi owner üyeliğiniz pasifleştirilemez.</p>}{member.role==='owner'&&owners===1&&<p className="text-sm">Son aktif owner korunur.</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className="staff-button" onClick={()=>void save()}>Rol ve durumu kaydet</button><button type="button" className="staff-button staff-secondary" onClick={()=>setEditing(null)}>Vazgeç</button></div>
     </fieldset>:<button className="staff-button staff-secondary mt-2" disabled={busy||blocked} onClick={()=>{setEditing(member);setEditRole(member.role);setEditActive(member.active);}}>Düzenle</button>}
    </article>)}
   </section>
   <section aria-label="Son davetler"><h2 className="font-semibold">Son davetler</h2>{!data.invites.length?<p>Henüz davet kaydı yok.</p>:data.invites.map(i=><article key={i.id} className="mt-2 min-w-0 rounded-lg border border-brand-border p-3 text-sm"><p className="break-all">{i.email}</p><p>{roleName[i.role]} · {({prepared:'Hazırlanıyor',sending:'Gönderiliyor',invited:'Auth daveti kabul etti',existing:'Mevcut hesap eklendi',failed:'Başarısız',unknown:'Sonuç belirsiz'} as Record<string,string>)[i.state]}</p><p>{new Date(i.createdAt).toLocaleString('tr-TR',{timeZone:'America/New_York'})} · New York</p><p>{managementMessages[i.safeCode]||'Davet durumu doğrulanamadı.'}</p></article>)}</section>
  </>}
 </section>;
}
