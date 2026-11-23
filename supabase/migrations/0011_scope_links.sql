-- scope lists: keep the LINZ suburb name from nz_suburb_map.csv (NZ_SUBURB_REF) so the worker can link M_SUBURB rows
alter table public.m_suburbs add column if not exists linz_ref text, add column if not exists source_file text;
grant select, insert on public.m_suburbs, public.m_suburb_links to worker;
create policy "worker reads m_suburbs" on public.m_suburbs for select to worker using (true);
