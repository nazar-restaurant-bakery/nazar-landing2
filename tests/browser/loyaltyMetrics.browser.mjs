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
const outputFlag=process.argv.indexOf('--output'),output=outputFlag<0?path.join(here,'artifacts/loyalty'):path.resolve(process.argv[outputFlag+1]);
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
  const {page,context}=await harness();
  const box=key=>page.getByTestId('loyalty-box-'+key);
  await box('customers').getByText(c.missing,{exact:true}).waitFor();
  assert.equal(await page.locator('[data-testid^="loyalty-box-"]').count(),4);
  await page.getByTestId('ops-tile-1').getByText('$112,34',{exact:true}).waitFor();
  assert.equal(await box('messages').getByText('0',{exact:true}).count(),0);
  checks.push('Missing RPC leaves four unknown boxes with reasons and all existing Ops values intact.');
  const data=await payload(page);await set(page,data);await refresh(page);
  await box('campaigns').getByText('SYNTHETIC K11 CAMPAIGN',{exact:true}).waitFor();
  await box('campaigns').getByText(c.applied+': 3',{exact:true}).waitFor();
  await box('campaigns').getByText(c.orderLinked+': 2',{exact:true}).waitFor();
  await box('campaigns').getByText(c.staffAttested+': 1',{exact:true}).waitFor();
  await box('campaigns').getByText(c.cohort,{exact:true}).waitFor();
  checks.push('Total 3 = linked 2 + attested 1; order-only repeat note visible.');
  await box('messages').getByText('0',{exact:true}).waitFor();await box('attribution').getByText(c.noAttribution,{exact:true}).waitFor();
  assert.equal(await box('attribution').getByText('0',{exact:true}).count(),0);
  await page.screenshot({path:path.join(output,'k11-metrics-desktop-synthetic.png'),fullPage:true});
  checks.push('Sourced new/repeat overlap, campaign cohort, sent zero and unproved attribution are distinct.');
  const legacy=structuredClone(data);delete legacy.campaigns.items[0].order_linked;delete legacy.campaigns.items[0].staff_attested;
  await set(page,legacy);await refresh(page);await box('campaigns').getByText(c.splitMissing,{exact:true}).waitFor();
  await box('campaigns').getByText(c.orderLinked+': —',{exact:true}).waitFor();
  await box('campaigns').getByText(c.staffAttested+': —',{exact:true}).waitFor();
  checks.push('Old backend keeps known total and explicitly unknown split, never fabricated zero.');
  await set(page,data);await refresh(page);await box('campaigns').getByText(c.orderLinked+': 2',{exact:true}).waitFor();
  await page.setViewportSize({width:375,height:812});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert.equal(await page.locator('[data-testid^="loyalty-box-"]').count(),4);
  await page.screenshot({path:path.join(output,'k11-metrics-mobile-synthetic.png'),fullPage:true});
  checks.push('375px mobile retains all four boxes without horizontal overflow.');
  await set(page,{...data,business_id:'33333333-3333-4333-8333-333333333333'});await refresh(page);
  await box('customers').getByText(c.error,{exact:true}).waitFor();assert.equal(await box('campaigns').getByText('SYNTHETIC K11 CAMPAIGN',{exact:true}).count(),0);
  checks.push('A foreign business response clears stale metrics and cannot appear.');
  await set(page,data);await refresh(page);await box('campaigns').getByText('SYNTHETIC K11 CAMPAIGN',{exact:true}).waitFor();
  await set(page,{...data,include_tests:true,customer_counts:{known:true,new:77,repeat:77,reason:null}});
  await page.getByRole('checkbox',{name:'Internal tests',exact:true}).check();
  await box('customers').getByText('77',{exact:true}).first().waitFor();
  const last=await page.evaluate(()=>window.__staffMock.snapshot().calls.filter(c=>c.name==='loyalty_metrics_v1').at(-1).params);
  assert.equal(last.p_include_tests,true);
  await set(page,data);await page.getByRole('checkbox',{name:'Internal tests',exact:true}).uncheck();
  await box('customers').getByText('1',{exact:true}).first().waitFor();assert.equal(await box('customers').getByText('77',{exact:true}).count(),0);
  checks.push('Global Internal tests changes server filter; previous test aggregate is never reused.');
  await set(page,null,{code:'42501'});await refresh(page);
  await page.getByText('Erişim yok',{exact:true}).first().waitFor();assert.equal(await page.locator('[data-testid^="loyalty-box-"]').count(),0);assert.equal(await page.locator('[data-testid^="ops-tile-"]').count(),0);
  checks.push('A loyalty permission denial removes all private Ops data.');
  assert.deepEqual((await page.evaluate(()=>window.__staffMock.snapshot())).unexpected,[]);await context.close();
  const late=await harness();await late.page.getByTestId('loyalty-box-customers').getByText(c.missing,{exact:true}).waitFor();
  await set(late.page,await payload(late.page));await late.page.evaluate(()=>window.__staffMock.hold('loyalty_metrics_v1'));await refresh(late.page);
  await late.page.getByRole('button',{name:'Çıkış',exact:true}).click();await late.page.evaluate(()=>window.__staffMock.release());
  await late.page.getByRole('heading',{name:'Personel girişi',exact:true}).waitFor();
  assert.equal(await late.page.locator('[data-testid^="loyalty-box-"]').count(),0);
  checks.push('Logout plus a late metric response cannot restore private data.');
  assert.deepEqual((await late.page.evaluate(()=>window.__staffMock.snapshot())).unexpected,[]);await late.context.close();
  const boundary=await harness();await boundary.page.getByTestId('loyalty-box-customers').getByText(c.missing,{exact:true}).waitFor();
  await boundary.page.clock.setSystemTime(new Date('2026-11-01T01:00:00Z'));
  const boundaryData={...await payload(boundary.page),month:'2026-10-01',timezone:'Asia/Tokyo'};
  await set(boundary.page,boundaryData);await refresh(boundary.page);
  // First October response discovers Tokyo already entered November. The
  // second response deliberately echoes old October and must show an error,
  // retaining the discovered timezone even though accepted data is null.
  await boundary.page.getByTestId('loyalty-box-customers').getByText(c.error,{exact:true}).waitFor();
  const boundaryParams=await boundary.page.evaluate(()=>window.__staffMock.snapshot().calls.filter(c=>c.name==='loyalty_metrics_v1').slice(-2).map(c=>c.params.p_month));
  assert.deepEqual(boundaryParams,['2026-10-01','2026-11-01']);
  assert.equal(await boundary.page.getByTestId('loyalty-box-customers').getByRole('status').count(),0);
  checks.push('Tenant month discovery followed by a failed re-read shows error, never an endless loading state.');
  assert.deepEqual((await boundary.page.evaluate(()=>window.__staffMock.snapshot())).unexpected,[]);await boundary.context.close();
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  checks.push('Every request stayed on loopback; no account/provider/analytics writes or runtime errors.');
  console.log(JSON.stringify({passed:checks.length,failed:0,syntheticOnly:true,checks},null,2));
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:checks.length,failed:0,syntheticOnly:true,checks},null,2)+'\n');
}finally{await browser.close();await server.close();}
