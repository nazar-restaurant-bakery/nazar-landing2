// Real owned loopback PG18.6, full application baseline and actual staff DDL.
// Auth table columns are a local platform facade; no hosted Auth or mail.
import test,{after} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import {join} from 'node:path';
import {fixture,repo} from './fixtures/customerTestClassificationNative.mjs';
const h=await fixture({currentCouponSchema:true});after(()=>h.stop());
h.sql(`ALTER TABLE auth.users ADD COLUMN email text,ADD COLUMN raw_user_meta_data jsonb DEFAULT '{}'::jsonb;`);
for(const path of ['20261021000850_staff_manage_authorization.sql','20261021000900_staff_management.sql'])h.sql(await readFile(join(repo,'supabase/migrations',path),'utf8'));
const actors=Object.fromEntries(['owner','manager','staff','platformOnly','platformMember','inactive'].map(x=>[x,randomUUID()]));
h.sql(`INSERT INTO auth.users(id,email) VALUES ${Object.entries(actors).map(([name,id])=>`('${id}','${name.toLowerCase()}@fixture.invalid')`).join(',')};
INSERT INTO core.business_staff(business_id,staff_id,role,active) VALUES('${h.business}','${actors.owner}','owner',true),('${h.business}','${actors.manager}','manager',true),('${h.business}','${actors.staff}','staff',true),('${h.business}','${actors.platformMember}','staff',true),('${h.business}','${actors.inactive}','staff',false);
INSERT INTO core.platform_operators(staff_id,active) VALUES('${actors.platformOnly}',true),('${actors.platformMember}',true);`);
const call=(id,b=h.business)=>h.raw(`\\set VERBOSITY verbose
SET request.jwt.claim.role='authenticated';SET request.jwt.claim.sub='${id}';SELECT public.staff_members_list_v1('${b}');`,{role:'authenticated'});
for(const name of ['manager','staff','platformOnly','inactive'])test('actual staff_members_list_v1 denies '+name+' with SQLSTATE42501',()=>{const r=call(actors[name]);assert.notEqual(r.status,0);assert.match(r.stderr,/42501/);});
for(const name of ['owner','platformMember'])test('existing staff management authority remains available to '+name,()=>{const r=call(actors[name]);assert.equal(r.status,0,r.stderr);});
test('wrong business owner cannot read members',()=>{const r=call(actors.owner,randomUUID());assert.notEqual(r.status,0);assert.match(r.stderr,/42501/);});
test('ordinary staff still has tenant CRM read without staff.manage',()=>{assert.equal(h.sql(`SET request.jwt.claim.role='authenticated';SET request.jwt.claim.sub='${actors.staff}';SELECT public.staff_business_authorized_v1('${h.business}','crm.read')`,{role:'authenticated'}),true);assert.equal(h.sql(`SET request.jwt.claim.role='authenticated';SET request.jwt.claim.sub='${actors.staff}';SELECT public.staff_business_authorized_v1('${h.business}','staff.manage')`,{role:'authenticated'}),false);});
