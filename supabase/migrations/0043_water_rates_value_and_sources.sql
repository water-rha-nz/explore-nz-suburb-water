-- Water charges based on property value, and two sources per charge (docs/SPEC.md section 36).
-- value_rate: dollars per dollar of property value for water + wastewater combined (residential, main scheme); value_basis:
-- 'capital value' or 'land value'. website_url: the provider's rates/charges web page; policy_url: its pricing policy document
-- (rates resolution, funding impact statement or fees schedule). The existing source_url is the policy document.
alter table public.water_rates add column if not exists value_rate numeric, add column if not exists value_basis text,
  add column if not exists website_url text, add column if not exists policy_url text;
update public.water_rates set policy_url = source_url where policy_url is null and source_url is not null;
notify pgrst, 'reload schema';
