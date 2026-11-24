-- The worker links each M_SUBURB row to its LINZ suburb(s) (prepare.linz); the table grant existed but row-level security had
-- no policy for the worker role, so every prepare job with a suburb list failed ("new row violates row-level security").
drop policy if exists "worker writes m_suburb_links" on public.m_suburb_links;
create policy "worker writes m_suburb_links" on public.m_suburb_links for all to worker using (true) with check (true);
