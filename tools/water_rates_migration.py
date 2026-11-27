"""Turn data/water_rates_research.csv (validated charges, one row per provider, territory (TA_CODE, blank = all its territories) and start date) into a migration that upserts
water_rates. Only providers in the file change; a figure left blank stays blank (unknown), and verified is true only for
rows read from the official source. Usage: python tools/water_rates_migration.py NNNN"""
import csv, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rows = list(csv.DictReader(open(os.path.join(ROOT, "data", "water_rates_research.csv"), encoding="utf-8")))
lit = lambda v: "null" if v in (None, "") else "'" + str(v).replace("'", "''") + "'"
num = lambda v: "null" if v in (None, "") else str(float(v))
out = ["-- Water charges researched from each provider's official 2026/27 documents (docs/SPEC.md section 36; data/water_rates_research.csv).",
       "-- Charging type always; a figure only where the source states it; verified only where read from the official document.",
       "-- THRESHOLD is litres per day (an annual allowance divided by 365); VALUE_RATE is dollars per dollar of property value (water + wastewater)."]
for r in rows:
    out.append(f"""insert into public.water_rates (prvdr, ta_code, valid_from, charging_type, fixed_pa, volumetric_pa, threshold_lpd, value_rate, value_basis, date_est, note, source_url, policy_url, website_url, verified, tariff)
values ({lit(r['PRVDR'])}, {lit(r.get('TA_CODE'))}, {lit(r['VALID_FROM'])}, {lit(r['CHARGING_TYPE'])}, {num(r['FIXED_NZD_PA'])}, {num(r['VOLUMETRIC_NZD_PER_M3'])}, {num(r['THRESHOLD_L_PER_DAY'])}, {num(r['VALUE_RATE_PER_DOLLAR'])}, {lit(r['VALUE_BASIS'])}, {lit(r['CHECKED'])}, {lit(r['NOTE'])}, {lit(r['POLICY_URL'] or r['WEBSITE_URL'])}, {lit(r['POLICY_URL'])}, {lit(r['WEBSITE_URL'])}, {'true' if r['VERIFIED'] == 'yes' else 'false'}, {lit(r.get('TARIFF_JSON')) + '::jsonb' if r.get('TARIFF_JSON') else 'null'})
on conflict (prvdr, (coalesce(ta_code, '')), valid_from) do update set charging_type = excluded.charging_type, fixed_pa = excluded.fixed_pa, volumetric_pa = excluded.volumetric_pa,
  threshold_lpd = excluded.threshold_lpd, value_rate = excluded.value_rate, value_basis = excluded.value_basis, date_est = excluded.date_est, note = excluded.note,
  source_url = excluded.source_url, policy_url = excluded.policy_url, website_url = excluded.website_url, verified = excluded.verified, tariff = excluded.tariff;""")
p = os.path.join(ROOT, "supabase", "migrations", f"{sys.argv[1]}_water_rates_research.sql"); open(p, "w").write("\n".join(out) + "\n")
print(p, len(rows), "providers")
