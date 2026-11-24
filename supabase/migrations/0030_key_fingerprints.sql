-- The signed-in user's own API key fingerprints (8 hex characters of SHA-256; the keys themselves never leave the Vault), so the
-- app can show the daily budget of the key actually in use. Usage is counted per key as '<user id>:<fingerprint>' (0029).
create extension if not exists pgcrypto with schema extensions;
create or replace function public.my_key_fingerprints() returns table (service text, fp text)
language sql stable security definer set search_path = public, vault, extensions as $$
  select k.service, left(encode(extensions.digest(d.decrypted_secret, 'sha256'), 'hex'), 8)
  from public.user_api_keys k join vault.decrypted_secrets d on d.id = k.secret_id
  where k.user_id = (select auth.uid());
$$;
revoke all on function public.my_key_fingerprints() from public, anon;
grant execute on function public.my_key_fingerprints() to authenticated;
notify pgrst, 'reload schema';
