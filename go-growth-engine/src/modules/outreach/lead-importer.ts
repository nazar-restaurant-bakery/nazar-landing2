import { goRpc } from '../../lib/supabase-client.js';
import { normalizeEmail } from '../../lib/validation.js';

export interface ImportLeadInput {
  email?: unknown;
  contact_name?: unknown;
  company_name?: unknown;
  title?: unknown;
}

interface CleanLead {
  email: string;
  company_name: string;
  contact_name: string | null;
  title: string | null;
}

const FILLABLE_FIELDS = ['contact_name', 'title', 'company_name'] as const;
const LOOKUP_CHUNK_SIZE = 100;

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Lead listesini b2b_leads'e aktarır. E-POSTA GÖNDERMEZ.
 * Yeni kayıt 'enrichment_pending'; var olan kayıtta yalnız boş alanlar doldurulur.
 */
export class LeadImporter {
  async importLeads(businessId: string, leads: ImportLeadInput[]) {
    const skipped: { index: number; reason: string }[] = [];
    const cleanLeads = new Map<string, CleanLead>();

    leads.forEach((lead, index) => {
      const email = normalizeEmail(lead?.email);
      if (!email) {
        skipped.push({ index, reason: 'invalid_email' });
        return;
      }
      const company_name = cleanText(lead.company_name);
      if (!company_name) {
        skipped.push({ index, reason: 'missing_company_name' });
        return;
      }
      if (cleanLeads.has(email)) {
        skipped.push({ index, reason: 'duplicate_in_request' });
        return;
      }
      cleanLeads.set(email, { email, company_name, contact_name: cleanText(lead.contact_name), title: cleanText(lead.title) });
    });

    const emails = [...cleanLeads.keys()];
    const existingByEmail = new Map<string, any>();
    for (let i = 0; i < emails.length; i += LOOKUP_CHUNK_SIZE) {
      const rows = await goRpc<any[]>('go_leads_by_email_v1', {
        p_business_id: businessId, p_emails: emails.slice(i, i + LOOKUP_CHUNK_SIZE)
      });
      for (const row of rows) {
        existingByEmail.set(row.email, row);
      }
    }

    const newRows = emails
      .filter((email) => !existingByEmail.has(email))
      .map((email) => ({
        ...cleanLeads.get(email)!,
        status: 'enrichment_pending',
        source: 'import'
      }));

    let inserted = 0;
    if (newRows.length > 0) {
      inserted = (await goRpc<string[]>('go_leads_insert_v1', { p_business_id: businessId, p_rows: newRows })).length;
    }

    let updated = 0;
    let unchanged = 0;
    for (const [email, existing] of existingByEmail) {
      const incoming = cleanLeads.get(email)!;
      const patch: Record<string, string> = {};
      for (const field of FILLABLE_FIELDS) {
        const incomingValue = incoming[field];
        if (incomingValue && !cleanText(existing[field])) {
          patch[field] = incomingValue;
        }
      }

      if (Object.keys(patch).length === 0) {
        unchanged++;
        continue;
      }

      // Fonksiyon yalnız boş alanları doldurur; durum değişmez
      await goRpc<boolean>('go_lead_fill_v1', { p_business_id: businessId, p_lead_id: existing.id, p_patch: patch });
      updated++;
    }

    return {
      received: leads.length,
      inserted,
      updated,
      unchanged,
      skipped: skipped.length,
      skipped_details: skipped
    };
  }
}
