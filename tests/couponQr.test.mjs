import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGIF,decompressFrames} from 'gifuct-js';
import jsQR from 'jsqr';
import {couponQrHandler} from '../functions/api/coupon-qr/[token].ts';
import {TEST_TURNSTILE_SECRET_KEY} from '../src/lib/deploymentEnvironment.ts';

const token='1234567890abcdef1234567890abcdef';
const payload='VIPCOUPON1:2345-6789-ABCD-EFGH';
const env={APP_ENV:'isolated-test',TEST_SUPABASE_URL:'https://ssssssssssssssssssss.supabase.co',
  TEST_BUSINESS_ID:'11111111-1111-4111-8111-111111111111',TEST_SUPABASE_SECRET_KEY:'sb_secret_SYNTHETIC_TEST_ONLY',
  TEST_TURNSTILE_SECRET_KEY,TEST_TURNSTILE_EXPECTED_HOSTNAME:'synthetic.pages.dev',TEST_COUPON_QR_ENABLED:'true'};
const context=(changes={})=>({request:new Request('https://synthetic.pages.dev/api/coupon-qr/'+token+'.gif'),env,params:{token:token+'.gif'},...changes});

test('first-party GIF independently decodes to only the opaque coupon payload',async()=>{
  const calls=[];const handler=couponQrHandler(async(url,options)=>{calls.push({url,options});return Response.json({payload});});
  const response=await handler(context());assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'image/gif');assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.equal(response.headers.get('access-control-allow-origin'),null);assert.equal(response.headers.get('etag'),null);
  const bytes=await response.arrayBuffer();assert.match(new TextDecoder().decode(bytes.slice(0,6)),/^GIF8[79]a$/);
  const frames=decompressFrames(parseGIF(bytes),true);assert.equal(frames.length,1);
  const frame=frames[0];const decoded=jsQR(frame.patch,frame.dims.width,frame.dims.height);
  assert.equal(decoded?.data,payload);assert.doesNotMatch(decoded.data,/@|customer|https?:/);
  assert.equal(calls.length,1);assert.equal(calls[0].url,env.TEST_SUPABASE_URL+'/rest/v1/rpc/coupon_qr_payload_v1');
  assert.deepEqual(JSON.parse(calls[0].options.body),{p_token:token});assert.equal(calls[0].options.redirect,'manual');
  assert.deepEqual(calls[0].options.headers,{apikey:env.TEST_SUPABASE_SECRET_KEY,'Content-Type':'application/json'});
});
test('image proxy reopens only reread the image payload; never redeem or consume',async()=>{
  const calls=[];const handler=couponQrHandler(async(url)=>{calls.push(url);return Response.json({payload});});
  for(let i=0;i<3;i++)assert.equal((await handler(context())).status,200);
  assert.equal(calls.length,3);assert.ok(calls.every(url=>url.endsWith('/coupon_qr_payload_v1')));
});
test('malformed, wrong extension and payload-in-query requests never reach DB',async()=>{
  let calls=0;const handler=couponQrHandler(async()=>{calls++;throw Error('unexpected');});
  for(const value of ['x.gif',token+'.svg',token.toUpperCase()+'.gif',token+'.gif/other'])assert.equal((await handler(context({params:{token:value}}))).status,404);
  assert.equal((await handler(context({request:new Request('https://synthetic.pages.dev/api/coupon-qr/'+token+'.gif?payload=private')}))).status,404);assert.equal(calls,0);
});
test('default disabled Production and unconfigured Preview have zero calls',async()=>{
  let calls=0;const handler=couponQrHandler(async()=>{calls++;throw Error('unexpected');});
  assert.equal((await handler(context({env:{SUPABASE_SECRET_KEY:'sb_secret_SYNTHETIC_PRODUCTION'},request:new Request('https://production.example/api/coupon-qr/'+token+'.gif')}))).status,503);
  assert.equal((await handler(context({env:{SUPABASE_SECRET_KEY:'sb_secret_SYNTHETIC_PRODUCTION',COUPON_QR_ENABLED:'true'}}))).status,503);assert.equal(calls,0);
});
test('POST cannot turn image rendering into a write',async()=>{
  let calls=0;const handler=couponQrHandler(async()=>{calls++;throw Error('unexpected');});
  const result=await handler(context({request:new Request('https://synthetic.pages.dev/api/coupon-qr/'+token+'.gif',{method:'POST'})}));assert.equal(result.status,405);assert.equal(calls,0);
});
test('unknown token, unexpected payload and PII never return an image or metadata',async()=>{
  for(const body of [{payload:null},{payload:'customer@example.invalid'},{payload:'VIPCOUPON1:0000-0000-0000-0000'},{name:'Private',email:'private@example.invalid'}]){
    const result=await couponQrHandler(async()=>Response.json(body))(context());assert.equal(result.status,404);assert.equal(await result.text(),'');
  }
});
test('redirect, unavailable database and thrown errors fail without following or echoing data',async()=>{
  for(const fetcher of [async()=>new Response(null,{status:302,headers:{Location:'https://foreign.invalid'}}),async()=>new Response('private',{status:500}),async()=>{throw Error('private');}]){
    const result=await couponQrHandler(fetcher)(context());assert.equal(result.status,503);assert.equal(await result.text(),'');
  }
});
