-- Per-user API keys (docs/SPEC.md section 23). Keys are encrypted in Supabase Vault; users can set, replace or
-- remove their own keys but never read them back (only the last 4 characters are shown). Only the worker role
-- can decrypt a key, and only the key of the user who queued the job it is running.
create table public.user_api_keys (
  user_id uuid not null references auth.users on delete cascade,
  service text not null check (service in ('linz', 'statsnz_ade', 'statsnz_datafinder', 'openmeteo')),
  secret_id uuid not null,
  last4 text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, service)
);
alter table public.user_api_keys enable row level security;
create policy "own keys metadata" on public.user_api_keys for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.user_api_keys from anon;

create or replace function public.set_my_api_key(p_service text, p_key text) returns text
language plpgsql security definer set search_path = public, vault as $$
declare uid uuid := auth.uid(); sid uuid; k text := btrim(coalesce(p_key, ''));
begin
  if uid is null or not public.has_role('viewer') then raise exception 'not allowed'; end if;
  if p_service not in ('linz', 'statsnz_ade', 'statsnz_datafinder', 'openmeteo') then raise exception 'unknown service %', p_service; end if;
  if length(k) < 8 or length(k) > 256 or k ~ '\s' then raise exception 'that does not look like an API key'; end if;
  select secret_id into sid from public.user_api_keys where user_id = uid and service = p_service;
  if sid is null then
    sid := vault.create_secret(k, 'user:' || uid || ':' || p_service, 'API key for ' || p_service);
    insert into public.user_api_keys (user_id, service, secret_id, last4) values (uid, p_service, sid, right(k, 4));
  else
    perform vault.update_secret(sid, k);
    update public.user_api_keys set last4 = right(k, 4), updated_at = now() where user_id = uid and service = p_service;
  end if;
  return right(k, 4);
end $$;

create or replace function public.delete_my_api_key(p_service text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare sid uuid;
begin
  delete from public.user_api_keys where user_id = auth.uid() and service = p_service returning secret_id into sid;
  if sid is not null then delete from vault.secrets where id = sid; end if;
end $$;

-- worker only: the key of the user who created the job (null -> the worker uses the project key)
create or replace function public.job_api_key(p_job bigint, p_service text) returns table (key text, owner uuid)
language sql stable security definer set search_path = public, vault as $$
  select d.decrypted_secret, k.user_id
  from public.jobs j join public.user_api_keys k on k.user_id = j.created_by and k.service = p_service
  join vault.decrypted_secrets d on d.id = k.secret_id
  where j.id = p_job;
$$;

revoke execute on function public.set_my_api_key(text, text) from public, anon;
revoke execute on function public.delete_my_api_key(text) from public, anon;
revoke execute on function public.job_api_key(bigint, text) from public, anon, authenticated;
grant execute on function public.set_my_api_key(text, text) to authenticated;
grant execute on function public.delete_my_api_key(text) to authenticated;
grant execute on function public.job_api_key(bigint, text) to worker;

-- usage budgets are per key: count usage per key owner ('project' = the project's own keys)
alter table public.api_usage add column if not exists key_owner text not null default 'project';
alter table public.api_usage drop constraint if exists api_usage_pkey;
alter table public.api_usage add primary key (service, period, bucket, key_owner);
