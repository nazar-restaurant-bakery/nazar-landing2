import { coreDb } from '../../lib/supabase-client.js';
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
    const db = coreDb();
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
      const { data, error } = await db
        .from('b2b_leads')
        .select('id, email, contact_name, title, company_name')
        .eq('business_id', businessId)
        .in('email', emails.slice(i, i + LOOKUP_CHUNK_SIZE));
      if (error) {
        throw error;
      }
      for (const row of data || []) {
        existingByEmail.set(row.email, row);
      }
    }

    const newRows = emails
      .filter((email) => !existingByEmail.has(email))
      .map((email) => ({
        business_id: businessId,
        ...cleanLeads.get(email)!,
        status: 'enrichment_pending',
        source: 'import'
      }));

    if (newRows.length > 0) {
      const { error } = await db.from('b2b_leads').insert(newRows);
      if (error) {
        throw error;
      }
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

      const { error } = await db
        .from('b2b_leads')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('business_id', businessId)
        .eq('id', existing.id);
      if (error) {
        throw error;
      }
      updated++;
    }

    return {
      received: leads.length,
      inserted: newRows.length,
      updated,
      unchanged,
      skipped: skipped.length,
      skipped_details: skipped
    };
  }
}
