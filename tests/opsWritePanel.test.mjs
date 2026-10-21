// Actual React component, localhost-only fixture and mocked Supabase invocation.
import test from 'node:test';import assert from 'node:assert/strict';
import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const require=createRequire(path.join(root,'package.json'));
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const {chromium}=await import(pathToFileURL(path.resolve(path.dirname(process.execPath),'../node_modules/playwright/index.mjs')).href);
test('dry-run panel previews, confirms once and blocks blind timeout retry',async()=>{
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import Demo from '/src/components/staff/ops/WriteGateDemo.tsx';window.React=React;
 window.fixture={calls:[],timeout:false,hold:false,release:null};createRoot(document.getElementById('root')).render(React.createElement(Demo,{businessId:'11111111-1111-4111-8111-111111111111'}));`;
 const client=`export const staffClient={functions:{invoke:async(name,{body})=>{const f=window.fixture;f.calls.push(body.operation);if(f.hold&&body.operation==='approve')await new Promise(r=>f.release=r);if(f.timeout&&body.operation==='execute')return {error:{}};const statuses={preview:'previewed',approve:'approved',execute:'succeeded',status:'executing'};return {data:{action:{id:'22222222-2222-4222-8222-222222222222',target_id:body.target_id||'33333333-3333-4333-8333-333333333333',preview_hash:'a'.repeat(64),expires_at:'2099-01-01T00:00:00Z',status:statuses[body.operation],safe_result_code:'dry_run_succeeded'}}};}}};`;
 const server=await createServer({configFile:false,root,envDir:false,esbuild:{jsx:'automatic'},plugins:[{name:'write-fixture',enforce:'pre',resolveId(id,importer){if(id==='virtual:write-test')return '\0entry';if(importer?.endsWith('WriteGateDemo.tsx')&&id.includes('lib/crmData'))return '\0client';},load(id){return id==='\0entry'?entry:id==='\0client'?client:null;},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/@id/virtual:write-test"></script>');}else next();});}}],server:{host:'127.0.0.1',port:0,hmr:false}});
 await server.listen();const base='http://127.0.0.1:'+server.httpServer.address().port;
 let browser;
 try{
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-background-networking','--disable-sync']});
  const page=await browser.newPage();await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  await page.goto(base);await page.getByRole('button',{name:'Dry-run önizle',exact:true}).click();
  await page.getByRole('group',{name:'Dry-run önizleme'}).waitFor({timeout:6000}).catch(async e=>{console.log('Fixture state',await page.evaluate(()=>({calls:window.fixture?.calls,text:document.body.innerText})));throw e;});await page.evaluate(()=>window.fixture.hold=true);
  const run=page.getByRole('button',{name:'Çalıştır',exact:true});await run.click();assert.equal(await run.isDisabled(),true);
  await page.waitForFunction(()=>window.fixture.release);await page.evaluate(()=>window.fixture.release());
  await page.getByText('Dry-run tamamlandı. Dış sistem değişmedi.',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.fixture.calls),['preview','approve','execute']);assert.equal(await run.isDisabled(),true);
  await page.reload();await page.getByRole('button',{name:'Dry-run önizle',exact:true}).click();await page.getByRole('group',{name:'Dry-run önizleme'}).waitFor({timeout:6000}).catch(async e=>{console.log('Fixture state',await page.evaluate(()=>({calls:window.fixture?.calls,text:document.body.innerText})));throw e;});
  await page.evaluate(()=>window.fixture.timeout=true);await run.click();await page.getByText(/Sonuç belirsiz veya işlem reddedildi/).waitFor();
  assert.equal(await run.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Dry-run önizle',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Durumu kontrol et',exact:true}).click();await page.getByText(/Durum: executing/).waitFor();
  assert.equal((await page.evaluate(()=>window.fixture.calls)).filter(x=>x==='execute').length,1);
 }finally{if(browser)await browser.close();await server.close();}
});
