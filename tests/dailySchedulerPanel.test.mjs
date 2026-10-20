// Actual read-only React card, localhost fixture, no external network.
import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(path.join(root,'package.json'));
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const {chromium}=await import(pathToFileURL(path.resolve(path.dirname(process.execPath),'../node_modules/playwright/index.mjs')).href);
test('scheduler panel reads only, shows pause/error and does not retain another tenant status',async()=>{
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import Card from '/src/components/staff/ops/DailySchedulerStatus.tsx';window.React=React;
 window.fixture={calls:[],failed:false,business:'11111111-1111-4111-8111-111111111111'};const root=createRoot(document.getElementById('root'));window.show=()=>root.render(React.createElement(Card,{key:window.fixture.business,businessId:window.fixture.business}));window.show();`;
 const client=`export const staffClient={rpc:async(name,args)=>{const f=window.fixture;f.calls.push({name,args});if(f.business.startsWith('2222'))return {error:{code:'42501'}};return {data:{enabled:false,requests_today:f.failed?30:0,last_run:f.failed?{local_date:'2026-11-02',target_date:'2026-11-01',status:'failed',clover_status:'failed',ops_status:'pending',safe_code:'budget_exhausted'}:null}};}};`;
 const server=await createServer({configFile:false,root,envDir:false,esbuild:{jsx:'automatic'},plugins:[{name:'scheduler-ui-fixture',enforce:'pre',resolveId(id,importer){if(id==='virtual:scheduler-test')return '\0entry';if(importer?.endsWith('DailySchedulerStatus.tsx')&&id.includes('lib/crmData'))return '\0client';},load(id){return id==='\0entry'?entry:id==='\0client'?client:null;},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/@id/virtual:scheduler-test"></script>');}else next();});}}],server:{host:'127.0.0.1',port:0,hmr:false}});
 await server.listen();const base='http://127.0.0.1:'+server.httpServer.address().port;let browser;
 try{
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-background-networking','--disable-sync']});const page=await browser.newPage();
  await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());await page.goto(base);
  await page.getByText('Bugünkü dış istek: 0 / 30',{exact:true}).waitFor();
  await page.evaluate(()=>window.fixture.failed=true);await page.getByRole('button',{name:'Zamanlayıcı durumunu yenile',exact:true}).click();
  await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/budget_exhausted/);
  const calls=await page.evaluate(()=>window.fixture.calls);assert.ok(calls.every(c=>c.name==='daily_scheduler_status'));assert.equal(calls.length,2);
  await page.evaluate(()=>{window.fixture.business='22222222-2222-4222-8222-222222222222';window.show();});
  await page.getByText('Kurulum veya yetki kontrolü bekliyor',{exact:true}).waitFor();assert.equal(await page.getByText('budget_exhausted',{exact:true}).count(),0);
 }finally{if(browser)await browser.close();await server.close();}
});
