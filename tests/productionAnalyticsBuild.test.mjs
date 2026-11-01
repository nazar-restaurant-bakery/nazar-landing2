import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { productionAnalyticsHtml, suppressProductionAnalytics } from '../tools/build/productionAnalytics.ts';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const production = { command: 'build', mode: 'production', env: {} };
function transform(context, source = html) {
  return productionAnalyticsHtml(context).transformIndexHtml.handler(source);
}

test('Production HTML is passed through byte-for-byte with the consent default before the GTM loader and no gtag.js', () => {
  for (const env of [{}, {CF_PAGES_BRANCH:'main'}, {APP_ENV:'production',VITE_APP_ENV:'production'}]) {
    assert.equal(transform({...production,env}), html);
  }
  assert.match(html, /<script>\s*\/\/ Consent Mode v2 default[\s\S]*?consent\('consent', 'default'[\s\S]*?<\/script>\s*<script>\(function\(w,d,s,l,i\)[^\n]*gtm\.js\?id=[^\n]*'GTM-TJ67R6VZ'\);<\/script>/);
  assert.doesNotMatch(html, /gtag\/js|G-LK46HFY46G'\)|gtag\('config'|function gtag/);
});

test('isolated build removes the consent default, dataLayer and GTM loader before Vite processes HTML', () => {
  const result = transform({...production,env:{VITE_APP_ENV:'isolated-test'}});
  assert.doesNotMatch(result,/googletagmanager|GTM-TJ67R6VZ|dataLayer|nazar-ad-opt-out-v1/);
  assert.match(result,/<title>Nazar/);
  assert.match(result,/src="\/src\/main.tsx"/);
});

test('local serve, non-production modes and unconfigured Cloudflare Preview never retain production GTM', () => {
  for (const context of [
    {...production,command:'serve'}, {...production,mode:'test'},
    {...production,env:{CF_PAGES_BRANCH:'feat/isolated-test-env'}},
    {...production,env:{APP_ENV:'isolated-test'}},
    {...production,env:{VITE_TEST_SUPABASE_URL:'https://synthetic.invalid'}},
    {...production,env:{TEST_SUPABASE_SECRET_KEY:'synthetic'}},
  ]) {
    assert.equal(suppressProductionAnalytics(context),true);
    assert.doesNotMatch(transform(context),/googletagmanager|GTM-TJ67R6VZ/);
  }
});

test('an isolated build fails closed when the known GTM block changes unexpectedly', () => {
  assert.throws(()=>transform({...production,env:{VITE_APP_ENV:'isolated-test'}},html.replace("'GTM-TJ67R6VZ');</script>", "'GTM-OTHER');</script>")),/refusing an isolated build/);
});
