// Kullanım: npx tsx scripts/import-apollo-csv.ts --business <uuid> --file <csv yolu> [--commit]
// Varsayılan deneme modudur: veritabanına hiçbir şey yazılmaz, yalnız özet basılır.
// --commit ile yeni kayıtlar toplu eklenir, var olanların yalnız boş alanları doldurulur.
// core.email_suppressions yalnız okunur; status'u var olan kayıtlarda asla değiştirilmez.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { goRpc } from '../src/lib/supabase-client.js';
import { isUuid, normalizeEmail } from '../src/lib/validation.js';

const USAGE = 'Kullanım: npx tsx scripts/import-apollo-csv.ts --business <uuid> --file <csv yolu> [--commit]';
const CHUNK_SIZE = 200;
const SAMPLE_LIMIT = 3;

const COLUMNS = {
  firstName: 'First Name',
  lastName: 'Last Name',
  title: 'Title',
  company: 'Company Name',
  email: 'Email',
  emailStatus: 'Email Status',
  catchAll: 'Primary Email Catch-all Status',
  lastVerifiedAt: 'Primary Email Last Verified At',
  city: 'City',
  state: 'State',
  employees: '# Employees',
  industry: 'Industry',
  linkedin: 'Person Linkedin Url',
  website: 'Website',
  contactId: 'Apollo Contact Id',
  accountId: 'Apollo Account Id'
} as const;
const REQUIRED_COLUMNS = [COLUMNS.email, COLUMNS.emailStatus, COLUMNS.company];
const EXCLUDED_INDUSTRIES = new Set(['restaurants', 'food & beverages']);
// Var olan kayıtta yalnız boşsa doldurulan sütunlar
const FILLABLE_FIELDS = ['contact_name', 'title', 'company_name', 'industry', 'employee_count', 'city', 'state'] as const;

type SkipReason =
  | 'invalid_email'
  | 'not_verified'
  | 'no_company'
  | 'excluded_industry'
  | 'duplicate_in_file'
  | 'suppressed';
type Category = 'new' | 'on_hold' | 'existing_updated' | 'existing_unchanged' | SkipReason;
const CATEGORIES: Category[] = [
  'new',
  'on_hold',
  'existing_updated',
  'existing_unchanged',
  'invalid_email',
  'not_verified',
  'no_company',
  'excluded_industry',
  'duplicate_in_file',
  'suppressed'
];

type FillableField = (typeof FILLABLE_FIELDS)[number];
type LeadFields = Record<FillableField, string | number | null>;

interface Candidate {
  email: string;
  status: 'new' | 'on_hold';
  fields: LeadFields;
  metadata: Record<string, string>;
}

interface ExistingLead extends LeadFields {
  id: string;
  email: string;
  metadata: Record<string, unknown> | null;
}

