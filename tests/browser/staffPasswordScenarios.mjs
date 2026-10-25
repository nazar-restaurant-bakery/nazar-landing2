import assert from 'node:assert/strict';
export async function runStaffPasswordScenarios({run,visible,exact,calls,snapshot,screenshot,c}) {
 const open=async p=>{await p.getByRole('heading',exact(c.passwordPage)).waitFor();await p.locator('summary').filter({hasText:c.passwordTitle}).click();};
 const fill=async(p,first='synthetic-long-password',second=first)=>{await p.getByLabel(c.password,{exact:true}).fill(first);await p.getByLabel(c.passwordConfirm,{exact:true}).fill(second);};
 await run('Password 01 restaurant staff own-account route and least-privilege menu','password-staff',async p=>{
  await open(p);await visible(p,c.passwordScope);assert.equal(await p.getByRole('link',exact(c.passwordPage)).count(),1);
  for(const label of [c.system,'Personel','Profil senkronu'])assert.equal(await p.getByRole('link',exact(label)).count(),0);
  assert.equal((await calls(p,'staff_business_authorized_v1')).filter(x=>x.params.p_operation==='staff.manage').length,0);
  await fill(p);await p.getByRole('button',exact(c.save)).click();await visible(p,c.passwordSaved);
  const updates=await calls(p,'auth.updateUser');assert.equal(updates.length,1);assert.deepEqual(updates[0].params,{keys:['password'],passwordOnly:true});
  assert.equal(await p.getByLabel(c.password,{exact:true}).inputValue(),'');assert.equal(await p.getByLabel(c.passwordConfirm,{exact:true}).inputValue(),'');
  assert.doesNotMatch(JSON.stringify(await snapshot(p)),/synthetic-long-password/);
 },'/staff/password');
 await run('Password 02 mobile 375px own-password route','password-staff',async p=>{
  await open(p);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=375),true);await screenshot(p,'staff-own-password-375');
 },'/staff/password',{viewport:{width:375,height:900}});
 for(const route of ['system','team','profile-sync'])await run('Password 03 restaurant direct platform route stays blocked '+route,'password-staff',async p=>{
  await p.waitForURL('**/staff/tasks*');assert.equal(await p.getByRole('link',exact(c.system)).count(),0);assert.equal((await calls(p,'auth.updateUser')).length,0);
 },'/staff/'+route);
 for(const mode of ['signed-out','auth-denied'])await run('Password 04 no password form without active authorized session '+mode,mode,async p=>{
  await visible(p,mode==='signed-out'?c.loginTitle:c.accessDenied);assert.equal(await p.getByRole('heading',exact(c.passwordPage)).count(),0);assert.equal((await calls(p,'auth.updateUser')).length,0);
 },'/staff/password');
 await run('Password 05 twelve-character guard and confirmation preserved','password-staff',async p=>{
  await open(p);await fill(p,'short','short');await p.locator('form').evaluate(f=>f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await visible(p,c.passwordLength);assert.equal((await calls(p,'auth.updateUser')).length,0);
  await fill(p,'synthetic-long-password','synthetic-other-password');await p.getByRole('button',exact(c.save)).click();await visible(p,c.passwordMismatch);assert.equal((await calls(p,'auth.updateUser')).length,0);
 },'/staff/password');
 for(const mode of ['password-401','password-throw'])await run('Password 06 Auth rejection safe message, fields cleared, no retry '+mode,mode,async p=>{
  await open(p);await fill(p);await p.getByRole('button',exact(c.save)).click();await visible(p,c.passwordUnknown);assert.equal((await calls(p,'auth.updateUser')).length,1);assert.equal(await p.getByText('SYNTHETIC_PRIVATE_AUTH_DETAIL',{exact:true}).count(),0);assert.equal(await p.getByLabel(c.password,{exact:true}).inputValue(),'');
 },'/staff/password');
 await run('Password 07 busy double-submit sends one own-account update','password-staff',async p=>{
  await open(p);await fill(p);await p.evaluate(()=>window.__staffMock.hold('auth.updateUser'));await p.getByRole('button',exact(c.save)).click();await p.getByRole('button',exact(c.saving)).waitFor();assert.equal(await p.getByRole('button',exact(c.saving)).isDisabled(),true);assert.equal((await calls(p,'auth.updateUser')).length,1);await p.evaluate(()=>window.__staffMock.release());await visible(p,c.passwordSaved);
 },'/staff/password');
 await run('Password 08 sign-out removes own password form','password-staff',async p=>{
  await open(p);await p.getByRole('button',exact(c.logout)).click();await visible(p,c.loginTitle);assert.equal(await p.locator('summary').filter({hasText:c.passwordTitle}).count(),0);assert.equal((await calls(p,'auth.updateUser')).length,0);
 },'/staff/password');
 await run('Password 09 account switch clears draft and late prior-account reply','password-staff',async p=>{
  await open(p);await fill(p);await p.evaluate(()=>window.__staffMock.hold('auth.updateUser'));await p.getByRole('button',exact(c.save)).click();await p.getByRole('button',exact(c.saving)).waitFor();
  await p.evaluate(()=>window.__staffMock.switchIdentity());await visible(p,'other-staff@example.invalid');await p.getByRole('heading',exact(c.passwordPage)).waitFor();await p.locator('summary').filter({hasText:c.passwordTitle}).click();
  assert.equal(await p.getByLabel(c.password,{exact:true}).inputValue(),'');assert.equal(await p.getByLabel(c.passwordConfirm,{exact:true}).inputValue(),'');
  await p.evaluate(()=>window.__staffMock.release());await p.waitForTimeout(100);assert.equal(await p.getByText(c.passwordSaved,{exact:true}).count(),0);assert.equal((await calls(p,'auth.updateUser')).length,1);
 },'/staff/password');
 await run('Password 10 platform existing system password path remains usable','normal',async p=>{
  await p.locator('summary').filter({hasText:c.passwordTitle}).click();await fill(p);await p.getByRole('button',exact(c.save)).click();await visible(p,c.passwordSaved);assert.equal((await calls(p,'auth.updateUser')).length,1);
 },'/staff/system');

 for(const role of ['manager','owner'])await run('Password 11 restaurant '+role+' own-account path','password-'+role,async p=>{
  await open(p);await fill(p);await p.getByRole('button',exact(c.save)).click();await visible(p,c.passwordSaved);assert.equal((await calls(p,'auth.updateUser')).length,1);assert.equal(await p.getByRole('link',exact(c.system)).count(),0);
 },'/staff/password');
 await run('Password 12 unconfirmed presentation role hides password form','password-role-unavailable',async p=>{
  await visible(p,'Görünüm rolü doğrulanamadı. Sayfayı yenileyin.');assert.equal(await p.locator('summary').filter({hasText:c.passwordTitle}).count(),0);assert.equal((await calls(p,'auth.updateUser')).length,0);
 },'/staff/password');

}
