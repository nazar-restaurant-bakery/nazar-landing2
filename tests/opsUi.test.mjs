import test from 'node:test';
import assert from 'node:assert/strict';
import { validOpsDashboard, validOpsConnections, validOpsAction, validOpsActions, opsReportPath, selectOpsMetric, opsCanResume } from '../src/lib/opsUi.ts';
import { freshOps, opsBusiness, opsActor, opsRequestKey } from './fixtures/opsDashboard.mjs';
const now = new Date('2026-10-19T14:00:00Z');
const action = () => ({ id:'eeeeeeee-eeee-4eee-8eee-000000000001', request_key:opsRequestKey, action:'commission_report',
  requested_by:opsActor, requested_at:now.toISOString(),status:'done',result:{},finished_at:now.toISOString() });

test('Aggregate contract rejects malformed metric/target structures rather than displaying zero', () => {
  const { dashboard,connections } = freshOps(now);
  assert.equal(validOpsDashboard(dashboard),true); assert.equal(validOpsConnections({items:connections}),true);
  assert.equal(validOpsDashboard({...dashboard,metrics:null}),false);
  assert.equal(validOpsDashboard({...dashboard,metrics:[{...dashboard.metrics[0],value_num:'0'}]}),false);
  assert.equal(validOpsDashboard({...dashboard,offers:[{id:'invented',name:'X',approved:true}]}),false);
});
test('Absent numeric values and a sourced zero remain distinct', () => {
  const { dashboard } = freshOps(now);
  const zero = selectOpsMetric(dashboard.metrics,'supabase','pending_signups',now);
  assert.equal(zero.value_num,0);
  assert.equal(selectOpsMetric(dashboard.metrics,'ga4','visits_7d',now),undefined);
  assert.equal(validOpsDashboard({...dashboard,metrics:[{...zero,value_num:null}]}),true);
});
test('A late import from an old month cannot replace the current month tile', () => {
  const { dashboard } = freshOps(now);
  const old = {...dashboard.metrics.find(m => m.metric==='net_sales_mtd'),period_start:'2026-09-01',period_end:'2026-09-30',collected_at:'2026-10-19T15:00:00Z',value_num:999999};
  assert.equal(selectOpsMetric([...dashboard.metrics,old],'clover','net_sales_mtd',now).value_num,1234.56);
  assert.equal(selectOpsMetric([old],'clover','net_sales_mtd',now),undefined);
});
test('Period matching uses the New York day at a UTC boundary', () => {
  const metric = {...freshOps(now).dashboard.metrics[0],period_start:'2026-09-29',period_end:'2026-09-29',collected_at:'2026-10-01T00:00:00Z'};
  assert.equal(selectOpsMetric([metric],'clover','net_sales_yesterday',new Date('2026-10-01T03:59:00Z')),metric);
  assert.equal(selectOpsMetric([metric],'clover','net_sales_yesterday',new Date('2026-10-01T04:00:00Z')),undefined);
});
test('Test and future-month snapshots never appear in operations totals', () => {
  const metric = freshOps(now).dashboard.metrics.find(m => m.metric==='net_sales_mtd');
  assert.equal(selectOpsMetric([{...metric,is_test:true}],'clover','net_sales_mtd',now),undefined);
  assert.equal(selectOpsMetric([{...metric,period_end:'2026-10-31'}],'clover','net_sales_mtd',now),undefined);
});
test('Seven-day fields reject a different or partial reporting period', () => {
  const metric = freshOps(now).dashboard.metrics.find(m => m.metric==='form_submissions_7d');
  assert.equal(selectOpsMetric([metric],'supabase','form_submissions_7d',now),metric);
  assert.equal(selectOpsMetric([{...metric,period_start:'2026-10-01'}],'supabase','form_submissions_7d',now),undefined);
});
test('Duplicate connection sources and actions without request identities are invalid', () => {
  const {connections}=freshOps(now);
  assert.equal(validOpsConnections({items:[connections[0],connections[0]]}),false);
  assert.equal(validOpsActions({items:[action()]}),true);
  assert.equal(validOpsActions({items:[{...action(),request_key:null}]}),false);
});
test('PDF download accepts only a completed matching business/month/action storage path', () => {
  const report=action();report.result.downloadPath=opsBusiness+'/ops/commission/2026-09-'+report.id+'.pdf';
  assert.equal(opsReportPath(report,opsBusiness),report.result.downloadPath);
  for (const path of ['https://outside.invalid/report.pdf','../secret.pdf',opsBusiness+'/ops/commission/2026-13-'+report.id+'.pdf',opsBusiness+'/ops/commission/2026-09-other.pdf']) {
    assert.equal(opsReportPath({...report,result:{downloadPath:path}},opsBusiness),null);
  }
  assert.equal(opsReportPath({...report,status:'running'},opsBusiness),null);
});
test('Legacy manual actions remain valid while explicit scheduler actors require collect and no staff identity', () => {
  const manual = {...action(),action:'collect',status:'queued'};
  assert.equal(validOpsAction(manual),true);
  assert.equal(validOpsAction({...manual,actor_kind:'staff'}),true);
  const scheduled = {...manual,actor_kind:'scheduler',requested_by:null};
  assert.equal(validOpsAction(scheduled),true);
  assert.equal(validOpsActions({items:[manual,scheduled]}),true);
  for(const malformed of [
    {...scheduled,requested_by:opsActor},
    {...scheduled,action:'offer_set_active'},
    {...scheduled,action:'retry_failed_job'},
    {...manual,actor_kind:'cron'},
    {...manual,actor_kind:null},
    {...manual,actor_kind:undefined},
    {...manual,actor_kind:'staff',requested_by:null},
  ]) {
    assert.equal(validOpsAction(malformed),false);
    assert.equal(validOpsActions({items:[malformed]}),false);
  }
});
test('Scheduler actions never acquire staff resume rights, including malformed identity fallbacks', () => {
  const queued = {...action(),action:'collect',status:'queued'};
  assert.equal(opsCanResume(queued,opsActor),true);
  assert.equal(opsCanResume({...queued,actor_kind:'staff'},opsActor),true);
  for(const actor of [null,opsActor]) {
    const scheduled = {...queued,actor_kind:'scheduler',requested_by:actor};
    for(const identity of ['',opsActor,'scheduler']) assert.equal(opsCanResume(scheduled,identity),false);
  }
  assert.equal(opsCanResume({...queued,requested_by:null},opsActor),false);
  assert.equal(opsCanResume(queued,'ffffffff-ffff-4fff-8fff-ffffffffffff'),false);
  assert.equal(opsCanResume({...queued,status:'running'},opsActor),false);
  assert.equal(opsCanResume({...queued,status:'done'},opsActor),false);
});
