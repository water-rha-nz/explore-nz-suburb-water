-- Saved configurations also keep provider-code matches and suburb allocations (docs/SPEC.md section 25), in the
-- same shape as the old builder's nz_suburb_builder_config.json: names and codes only, never file contents.
alter table public.batch_configs add column if not exists prvdr_matches jsonb not null default '{}'::jsonb;  -- {"TAUPO_WATER": "TDC"}
alter table public.batch_configs add column if not exists allocations jsonb not null default '[]'::jsonb;    -- [{file, name, territory, linzSuburbs: [{name, territory}]}]
grant select (prvdr_matches, allocations) on public.batch_configs to authenticated;
