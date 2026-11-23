-- the worker reuses the shared LINZ suburb cache filled by validation (no suburbs request when cached)
grant select on public.linz_suburb_index to worker;
create policy "worker reads suburb cache" on public.linz_suburb_index for select to worker using (true);
