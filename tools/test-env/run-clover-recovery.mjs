// Secrets arrive only in the child process environment, never argv or output.
import fs from 'node:fs/promises';
import {orderPullConfig} from '../../functions/_lib/cloverOrderPull.ts';
import {recover,recoveryWindow} from './clover-recovery.ts';
try {
 const [configPath,from,to,receiptPath,reserveRpc]=process.argv.slice(2);
 recoveryWindow(from,to);
 if(!['daily_reserve_external_request','ops_reserve_external_request'].includes(reserveRpc))throw Error('invalid_rpc');
 const c=JSON.parse(await fs.readFile(configPath,'utf8'));
 const env={...c.environment,...process.env};
 const target=orderPullConfig(env,c.hostname);
 if(!target.ready||target.url!==c.expectedUrl||target.businessId!==c.expectedBusinessId)throw Error('target_mismatch');
 const proof=await recover(target,from,to,reserveRpc);
 await fs.writeFile(receiptPath,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
 console.log('CLOVER RECOVERY: source collected and upserted; database daily check required');
}catch(e){
 const allowed=['invalid_range','invalid_rpc','configuration_missing','target_mismatch','merchant_mismatch','optional_scope_incomplete','daily_budget_exhausted','clover_request_budget_exhausted','clover_rate_limited'];
 console.error('CLOVER RECOVERY: STOPPED ('+(allowed.includes(e.message)?e.message:e.code==='ENOENT'?'configuration_missing':'result_unconfirmed')+')');process.exitCode=1;
}
