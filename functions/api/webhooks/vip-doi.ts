import { doiWebhookConfig, doiWebhookProvider, doiWebhookStore, handleDoiWebhook } from '../../_lib/vipDoiWebhook.ts';
type Context={request:Request;env:Record<string,string|undefined>};
export async function onRequest({request,env}:Context):Promise<Response>{
 const config=doiWebhookConfig(env,new URL(request.url).hostname);
 return handleDoiWebhook(request,config,{store:doiWebhookStore(config,fetch),provider:doiWebhookProvider(config,fetch)});
}
