import test from 'node:test';
import assert from 'node:assert/strict';
import { validCrmQueue } from '../src/lib/crmQueue.ts';
const id = '11111111-1111-4111-8111-111111111111';
const row = {kind:'request',id,request_id:id,customer_id:id,customer_name:null,title:'Catering follow-up',request_status:'new',assigned_to:null,due_at:null,created_at:'2026-10-16T12:00:00Z',flags:['missing_owner','missing_followup']};
const result = () => ({generated_at:'2026-10-16T12:00:00Z',queue:'open_catering',offset:0,page_size:25,total:1,counts:{open_catering:1,missing_owner:1,missing_followup:1,overdue_catering:0,open_tasks:0,overdue_tasks:0,pending_decisions:0},items:[row]});
test('valid full-database count and nullable missing fields remain visible',()=>assert.equal(validCrmQueue(result(),'open_catering',0),true));
test('missing, wrong-category and inconsistent results cannot appear as an empty queue',()=>{
 for(const mutate of [x=>null,x=>({...x,queue:'open_tasks'}),x=>({...x,offset:25}),x=>({...x,counts:{}}),x=>({...x,total:0}),x=>({...x,items:[]}),x=>({...x,items:[{...row,created_at:'invalid'}]}),x=>({...x,items:[{...row,kind:'task'}]})]) assert.equal(validCrmQueue(mutate(result()),'open_catering',0),false);
});
test('an empty database result differs from inaccessible data',()=>{
 const r=result();r.total=0;r.items=[];r.counts.open_catering=0;
 assert.equal(validCrmQueue(r,'open_catering',0),true);assert.equal(validCrmQueue(null,'open_catering',0),false);
});
test('pagination validates rows against the full total, not a hundred-row ceiling',()=>{
 const r=result();r.total=131;r.counts.open_catering=131;r.offset=125;
 r.items=Array.from({length:6},(_,i)=>({...row,id:`11111111-1111-4111-8111-${String(i).padStart(12,'0')}`}));
 assert.equal(validCrmQueue(r,'open_catering',125),true);
 r.items.push(r.items[0]);assert.equal(validCrmQueue(r,'open_catering',125),false);
});
