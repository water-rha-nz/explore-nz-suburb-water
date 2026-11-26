"""Turn data/water_rates_research.csv (validated charges, one row per provider and start date) into a migration that upserts
water_rates. Only providers in the file change; a figure left blank stays blank (unknown), and verified is true only for
rows read from the official source. Usage: python tools/water_rates_migration.py NNNN"""
import csv, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rows = list(csv.DictReader(open(os.path.join(ROOT, "data", "water_rates_research.csv"), encoding="utf-8")))
lit = lambda v: "null" if v in (None, "") else "'" + str(v).replace("'", "''") + "'"
num = lambda v: "null" if v in (None, "") else str(float(v))
out = ["-- Water charges researched from each provider's official 2026/27 documents (docs/SPEC.md section 36; data/water_rates_research.csv).",
       "-- Charging type always; a figure only where the source states it; verified only where read from the official document.",
       "-- THRESHOLD is litres per day (an annual allowance divided by 365)."]
for r in rows:
    out.append(f"""insert into public.water_rates (prvdr, valid_from, charging_type, fixed_pa, volumetric_pa, threshold_lpd, date_est, note, source_url, verified)
values ({lit(r['PRVDR'])}, {lit(r['VALID_FROM'])}, {lit(r['CHARGING_TYPE'])}, {num(r['FIXED_NZD_PA'])}, {num(r['VOLUMETRIC_NZD_PER_M3'])}, {num(r['THRESHOLD_L_PER_DAY'])}, {lit(r['CHECKED'])}, {lit(r['NOTE'])}, {lit(r['SOURCE_URL'])}, {'true' if r['VERIFIED'] == 'yes' else 'false'})
on conflict (prvdr, valid_from) do update set charging_type = excluded.charging_type, fixed_pa = excluded.fixed_pa, volumetric_pa = excluded.volumetric_pa,
  threshold_lpd = excluded.threshold_lpd, date_est = excluded.date_est, note = excluded.note, source_url = excluded.source_url, verified = excluded.verified;""")
p = os.path.join(ROOT, "supabase", "migrations", f"{sys.argv[1]}_water_rates_research.sql"); open(p, "w").write("\n".join(out) + "\n")
print(p, len(rows), "providers")
