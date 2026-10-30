import express, { Request, Response, NextFunction } from 'express';
import { httpServerHandler } from 'cloudflare:node';
import { ApolloB2BMiner } from './modules/apollo/b2b-miner.js';
import { ApolloEnricher } from './modules/apollo/enricher.js';
import { ApifyAdScraper } from './modules/apify/ad-scraper.js';
import { OutreachSequencer } from './modules/outreach/email-sequencer.js';
import { LeadImporter } from './modules/outreach/lead-importer.js';
import { verifyUnsubscribeToken, suppressEmail } from './modules/outreach/unsubscribe.js';
import { verifySvixSignature, handleResendEvent } from './modules/webhooks/resend-webhook.js';
import { coreDb } from './lib/supabase-client.js';
import { getBusinessSettings } from './lib/business-settings.js';
import { findActiveApiKeyId, isApiKeyBoundToBusiness } from './lib/api-key.js';
import { HttpError } from './lib/http-error.js';
import { isUuid, normalizeEmail } from './lib/validation.js';
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

// 1. Resend webhook — ham gövde gerekir, bu yüzden express.json'dan önce tanımlanır
app.post('/webhooks/resend', express.raw({ type: '*/*', limit: '1mb' }), async (req: Request, res: Response) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const secret = getConfig('RESEND_WEBHOOK_SECRET');

  if (!secret) {
    console.error('❌ [Resend webhook]: RESEND_WEBHOOK_SECRET boş');
    return res.status(503).json({ success: false, error: 'İşlem başarısız' });
  }

  const verified = verifySvixSignature(rawBody, {
    id: req.get('svix-id'),
    timestamp: req.get('svix-timestamp'),
    signature: req.get('svix-signature')
  }, secret);
  if (!verified) {
    console.warn('🛑 [Resend webhook] Geçersiz imza ya da zaman damgası');
    return badRequest(res, 'Geçersiz imza');
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return badRequest(res, 'Geçersiz gövde');
  }

  try {
    const outcome = await handleResendEvent(event);
    console.log(`📨 [Resend webhook] ${event?.type} → ${outcome}`);
    return res.status(200).json({ success: true });
  } catch (error: any) {
    // 500 → Resend yeniden dener; işlem tekrar güvenli
    return sendServerError(res, 'Resend webhook', error);
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

// 4. /api/growth/* koruması: API anahtarı (401) → business_id (400/404) → anahtar-işletme bağı (403)
async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (!match) {
    return res.status(401).json({ success: false, error: 'Geçersiz API anahtarı' });
  }

  try {
    const apiKeyId = await findActiveApiKeyId(match[1]);
    if (!apiKeyId) {
      return res.status(401).json({ success: false, error: 'Geçersiz API anahtarı' });
    }
    res.locals.apiKeyId = apiKeyId;
    return next();
  } catch (error: any) {
    return sendServerError(res, 'API anahtarı doğrulama', error);
  }
}

async function requireBusinessId(req: Request, res: Response, next: NextFunction) {
  const { business_id } = req.body || {};

  if (!isUuid(business_id)) {
    return badRequest(res, 'business_id zorunlu');
  }

  try {
    const { data, error } = await coreDb()
      .from('businesses')
      .select('id')
      .eq('id', business_id)
      .maybeSingle();

    if (error) {
      throw error;
    }
    if (!data) {
      return res.status(404).json({ success: false, error: 'business_id bulunamadı' });
    }
    if (!(await isApiKeyBoundToBusiness(res.locals.apiKeyId, business_id))) {
      return res.status(403).json({ success: false, error: 'Bu işletme için yetki yok' });
    }
    return next();
  } catch (error: any) {
    return sendServerError(res, 'business_id doğrulama', error);
  }
}

app.use('/api/growth', requireApiKey, requireBusinessId);

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

// 11. E-posta Gönderim Testi (gönderen bilgileri işletme ayarlarından)
app.post('/api/growth/email/test', async (req: Request, res: Response) => {
  const { business_id, to } = req.body || {};
  const email = normalizeEmail(to);
  if (!email) {
    return badRequest(res, 'to geçerli bir e-posta olmalı');
  }

  try {
    const sequencer = new OutreachSequencer();
    const result = await sequencer.sendTestEmail(business_id, email);
    return res.status(200).json({ success: true, ...result });
  } catch (error: any) {
    return sendServerError(res, 'E-posta testi', error);
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
