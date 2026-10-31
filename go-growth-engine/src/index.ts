import express, { Request, Response, NextFunction } from 'express';
import { httpServerHandler } from 'cloudflare:node';
import { ApolloB2BMiner } from './modules/apollo/b2b-miner.js';
import { ApolloEnricher } from './modules/apollo/enricher.js';
import { ApifyAdScraper } from './modules/apify/ad-scraper.js';
import { OutreachSequencer } from './modules/outreach/email-sequencer.js';
import { LeadImporter } from './modules/outreach/lead-importer.js';
import { verifyUnsubscribeToken, suppressEmail } from './modules/outreach/unsubscribe.js';
import { verifyWebhookToken, handleSmartleadEvent } from './modules/webhooks/smartlead-webhook.js';
import { goRpc } from './lib/supabase-client.js';
import { getBusinessSettings } from './lib/business-settings.js';
import { authorizeApiKey } from './lib/api-key.js';
import { HttpError } from './lib/http-error.js';
import { isUuid } from './lib/validation.js';
import { getConfig } from './config.js';
import { runScheduledTick } from './scheduler.js';

const app = express();

// Cloudflare httpServerHandler bu porttaki sunucuya yönlendirir (Worker içinde gerçek port açılmaz)
const INTERNAL_PORT = 3000;

const RUN_DUE_DEFAULT_LIMIT = 20;
const RUN_DUE_MAX_LIMIT = 100;
const BULK_IMPORT_MAX_LEADS = 500;

// Ayrıntı loga yazılır, dışarıya genel mesaj döner
function sendServerError(res: Response, context: string, error: any) {
  console.error(`❌ [${context}]:`, error?.message ?? error);
  if (error instanceof HttpError) {
    return res.status(error.status).json({ success: false, error: error.publicMessage });
  }
  return res.status(500).json({ success: false, error: 'İşlem başarısız' });
}

function badRequest(res: Response, message: string) {
  return res.status(400).json({ success: false, error: message });
}

// undefined → varsayılan; pozitif tam sayı değilse null
function parsePositiveInt(value: unknown, fallback?: number): number | null | undefined {
  if (value === undefined || value === null) return fallback;
  return Number.isInteger(value) && (value as number) >= 1 ? (value as number) : null;
}

// 1. Smartlead webhook (EMAIL_SENT, EMAIL_REPLY, EMAIL_BOUNCE, LEAD_UNSUBSCRIBED).
// Smartlead imza göndermez; adres içindeki gizli belirteç doğrulanır. Ham gövde olay anahtarıdır.
app.post('/webhooks/smartlead/:token', express.raw({ type: '*/*', limit: '256kb' }), async (req: Request<{ token: string }>, res: Response) => {
  const secret = getConfig('SMARTLEAD_WEBHOOK_SECRET');
  if (secret.length < 32) {
    console.error('❌ [Smartlead webhook]: SMARTLEAD_WEBHOOK_SECRET boş ya da kısa');
    return res.status(503).json({ success: false, error: 'İşlem başarısız' });
  }
  if (!verifyWebhookToken(req.params.token, secret)) {
    return res.status(404).json({ success: false, error: 'Bulunamadı' });
  }
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  try {
    const result = await handleSmartleadEvent(rawBody);
    console.log(`📨 [Smartlead webhook] → ${result.outcome}`);
    return res.status(result.status).json({ success: result.status === 200 });
  } catch (error: any) {
    // 500 → Smartlead yeniden dener; olay anahtarı aynı olduğu için işlem tekrar güvenli
    return sendServerError(res, 'Smartlead webhook', error);
  }
});

app.use(express.json());

// 2. Health Check
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'GO Growth Engine', timestamp: new Date().toISOString() });
});

