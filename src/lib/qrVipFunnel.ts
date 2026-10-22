export type QrVipFunnel = {
 version:1;business_id:string;month:string;timezone:string;include_tests:boolean;cohort_end_exclusive:string;observed_at:string;
 source:'qr/offline/qr_paket';coupon_scope:'signup_reward:SIMIT';sessions:number|null;sessions_checked_at:string|null;
 registrations:number;confirmed:number;coupons:number;used:number;order_linked:number;staff_attested:number;
 repeat_30d:{known:boolean;numerator:number|null;denominator:number|null;rate:number|null};
};
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const n=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const date=(v:unknown)=>typeof v==='string'&&/T/.test(v)&&Number.isFinite(Date.parse(v));
export function validQrFunnel(v:unknown,business:string,month:string,tests:boolean):v is QrVipFunnel {
 if(!obj(v)||v.version!==1||v.business_id!==business||v.month!==month||v.include_tests!==tests
  ||v.source!=='qr/offline/qr_paket'||v.coupon_scope!=='signup_reward:SIMIT'||!date(v.cohort_end_exclusive)||!date(v.observed_at)
  ||typeof v.timezone!=='string'||!(v.sessions===null||n(v.sessions))||!(v.sessions_checked_at===null||date(v.sessions_checked_at)))return false;
 try{new Intl.DateTimeFormat('en',{timeZone:v.timezone}).format();}catch{return false;}
 if(![v.registrations,v.confirmed,v.coupons,v.used,v.order_linked,v.staff_attested].every(n)
  ||Number(v.confirmed)>Number(v.registrations)||Number(v.used)>Number(v.coupons)||v.used!==Number(v.order_linked)+Number(v.staff_attested)
  ||tests&&v.sessions!==null)return false;
 const r=v.repeat_30d;
 return obj(r)&&typeof r.known==='boolean'&&(r.known?n(r.numerator)&&n(r.denominator)&&r.denominator>0&&r.denominator<=Number(v.order_linked)
  &&r.numerator<=r.denominator&&typeof r.rate==='number'&&Number.isFinite(r.rate)&&Math.abs(r.rate-r.numerator/r.denominator)<1e-6
  :r.numerator===null&&r.denominator===null&&r.rate===null);
}
