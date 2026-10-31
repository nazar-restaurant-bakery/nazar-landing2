import { listBusinessSettings, BusinessSettings } from './lib/business-settings.js';
import { HttpError } from './lib/http-error.js';
import { zonedParts, timeToMinutes } from './lib/time.js';
import { getConfig } from './config.js';
import { OutreachSequencer, getDailySendQuota } from './modules/outreach/email-sequencer.js';
import { ApolloEnricher } from './modules/apollo/enricher.js';

const RUN_DUE_LIMIT = 20;
// wrangler.toml: crons = ["7 * * * *"] → her saat :07'de bir tick
const TICK_MINUTE = 7;

/**
 * Bu tick'in günlük kotadan payı: kalan hak, pencere sonuna kadar kalan tick'lere
 * (bu saat dahil) eşit yayılır. Ör. 09:07, pencere 09–16 → 7 tick; 10 hak → ceil(10/7) = 2.
 */
export function computeTickShare(remaining: number, localHour: number, endMinutes: number) {
  const lastTickHour = Math.ceil((endMinutes - TICK_MINUTE) / 60) - 1;
  const ticksLeft = Math.max(1, lastTickHour - localHour + 1);
  return { ticks_left: ticksLeft, tick_share: Math.ceil(Math.max(0, remaining) / ticksLeft) };
}

/**
 * İşletmenin mesai penceresi: yerel gün outreach_send_days içinde ve start ≤ saat < end.
 * Zenginleştirme: pencere içinde ve yerel saat, start saatine eşit (günde bir kez).
 */
export function evaluateSendWindow(settings: BusinessSettings, at: Date) {
  const local = zonedParts(at, settings.outreach_timezone);
  const minutes = local.hour * 60 + local.minute;
  const startMinutes = timeToMinutes(settings.outreach_send_start);
  const endMinutes = timeToMinutes(settings.outreach_send_end);

  const inWindow = settings.outreach_send_days.includes(local.isoWeekday)
    && minutes >= startMinutes
    && minutes < endMinutes;

  return {
    local_time: `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`,
    local_weekday: local.isoWeekday,
    in_window: inWindow,
    enrichment_hour: inWindow && local.hour === Math.floor(startMinutes / 60)
  };
}

async function runForBusiness(settings: BusinessSettings, at: Date) {
  const entry: Record<string, unknown> = { business_id: settings.business_id, timezone: settings.outreach_timezone };

  const window = evaluateSendWindow(settings, at);
  Object.assign(entry, window);
  if (!window.in_window) {
    return entry;
  }

  try {
    const quota = await getDailySendQuota(settings.business_id);
    const local = zonedParts(at, settings.outreach_timezone);
    const { tick_share } = computeTickShare(quota.remaining, local.hour, timeToMinutes(settings.outreach_send_end));
    Object.assign(entry, { daily_limit: quota.daily_limit, sent_today: quota.sent_today, tick_share });

    // Pay 0 ise (sınır dolu) runDue sınırı kendisi görür ve daily_limit_reached döner
    const result = await new OutreachSequencer().runDue(settings.business_id, Math.max(1, Math.min(RUN_DUE_LIMIT, tick_share)));
    entry.outreach = { selected: result.selected, queued_count: result.queued_count, reasons: result.reasons };
  } catch (error: any) {
    console.error(`❌ [Scheduler] outreach ${settings.business_id}:`, error?.message ?? error);
    entry.outreach = { error: String(error?.message ?? error) };
  }

  if (window.enrichment_hour) {
    if (!getConfig('APOLLO_API_KEY')) {
      entry.enrichment = 'skipped_no_api_key';
    } else {
      try {
        const result = await new ApolloEnricher().enrichLeads(settings.business_id);
        entry.enrichment = { processed: result.processed, enriched_count: result.enriched_count, failed_count: result.failed_count, credits_used: result.credits_used };
      } catch (error: any) {
        if (error instanceof HttpError && error.status === 429) {
          entry.enrichment = 'credit_limit_reached';
        } else {
          console.error(`❌ [Scheduler] enrichment ${settings.business_id}:`, error?.message ?? error);
          entry.enrichment = { error: String(error?.message ?? error) };
        }
      }
    }
  }

  return entry;
}

export async function runScheduledTick(scheduledTime: number): Promise<void> {
  if (getConfig('GO_SCHEDULER_ENABLED') !== 'true') {
    console.log('⏸️ [Scheduler] kapalı (GO_SCHEDULER_ENABLED != "true"); hiçbir işlem yapılmadı.');
    return;
  }

  const at = new Date(scheduledTime);
  const allSettings = await listBusinessSettings();
  const businesses: Record<string, unknown>[] = [];

  // Bir işletmenin hatası diğerlerini durdurmaz
  for (const settings of allSettings) {
    try {
      businesses.push(await runForBusiness(settings, at));
    } catch (error: any) {
      console.error(`❌ [Scheduler] ${settings.business_id}:`, error?.message ?? error);
      businesses.push({ business_id: settings.business_id, error: String(error?.message ?? error) });
    }
  }

  console.log('🕒 [Scheduler] özet:', JSON.stringify({ scheduled_at: at.toISOString(), businesses }));
}
