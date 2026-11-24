-- Daily budgets are counted per API key (docs/SPEC.md section 28): the worker records a user's usage as '<user id>:<key
-- fingerprint>' (8 hex characters of the key's SHA-256; the key itself is never stored here), so a replaced key starts with its
-- own budget. Users keep seeing their own usage rows.
drop policy if exists "own or project usage" on public.api_usage;
create policy "own or project usage" on public.api_usage for select to authenticated
  using (public.has_role('editor') and (key_owner = 'project' or key_owner = (select auth.uid())::text or key_owner like (select auth.uid())::text || ':%')
         or public.has_role('admin'));
