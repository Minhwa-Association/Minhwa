-- Migration v16.4 — approved receipts are saved to the association's Google Drive (2026-10-15)
-- Run once in Supabase SQL Editor (after v16.3). Safe to run again.
--
-- What changes
--   * The admin connects Google Drive once in Settings ("Connect Google Drive", signed in as manager@minhwa.org).
--     The app keeps Google's lasting key (refresh token) here — encrypted by the app with a key made from
--     GOOGLE_CLIENT_SECRET, which only Vercel has, so the stored value is useless on its own. The app may only
--     touch files and folders it made itself (Google's "drive.file" access), nothing else in that Drive.
--   * On connecting, the app makes the folders "Minhwa — Bokföring" / "Receipts" (once; it remembers their ids,
--     so they can be moved or renamed in Drive).
--   * When the treasurer approves a receipt, its files go into that folder as
--     "2026-10-15 R0012 Material — Julien Petotte 450 kr.jpg" (purchase date, or the day it came in);
--     claim_files.drive_file_id remembers each one. Approving again after a change renames the file instead of
--     adding a second one. Declining a receipt that was already in Drive moves its files to Drive's bin.
--   * Disconnect drops the key only; connecting the same account again goes on in the same folders.
--   * Nothing else changes: the original stays in the app, Drive is the association's copy.

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'place_order' and prosrc like '%two minutes%') then
    raise exception 'Run migration_v16_3_double_submit.sql first';
  end if;
end $$;

-- ───────────────────────── 1. the connection (one row) ─────────────────────────
create table if not exists drive_connection (
  id                  int primary key default 1 check (id = 1),
  email               text not null,                      -- the Google account the files go to
  token_enc           text,                               -- refresh token, encrypted by the app (null = disconnected)
  root_folder_id      text,                               -- "Minhwa — Bokföring"
  receipts_folder_id  text,                               -- "Minhwa — Bokföring / Receipts"
  connected_by        uuid references members(id) on delete set null,
  connected_at        timestamptz not null default now()
);
alter table drive_connection alter column token_enc drop not null;   -- (a first run of this file had it not null)
alter table drive_connection enable row level security;  -- no policies: only the functions below read or write it

-- ───────────────────────── 2. which receipt file is in Drive ─────────────────────────
alter table claim_files add column if not exists drive_file_id  text;
alter table claim_files add column if not exists drive_saved_at timestamptz;

-- ───────────────────────── 3. functions ─────────────────────────
-- treasurer / admin: is Drive connected, and where do receipts go (the folders are kept after a disconnect,
-- so connecting the same account again uses the same folders)
drop function if exists drive_status();
create or replace function drive_status()
returns table (email text, connected boolean, connected_at timestamptz, root_folder_id text, receipts_folder_id text)
language sql stable security definer set search_path = public as $$
  select d.email, d.token_enc is not null, d.connected_at, d.root_folder_id, d.receipts_folder_id
    from drive_connection d where can_use_payments();
$$;

-- treasurer / admin (the app's server, while saving): the encrypted key and the folders
create or replace function drive_token()
returns table (email text, token_enc text, root_folder_id text, receipts_folder_id text)
language sql stable security definer set search_path = public as $$
  select d.email, d.token_enc, d.root_folder_id, d.receipts_folder_id
    from drive_connection d where can_use_payments() and d.token_enc is not null;
$$;

-- admin: connect (or reconnect) — replaces the one row
create or replace function drive_connect(p_email text, p_token_enc text, p_root text, p_receipts text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admin only'; end if;
  if coalesce(trim(p_token_enc), '') = '' then raise exception 'No key from Google — try Connect again'; end if;
  insert into drive_connection (id, email, token_enc, root_folder_id, receipts_folder_id, connected_by, connected_at)
  values (1, lower(trim(p_email)), p_token_enc, p_root, p_receipts, current_member_id(), now())
  on conflict (id) do update
    set email = excluded.email, token_enc = excluded.token_enc, root_folder_id = excluded.root_folder_id,
        receipts_folder_id = excluded.receipts_folder_id, connected_by = excluded.connected_by, connected_at = now();
end $$;

-- treasurer / admin: the folders were made again (deleted in Drive)
create or replace function drive_set_folders(p_root text, p_receipts text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update drive_connection set root_folder_id = p_root, receipts_folder_id = p_receipts where id = 1;
end $$;

-- admin: disconnect — the key is dropped; the files in Drive and the folder ids stay
create or replace function drive_disconnect() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admin only'; end if;
  update drive_connection set token_enc = null where id = 1;
end $$;

-- treasurer / admin: this receipt file is now in Drive (or, with null, no longer)
create or replace function claim_file_in_drive(p_file_id uuid, p_drive_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update claim_files
     set drive_file_id = nullif(trim(coalesce(p_drive_id, '')), ''),
         drive_saved_at = case when nullif(trim(coalesce(p_drive_id, '')), '') is null then null else now() end
   where id = p_file_id;
  if not found then raise exception 'No such receipt file'; end if;
end $$;
