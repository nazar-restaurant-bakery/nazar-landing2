import { getConfig } from '../../config.js';

export interface CompetitorAd {
  competitor_name: string;
  ad_platform: 'meta' | 'google';
  headline: string;
  body_text: string;
  offer_type: 'discount' | 'free_item' | 'catering_special' | 'general';
  active_days: number;
  ad_url?: string;
  media_type: 'image' | 'video' | 'carousel';
  scraped_at: string;
}

export class ApifyAdScraper {
  private apiToken: string;

  constructor() {
    this.apiToken = getConfig('APIFY_API_TOKEN');
  }

  // Henüz gerçek Apify entegrasyonu yok: her zaman demo veri döner
  async scrapeCompetitorAds(competitorNames: string[] = ['Local Mediterranean House']): Promise<{
    ads: CompetitorAd[];
    is_mock: boolean;
  }> {
    const ads: CompetitorAd[] = [
      {
        competitor_name: 'Local Mediterranean House',
        ad_platform: 'meta',
        headline: '10% Off Your First Catering Order!',
        body_text: 'Authentic Mediterranean platters for your office meetings.',
        offer_type: 'catering_special',
        active_days: 42,
        media_type: 'image',
        scraped_at: new Date().toISOString()
      }
    ];
    return { ads, is_mock: true };
  }
}