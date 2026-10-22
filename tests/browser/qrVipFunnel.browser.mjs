// Local-only synthetic staff screen. SDK alias and request blocking prevent
// database, account, analytics, message or provider access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loyaltyCopy as c, opsCopy as o } from '../../src/lib/staffCopy.ts';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../..');
const require=createRequire(path.join(repo,'package.json'));
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const {default:react}=await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
const bundled=path.resolve(path.dirname(process.execPath),'..','node_modules/playwright/index.mjs');
let playwright;try{playwright=await import('playwright');}catch{playwright=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||bundled).href);}
const {chromium}=playwright;
const executablePath=[process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(existsSync);
assert.ok(executablePath,'Requires existing Chromium; no download is attempted.');
const outputFlag=process.argv.indexOf('--output'),output=outputFlag<0?path.join(here,'artifacts/qr-funnel'):path.resolve(process.argv[outputFlag+1]);
await fs.mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:here,envDir:here,appType:'spa',plugins:[react(),{name:'synthetic-host',transform(source,id){if(id.endsWith('/src/lib/supabase.ts'))return source.replace('window.location.hostname',JSON.stringify('synthetic-production.invalid'));}}],
  define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://khgczybubufouraqyrcj.supabase.co'),'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('sb_publishable_OFFLINE_SYNTHETIC_ONLY'),'import.meta.env.VITE_NAZAR_BUSINESS_ID':JSON.stringify('a358eba4-b197-4309-805b-46f43a718454')},
  resolve:{alias:{'@supabase/supabase-js':path.join(here,'mockSdk.js')}},server:{host:'127.0.0.1',port:0,hmr:false,fs:{allow:[repo]}},css:{postcss:repo}});
await server.listen();const base='http://127.0.0.1:'+server.httpServer.address().port;
const browser=await chromium.launch({executablePath,headless:true,args:['--disable-background-networking','--disable-component-update','--disable-sync']});
const checks=[],external=[],errors=[];
async function harness(mode='normal'){
  const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Europe/Istanbul',serviceWorkers:'block'});
  await context.route('**/*',async route=>{const url=route.request().url();if(url.startsWith(base+'/')&&!new URL(url).pathname.startsWith('/api/')||url.startsWith('data:'))await route.continue();else{external.push(url);await route.abort('blockedbyclient');}});
  const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/staff/ops?mode='+mode,{waitUntil:'networkidle'});
  return {page,context};
}
const refresh=page=>page.getByRole('button',{name:o.refresh,exact:true}).click();
async function payload(page,includeTests=false){
  const params=await page.evaluate(()=>window.__staffMock.snapshot().calls.filter(c=>c.name==='loyalty_metrics_v1').at(-1).params);
  return {version:1,business_id:params.p_business_id,month:params.p_month,timezone:'America/New_York',include_tests:includeTests,generated_at:new Date().toISOString(),coverage:'observed_ingested_orders',
    customer_counts:{known:true,new:1,repeat:1,reason:null},campaigns:{known:true,items:[{campaign_id:'22222222-2222-4222-8222-222222222222',name:'SYNTHETIC K11 CAMPAIGN',applied:3,order_linked:2,staff_attested:1,repeat_30d:{known:true,numerator:1,denominator:2,rate:.5,reason:null}}],reason:null},
    messages:{known:true,sent:0,reason:null},attribution:{known:false,orders:null,reason:'explicit_attribution_missing'}};
}
const set=(page,data,error=null)=>page.evaluate(({data,error})=>window.__staffMock.setLoyaltyResponse(data,error),{data,error});
try{
 const {page,context}=await harness();const box=page.getByTestId('qr-vip-funnel');
 await box.getByText('Huni kaynağı bekleniyor veya doğrulanamadı.',{exact:true}).waitFor();checks.push('Missing RPC is unknown, not zero.');
 const params=await page.evaluate(()=>window.__staffMock.snapshot().calls.filter(c=>c.name==='qr_vip_funnel_v1').at(-1).params);
 const data={version:1,business_id:params.p_business_id,month:params.p_month,timezone:'America/New_York',include_tests:false,cohort_end_exclusive:new Date().toISOString(),observed_at:new Date().toISOString(),source:'qr/offline/qr_paket',coupon_scope:'signup_reward:SIMIT',sessions:7,sessions_checked_at:new Date().toISOString(),registrations:3,confirmed:2,coupons:2,used:2,order_linked:1,staff_attested:1,repeat_30d:{known:false,numerator:null,denominator:null,rate:null}};
 const put=async(d,error=null)=>{await page.evaluate(({d,error})=>window.__staffMock.setQrFunnelResponse(d,error),{d,error});await box.getByRole('button',{name:'Huniyi yenile',exact:true}).click();};
 await put(data);await box.getByText('Siparişe bağlı: 1',{exact:true}).waitFor();await box.getByText('Personel beyanı: 1',{exact:true}).waitFor();checks.push('QR sessions, VIP, actual confirmation and coupon split shown; immature repeat unknown.');
 await page.screenshot({path:path.join(output,'qr-funnel-desktop.png'),fullPage:true});await page.setViewportSize({width:375,height:812});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'qr-funnel-375.png'),fullPage:true});checks.push('375px no horizontal overflow.');
 await put({...data,business_id:'33333333-3333-4333-8333-333333333333'});await box.getByText('Huni kaynağı bekleniyor veya doğrulanamadı.',{exact:true}).waitFor();assert.equal(await box.getByText('Siparişe bağlı: 1',{exact:true}).count(),0);checks.push('Foreign tenant clears prior counts.');
 await put(null,{code:'42501'});await box.getByText('403 · Huni okuma yetkisi yok.',{exact:true}).waitFor();checks.push('403 reveals no counts.');
 assert.deepEqual((await page.evaluate(()=>window.__staffMock.snapshot())).unexpected,[]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);checks.push('Loopback only, no provider/GA4/account access or runtime errors.');await context.close();
 await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:checks.length,failed:0,syntheticOnly:true,checks},null,2)+'\n');console.log(JSON.stringify({passed:checks.length,checks}));
}finally{await browser.close();await server.close();}
