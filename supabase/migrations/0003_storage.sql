-- Storage buckets and policies (docs/SPEC.md section 12.1 step 4). Both buckets are private.
insert into storage.buckets (id, name, public) values ('exports', 'exports', false), ('chips', 'chips', false)
on conflict (id) do nothing;

-- validation chips: readable by labellers (images of private sections; never public)
create policy "labellers read chips" on storage.objects for select
  using (bucket_id = 'chips' and public.has_role('labeller'));

-- export bundles: the requester or an editor can read; written by the worker (service role) only
create policy "own or editor exports" on storage.objects for select
  using (bucket_id = 'exports' and (owner = auth.uid() or public.has_role('editor')));
