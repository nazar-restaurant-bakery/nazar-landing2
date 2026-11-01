import assert from 'node:assert/strict';
import {test,afterEach} from 'node:test';
import {trackCloverOrderHandoffs} from '../src/lib/analytics.ts';
afterEach(()=>{for(const key of ['window','document','Element','HTMLAnchorElement'])delete globalThis[key]});
function fixture(path='/contact'){
 class E {constructor(anchor){this.anchor=anchor}closest(){return this.anchor||this}}
 class A extends E {constructor(href,marker=null){super();this.href=href;this.marker=marker}getAttribute(name){return name==='data-analytics'?this.marker:null}}
 globalThis.Element=E;globalThis.HTMLAnchorElement=A;
 const listeners=[],calls=[];globalThis.document={addEventListener:(type,fn)=>{assert.equal(type,'click');listeners.push(fn)}};
 globalThis.window={location:{pathname:path,search:'?email=private@example.invalid',hash:'#private'},dataLayer:Object.assign([],{push:(o)=>{const {event,...p}=o;calls.push(['event',event,p]);}})};
 const click=(href,marker=null,nested=false)=>{const a=new A(href,marker);for(const fn of listeners)fn({target:nested?new E(a):a})};
 return {calls,listeners,click};
}
test('Nazar telephone activation produces one phone event with only a public page path',()=>{
 const f=fixture();trackCloverOrderHandoffs();f.click('tel:12034082697');
 assert.deepEqual(f.calls,[['event','phone_click',{page_path:'/contact'}]]);
});
test('a nested phone label and formatted business number are recognized',()=>{
 const f=fixture();trackCloverOrderHandoffs();f.click('tel:+1-203-408-2697',null,true);assert.equal(f.calls[0][1],'phone_click');
});
test('marked map links produce directions, while review links and embedded maps do not',()=>{
 const f=fixture('/');trackCloverOrderHandoffs();
 f.click('https://www.google.com/maps/search/?api=1&query=Nazar','directions');
 f.click('https://www.google.com/maps?q=Nazar','directions');
 f.click('https://www.google.com/maps/search/?query=Nazar');
 f.click('https://search.google.com/local/writereview?placeid=example');
 assert.deepEqual(f.calls.map(c=>c[1]),['directions_click','directions_click']);
});
test('a different phone, unrelated destination and lookalike map host are excluded',()=>{
 const f=fixture();trackCloverOrderHandoffs();
 for(const href of ['tel:12035550123','mailto:private@example.invalid','https://google.com.evil.invalid/maps?q=Nazar','https://www.google.com/search?q=Nazar','javascript:void(0)','not a URL'])f.click(href,'directions');
 assert.equal(f.calls.length,0);
});
test('Clover handoffs remain distinct from phone and direction clicks',()=>{
 const f=fixture('/menu');trackCloverOrderHandoffs();f.click('https://nazar-bakery-west-haven.cloveronline.com/');f.click('https://other.cloveronline.com/');
 assert.deepEqual(f.calls,[['event','clover_order_click',{page_path:'/menu'}]]);
});
test('repeated initialization does not duplicate events and separate activations remain separate',()=>{
 const f=fixture();trackCloverOrderHandoffs();trackCloverOrderHandoffs();assert.equal(f.listeners.length,1);
 f.click('tel:12034082697');f.click('tel:12034082697');assert.equal(f.calls.length,2);
});
test('private and unknown page paths produce no public click event',()=>{
 for(const path of ['/staff','/staff/crm','/customer/private@example.invalid','/unknown']){
 const f=fixture(path);trackCloverOrderHandoffs();f.click('tel:12034082697');f.click('https://www.google.com/maps?q=Nazar','directions');f.click('https://nazar-bakery-west-haven.cloveronline.com/');assert.equal(f.calls.length,0);
 }
});
test('unavailable or throwing analytics never breaks link behavior',()=>{
 const f=fixture();trackCloverOrderHandoffs();delete window.dataLayer;assert.doesNotThrow(()=>f.click('tel:12034082697'));
 window.dataLayer=Object.assign([],{push:()=>{throw Error('blocked')}});assert.doesNotThrow(()=>f.click('https://www.google.com/maps?q=Nazar','directions'));
});
test('trailing slashes use the canonical public path',()=>{
 const f=fixture('/contact/');trackCloverOrderHandoffs();f.click('tel:12034082697');assert.deepEqual(f.calls[0][2],{page_path:'/contact'});
});
