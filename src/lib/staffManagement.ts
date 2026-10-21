export const staffRoles=['owner','manager','staff'] as const;
export type StaffRole=typeof staffRoles[number];
export type Member={staffId:string;name:string;email:string|null;role:StaffRole;active:boolean;isSelf:boolean};
export type StaffInvite={id:string;email:string;role:StaffRole;state:string;safeCode:string;createdAt:string};
export type MemberList={businessId:string;actorId:string;inviteEnabled:boolean;truncated:boolean;members:Member[];invites:StaffInvite[]};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const roleName:Record<StaffRole,string>={owner:'Owner',manager:'Manager',staff:'Staff'};
export const managementMessages:Record<string,string>={
 invited:'Davet e-postası Supabase Auth tarafından kabul edildi. Personel kendi bağlantısıyla giriş yapar.',
 existing_account_added:'Mevcut hesap işletmeye eklendi; yeni hesap veya davet e-postası oluşturulmadı.',
 member_exists:'Bu hesap zaten işletme üyesi. Rol ve aktiflik değişikliği için üye kaydını düzenleyin.',
 invite_rejected:'Davet kabul edilmedi. E-posta ve Auth yapılandırmasını kontrol edin.',
 invite_unknown:'Davet sonucu belirsiz. Tekrar e-posta gönderilmez; Talip Auth kaydı ve gönderim sonucunu kontrol etmelidir.',
 access_revoked:'İşlem sırasında yönetim yetkisi kaldırıldı. Yeni üyelik verilmedi; davet sonucunu Talip kontrol etmelidir.',
 in_progress:'Bu adres için bir davet işlemi var. Durumu yenileyin; tekrar gönderilmedi.',
 sending:'Davet işlemi sürüyor. Durumu yenileyin; tekrar gönderilmedi.',
 configuration_required:'Davet kurulumu henüz etkin değil. Talip yönlendirme ve Auth ayarlarını tamamlamalı.',
 expired:'Önceki hazırlığın süresi dolmuş. Durumu yenileyip yeni davet hazırlayın.',
 own_owner:'Kendi owner üyeliğinizi pasifleştiremezsiniz.',last_owner:'İşletmenin son aktif owner üyeliği kaldırılamaz veya rolü düşürülemez.',
 stale_member:'Bu üye başka bir işlemde değişmiş. Listeyi yenileyip tekrar inceleyin.',member_not_found:'Üye bu işletmede bulunamadı.',
 updated:'Personel üyeliği güncellendi.',unchanged:'Üyelikte değişiklik yok.',
};
export function validMemberList(value:unknown,businessId:string):value is MemberList{
 if(!object(value)||value.businessId!==businessId||!uuid(value.actorId)||typeof value.inviteEnabled!=='boolean'||typeof value.truncated!=='boolean'
 ||!Array.isArray(value.members)||value.members.length>200||!Array.isArray(value.invites)||value.invites.length>30)return false;
 return value.members.every(m=>object(m)&&uuid(m.staffId)&&typeof m.name==='string'&&m.name.length<=200&&(m.email===null||typeof m.email==='string'&&m.email.length<=254)
 &&staffRoles.includes(m.role as StaffRole)&&typeof m.active==='boolean'&&typeof m.isSelf==='boolean'&&m.isSelf===(m.staffId===value.actorId))
 &&value.invites.every(i=>object(i)&&uuid(i.id)&&typeof i.email==='string'&&i.email.length<=254&&staffRoles.includes(i.role as StaffRole)
 &&['prepared','sending','invited','existing','failed','unknown'].includes(String(i.state))&&typeof i.safeCode==='string'&&typeof i.createdAt==='string'&&Number.isFinite(Date.parse(i.createdAt)));
}
export function managementDenied(r:{error?:unknown;status?:number}){
 const e=r.error as {code?:string;status?:number;context?:Response}|null;
 return r.status===403||e?.status===403||e?.code==='42501'||e?.code==='403'||e?.context?.status===403;
}
export async function inviteCode(r:{data?:unknown;error?:unknown}):Promise<string|null>{
 let data=r.data;const e=r.error as {context?:Response}|null;
 if(!data&&e?.context instanceof Response){try{data=await e.context.json();}catch{return null;}}
 return object(data)&&typeof data.code==='string'&&Object.hasOwn(managementMessages,data.code)?data.code:null;
}
