import { goRpc } from '../../lib/supabase-client.js';
import { getConfig } from '../../config.js';

export interface ApolloSearchFilters {
  business_id: string;
  locations?: string[];
  titles?: string[];
  minEmployees?: number;
  maxEmployees?: number;
  page?: number;
  perPage?: number;
}

export interface B2BLeadRecord {
  business_id: string;
  apollo_person_id: string;
  company_name: string;
  contact_name: string | null;
  title: string | null;
  email: null;
  phone?: string | null;
  industry?: string | null;
  employee_count?: number | null;
  city: string | null;
  state: string;
  source: 'apollo';
  status: 'enrichment_pending';
  metadata: Record<string, unknown>;
}

const APOLLO_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_people/api_search';

/**
 * Apollo kişisini b2b_leads kaydına çevirir. Kimliği ya da şirket adı olmayan kişi atlanır (null);
 * company_name veritabanında zorunlu. Apollo'dan gelmeyen alanlar yer tutucuyla doldurulmaz, NULL kalır.
 */
export function mapApolloPerson(businessId: string, person: any): B2BLeadRecord | null {
  const companyName = typeof person?.organization?.name === 'string' ? person.organization.name.trim() : '';
  if (!person?.id || !companyName) {
    return null;
  }

  const firstPhone = person.phone_numbers && person.phone_numbers.length > 0
    ? person.phone_numbers[0]?.sanitized_number
    : null;
  const orgPhone = person.organization?.primary_phone?.sanitized_number || null;
  const employeeCount = person.organization?.estimated_num_employees;

  return {
    business_id: businessId,
    apollo_person_id: String(person.id),
    company_name: companyName,
    contact_name: `${person.first_name || ''} ${person.last_name || ''}`.trim() || null,
    title: person.title || null,
    email: null,
    phone: firstPhone || orgPhone,
    industry: person.organization?.industry || null,
    employee_count: Number.isInteger(employeeCount) && employeeCount > 0 ? employeeCount : null,
    city: person.city || null,
    state: person.state || 'CT',
    source: 'apollo',
    status: 'enrichment_pending',
    metadata: {
      linkedin_url: person.linkedin_url,
      organization_id: person.organization_id,
      search_region: 'New Haven County (12m Radius)'
    }
  };
}

export class ApolloB2BMiner {
  private apiKey: string;

  constructor() {
    this.apiKey = getConfig('APOLLO_API_KEY');
  }

  async searchCateringLeads(filters: ApolloSearchFilters): Promise<{
    leads: B2BLeadRecord[];
    is_mock: boolean;
    saved_to_db: boolean;
    saved_count: number;
    skipped: number;
  }> {
    const businessId = filters.business_id;
    if (!businessId) {
      throw new Error('business_id zorunlu');
    }

    // 12 millik yarıçap / New Haven County kapsama alanları
    const targetLocations = (filters.locations && filters.locations.length > 0)
      ? filters.locations
      : ['New Haven County, CT', 'West Haven, CT', 'New Haven, CT', 'Milford, CT', 'Orange, CT', 'East Haven, CT', 'Hamden, CT'];

    let leads: B2BLeadRecord[] = [];

    // Demo modu: sahte lead veritabanına yazılmaz
    if (!this.apiKey) {
      console.warn('⚠️ APOLLO_API_KEY .env dosyasında bulunamadı! Demo veri dönüyor (veritabanına yazılmaz).');
      leads = [
        {
          business_id: businessId,
          apollo_person_id: 'mock-person-1',
          company_name: 'Yale New Haven Health (Mock)',
          contact_name: 'Jennifer Adams',
          title: 'Office Manager',
          email: null,
          phone: '+12035550144',
          industry: 'Healthcare / Logistics',
          employee_count: 150,
          city: 'New Haven',
          state: 'CT',
          source: 'apollo',
          status: 'enrichment_pending',
          metadata: { is_mock: true, region: 'New Haven County (12m Radius)' }
        }
      ];
      return { leads, is_mock: true, saved_to_db: false, saved_count: 0, skipped: 0 };
    }

    let skipped = 0;
    try {
      const response = await fetch(APOLLO_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'x-api-key': this.apiKey
        },
        body: JSON.stringify({
          person_titles: filters.titles || ['Office Manager', 'HR Director', 'Event Coordinator', 'Facilities Manager'],
          person_locations: targetLocations,
          page: filters.page || 1,
          per_page: filters.perPage || 10
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Apollo API hatası (${response.status}): ${errText}`);
      }

      const data: any = await response.json();
      const allPeople: any[] = data.people || [];
      leads = allPeople
        .map((person: any) => mapApolloPerson(businessId, person))
        .filter((lead): lead is B2BLeadRecord => lead !== null);
      skipped = allPeople.length - leads.length;
    } catch (error: any) {
      console.error('❌ Apollo API Çağrı Hatası:', error.message);
      throw error;
    }

    let saved_count = 0;

    if (leads.length > 0) {
      // Var olan kayda dokunma: yalnız yeni kişiler eklenir. İşletme fonksiyon parametresinden gelir.
      let insertedIds: string[];
      try {
        insertedIds = await goRpc<string[]>('go_leads_insert_v1', {
          p_business_id: businessId,
          p_rows: leads.map(({ business_id: _business, ...row }) => row)
        });
      } catch (dbError: any) {
        console.error('❌ Supabase Veritabanı Kayıt Hatası:', dbError?.message ?? dbError);
        throw dbError;
      }

      saved_count = insertedIds.length;
      console.log(`✅ ${saved_count} yeni lead b2b_leads tablosuna yazıldı (enrichment_pending).`);
    }

    return { leads, is_mock: false, saved_to_db: leads.length > 0, saved_count, skipped };
  }
}
