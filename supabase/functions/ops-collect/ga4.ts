import { CollectorError, budget, count, failure, googleAccessToken, metric, notConnected, object, periods, providerJson, type CollectorContext, type CollectorResult } from "./collectors.ts";
// https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart
export async function collect(ctx: CollectorContext, accessToken?: string): Promise<CollectorResult> {
  if (!ctx.env.GA4_ACCESS_TOKEN && !ctx.env.GA4_SERVICE_ACCOUNT_JSON) return notConnected("ga4", "GA4 Data API erişimi bekleniyor.");
  if (ctx.env.GA4_PROPERTY_ID && ctx.env.GA4_PROPERTY_ID !== "551076037") return notConnected("ga4", "Yalnız Nazar GA4 mülkü kullanılabilir.");
  const start = budget(ctx).remaining;
  try {
    const token = accessToken ?? await googleAccessToken(ctx, "GA4"); if (!token) return notConnected("ga4", "GA4 credentials bekleniyor.");
    const period = periods(ctx);
    const data = await providerJson(ctx, "https://analyticsdata.googleapis.com/v1beta/properties/551076037:runReport", "analyticsdata.googleapis.com", {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ dateRanges: [{ startDate: period.sevenStart, endDate: period.sevenEnd }], metrics: [{ name: "sessions" }], limit: 1 }),
    }, "/v1beta/properties/551076037:");
    if (!object(data) || !object(data.metadata) || data.metadata.timeZone !== "America/New_York" || !Array.isArray(data.metricHeaders)
      || !object(data.metricHeaders[0]) || data.metricHeaders[0].name !== "sessions") throw new CollectorError("ga4_invalid_scope_or_payload");
    const rows = data.rows; let visits: number | null = null;
    if ((rows === undefined || (Array.isArray(rows) && rows.length === 0)) && data.rowCount === 0) visits = 0;
    else if (Array.isArray(rows) && rows.length === 1 && object(rows[0]) && Array.isArray(rows[0].metricValues) && object(rows[0].metricValues[0])) visits = count(rows[0].metricValues[0].value);
    if (visits === null) throw new CollectorError("ga4_incomplete_report");
    return { source: "ga4", status: "connected", metrics: [metric(ctx, "ga4", "visits_7d", visits, "GA4 sessions; sipariş veya form başvurusu değildir.", period.sevenStart, period.sevenEnd)], requestsUsed: start - budget(ctx).remaining };
  } catch (error) { return failure(ctx, "ga4", start, error); }
}

// Existing visits_7d stays independent; one additional budgeted aggregate read for printed P stock.
// Native session dimensions: https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema
export async function collectWithQr(ctx: CollectorContext): Promise<CollectorResult> {
 const before=budget(ctx).remaining;
 if((ctx.env.GA4_PROPERTY_ID&&ctx.env.GA4_PROPERTY_ID!=="551076037")||(!ctx.env.GA4_ACCESS_TOKEN&&!ctx.env.GA4_SERVICE_ACCOUNT_JSON))return collect(ctx);
 let token:string|null;
 try{token=await googleAccessToken(ctx,"GA4");}catch(error){return failure(ctx,"ga4",before,error);}
 if(!token)return collect(ctx);
 const base=await collect(ctx,token);
 base.requestsUsed=before-budget(ctx).remaining;
 if(base.status!=="connected")return base;
 const p=periods(ctx);
 if(p.monthStart>p.yesterday)return base; // No completed day in this month; never fabricate zero.
 try {
  const report=await providerJson(ctx,"https://analyticsdata.googleapis.com/v1beta/properties/551076037:runReport","analyticsdata.googleapis.com",{
   method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
   body:JSON.stringify({dateRanges:[{startDate:p.monthStart,endDate:p.yesterday}],metrics:[{name:"sessions"}],
    dimensionFilter:{andGroup:{expressions:[
     {filter:{fieldName:"sessionSource",stringFilter:{matchType:"EXACT",value:"qr",caseSensitive:true}}},
     {filter:{fieldName:"sessionMedium",stringFilter:{matchType:"EXACT",value:"offline",caseSensitive:true}}},
     {filter:{fieldName:"sessionCampaignName",stringFilter:{matchType:"EXACT",value:"qr_paket",caseSensitive:true}}}
    ]}},limit:1})
  },"/v1beta/properties/551076037:");
  if(!object(report)||!object(report.metadata)||report.metadata.timeZone!=="America/New_York"
   ||report.metadata.subjectToThresholding===true||report.metadata.dataLossFromOtherRow===true
   ||Array.isArray(report.metadata.samplingMetadatas)&&report.metadata.samplingMetadatas.length>0
   ||!Array.isArray(report.metricHeaders)||!object(report.metricHeaders[0])||report.metricHeaders[0].name!=="sessions")throw new CollectorError("qr_report_unverified");
  let value:number|null=null;
  if(report.rowCount===0&&(report.rows===undefined||Array.isArray(report.rows)&&report.rows.length===0))value=0;
  else if(report.rowCount===1&&Array.isArray(report.rows)&&report.rows.length===1&&object(report.rows[0])&&Array.isArray(report.rows[0].metricValues)&&object(report.rows[0].metricValues[0]))value=count(report.rows[0].metricValues[0].value);
  if(value===null)throw new CollectorError("qr_report_incomplete");
  base.metrics.push(metric(ctx,"ga4","qr_paket_sessions_mtd",value,"GA4 qr/offline/qr_paket sessions; not physical scans or identified customers.",p.monthStart,p.yesterday));
 }catch(error){
  const code=error instanceof CollectorError?error.code:"qr_report_unavailable";
  base.metrics.push(metric(ctx,"ga4","qr_paket_sessions_mtd",null,code,p.monthStart,p.yesterday));
  base.note="GA4 total available; QR report unverified.";
 }
 base.requestsUsed=before-budget(ctx).remaining;
 return base;
}
