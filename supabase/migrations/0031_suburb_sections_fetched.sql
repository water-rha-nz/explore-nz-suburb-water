-- When a suburb's parcels and buildings were downloaded (docs/SPEC.md section 28). Suburbs with no residential sections
-- (industrial, rural, parkland, water) stored nothing, so the LINZ step treated them as never downloaded and fetched them again
-- in every part, never finishing. The worker now marks each downloaded suburb here.
alter table public.suburbs add column if not exists sections_fetched_at timestamptz;