// 3. Abonelikten çıkma (API anahtarı ve business_id gövde kontrolünden muaf; kimlik token'dan gelir)
// GET yalnız onay sayfası gösterir (bağlantı tarayıcıları işlem tetiklemesin); işlem POST'ta yapılır.
const unsubscribeForm = express.urlencoded({ extended: false });

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function unsubscribePage(body: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribe</title>${body}`;
}

const INVALID_LINK_PAGE = unsubscribePage('<p>Invalid unsubscribe link.</p>');
const ERROR_PAGE = unsubscribePage('<p>Something went wrong. Please try again later.</p>');

app.get('/u/:token', async (req: Request<{ token: string }>, res: Response) => {
  const target = verifyUnsubscribeToken(req.params.token);
  if (!target) {
    return res.status(400).type('html').send(INVALID_LINK_PAGE);
  }

  // Ayar okunamazsa da çıkış engellenmez; genel metin gösterilir
  let senderName: string | null = null;
  try {
    senderName = (await getBusinessSettings(target.businessId)).outreach_sender_name;
  } catch (error: any) {
    console.error('❌ [Unsubscribe GET] business_settings okunamadı:', error?.message ?? error);
  }

  const question = senderName ? `Unsubscribe from ${escapeHtml(senderName)} emails?` : 'Unsubscribe from these emails?';
  return res.status(200).type('html').send(unsubscribePage(
    `<p>${question}</p><form method="post"><button type="submit">Unsubscribe</button></form>`
  ));
});

// Hem onay formundan hem e-posta programının tek tık isteğinden (List-Unsubscribe=One-Click) gelir
app.post('/u/:token', unsubscribeForm, async (req: Request<{ token: string }>, res: Response) => {
  const isOneClick = req.body?.['List-Unsubscribe'] === 'One-Click';

  try {
    const target = verifyUnsubscribeToken(req.params.token);
    if (!target) {
      return isOneClick ? badRequest(res, 'Geçersiz bağlantı') : res.status(400).type('html').send(INVALID_LINK_PAGE);
    }

    await suppressEmail(target.businessId, target.email);
    console.log(`🔕 [Unsubscribe${isOneClick ? ' one-click' : ''}] ${target.businessId} / ${target.email}`);

    return isOneClick
      ? res.status(200).json({ success: true })
      : res.status(200).type('html').send(unsubscribePage('<p>You have been unsubscribed.</p>'));
  } catch (error: any) {
    if (isOneClick) {
      return sendServerError(res, 'Unsubscribe POST', error);
    }
    console.error('❌ [Unsubscribe POST]:', error?.message ?? error);
    return res.status(500).type('html').send(ERROR_PAGE);
  }
});

// 4. /api/growth/* koruması: API anahtarı (401) → business_id (400/404) → anahtar-işletme bağı (403).
// Tek veritabanı fonksiyonu aynı sırayla karar verir; tablolara doğrudan erişilmez.
async function requireApiKeyAndBusiness(req: Request, res: Response, next: NextFunction) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (!match) {
    return res.status(401).json({ success: false, error: 'Geçersiz API anahtarı' });
  }

  const { business_id } = req.body || {};
  try {
    const check = await authorizeApiKey(match[1], isUuid(business_id) ? business_id : null);
    switch (check) {
      case 'ok': return next();
      case 'invalid_key': return res.status(401).json({ success: false, error: 'Geçersiz API anahtarı' });
      case 'business_missing': return badRequest(res, 'business_id zorunlu');
      case 'business_not_found': return res.status(404).json({ success: false, error: 'business_id bulunamadı' });
      case 'forbidden': return res.status(403).json({ success: false, error: 'Bu işletme için yetki yok' });
      default: throw new Error(`Beklenmeyen yetki sonucu: ${String(check)}`);
    }
  } catch (error: any) {
    return sendServerError(res, 'API anahtarı/business_id doğrulama', error);
  }
}

app.use('/api/growth', requireApiKeyAndBusiness);

// Salt okunur platform doğrulaması: aday sayıları (duruma göre), engel kaydı sayısı ve
// outreach_settings satırı. Yazma, gönderim ya da harici çağrı yapmaz.
app.post('/api/growth/platform/verify', async (req: Request, res: Response) => {
  try {
    const result = await goRpc<Record<string, unknown>>('go_platform_verify_v1', { p_business_id: req.body.business_id });
    return res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    return sendServerError(res, 'Platform doğrulama', error);
  }
});

// 5. Apollo B2B Lead Mining (e-postasız, enrichment_pending)
app.post('/api/growth/apollo/mine-leads', async (req: Request, res: Response) => {
  try {
    const { business_id, locations, titles } = req.body || {};
    const miner = new ApolloB2BMiner();
    const result = await miner.searchCateringLeads({ business_id, locations, titles });
    return res.status(200).json({ success: true, ...result });
  } catch (error: any) {
    return sendServerError(res, 'Apollo mine-leads', error);
  }
});

// 6. Apollo Zenginleştirme (kredi sınırlı)
app.post('/api/growth/apollo/enrich-leads', async (req: Request, res: Response) => {
  const { business_id, lead_ids, limit } = req.body || {};

  if (lead_ids !== undefined && (!Array.isArray(lead_ids) || lead_ids.length === 0 || !lead_ids.every(isUuid))) {
    return badRequest(res, 'lead_ids UUID listesi olmalı');
  }
  const parsedLimit = parsePositiveInt(limit);
  if (parsedLimit === null) {
    return badRequest(res, 'limit pozitif tam sayı olmalı');
  }

  try {
    const enricher = new ApolloEnricher();
    const result = await enricher.enrichLeads(business_id, { leadIds: lead_ids, limit: parsedLimit });
    return res.status(200).json({ success: true, ...result });
  } catch (error: any) {
    return sendServerError(res, 'Apollo enrich-leads', error);
  }
});

// 7. Apify Rakip Reklam Kazıma
app.post('/api/growth/apify/scrape-ads', async (req: Request, res: Response) => {
  try {
    const { competitors } = req.body || {};
    const scraper = new ApifyAdScraper();
    const result = await scraper.scrapeCompetitorAds(competitors || []);
    return res.status(200).json({ success: true, is_mock: result.is_mock, count: result.ads.length, data: result.ads });
  } catch (error: any) {
    return sendServerError(res, 'Apify scrape-ads', error);
  }
});

// 8. Tekil lead için sıradaki outreach adımı (ham e-posta kabul etmez)
app.post('/api/growth/outreach/trigger-sequence', async (req: Request, res: Response) => {
  const { business_id, b2b_lead_id } = req.body || {};

  if (!isUuid(b2b_lead_id)) {
    return badRequest(res, 'b2b_lead_id zorunlu');
  }

  try {
    const sequencer = new OutreachSequencer();
    const result = await sequencer.sendNextStep(business_id, b2b_lead_id);
    return res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    return sendServerError(res, 'Outreach trigger-sequence', error);
  }
});

// 9. Zamanı gelen outreach adımlarını gönder
app.post('/api/growth/outreach/run-due', async (req: Request, res: Response) => {
  const { business_id, limit } = req.body || {};

  const parsedLimit = parsePositiveInt(limit, RUN_DUE_DEFAULT_LIMIT);
  if (parsedLimit === null || parsedLimit === undefined) {
    return badRequest(res, 'limit pozitif tam sayı olmalı');
  }

  try {
    const sequencer = new OutreachSequencer();
    const result = await sequencer.runDue(business_id, Math.min(parsedLimit, RUN_DUE_MAX_LIMIT));
    return res.status(200).json({ success: true, ...result });
  } catch (error: any) {
    return sendServerError(res, 'Outreach run-due', error);
  }
});

// 10. Toplu lead aktarma — E-POSTA GÖNDERMEZ
app.post('/api/growth/outreach/bulk-trigger', async (req: Request, res: Response) => {
  const { business_id, leads } = req.body || {};

  if (!Array.isArray(leads) || leads.length === 0 || leads.length > BULK_IMPORT_MAX_LEADS) {
    return badRequest(res, `leads 1-${BULK_IMPORT_MAX_LEADS} kayıtlık liste olmalı`);
  }

  try {
    const importer = new LeadImporter();
    const result = await importer.importLeads(business_id, leads);
    return res.status(200).json({ success: true, ...result });
  } catch (error: any) {
    return sendServerError(res, 'Outreach bulk-trigger', error);
  }
});

app.listen(INTERNAL_PORT);

const httpHandler = httpServerHandler({ port: INTERNAL_PORT });

// Aynı Worker hem HTTP isteklerini hem cron tetiklemelerini işler
export default {
  ...httpHandler,
  async scheduled(controller: ScheduledController, _env: unknown, ctx: ExecutionContext) {
    ctx.waitUntil(
      runScheduledTick(controller.scheduledTime).catch((error: any) => {
        console.error('❌ [Scheduler] çalışma hatası:', error?.message ?? error);
      })
    );
  }
} satisfies ExportedHandler;
