import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {productionAnalyticsHtml} from '../tools/build/productionAnalytics.ts';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(path.join(repo,'package.json'));
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);const {default:react}=await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
const {chromium}=await import(pathToFileURL(path.resolve(path.dirname(process.execPath),'../node_modules/playwright/index.mjs')).href);
const executablePath=[chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);assert.ok(executablePath);
const env={VITE_APP_ENV:'isolated-test',VITE_TEST_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',VITE_TEST_BUSINESS_ID:'11111111-1111-4111-8111-111111111111',VITE_TEST_SUPABASE_ANON_KEY:'sb_publishable_synthetic_privacy_only'};
const define=Object.fromEntries(Object.entries(env).map(([k,v])=>['import.meta.env.'+k,JSON.stringify(v)]));
const server=await createServer({configFile:false,root:repo,envDir:path.join(repo,'tests/browser'),define,plugins:[react(),productionAnalyticsHtml({command:'build',mode:'production',env})],server:{host:'127.0.0.1',port:0,hmr:false},css:{postcss:repo}});await server.listen();const origin='http://127.0.0.1:'+server.httpServer.address().port;
const browser=await chromium.launch({executablePath,headless:true});const blocked=[],errors=[],checks=[];const out=path.join(repo,'20_Yonetim/Teslim_Raporlari/K12_Privacy_kanit');await fs.mkdir(out,{recursive:true});
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});await ctx.route('**/*',async r=>{if(r.request().url().startsWith(origin+'/')||r.request().url().startsWith('data:'))await r.continue();else{blocked.push(new URL(r.request().url()).origin);await r.abort();}});
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/privacy',{waitUntil:'networkidle'});
 await page.getByRole('heading',{name:'Privacy Policy',exact:true}).waitFor();assert.match(await page.title(),/^Privacy Policy/);checks.push('Public direct route and SEO title');
 assert.equal(await page.locator('link[rel=canonical]').getAttribute('href'),'https://www.nazarrestaurantandbakery.com/privacy');checks.push('Canonical privacy URL');
 const article=page.getByRole('article');assert.equal(await article.getByRole('heading',{level:2}).count(),8);await article.getByRole('heading',{name:'Disconnect an account or request deletion'}).waitFor();assert.equal(await article.locator('a[href="mailto:ctnazarbakery@gmail.com"]').count(),1);checks.push('Eight sections and working deletion contact link');
 await page.screenshot({path:path.join(out,'privacy-desktop.png'),fullPage:true});await page.setViewportSize({width:375,height:812});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,'privacy-375.png'),fullPage:true});checks.push('375px no horizontal overflow');
 await page.goto(origin+'/vip',{waitUntil:'networkidle'});await page.locator('footer').getByRole('link',{name:'Privacy Policy',exact:true}).click();await page.getByRole('heading',{name:'Privacy Policy',exact:true}).waitFor();checks.push('Footer link reaches privacy from VIP');
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);checks.push('No runtime errors, provider calls, account or analytics traffic');
 await fs.writeFile(path.join(out,'browser.json'),JSON.stringify({passed:checks.length,failed:0,checks,synthetic:true},null,2)+'\n');console.log(JSON.stringify({passed:checks.length,checks}));await ctx.close();
}finally{await browser.close();await server.close();}
