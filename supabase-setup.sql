-- ============================================================================
-- Hearts On Fire Network — Secure Download System
-- Run this in the Supabase SQL Editor (project: dbclgsumkdlrfxyltqzh).
-- ============================================================================

-- 1) Token table -------------------------------------------------------------
create table if not exists public.hof_download_tokens (
  id                uuid primary key default gen_random_uuid(),
  token             uuid unique not null default gen_random_uuid(),
  buyer_name        text not null,
  buyer_email       text not null,
  product_id        text not null,
  product_title     text not null,
  pdf_storage_path  text not null,          -- path inside the 'hof-stamped-pdfs' bucket
  created_at        timestamptz default now(),
  expires_at        timestamptz not null,
  download_count    int default 0,
  max_downloads     int default 2
);

create index if not exists idx_hof_download_tokens_token
  on public.hof_download_tokens (token);

-- 2) Storage buckets (both PRIVATE) -----------------------------------------
--    hof-pdfs          → upload the 4 ORIGINAL master PDFs here
--    hof-stamped-pdfs  → the system writes per-buyer stamped copies here
insert into storage.buckets (id, name, public)
values ('hof-pdfs', 'hof-pdfs', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('hof-stamped-pdfs', 'hof-stamped-pdfs', false)
on conflict (id) do nothing;

-- 3) Row Level Security ------------------------------------------------------
--    The Netlify Functions use the SERVICE (secret) key, which bypasses RLS.
--    We enable RLS with NO public policies so nothing is readable with the
--    anon/publishable key. (Storage buckets are private for the same reason.)
alter table public.hof_download_tokens enable row level security;

-- ============================================================================
-- After running this:
--   • Upload the master PDFs into the 'hof-pdfs' bucket with these exact names:
--       guard-your-heart-book.pdf
--       companion-workbook.pdf
--       small-group-guide.pdf
--       thirty-day-journal.pdf
--   • Set SUPABASE_URL + SUPABASE_SERVICE_KEY in the Netlify environment.
-- ============================================================================
