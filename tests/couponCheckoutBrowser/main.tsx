import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import Checkout from '../../src/pages/staff/CouponCheckout';import '../../src/index.css';import '../../src/pages/staff/staff.css';
export function Fixture(){const [identity,setIdentity]=useState('a');return <main className="staff-workspace p-3">
 <p>INTERNAL TEST · K10 kasa</p><div className="mb-3 flex gap-3"><button onClick={()=>setIdentity('')}>Synthetic logout</button><button onClick={()=>setIdentity('b')}>Synthetic new session</button></div>
 {identity?<Checkout key={identity} businessId="11111111-1111-4111-8111-111111111111"/>:<p>Signed out</p>}</main>;}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture/></React.StrictMode>);
