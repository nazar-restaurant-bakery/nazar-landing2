-- Gorev 5 · GO verisini disa aktarma. YALNIZ GO'nun eski Supabase projesinde calisir; salt okunur.
-- Sonucu "Export -> Download CSV" ile indir: C:\Users\Talip\nazar-go-growth\go_export.csv
SELECT 'b2b_leads' AS tablo, to_jsonb(l) AS satir FROM core.b2b_leads l
UNION ALL SELECT 'email_suppressions', to_jsonb(s) FROM core.email_suppressions s
UNION ALL SELECT 'enrichment_log', to_jsonb(e) FROM core.enrichment_log e
UNION ALL SELECT 'business_settings', to_jsonb(b) FROM core.business_settings b
ORDER BY 1;
