-- Water charges belong to a territory (docs/SPEC.md section 36): one provider can charge differently in each territorial
-- authority it serves (e.g. Tiaki Wai in Wellington, Hutt, Porirua and Upper Hutt). ta_code is the TA a charge applies to; a row
-- without ta_code applies to every territory of the provider that has no row of its own. Key: provider, territory, start date.
alter table public.water_rates add column if not exists ta_code text;
alter table public.water_rates drop constraint if exists water_rates_pkey;
create unique index if not exists water_rates_key on public.water_rates (prvdr, (coalesce(ta_code, '')), valid_from);
notify pgrst, 'reload schema';
