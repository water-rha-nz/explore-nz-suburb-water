-- Which TAs' PRVDRs were chosen by hand in a saved configuration. Only those outrank the PRVDRs your lists give
-- (nz_suburb_provider.csv, nz_suburb_map.csv); the rest of prvdr_by_ta is the value resolved when it was saved.
alter table public.batch_configs add column if not exists prvdr_manual text[] not null default '{}';
grant select (prvdr_manual) on public.batch_configs to authenticated;
