import {couponBootstrapConfig,bootstrapStore,bootstrapProvider,handleCouponBootstrapRequest} from '../../_lib/couponBootstrap.ts';
import type {CouponProvider} from '../../_lib/couponWelcome.ts';
type Context={request:Request;env:Record<string,string|undefined>};
export async function onRequest(context:Context):Promise<Response>{
 const config=couponBootstrapConfig(context.env,new URL(context.request.url).hostname);
 const mock:CouponProvider={mode:'mock',async get(){throw Error('mock_evidence_required');},async eventAccount(){throw Error('mock_evidence_required');},async event(){throw Error('mock_evidence_required');}};
 const provider=config.mode==='live'?bootstrapProvider(config):{coupon:mock,async inventory(){throw Error('mock_evidence_required');},async events(){throw Error('mock_evidence_required');}};
 return handleCouponBootstrapRequest(context.request,config,{store:bootstrapStore(config),provider});
}
