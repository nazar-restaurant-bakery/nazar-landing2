import assert from 'node:assert/strict';
import test from 'node:test';
import {safeCrmRequest,crmDisplayDate,crmNoteAuthor,crmLocalInput,crmTaskError,crmRequestError,validCrmOverview,validCrmTasks,validCrmDecisions} from '../src/lib/crmUi.ts';

test('note attribution identifies the stored staff account without inferring a person',()=>{
 assert.equal(crmNoteAuthor('AABBCCDD-1111-4222-8333-0123456789AB'),'Staff account aabbccdd');
 for(const author of [undefined,null,'','Owner','<script>bad</script>',123,{}]) assert.equal(crmNoteAuthor(author),'Author unavailable');
});
test('missing and malformed dates never throw while valid dates remain usable',()=>{
 assert.equal(crmDisplayDate(null),'—'); assert.equal(crmDisplayDate('broken'),'Invalid date');
 assert.equal(crmLocalInput('broken'),''); assert.match(crmLocalInput('2026-10-20T16:00:00Z'),/^2026-10-20T/);
});
test('task inputs reject whitespace and oversized fields before saving',()=>{
 assert.match(crmTaskError(' ','Staff','2026-10-20T10:00'),/task/);
 assert.match(crmTaskError('Task',' ','2026-10-20T10:00'),/assignee/);
 assert.match(crmTaskError('x'.repeat(301),'Staff','2026-10-20T10:00'),/300/);
 assert.match(crmTaskError('Task','Staff','2026-02-30T10:00'),/valid due/);
});
test('existing rules allow valid past task dates and closed requests without follow-up',()=>{
 assert.equal(crmTaskError('Task','Staff','2020-01-01T10:00'),null);
 assert.equal(crmRequestError('closed','Staff',''),null);
 assert.equal(crmRequestError('new','Staff','2026-10-20T10:00'),null);
});
test('request validation rejects missing owner, missing open follow-up and malformed status/date',()=>{
 assert.match(crmRequestError('new',' ','2026-10-20T10:00'),/assignee/);
 assert.match(crmRequestError('new','Staff',''),/follow-up/);
 assert.match(crmRequestError('invalid','Staff',''),/status/);
 assert.match(crmRequestError('closed','Staff','bad-date'),/valid follow-up/);
});
test('network rejection becomes a recoverable error and denial is preserved',async()=>{
 assert.equal((await safeCrmRequest(()=>Promise.reject(new Error('offline')))).error.code,'NETWORK_ERROR');
 const denied={data:null,error:{code:'42501'}};
 assert.equal(await safeCrmRequest(()=>Promise.resolve(denied)),denied);
});
test('empty CRM records are valid but malformed payloads are not zero customer results',()=>{
 assert.equal(validCrmOverview({customers:[],requests:[]}),true);
 for(const value of [null,{}, {customers:null,requests:[]},{customers:[null],requests:[]},{customers:[],requests:[{}]}]) assert.equal(validCrmOverview(value),false);
});
test('unavailable task/decision payloads cannot masquerade as empty valid lists',()=>{
 assert.equal(validCrmTasks([]),true); assert.equal(validCrmTasks([null]),false);
 assert.equal(validCrmDecisions({items:[]}),true); assert.equal(validCrmDecisions({items:[null]}),false);
});
