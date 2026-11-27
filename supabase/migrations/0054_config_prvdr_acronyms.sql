-- The study's own PRVDR acronym for each territory, as configured in 2.1 (e.g. "WCC" for Wellington City, mapped to the provider
-- code TIAKIWAI). Shown wherever the study's PRVDR appears; the provider's legal name is shown as "Provider".
alter table public.batch_configs add column if not exists prvdr_acronyms jsonb not null default '{}'::jsonb;
grant select (prvdr_acronyms) on public.batch_configs to authenticated;
notify pgrst, 'reload schema';
