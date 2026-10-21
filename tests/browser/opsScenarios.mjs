import assert from 'node:assert/strict';
import { opsCopy as o } from '../../src/lib/opsCopy.ts';
import { opsOffer } from '../fixtures/opsDashboard.mjs';
export async function runOpsScenarios({ run, visible, screenshot, exact, snapshot, calls, setMode, c }) {
  const ready = async page => { await page.getByRole('heading',exact(o.title)).waitFor(); await page.getByTestId('ops-tile-1').getByText('$112,34',{exact:true}).waitFor(); };
  const confirm = page => page.getByTestId('ops-action-confirmation');
  const ops = page => page.evaluate(() => window.__opsMock.snapshot());
  const complete = async page => { await page.getByRole('region',{name:o.actionLog}).getByText(o.done,{exact:true}).first().waitFor({timeout:10000}); };
  await run('37 Ops menu route has nine tiles, scheduler status and seven actions; System stays separate','normal',async page=>{
    await page.waitForURL('**/staff/ops*');await ready(page);
    assert.equal(await page.locator('[data-testid^="ops-tile-"]').count(),9);
    assert.equal(await page.locator('button[data-testid^="ops-action-"]').count(),7);
    await page.getByTestId('ops-connection-google_ads').getByText(/Bağlantı bekliyor/).waitFor();
    await page.getByRole('region',{name:'Günlük zamanlayıcı',exact:true}).getByText('Duraklatıldı · Varsayılan kapalı',{exact:true}).waitFor();
    await page.getByTestId('ops-tile-3').getByText(o.estimate,{exact:true}).waitFor();
    assert.equal(await page.getByTestId('ops-tile-5').getByText('$0',{exact:true}).count(),0);
    await screenshot(page,'staff-ops-desktop');
  },'/staff/ops');
  await run('38 Missing ops migration preserves complete waiting layout without queue writes','ops-pending',async page=>{
    await visible(page,o.missingMigration);
    assert.equal(await page.locator('[data-testid^="ops-tile-"]').count(),9);
    await page.getByTestId('ops-action-collect').click();
    assert.equal(await confirm(page).getByRole('button',exact(o.run)).isDisabled(),true);
    assert.equal((await calls(page,'ops_request_action')).length,0);
    assert.equal((await calls(page,'edge.ops_collect')).length,0);
  },'/staff/ops');
  await run('39 Ops permission denial clears records and hides every metric','ops-denied',async page=>{
    await visible(page,c.accessDenied);
    assert.equal(await page.getByRole('heading',exact(o.title)).count(),0);
    assert.equal(await page.locator('[data-testid^="ops-tile-"]').count(),0);
    assert.equal(await page.getByText('Örnek Müşteri',{exact:true}).count(),0);
  },'/staff/ops');
  await run('40 Ops refresh reads snapshots only; source failure keeps verified values','normal',async page=>{
    await ready(page);await setMode(page,'ops-read-error');
    await page.getByRole('button',exact(o.refresh)).click();await visible(page,o.unavailable);
    await page.getByTestId('ops-tile-1').getByText('$112,34',{exact:true}).waitFor();
    assert.equal((await calls(page,'edge.ops_collect')).length,0);
    assert.equal((await calls(page,'ops_request_action')).length,0);
  },'/staff/ops');
  await run('41 Disconnected action requires confirmation and logs not_connected without provider work','normal',async page=>{
    await ready(page);await page.getByTestId('ops-action-ads_set_status').click();
    assert.equal((await calls(page,'ops_request_action')).length,0);
    await confirm(page).getByRole('button',exact(o.run)).click();
    await page.getByRole('region',{name:o.actionLog}).getByText(o.notConnected,{exact:true}).waitFor();
    const rows=(await ops(page)).actions;
    assert.equal(rows.length,1);assert.equal(rows[0].status,'not_connected');
    assert.equal(rows[0].action,'ads_set_status');
  },'/staff/ops');
  await run('42 Collect confirmation can cancel and a double click cannot enqueue twice','normal',async page=>{
    await ready(page);await page.getByTestId('ops-action-collect').click();
    assert.equal(await page.getByRole('region',{name:o.statusTitle}).getByTestId('ops-action-confirmation').count(),1);
    assert.equal(await page.getByRole('region',{name:o.actions,exact:true}).getByTestId('ops-action-confirmation').count(),0);
    await screenshot(page,'staff-ops-collect-confirmation-desktop');
    await confirm(page).getByRole('button',exact(o.cancel)).click();
    assert.equal((await calls(page,'ops_request_action')).length,0);
    await page.getByTestId('ops-action-collect').click();
    const button=confirm(page).getByRole('button',exact(o.run));await button.dblclick();
    await complete(page);
    assert.equal((await calls(page,'ops_request_action')).length,1);
    const payload=(await calls(page,'ops_request_action'))[0].params.p_payload;
    assert.match(payload.clientRequestId,/^[a-f0-9-]{36}$/);
    assert.equal((await calls(page,'edge.ops_collect')).length,1);
  },'/staff/ops');
  await run('43 Lost running acknowledgement needs manual reconciliation without another enqueue','ops-lost',async page=>{
    await ready(page);await page.getByTestId('ops-action-collect').click();
    await confirm(page).getByRole('button',exact(o.run)).click();await visible(page,o.unknownAction);
    await page.waitForFunction(()=>window.__opsMock.snapshot().actions.some(a=>a.status==='done'));
    assert.equal((await calls(page,'ops_request_action')).length,1);
    await page.getByRole('button',exact(o.refresh)).click();await complete(page);
    assert.equal((await calls(page,'edge.ops_collect')).length,1);
    assert.equal((await calls(page,'ops_request_action')).length,1);
  },'/staff/ops');
  await run('44 Lost queue acknowledgement resumes existing ID only after explicit confirmation','ops-enqueue-lost',async page=>{
    await ready(page);await page.getByTestId('ops-action-collect').click();
    await confirm(page).getByRole('button',exact(o.run)).click();await visible(page,o.unknownAction);
    await page.getByRole('button',exact(o.refresh)).click();
    await page.getByRole('button',exact(o.resumeQueued)).click();
    await setMode(page,'normal');
    const row=(await ops(page)).actions[0];
    await page.getByTestId('ops-resume-'+row.id).getByRole('button',exact(o.run)).dblclick();
    await complete(page);
    assert.equal((await calls(page,'ops_request_action')).length,1);
    const kicks=await calls(page,'edge.ops_collect');assert.equal(kicks.length,2);
    assert.deepEqual(kicks[1].params,{actionId:row.id});
  },'/staff/ops');
  await run('45 Other staff queued work cannot expose a resume control','ops-other-queued',async page=>{
    await ready(page);assert.equal(await page.getByRole('button',exact(o.resumeQueued)).count(),0);
  },'/staff/ops');
  await run('46 CSV upload preserves private rows outside the visible panel and queues exact range','normal',async page=>{
    await ready(page);await page.getByTestId('ops-action-sync_clover_csv').click();
    const form=page.getByRole('form',{name:o.uploadTitle});
    const csv='order_id,paid_at,net_sales,channel,status\nSYNTHETIC-1,2026-10-18T15:00:00Z,100.00,pickup,paid\n';
    await form.getByLabel(o.csvFile,{exact:true}).setInputFiles({name:'synthetic-orders.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
    await form.getByLabel(o.csvStart,{exact:true}).fill('2026-10-01');
    await form.getByLabel(o.csvEnd,{exact:true}).fill('2026-10-18');
    assert.equal(await page.getByText('SYNTHETIC-1',{exact:false}).count(),0);
    await form.getByRole('button',exact(o.csvSubmit)).click();await complete(page);
    const payload=(await calls(page,'ops_request_action'))[0].params.p_payload;
    assert.equal(payload.csv,csv);assert.equal(payload.fileName,'synthetic-orders.csv');
    assert.equal(payload.periodStart,'2026-10-01');assert.equal(payload.periodEnd,'2026-10-18');
    assert.equal((await calls(page,'ops_request_action')).length,1);
  },'/staff/ops');
  await run('47 CSV oversized file never reaches an action request','normal',async page=>{
    await ready(page);await page.getByTestId('ops-action-sync_clover_csv').click();
    const form=page.getByRole('form',{name:o.uploadTitle});
    await form.getByLabel(o.csvFile,{exact:true}).setInputFiles({name:'oversized.csv',mimeType:'text/csv',buffer:Buffer.alloc(1000001,65)});
    await visible(page,o.csvInvalid);assert.equal((await calls(page,'ops_request_action')).length,0);
  },'/staff/ops');
  await run('48 Test offer action uses only a server catalog ID and explicit target state','normal',async page=>{
    await ready(page);
    await page.getByRole('checkbox',{name:new RegExp(c.tests)}).check();await ready(page);
    await page.getByTestId('ops-action-offer_set_active').click();
    await confirm(page).getByLabel(o.selectOffer,{exact:false}).selectOption(opsOffer);
    await confirm(page).getByLabel(o.targetState,{exact:false}).selectOption('true');
    await confirm(page).getByRole('button',exact(o.run)).click();await complete(page);
    const payload=(await calls(page,'ops_request_action'))[0].params.p_payload;
    assert.equal(payload.offerId,opsOffer);assert.equal(payload.active,true);
  },'/staff/ops');
  await run('49 Late ops read after logout cannot restore metrics or job state','normal',async page=>{
    await ready(page);await page.evaluate(()=>window.__staffMock.hold('ops_dashboard_v'));
    await page.getByRole('button',exact(o.refresh)).click();
    await page.waitForFunction(()=>window.__staffMock.snapshot().held.includes('ops_dashboard_v'));
    await page.getByRole('button',exact(c.logout)).click();await visible(page,c.loginTitle);
    await page.evaluate(()=>window.__staffMock.release());await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-testid^="ops-tile-"]').count(),0);
  },'/staff/ops');
  await run('50 Ops panel displays totals and diagnostic aggregates without customer contact text','normal',async page=>{
    await ready(page);
    const panel=page.getByLabel(o.title,{exact:true});const text=await panel.innerText();
    assert.equal(text.includes('Örnek Müşteri'),false);assert.equal(text.includes('11111111@example.invalid'),false);
    assert.equal(text.includes('SYNTHETIC FIXTURE ONLY'),false);
    assert.equal((await snapshot(page)).calls.filter(call=>/setup-test|send|email-draft/.test(call.name)).length,0);
  },'/staff/ops');
  await run('51 Ops mobile 375px has a single metric column and no horizontal overflow','normal',async page=>{
    await ready(page);await page.getByTestId('ops-action-collect').click();
    assert.equal(await page.getByRole('region',{name:o.statusTitle}).getByTestId('ops-action-confirmation').count(),1);
    await screenshot(page,'staff-ops-mobile');
    const sizes=await page.getByTestId('ops-metric-grid').evaluate(element=>({columns:getComputedStyle(element).gridTemplateColumns,scroll:document.documentElement.scrollWidth,width:innerWidth}));
    assert.equal(sizes.columns.trim().split(/\s+/).length,1);assert.ok(sizes.scroll<=sizes.width+1,JSON.stringify(sizes));
  },'/staff/ops',{viewport:{width:375,height:812},isMobile:true,hasTouch:true});
  await run('52 Running action polls only the action log and stops at two minutes without retry','ops-running',async page=>{
    await ready(page);const dashboardReads=(await calls(page,'ops_dashboard_v')).length;
    await page.getByTestId('ops-action-collect').click();
    await confirm(page).getByRole('button',exact(o.run)).click();
    await page.waitForFunction(()=>window.__opsMock.snapshot().actions.some(a=>a.status==='running'));
    await page.waitForTimeout(3200);
    assert.equal((await calls(page,'ops_dashboard_v')).length,dashboardReads);
    assert.ok((await calls(page,'ops_actions_v')).length>=2);
    await page.evaluate(()=>{const now=Date.now();Date.now=()=>now+121000;});
    await visible(page,o.timedOut);
    const reads=(await calls(page,'ops_actions_v')).length;
    await page.waitForTimeout(3200);
    assert.equal((await calls(page,'ops_actions_v')).length,reads);
    assert.equal((await calls(page,'edge.ops_collect')).length,1);
    assert.equal((await calls(page,'ops_request_action')).length,1);
  },'/staff/ops');
  await run('53 Lost CSV acknowledgement retains file and date drafts until explicit reconciliation','ops-lost',async page=>{
    await ready(page);await page.getByTestId('ops-action-sync_clover_csv').click();
    const form=page.getByRole('form',{name:o.uploadTitle});
    await form.getByLabel(o.csvFile,{exact:true}).setInputFiles({name:'synthetic-lost.csv',mimeType:'text/csv',buffer:Buffer.from('order_id,net_sales\nSYNTHETIC-1,100.00\n')});
    await form.getByLabel(o.csvStart,{exact:true}).fill('2026-10-01');
    await form.getByLabel(o.csvEnd,{exact:true}).fill('2026-10-18');
    await form.getByRole('button',exact(o.csvSubmit)).click();await visible(page,o.unknownAction);
    assert.equal(await form.getByLabel(o.csvStart,{exact:true}).inputValue(),'2026-10-01');
    assert.equal(await form.getByLabel(o.csvFile,{exact:true}).evaluate(input=>input.files.length),1);
    assert.equal(await form.getByRole('button',exact(o.csvSubmit)).isDisabled(),true);
    await page.waitForFunction(()=>window.__opsMock.snapshot().actions[0].status==='done');
    await page.getByRole('button',exact(o.refresh)).click();await complete(page);
    assert.equal((await calls(page,'ops_request_action')).length,1);
  },'/staff/ops');
}