// RFC 4180: tırnaklı alanlar, "" kaçışı, hücre içinde virgül/satır sonu, BOM
function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (inQuotes) {
    throw new Error('CSV bozuk: kapanmayan tırnak.');
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Tamamen boş satırlar atılır
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

function textOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isCatchAll(value: string | undefined): boolean {
  return /^catch[-\s]?all\b/i.test(value?.trim() ?? '');
}

function parseEmployeeCount(value: string | undefined): number | null {
  const cleaned = value?.trim().replace(/,/g, '') ?? '';
  return /^\d+$/.test(cleaned) ? Number(cleaned) : null;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function fail(stage: string, error: { message?: string } | null): never {
  throw new Error(`[${stage}] ${error?.message ?? 'bilinmeyen hata'}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      business: { type: 'string' },
      file: { type: 'string' },
      commit: { type: 'boolean', default: false }
    }
  });

  const businessId = values.business?.trim();
  const filePath = values.file?.trim();
  if (!businessId || !isUuid(businessId) || !filePath) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const commit = values.commit === true;
  const importFile = basename(filePath);
  const importedAt = new Date().toISOString();

  let business = false;
  try { business = await goRpc<boolean>('go_business_check_v1', { p_business_id: businessId }); }
  catch (businessError: any) { fail('işletme kontrolü', businessError); }
  if (!business) {
    console.error(`❌ İşletme bulunamadı: ${businessId}`);
    process.exitCode = 1;
    return;
  }

  const rows = parseCsv(readFileSync(filePath, 'utf8'));
  if (rows.length === 0) {
    console.error('❌ CSV boş.');
    process.exitCode = 1;
    return;
  }
  const header = rows[0].map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((name) => !header.includes(name));
  if (missing.length > 0) {
    console.error(`❌ Zorunlu başlık eksik: ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const index = new Map(header.map((name, i) => [name, i]));
  const cell = (row: string[], name: string) => {
    const i = index.get(name);
    return i === undefined ? undefined : row[i];
  };

  const dataRows = rows.slice(1);
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const samples = Object.fromEntries(CATEGORIES.map((c) => [c, [] as string[]])) as Record<Category, string[]>;
  const record = (category: Category, label: string) => {
    counts[category]++;
    if (samples[category].length < SAMPLE_LIMIT) samples[category].push(label);
  };

  // a–e: dosya içi kontroller
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const [i, row] of dataRows.entries()) {
    const rawEmail = cell(row, COLUMNS.email);
    const email = normalizeEmail(rawEmail);
    if (!email) {
      record('invalid_email', rawEmail?.trim() ? `satır ${i + 2}: biçim bozuk` : `satır ${i + 2}: boş`);
      continue;
    }
    if (cell(row, COLUMNS.emailStatus)?.trim().toLowerCase() !== 'verified') {
      record('not_verified', maskEmail(email));
      continue;
    }
    const company = textOrNull(cell(row, COLUMNS.company));
    if (!company) {
      record('no_company', maskEmail(email));
      continue;
    }
    const industry = textOrNull(cell(row, COLUMNS.industry));
    if (industry && EXCLUDED_INDUSTRIES.has(industry.toLowerCase())) {
      record('excluded_industry', `${maskEmail(email)} (${company})`);
      continue;
    }
    if (seen.has(email)) {
      record('duplicate_in_file', maskEmail(email));
      continue;
    }
    seen.add(email);

    const catchAllStatus = textOrNull(cell(row, COLUMNS.catchAll));
    const contactName = [cell(row, COLUMNS.firstName), cell(row, COLUMNS.lastName)]
      .map((part) => part?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    const metadata: Record<string, string> = {};
    const meta: [string, string | null][] = [
      ['apollo_contact_id', textOrNull(cell(row, COLUMNS.contactId))],
      ['apollo_account_id', textOrNull(cell(row, COLUMNS.accountId))],
      ['linkedin_url', textOrNull(cell(row, COLUMNS.linkedin))],
      ['website', textOrNull(cell(row, COLUMNS.website))],
      ['email_status', textOrNull(cell(row, COLUMNS.emailStatus))],
      ['catch_all_status', catchAllStatus],
      ['email_last_verified_at', textOrNull(cell(row, COLUMNS.lastVerifiedAt))],
      ['imported_at', importedAt],
      ['import_file', importFile]
    ];
    for (const [key, value] of meta) {
      if (value !== null) metadata[key] = value;
    }
    const onHold = isCatchAll(catchAllStatus ?? undefined);
    if (onHold) metadata.hold_reason = 'catch_all';

    candidates.push({
      email,
      status: onHold ? 'on_hold' : 'new',
      fields: {
        contact_name: contactName || null,
        title: textOrNull(cell(row, COLUMNS.title)),
        company_name: company,
        industry,
        employee_count: parseEmployeeCount(cell(row, COLUMNS.employees)),
        city: textOrNull(cell(row, COLUMNS.city)?.split(',')[0]),
        state: textOrNull(cell(row, COLUMNS.state))
      },
      metadata
    });
  }

  // f + var olan kayıtlar: e-posta listesiyle toplu okuma
  const suppressed = new Set<string>();
  const existing = new Map<string, ExistingLead>();
  for (const emails of chunk(candidates.map((c) => c.email), CHUNK_SIZE)) {
    let supRows: string[] = [];
    try { supRows = await goRpc<string[]>('go_suppressed_emails_v1', { p_business_id: businessId, p_emails: emails }); }
    catch (supError: any) { fail('suppression okuma', supError); }
    for (const email of supRows) suppressed.add(email);

    let leadRows: ExistingLead[] = [];
    try { leadRows = await goRpc<ExistingLead[]>('go_leads_by_email_v1', { p_business_id: businessId, p_emails: emails }); }
    catch (leadError: any) { fail('mevcut lead okuma', leadError); }
    for (const r of leadRows) existing.set(r.email, r);
  }

  const inserts: Record<string, unknown>[] = [];
  const updates: { id: string; email: string; patch: Record<string, unknown> }[] = [];
  for (const c of candidates) {
    if (suppressed.has(c.email)) {
      record('suppressed', maskEmail(c.email));
      continue;
    }
    const lead = existing.get(c.email);
    if (!lead) {
      record(c.status, `${maskEmail(c.email)} (${c.fields.company_name})`);
      // İşletme fonksiyon parametresinden gelir; sequence_step 0 ve next_step_at NULL tablo varsayılanıdır
      inserts.push({
        email: c.email,
        status: c.status,
        ...c.fields,
        source: 'apollo_csv',
        metadata: c.metadata
      });
      continue;
    }

    // Var olan kayıt: status'a dokunulmaz, yalnız boş alanlar ve eksik metadata anahtarları
    const patch: Record<string, unknown> = {};
    for (const field of FILLABLE_FIELDS) {
      if (isBlank(lead[field]) && !isBlank(c.fields[field])) patch[field] = c.fields[field];
    }
    const currentMeta = lead.metadata ?? {};
    const addedMeta = Object.fromEntries(Object.entries(c.metadata).filter(([key]) => !(key in currentMeta)));
    if (Object.keys(addedMeta).length > 0) patch.metadata = { ...currentMeta, ...addedMeta };

    if (Object.keys(patch).length > 0) {
      record('existing_updated', `${maskEmail(c.email)} (${Object.keys(patch).join(', ')})`);
      updates.push({ id: lead.id, email: c.email, patch });
    } else {
      record('existing_unchanged', maskEmail(c.email));
    }
  }

  let written = 0;
  if (commit) {
    for (const [n, batch] of chunk(inserts, CHUNK_SIZE).entries()) {
      try { written += (await goRpc<string[]>('go_leads_insert_v1', { p_business_id: businessId, p_rows: batch })).length; }
      catch (error: any) { fail(`insert parça ${n + 1} (önceden yazılan: ${written})`, error); }
    }
    for (const u of updates) {
      // Fonksiyon yalnız boş alanları ve eksik metadata anahtarlarını doldurur; status değişmez
      try { await goRpc<boolean>('go_lead_fill_v1', { p_business_id: businessId, p_lead_id: u.id, p_patch: u.patch }); }
      catch (error: any) { fail(`update ${maskEmail(u.email)} (önceden yazılan: ${written})`, error); }
      written++;
    }
  }

  console.log(commit ? '✅ COMMIT modu' : '🔎 DENEME modu (veritabanına yazılmadı; yazmak için --commit)');
  console.log(`Dosya: ${importFile} · İşletme: ${businessId}`);
  console.log(`Toplam satır: ${dataRows.length}`);
  for (const category of CATEGORIES) {
    const extra = samples[category].length > 0 ? `  örn: ${samples[category].join('; ')}` : '';
    console.log(`  ${category.padEnd(19)} ${String(counts[category]).padStart(4)}${extra}`);
  }
  if (commit) console.log(`Yazılan kayıt: ${written}`);
}

main().catch((error) => {
  console.error('❌', error?.message ?? error);
  process.exitCode = 1;
});
