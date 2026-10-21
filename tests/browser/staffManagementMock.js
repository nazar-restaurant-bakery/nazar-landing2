// Only synthetic in-memory data. Native PostgreSQL suite checks actual SQL/races.
export function createStaffManagementMock(get,remember){
 const biz='a358eba4-b197-4309-805b-46f43a718454',actor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 let members=[{staffId:actor,name:'Synthetic Owner',email:'owner@example.invalid',role:'owner',active:true,isSelf:true},{staffId:other,name:'Synthetic Cashier',email:'cashier@example.invalid',role:'staff',active:true,isSelf:false}],invites=[];
 const denied=()=>['members-staff','members-platform-only','members-wrong-business'].includes(get().mode);
 return {rpc(name,p){
  if(name==='staff_business_authorized_v1'&&p?.p_operation==='staff.manage')return {data:!denied(),error:null};
  if(!['staff_members_list_v1','staff_member_update_v1'].includes(name))return undefined;
  if(denied())return {data:null,error:{code:'42501'},status:403};
  if(p.p_business_id!==biz)throw Error('Synthetic wrong business parameters');
  if(name==='staff_members_list_v1')return {data:structuredClone({businessId:get().mode==='members-corrupt-business'?other:biz,actorId:actor,inviteEnabled:get().mode!=='members-disabled',truncated:false,members,invites}),error:null};
  const target=members.find(m=>m.staffId===p.p_target_staff_id);if(!target)throw Error('Unknown synthetic member');
  if(target.isSelf&&!p.p_active)return {data:{code:'own_owner'},error:null};
  target.role=p.p_role;target.active=p.p_active;
  if(get().mode==='members-lost-update')throw Error('Synthetic lost update response');
  return {data:{code:'updated'},error:null};
 },async invoke(p){
  remember('staff-manage-invite',p);if(denied())return {data:null,error:{status:403}};
  if(p.businessId!==biz||p.email!=='new@example.invalid'||!['staff','manager','owner'].includes(p.role)||!p.requestId)throw Error('Unknown synthetic invite');
  await new Promise(r=>setTimeout(r,60));
  const uncertain=get().mode==='members-lost-invite';
  invites.push({id:crypto.randomUUID(),email:p.email,role:p.role,state:uncertain?'unknown':'invited',safeCode:uncertain?'invite_unknown':'invited',createdAt:'2026-10-21T03:00:00Z'});
  if(uncertain)throw Error('Synthetic lost invite response');
  members.push({staffId:crypto.randomUUID(),name:'',email:p.email,role:p.role,active:true,isSelf:false});
  return {data:{code:'invited'},error:null};
 }};
}
