import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { productionAnalyticsHtml, suppressProductionAnalytics } from '../tools/build/productionAnalytics.ts';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const production = { command: 'build', mode: 'production', env: {} };
function transform(context, source = html) {
  return productionAnalyticsHtml(context).transformIndexHtml.handler(source);
}

test('Production HTML is passed through byte-for-byte with the original static async tag and synchronous initialization', () => {
  for (const env of [{}, {CF_PAGES_BRANCH:'main'}, {APP_ENV:'production',VITE_APP_ENV:'production'}]) {
    assert.equal(transform({...production,env}), html);
  }
  assert.match(html, /<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-LK46HFY46G"><\/script>\s*<script>\s*window\.dataLayer = window\.dataLayer \|\| \[\];/);
  assert.doesNotMatch(html, /document\.createElement\('script'\)|window\.gtag = function/);
});

test('isolated build removes both external GA4 load and initializer before Vite processes HTML', () => {
  const result = transform({...production,env:{VITE_APP_ENV:'isolated-test'}});
  assert.doesNotMatch(result,/googletagmanager|G-LK46HFY46G|dataLayer|function gtag/);
  assert.match(result,/<title>Nazar/);
  assert.match(result,/src="\/src\/main.tsx"/);
});

test('local serve, non-production modes and unconfigured Cloudflare Preview never retain production GA4', () => {
  for (const context of [
    {...production,command:'serve'}, {...production,mode:'test'},
    {...production,env:{CF_PAGES_BRANCH:'feat/isolated-test-env'}},
    {...production,env:{APP_ENV:'isolated-test'}},
    {...production,env:{VITE_TEST_SUPABASE_URL:'https://synthetic.invalid'}},
    {...production,env:{TEST_SUPABASE_SECRET_KEY:'synthetic'}},
  ]) {
    assert.equal(suppressProductionAnalytics(context),true);
    assert.doesNotMatch(transform(context),/googletagmanager|G-LK46HFY46G/);
  }
});

test('an isolated build fails closed when the known GA4 block changes unexpectedly', () => {
  assert.throws(()=>transform({...production,env:{VITE_APP_ENV:'isolated-test'}},html.replace('<script async src=', '<script defer src=')),/refusing an isolated build/);
});
