import {useEffect,useState} from 'react';
import {NavLink} from 'react-router-dom';
import {staffClient} from '../../lib/crmData';
export default function StaffManagementLink({businessId}:{businessId:string}){
 const [allowed,setAllowed]=useState(false);
 useEffect(()=>{let active=true;
  if(staffClient&&businessId)void Promise.resolve(staffClient.rpc('staff_business_authorized_v1',{p_business_id:businessId,p_operation:'staff.manage'}))
   .then(r=>{if(active)setAllowed(!r.error&&r.data===true);},()=>{if(active)setAllowed(false);});
  return()=>{active=false;};
 },[businessId]);
 return allowed?<NavLink to="/staff/team" className={({isActive})=>`rounded-lg px-3 py-2 text-sm font-medium ${isActive?'bg-brand-primarySoft text-brand-dark':'text-stone-600 hover:bg-brand-bg'}`}>Personel</NavLink>:null;
}
