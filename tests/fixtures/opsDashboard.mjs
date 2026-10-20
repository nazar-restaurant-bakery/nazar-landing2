// Entirely synthetic data. No real account metrics, customer details or secrets.
export const opsBusiness = 'a358eba4-b197-4309-805b-46f43a718454';
export const opsActor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const opsOffer = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const opsRequestKey = '12121212-1212-4212-8212-121212121212';
export function freshOps(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(p => [p.type, p.value]));
  const today = parts.year + '-' + parts.month + '-' + parts.day;
  const shift = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const yesterday = shift(today, -1), first = today.slice(0, 7) + '-01', at = now.toISOString();
  const metrics = [];
  function add(source, metric, value, period) {
    const range = period || (metric.endsWith('_mtd') || ['baseline','rate'].includes(metric) ? [first, today]
      : metric.endsWith('_yesterday') ? [yesterday, yesterday]
      : metric.endsWith('_7d') ? [shift(yesterday, -6), yesterday] : [null,null]);
    metrics.push({ source, metric, value_num: typeof value === 'number' ? value : null, value_text: typeof value === 'string' ? value : null,
      period_start: range[0], period_end: range[1], collected_at: at, collector: 'edge_fn', is_test: false });
  }
  add('clover','net_sales_yesterday',112.34); add('clover','orders_yesterday',8);
  add('clover','net_sales_mtd',1234.56); add('clover','orders_mtd',89);
  for (const [channel, value] of [['dine_in',400],['pickup',300],['delivery',300],['catering',234.56]]) {
    add('clover','channel_' + channel + '_net_sales_mtd',value); add('clover','channel_' + channel + '_orders_mtd',20);
  }
  for (const [key,value] of [['qualified_sales_mtd',1234.56],['qicr_mtd',-10765.44],['baseline',12000],['commission_mtd',0],['rate',0.2],
    ['form_submissions_7d',3],['pending_signups',0],['failed_records_7d',0],['last_clover_import_at',at],['last_clover_import_source','manual_csv']]) add('supabase',key,value);
  for (const item of metrics.filter(item => item.source === 'supabase' && ['qualified_sales_mtd','qicr_mtd','commission_mtd'].includes(item.metric))) item.value_text = 'estimate';
  for (const [key,value] of [['subscribers',12],['net_growth_7d',3],['last_campaign_name','ÖRNEK — Deneme kampanyası'],['last_campaign_open_rate',42],['last_campaign_click_rate',3]]) add('klaviyo',key,value);
  for (const [key,value] of [['rating',4.8],['total_reviews',37],['new_reviews_7d',2]]) add('reviews',key,value);
  add('site','is_up',1); add('site','http_status',200); add('site','response_ms',225);
  add('supabase','manual_runs_24h',2); add('supabase','manual_failed_24h',0); add('supabase','scheduler_mode','manual_only');
  return {
    dashboard: { business_id: opsBusiness, generated_at: at, metrics,
      offers: [{ id: opsOffer,name:'ÖRNEK — Onaylı test teklifi',is_test:true,active:false,approved:true }],
      failed_jobs: [],campaigns:[],products:[] },
    connections: ['clover','klaviyo','google_ads','meta','site','ga4','reviews','scheduler','supabase'].map(source => ({
      source, status:['google_ads','meta','ga4','scheduler'].includes(source)?'not_connected':'connected',
      last_ok_at:['google_ads','meta','ga4','scheduler'].includes(source)?null:at,last_error:null,note:source==='scheduler'?'Günlük scheduler yok; yalnız manuel ops koşumları.':null,
      capabilities:source==='supabase'?['collect','offer_set_active','commission_report']:source==='clover'?['sync_clover_csv']:[],
    })),
    actions: [],
  };
}
