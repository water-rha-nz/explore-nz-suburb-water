-- review-chips accepts a request when the SHA-256 of its x-review-token matches an active row here (docs/SPEC.md section 29).
-- Only the hash of a random 256-bit key is stored (it cannot be turned back into the key); revoke by setting revoked = true.
create table if not exists public.review_keys (sha256 text primary key, label text, created_at timestamptz default now(), revoked boolean not null default false);
alter table public.review_keys enable row level security;
revoke all on public.review_keys from anon, authenticated;
insert into public.review_keys (sha256, label) values ('1e1c5d8222c92e9fbd23091b64ca5b2fb7a8a15b8f20739a38f1dcb5fc64008d', 'second reviewer (blind)') on conflict (sha256) do nothing;
