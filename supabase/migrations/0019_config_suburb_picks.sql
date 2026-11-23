-- Suburbs you include or exclude per TA in 2.2 Allocate: {"021": {"add": ["Wairakei"], "ex": ["Nukuhau"]}} (LINZ names only)
alter table public.batch_configs add column if not exists suburb_picks jsonb not null default '{}'::jsonb;
grant select (suburb_picks) on public.batch_configs to authenticated;
