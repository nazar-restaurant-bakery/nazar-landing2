import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'package.json'));
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const {chromium}=await import(pathToFileURL(path.resolve(path.dirname(process.execPath),'../node_modules/playwright/index.mjs')).href);
test('mobile checkout calendar, disabled Wednesday/early slots and localized field errors',async()=>{
 const entry=`import '/src/index.css';import React from 'react';import {createRoot} from 'react-dom/client';import Form from '/src/components/CateringCheckoutForm.tsx';import {LanguageProvider} from '/src/components/Language.tsx';window.React=React;createRoot(document.getElementById('root')).render(React.createElement(LanguageProvider,null,React.createElement(Form,{selections:[{id:'synthetic',size:10,title:'Synthetic',price:10}]})));`;
 const server=await createServer({configFile:false,root,envDir:false,esbuild:{jsx:'automatic'},optimizeDeps:{include:['react','react-dom/client']},plugins:[{name:'pickup-fixture',enforce:'pre',resolveId(id,importer){if(id==='virtual:pickup-test')return '\0entry';if(importer?.endsWith('CateringCheckoutForm.tsx')&&id==='./TurnstileWidget')return '\0widget';if(importer?.endsWith('CateringCheckoutForm.tsx')&&id==='../lib/formConfig')return '\0config';},load(id){return id==='\0entry'?entry:id==='\0config'?`export const turnstileSiteKey='synthetic';`:id==='\0widget'?`import React from 'react';export default function Widget({onToken}){return React.createElement('button',{type:'button',onClick:()=>onToken('synthetic')},'Test verification');}`:null;},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:pickup-test"></script></body></html>');}else next();});}}],server:{host:'127.0.0.1',port:0,hmr:false}});
 await server.listen();const base='http://127.0.0.1:'+server.httpServer.address().port;
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-background-networking','--disable-sync']});
 try {
  for(const lang of ['en','tr','ar']) {
   const page=await browser.newPage({viewport:{width:375,height:900},timezoneId:'Asia/Tokyo'});
   page.on('pageerror', error=>console.log('Fixture page error:',error.message));
   let posts=0;
   await page.route('**/*',route=>{if(route.request().method()==='POST')posts++;return new URL(route.request().url()).origin===base?route.continue():route.abort();});
   await page.addInitScript(lang=>localStorage.setItem('nazar_lang',lang),lang);
   await page.clock.install({time:new Date('2026-10-23T14:50:00Z')});
   await page.goto(base);
   const date=page.locator('#catering-pickup-date'),time=page.locator('select');
   await date.waitFor({timeout:8000});assert.equal(await date.inputValue(),'2026-10-26');assert.equal(await date.getAttribute('min'),'2026-10-26');assert.equal(await time.inputValue(),'11:30');
   assert.equal(await time.locator('option[value="11:00"]').getAttribute('disabled'),'');
   assert.equal(await time.locator('option[value="11:30"]').getAttribute('disabled'),null);
   await date.click();assert.equal(await page.getByRole('button',{name:'2026-10-28',exact:true}).isDisabled(),true);
   assert.equal(await page.getByRole('button',{name:'2026-10-25',exact:true}).isDisabled(),true);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= 375),true);
   if(process.env.PICKUP_EVIDENCE_DIR){await mkdir(process.env.PICKUP_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PICKUP_EVIDENCE_DIR,`pickup-${lang}-375.png`),fullPage:true});}
   await page.getByRole('button',{name:'2026-10-27',exact:true}).click();
   assert.equal(await date.inputValue(),'2026-10-27');assert.equal(await time.inputValue(),'11:00');
   assert.equal(await time.locator('option[value="19:00"]').isDisabled(),false);
   assert.equal(await time.locator('option[value="19:30"]').count(),0);
   // Simulate stale/forged input without making any server/payment request.
   await time.evaluate(el=>{const option=new Option('19:30','19:30');el.add(option);el.value='19:30';el.dispatchEvent(new Event('change',{bubbles:true}));});
   const alert=page.getByRole('alert');await alert.waitFor();
   assert.match(await alert.innerText(),lang==='en'?/Choose a pickup/:lang==='tr'?/tam veya bu\u00e7uk/:/\u0627\u062e\u062a\u0631/);
   await page.locator('input[autocomplete="name"]').fill('Synthetic');
   await page.locator('input[type="email"]').fill('synthetic@example.invalid');
   await page.getByRole('button',{name:'Test verification',exact:true}).click();
   await page.locator('button[type="submit"]').click();
   assert.equal(posts,0);
   assert.equal(await page.locator('#catering-pickup-time').evaluate(el=>document.activeElement===el),true);
   // A once-valid slot aging beyond the threshold shows a field warning.
   await page.reload();await date.waitFor({timeout:8000});await page.clock.fastForward(31*60*1000);
   await alert.waitFor();assert.match(await alert.innerText(),/72/);
   assert.equal(posts,0);await page.close();
  }
 } finally {await browser.close();await server.close();}
});
