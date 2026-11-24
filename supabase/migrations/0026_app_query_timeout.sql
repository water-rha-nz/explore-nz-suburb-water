-- Large regions' outlines, census and climate summaries can take longer than Supabase's default 8 s limit for app queries,
-- which left the app waiting on "Loading region…"; allow 30 s for signed-in users (anon stays at its default).
alter role authenticated set statement_timeout = '30s';
