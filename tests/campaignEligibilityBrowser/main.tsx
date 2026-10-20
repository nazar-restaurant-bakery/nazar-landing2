// Synthetic component fixture only; no public application, analytics, Auth, or DB.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import CloverOrdersPanel from '../../src/components/CloverOrdersPanel';
import '../../src/index.css';
export function Fixture() {
  const [token, setToken] = useState<string | null>('synthetic-session-a');
  return <main className="mx-auto max-w-5xl p-3"><h1 className="mb-3 font-semibold">INTERNAL TEST · K10 sipariş hak kontrolü</h1>
    <div className="mb-3 flex gap-3"><button onClick={() => setToken(null)}>Synthetic logout</button><button onClick={() => setToken('synthetic-session-b')}>Synthetic new session</button></div>
    {token ? <CloverOrdersPanel accessToken={token}/> : <p>Synthetic signed out</p>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture/></React.StrictMode>);
