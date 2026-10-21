-- Add synthetic tenants only after the exact 9b Nazar engine is installed.
INSERT INTO core.business_settings(business_id,baseline_monthly,commission_rate) VALUES
 ('11111111-1111-4111-8111-111111111111',12000,0.20),
 ('22222222-2222-4222-8222-222222222222',12000,0.20);
