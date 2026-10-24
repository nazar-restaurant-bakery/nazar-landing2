/** Bootstrap-only response limits; normal provider transport is unchanged. */
export type ReadBudget={remaining:number};
export async function boundedJsonText(response:Response,budget:ReadBudget,perResponse=1000000,timeoutMs=5000):Promise<string>{
 if(!response.body)throw Error('bootstrap_empty_response');
 const length=Number(response.headers.get('Content-Length'));
 if(Number.isFinite(length)&&length>Math.min(perResponse,budget.remaining))throw Error('bootstrap_read_limit');
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const body=(async()=>{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;
   if(bytes>perResponse||part.value.byteLength>budget.remaining)throw Error('bootstrap_read_limit');budget.remaining-=part.value.byteLength;parts.push(part.value);}})();
  await Promise.race([body,new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(Error('bootstrap_read_timeout')),timeoutMs);})]);
  const all=new Uint8Array(bytes);let offset=0;for(const part of parts){all.set(part,offset);offset+=part.byteLength;}
  return new TextDecoder('utf-8',{fatal:true}).decode(all);
 }finally{if(timer!==undefined)clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
export function bootstrapBoundedFetcher(fetcher:typeof fetch,budget:ReadBudget={remaining:4000000}):typeof fetch{
 return async(input,init)=>{
  const response=await fetcher(input,init),method=init?.method||(input instanceof Request?input.method:'GET');
  // Never consume accepted-event response bodies, redirects or provider errors.
  if(method!=='GET'||response.status!==200)return response;
  const text=await boundedJsonText(response,budget);
  return new Response(text,{status:200,headers:{'Content-Type':'application/vnd.api+json'}});
 };
}
