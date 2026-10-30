"""Gorev 5 · GO disa aktarim CSV'sinden platforma tek islemlik ice aktarim SQL'i uretir.
Kullanim: python build_import.py go_export.csv 02_import_into_platform.sql
GO isletme kimligi platformdaki Nazar kimligine esler. Var olan kayitlar degismez (ON CONFLICT DO NOTHING)."""
import csv, json, sys
GO_BIZ = "b10a2938-7481-4233-a261-291823901a11"
NAZAR = "a358eba4-b197-4309-805b-46f43a718454"
src, out = sys.argv[1], sys.argv[2]
rows = {"b2b_leads": [], "email_suppressions": [], "enrichment_log": [], "business_settings": []}
with open(src, newline="", encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        d = json.loads(r["satir"])
        if d.get("business_id") != GO_BIZ:
            sys.exit(f"Beklenmeyen business_id: {d.get('business_id')}")
        d["business_id"] = NAZAR
        rows[r["tablo"]].append(d)
s = rows["business_settings"]
outreach = [{
    "business_id": NAZAR, "sender_name": x["outreach_sender_name"], "sender_email": x["outreach_sender_email"],
    "reply_to": x["outreach_reply_to"], "physical_address": x["outreach_physical_address"],
    "link_base_url": x["outreach_link_base_url"], "timezone": x["outreach_timezone"],
    "send_days": x["outreach_send_days"], "send_start": x["outreach_send_start"], "send_end": x["outreach_send_end"],
    "daily_send_limit": x["outreach_daily_send_limit"],
    "enrichment_daily_credit_limit": x["enrichment_daily_credit_limit"],
    "enrichment_monthly_credit_limit": x["enrichment_monthly_credit_limit"]} for x in s]
def lit(obj):
    return "$j$" + json.dumps(obj, ensure_ascii=False) + "$j$::jsonb"
n = {k: len(v) for k, v in rows.items()}
sql = f"""-- Gorev 5 · GO verisinin platforma aktarimi. YALNIZ Nazar-production'da calisir. Tek islem.
-- Kaynak sayilari: aday {n['b2b_leads']}, engel {n['email_suppressions']}, zenginlestirme {n['enrichment_log']}, ayar {len(outreach)}
BEGIN;
DO $g$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.businesses WHERE id='{NAZAR}') OR to_regclass('core.outreach_settings') IS NULL THEN
    RAISE EXCEPTION 'G5_WRONG_PROJECT_OR_G4_MISSING'; END IF;
END $g$;
INSERT INTO core.b2b_leads SELECT * FROM jsonb_populate_recordset(NULL::core.b2b_leads, {lit(rows['b2b_leads'])}) ON CONFLICT DO NOTHING;
INSERT INTO core.email_suppressions SELECT * FROM jsonb_populate_recordset(NULL::core.email_suppressions, {lit(rows['email_suppressions'])}) ON CONFLICT DO NOTHING;
INSERT INTO core.enrichment_log SELECT * FROM jsonb_populate_recordset(NULL::core.enrichment_log, {lit(rows['enrichment_log'])}) ON CONFLICT DO NOTHING;
INSERT INTO core.outreach_settings SELECT * FROM jsonb_populate_recordset(NULL::core.outreach_settings, {lit(outreach)}) ON CONFLICT DO NOTHING;
DO $c$ BEGIN
  IF (SELECT count(*) FROM core.b2b_leads) < {n['b2b_leads']}
    OR (SELECT count(*) FROM core.email_suppressions) < {n['email_suppressions']}
    OR (SELECT count(*) FROM core.outreach_settings) < {len(outreach)} THEN
    RAISE EXCEPTION 'G5_COUNT_MISMATCH'; END IF;
END $c$;
COMMIT;
SELECT status, count(*) FROM core.b2b_leads GROUP BY status ORDER BY 1;
"""
open(out, "w", encoding="utf-8", newline="\n").write(sql)
print(n, "ayar", len(outreach))
