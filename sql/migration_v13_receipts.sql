-- Migration v13 — Receipts: members buy for the association, email the receipt, get paid back
-- Run once in Supabase SQL Editor (after v12). Safe to run again.
--
--   * A member pays for something for the association and emails the receipt to receipt@minhwa.org
--     (an alias of manager@minhwa.org). Microsoft 365 passes a copy to the app (Resend inbound →
--     POST /api/inbound/receipt). The app stores the files in the private bucket "receipts", creates an
--     expense claim (code R0001…), links the member by the sending address, reads the receipt with Claude
--     (shop, date, total, VAT), suggests a ledger category and sends ONE automatic reply: "received".
--   * The Treasurer approves (or declines) in Payments → Receipts, pays from Nordea by bank transfer to the
--     account the member registered in the app, and the outgoing bank line is matched to the claim
--     (amount + name + date, or the claim code written in the transfer message) → paid.
--   * ledger_categories: the 2024 categories as seed — the start of the ledger (step 3).
--   * member_bank_accounts: clearing + account, seen only by the member and the Treasurer/Admin.

do $$
begin
  if to_regclass('public.bank_transactions') is null then raise exception 'Run migration_v8_payments.sql first'; end if;
  if to_regclass('public.products') is null then raise exception 'Run migration_v9_store.sql first'; end if;
  if to_regclass('public.requests') is null then raise exception 'Run migration_v11_group_orders.sql first'; end if;
end $$;

-- ───────────────────────── 1. ledger categories (2024 seed) ─────────────────────────
create table if not exists ledger_categories (
  code    text primary key,                       -- key used by the app
  name    text not null,
  bas     text not null,                          -- BAS account number
  kind    text not null check (kind in ('income', 'expense', 'balance')),
  sort    int  not null default 100,
  active  boolean not null default true
);

insert into ledger_categories (code, name, bas, kind, sort) values
  ('membership',    'Membership fee',                         '3985', 'income',  10),
  ('course',        'Course fee (one-day class)',             '3400', 'income',  20),
  ('seat',          'Seat fee (weekly painting)',             '3400', 'income',  30),
  ('material_sale', 'Material sold to members',               '3980', 'income',  40),
  ('grant',         'Grant (NBV and others)',                 '3980', 'income',  50),
  ('loan',          'Loan from a board member / repayment',   '2893', 'balance', 60),
  ('material',      'Material bought (brushes, paper, colours)', '5460', 'expense', 70),
  ('venue',         'Venue and room hire',                    '5010', 'expense', 80),
  ('fika',          'Fika and food for activities',           '6071', 'expense', 90),
  ('fee',           'Bank and Swish fees',                    '6570', 'expense', 100),
  ('other',         'Other expenses',                         '6990', 'expense', 110)
on conflict (code) do nothing;

-- ───────────────────────── 2. members: bank account, other sending addresses ─────────────────────────
create table if not exists member_bank_accounts (
  member_id   uuid primary key references members(id) on delete cascade,
  clearing    text not null check (clearing ~ '^[0-9]{4,5}$'),
  account     text not null check (account ~ '^[0-9]{1,12}$'),
  bank        text,                               -- optional, what the member calls it ("Swedbank")
  holder      text,                               -- name on the account when it is not the member's own
  updated_at  timestamptz not null default now()
);

-- other addresses this member sends receipts from (lower-case), learned when the treasurer links a claim
alter table members add column if not exists extra_emails text[] not null default '{}';

-- ───────────────────────── 3. claims and their files ─────────────────────────
create sequence if not exists claim_code_seq start 1;

create table if not exists expense_claims (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique default ('R' || lpad(nextval('claim_code_seq')::text, 4, '0')),
  status              text not null default 'new' check (status in ('new', 'approved', 'paid', 'declined')),
  source              text not null default 'email' check (source in ('email', 'app')),
  member_id           uuid references members(id) on delete set null,
  -- the email as it came in
  sender_email        text,
  sender_name         text,
  subject             text,
  body_text           text,
  message_id          text,                       -- Message-ID header — the same mail twice is one claim
  received_at         timestamptz not null default now(),
  acked_at            timestamptz,                -- when the "received" reply went out
  -- what the receipt says (read by the app, corrected by the treasurer)
  merchant            text,
  purchased_on        date,
  receipt_total       numeric(12,2),
  receipt_currency    text,
  amount_sek          numeric(12,2),              -- what the member asks back
  vat_sek             numeric(12,2),
  purpose             text,
  category_code       text references ledger_categories(code),
  ai_json             jsonb,
  ai_note             text,                       -- "card slip, not a receipt", "could not read", …
  read_at             timestamptz,
  duplicate_of        uuid references expense_claims(id),
  -- the decision
  approved_amount_sek numeric(12,2),
  reviewed_by         uuid references members(id),
  reviewed_at         timestamptz,
  reply               text,                       -- shown to the member (reason when declined)
  note                text,                       -- treasurer's own note
  -- the money
  paid_at             date,
  bank_tx_id          uuid references bank_transactions(id) on delete set null,
  suggested_tx_id     uuid references bank_transactions(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists expense_claims_message_id on expense_claims (message_id) where message_id is not null;
create index if not exists expense_claims_member on expense_claims (member_id, received_at desc);

create table if not exists claim_files (
  id            uuid primary key default gen_random_uuid(),
  claim_id      uuid not null references expense_claims(id) on delete cascade,
  path          text not null,                    -- in bucket "receipts": <claim id>/<n>-<file name>
  filename      text,
  content_type  text,
  bytes         int,
  sha256        text,
  sort          int not null default 1
);
create index if not exists claim_files_claim on claim_files (claim_id, sort);
create index if not exists claim_files_sha on claim_files (sha256);

alter table bank_transactions add column if not exists claim_id uuid references expense_claims(id) on delete set null;

drop trigger if exists expense_claims_touch on expense_claims;
create trigger expense_claims_touch before update on expense_claims for each row execute function touch_updated_at();

-- ───────────────────────── 4. the private bucket ─────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 15728640,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf', 'text/html', 'text/plain'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- a member sees the files of their own claims; the treasurer sees all; only the treasurer (and the app's
-- service key, which is not bound by these policies) writes
drop policy if exists "receipts: own or treasurer can view" on storage.objects;
create policy "receipts: own or treasurer can view" on storage.objects
  for select to authenticated using (
    bucket_id = 'receipts' and (
      public.can_use_payments()
      or exists (select 1 from public.expense_claims c
                  where c.member_id = public.current_member_id() and storage.objects.name like c.id::text || '/%')));

-- a member may add files to a claim of their own that is still being checked (the app's upload); the treasurer to any
drop policy if exists "receipts: treasurer uploads" on storage.objects;
drop policy if exists "receipts: own claim or treasurer uploads" on storage.objects;
create policy "receipts: own claim or treasurer uploads" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'receipts' and (
      public.can_use_payments()
      or exists (select 1 from public.expense_claims c
                  where c.member_id = public.current_member_id() and c.status = 'new' and storage.objects.name like c.id::text || '/%')));

drop policy if exists "receipts: treasurer removes" on storage.objects;
create policy "receipts: treasurer removes" on storage.objects
  for delete to authenticated using (bucket_id = 'receipts' and public.can_use_payments());

-- ───────────────────────── 5. helpers ─────────────────────────
-- the app's inbound route calls with the service key (PostgREST puts role "service_role" in the request claims);
-- a logged-out visitor with the public key has no user AND no such role, so the guard tells them apart.
-- (app.role is the stand-in the local tests set.)
create or replace function is_service_role() returns boolean
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role',
                  current_setting('app.role', true), '') = 'service_role';
$$;

create or replace function is_service_or_treasurer() returns boolean
language sql stable security definer set search_path = public as $$
  select is_service_role() or can_use_payments();
$$;

-- "  Jisu.Park@Gmail.com " → "jisu.park@gmail.com"
create or replace function clean_email(t text) returns text
language sql immutable as $$
  select nullif(lower(trim(coalesce(t, ''))), '');
$$;

-- the member a sending address belongs to (their email, or one learned earlier)
create or replace function member_by_email(p_email text) returns uuid
language sql stable security definer set search_path = public as $$
  select m.id from members m
   where clean_email(p_email) is not null
     and (clean_email(m.email) = clean_email(p_email) or clean_email(p_email) = any(m.extra_emails))
   order by (clean_email(m.email) = clean_email(p_email)) desc, m.created_at
   limit 1;
$$;

-- ───────────────────────── 6. taking a claim in ─────────────────────────
-- p: {message_id, sender_email, sender_name, subject, body_text, received_at, source,
--     files: [{path, filename, content_type, bytes, sha256}, …]}
-- Called by the inbound route with the service key (source 'email'), or by a member from the app (source 'app').
-- Returns {claim_id, code, created, member_id, member_name, duplicate_of}
create or replace function import_claim(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_source text := coalesce(p->>'source', 'email');
  v_member uuid;
  v_id uuid;
  v_code text;
  v_dup uuid;
  v_existing record;
begin
  if v_source = 'app' then
    v_member := current_member_id();
    if v_member is null then raise exception 'Log in first'; end if;
  else
    if not is_service_or_treasurer() then raise exception 'Treasurer or Admin only'; end if;
    v_member := member_by_email(p->>'sender_email');
  end if;

  -- the same email twice (a retry of the webhook) is one claim
  if nullif(p->>'message_id', '') is not null then
    select id, code, member_id into v_existing from expense_claims where message_id = p->>'message_id';
    if found then
      return jsonb_build_object('claim_id', v_existing.id, 'code', v_existing.code, 'created', false, 'member_id', v_existing.member_id);
    end if;
  end if;

  insert into expense_claims (id, source, member_id, sender_email, sender_name, subject, body_text, message_id, received_at)
  values (coalesce(nullif(p->>'id', '')::uuid, gen_random_uuid()), v_source, v_member, clean_email(p->>'sender_email'), nullif(trim(coalesce(p->>'sender_name', '')), ''),
          nullif(trim(coalesce(p->>'subject', '')), ''), nullif(trim(coalesce(p->>'body_text', '')), ''),
          nullif(p->>'message_id', ''), coalesce((p->>'received_at')::timestamptz, now()))
  returning id, code into v_id, v_code;

  insert into claim_files (claim_id, path, filename, content_type, bytes, sha256, sort)
  select v_id, f.path, f.filename, f.content_type, f.bytes, f.sha256, coalesce(f.sort, row_number() over ())
    from jsonb_to_recordset(coalesce(p->'files', '[]'::jsonb)) as f(path text, filename text, content_type text, bytes int, sha256 text, sort int)
   where f.path is not null;

  -- the same file was sent before → flag it (the treasurer decides)
  select f2.claim_id into v_dup
    from claim_files f1 join claim_files f2 on f2.sha256 = f1.sha256 and f2.claim_id <> f1.claim_id
   where f1.claim_id = v_id and f1.sha256 is not null
   order by f2.claim_id limit 1;
  if v_dup is not null then update expense_claims set duplicate_of = v_dup where id = v_id; end if;

  return jsonb_build_object('claim_id', v_id, 'code', v_code, 'created', true, 'member_id', v_member,
                            'member_name', (select name from members where id = v_member), 'duplicate_of', v_dup);
end $$;

-- files added after the claim was made (the app's upload: the claim is created first, the pictures follow)
create or replace function add_claim_files(p_claim_id uuid, p_files jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  c expense_claims%rowtype;
  v_next int;
  v_n int;
  v_dup uuid;
begin
  select * into c from expense_claims where id = p_claim_id for update;
  if not found then raise exception 'No such claim'; end if;
  if not (is_service_or_treasurer() or (c.member_id = current_member_id() and c.status = 'new')) then
    raise exception 'Not your claim';
  end if;
  select coalesce(max(sort), 0) into v_next from claim_files where claim_id = p_claim_id;
  insert into claim_files (claim_id, path, filename, content_type, bytes, sha256, sort)
  select p_claim_id, f.path, f.filename, f.content_type, f.bytes, f.sha256, v_next + row_number() over ()
    from jsonb_to_recordset(coalesce(p_files, '[]'::jsonb)) as f(path text, filename text, content_type text, bytes int, sha256 text)
   where f.path is not null and f.path like p_claim_id::text || '/%'
     and not exists (select 1 from claim_files x where x.claim_id = p_claim_id and x.path = f.path);
  get diagnostics v_n = row_count;
  if c.duplicate_of is null then
    select f2.claim_id into v_dup
      from claim_files f1 join claim_files f2 on f2.sha256 = f1.sha256 and f2.claim_id <> f1.claim_id
     where f1.claim_id = p_claim_id and f1.sha256 is not null
     order by f2.claim_id limit 1;
    if v_dup is not null then update expense_claims set duplicate_of = v_dup where id = p_claim_id; end if;
  end if;
  return v_n;
end $$;

-- what the app read from the receipt: {merchant, purchased_on, receipt_total, receipt_currency, amount_sek, vat_sek,
--   purpose, category_code, ai_json, ai_note, force}. Fills what is still empty; with force (the treasurer's
--   "Read again") the new reading wins where it has a value.
create or replace function set_claim_reading(p_claim_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  c expense_claims%rowtype;
  v_dup uuid;
  f boolean := coalesce((p->>'force')::boolean, false);
  n_merchant text := nullif(trim(coalesce(p->>'merchant', '')), '');
  n_date date := (nullif(p->>'purchased_on', ''))::date;
  n_total numeric := (nullif(p->>'receipt_total', ''))::numeric;
  n_cur text := nullif(upper(trim(coalesce(p->>'receipt_currency', ''))), '');
  n_amount numeric := (nullif(p->>'amount_sek', ''))::numeric;
  n_vat numeric := (nullif(p->>'vat_sek', ''))::numeric;
  n_purpose text := nullif(trim(coalesce(p->>'purpose', '')), '');
  n_cat text := (select code from ledger_categories where code = p->>'category_code');
begin
  if not is_service_or_treasurer() then raise exception 'Treasurer or Admin only'; end if;
  select * into c from expense_claims where id = p_claim_id for update;
  if not found then raise exception 'No such claim'; end if;
  if c.status in ('paid', 'declined') and not f then return; end if;
  update expense_claims set
    merchant         = case when f then coalesce(n_merchant, c.merchant) else coalesce(c.merchant, n_merchant) end,
    purchased_on     = case when f then coalesce(n_date, c.purchased_on) else coalesce(c.purchased_on, n_date) end,
    receipt_total    = case when f then coalesce(n_total, c.receipt_total) else coalesce(c.receipt_total, n_total) end,
    receipt_currency = case when f then coalesce(n_cur, c.receipt_currency) else coalesce(c.receipt_currency, n_cur) end,
    amount_sek       = case when f then coalesce(n_amount, c.amount_sek) else coalesce(c.amount_sek, n_amount) end,
    vat_sek          = case when f then coalesce(n_vat, c.vat_sek) else coalesce(c.vat_sek, n_vat) end,
    purpose          = case when f then coalesce(n_purpose, c.purpose) else coalesce(c.purpose, n_purpose) end,
    category_code    = case when f then coalesce(n_cat, c.category_code) else coalesce(c.category_code, n_cat) end,
    ai_json          = coalesce(p->'ai_json', c.ai_json),
    ai_note          = case when p ? 'ai_note' then nullif(trim(coalesce(p->>'ai_note', '')), '') else c.ai_note end,
    read_at          = now()
  where id = p_claim_id;

  -- same shop, same day, same amount as another claim → flag it too
  select * into c from expense_claims where id = p_claim_id;
  if c.duplicate_of is null and c.merchant is not null and c.purchased_on is not null and c.receipt_total is not null then
    select o.id into v_dup from expense_claims o
     where o.id <> c.id and o.status <> 'declined'
       and lower(o.merchant) = lower(c.merchant) and o.purchased_on = c.purchased_on and o.receipt_total = c.receipt_total
     order by o.received_at limit 1;
    if v_dup is not null then update expense_claims set duplicate_of = v_dup where id = c.id; end if;
  end if;
end $$;

-- the "received" reply went out
create or replace function mark_claim_acked(p_claim_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_service_or_treasurer() then raise exception 'Treasurer or Admin only'; end if;
  update expense_claims set acked_at = now() where id = p_claim_id;
end $$;

-- ───────────────────────── 7. the treasurer's desk ─────────────────────────
-- "Who is this?" — tie a claim to a member; remember the address for next time
create or replace function link_claim_member(p_claim_id uuid, p_member_id uuid, p_remember boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_email text;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  if not exists (select 1 from members where id = p_member_id) then raise exception 'No such member'; end if;
  update expense_claims set member_id = p_member_id where id = p_claim_id returning sender_email into v_email;
  if not found then raise exception 'No such claim'; end if;
  if p_remember and v_email is not null then
    update members set extra_emails = array_append(extra_emails, v_email)
     where id = p_member_id and clean_email(email) is distinct from v_email and not (v_email = any(extra_emails));
  end if;
end $$;

-- save what the treasurer typed (no decision yet)
create or replace function review_claim(p_claim_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update expense_claims set
    merchant         = case when p ? 'merchant'         then nullif(trim(coalesce(p->>'merchant', '')), '') else merchant end,
    purchased_on     = case when p ? 'purchased_on'     then (nullif(p->>'purchased_on', ''))::date else purchased_on end,
    receipt_total    = case when p ? 'receipt_total'    then (nullif(p->>'receipt_total', ''))::numeric else receipt_total end,
    receipt_currency = case when p ? 'receipt_currency' then nullif(upper(trim(coalesce(p->>'receipt_currency', ''))), '') else receipt_currency end,
    amount_sek       = case when p ? 'amount_sek'       then (nullif(p->>'amount_sek', ''))::numeric else amount_sek end,
    vat_sek          = case when p ? 'vat_sek'          then (nullif(p->>'vat_sek', ''))::numeric else vat_sek end,
    purpose          = case when p ? 'purpose'          then nullif(trim(coalesce(p->>'purpose', '')), '') else purpose end,
    category_code    = case when p ? 'category_code'    then (select code from ledger_categories where code = p->>'category_code') else category_code end,
    note             = case when p ? 'note'             then nullif(trim(coalesce(p->>'note', '')), '') else note end,
    duplicate_of     = case when (p->>'not_duplicate')::boolean then null else duplicate_of end
  where id = p_claim_id and status in ('new', 'approved');
  if not found then raise exception 'This claim is already paid or declined'; end if;
end $$;

-- Approve: the amount to pay back is fixed here. Looks for the transfer in the bank lines already imported.
create or replace function approve_claim(p_claim_id uuid, p_amount_sek numeric, p_category_code text default null, p_reply text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  c expense_claims%rowtype;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select * into c from expense_claims where id = p_claim_id for update;
  if not found then raise exception 'No such claim'; end if;
  if c.status not in ('new', 'declined') then raise exception 'This claim is already %', c.status; end if;
  if c.member_id is null then raise exception 'Say who the member is first'; end if;
  if p_amount_sek is null or p_amount_sek <= 0 then raise exception 'Type the amount to pay back'; end if;
  update expense_claims set
    status = 'approved', approved_amount_sek = round(p_amount_sek, 2),
    amount_sek = coalesce(amount_sek, round(p_amount_sek, 2)),
    category_code = coalesce((select code from ledger_categories where code = p_category_code), category_code, 'material'),
    reply = coalesce(nullif(trim(coalesce(p_reply, '')), ''), case when status = 'declined' then null else reply end),
    reviewed_by = current_member_id(), reviewed_at = now()
  where id = p_claim_id;
  perform claims_match_outgoing();
end $$;

create or replace function decline_claim(p_claim_id uuid, p_reply text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update expense_claims set status = 'declined', reply = nullif(trim(coalesce(p_reply, '')), ''),
         reviewed_by = current_member_id(), reviewed_at = now(), suggested_tx_id = null
   where id = p_claim_id and status in ('new', 'approved');
  if not found then raise exception 'This claim is paid or already declined'; end if;
end $$;

-- back to the review list (from approved-not-paid or declined)
create or replace function reopen_claim(p_claim_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update expense_claims set status = 'new', suggested_tx_id = null, reviewed_by = null, reviewed_at = null
   where id = p_claim_id and status in ('approved', 'declined');
  if not found then raise exception 'Only an approved (unpaid) or declined claim can be reopened'; end if;
end $$;

-- Paid: with the bank line (the transfer as Nordea shows it) or by hand with a date.
create or replace function mark_claim_paid(p_claim_id uuid, p_tx_id uuid default null, p_paid_on date default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  c expense_claims%rowtype;
  t bank_transactions%rowtype;
  v_name text;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select * into c from expense_claims where id = p_claim_id for update;
  if not found then raise exception 'No such claim'; end if;
  if c.status <> 'approved' then raise exception 'Approve the claim first'; end if;
  if p_tx_id is not null then
    select * into t from bank_transactions where id = p_tx_id for update;
    if not found then raise exception 'No such bank line'; end if;
    if t.amount_sek >= 0 then raise exception 'That line is money coming in'; end if;
    if t.claim_id is not null and t.claim_id <> c.id then raise exception 'That bank line already belongs to another claim'; end if;
    if t.payment_id is not null then raise exception 'That bank line belongs to a payment'; end if;
    if abs(t.amount_sek) <> c.approved_amount_sek then
      raise exception 'The bank line is % kr but the claim is % kr', abs(t.amount_sek), c.approved_amount_sek;
    end if;
    update bank_transactions set claim_id = c.id where id = t.id;
    update expense_claims set status = 'paid', paid_at = t.booked_on, bank_tx_id = t.id, suggested_tx_id = null where id = c.id;
    -- remember how the bank writes this member's name
    select name into v_name from members where id = c.member_id;
    if t.counterparty is not null and not names_match(t.counterparty, v_name) then
      update members set bank_names = array_append(bank_names, name_key(t.counterparty))
       where id = c.member_id and name_key(t.counterparty) <> '' and not (name_key(t.counterparty) = any(bank_names));
    end if;
  else
    update expense_claims set status = 'paid', paid_at = coalesce(p_paid_on, current_date), suggested_tx_id = null where id = c.id;
  end if;
end $$;

-- take "paid" back (wrong line, or not sent after all)
create or replace function unpay_claim(p_claim_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c expense_claims%rowtype;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select * into c from expense_claims where id = p_claim_id for update;
  if not found or c.status <> 'paid' then raise exception 'This claim is not marked as paid'; end if;
  update bank_transactions set claim_id = null where id = c.bank_tx_id;
  update expense_claims set status = 'approved', paid_at = null, bank_tx_id = null where id = c.id;
end $$;

-- ───────────────────────── 8. finding the transfer in the bank ─────────────────────────
-- For every approved claim without a suggestion: an outgoing line with the same amount, on or after the day it was
-- approved (minus one, the transfer may have been sent first), that names the member — or carries the claim code
-- in its message (write "R0012" in the transfer message and it is found straight away).
create or replace function claims_match_outgoing() returns int
language plpgsql security definer set search_path = public as $$
declare
  c record;
  v_tx uuid;
  n int := 0;
begin
  for c in select x.*, m.name as member_name, m.bank_names
             from expense_claims x join members m on m.id = x.member_id
            where x.status = 'approved' and x.suggested_tx_id is null loop
    select t.id into v_tx
      from bank_transactions t
     where t.amount_sek < 0 and t.claim_id is null and t.payment_id is null and t.status = 'outgoing'
       and abs(t.amount_sek) = c.approved_amount_sek
       and t.booked_on >= (c.reviewed_at at time zone 'Europe/Stockholm')::date - 1
       and not exists (select 1 from expense_claims o where o.suggested_tx_id = t.id)
       and (upper(coalesce(t.message, '') || ' ' || coalesce(t.title, '')) ~ ('\m' || c.code || '\M')
            or names_match(t.counterparty, c.member_name)
            or name_key(t.counterparty) = any(c.bank_names)
            or (length(coalesce(t.counterparty, '')) >= 19 and name_prefix_match(t.counterparty, c.member_name)))
     order by (upper(coalesce(t.message, '')) ~ ('\m' || c.code || '\M')) desc, t.booked_on
     limit 1;
    if v_tx is not null then
      update expense_claims set suggested_tx_id = v_tx where id = c.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- only the functions above (and the trigger below) call this one
do $$
declare r text;
begin
  revoke execute on function claims_match_outgoing() from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function claims_match_outgoing() from %I', r);
    end if;
  end loop;
end $$;

-- the same, callable from the app (after a statement import, or with the "Look in the bank" button)
create or replace function match_claims_to_bank() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  return jsonb_build_object('suggested', claims_match_outgoing());
end $$;

-- every statement import also looks for approved claims
create or replace function bank_tx_after_import() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform claims_match_outgoing();
  return null;
end $$;
drop trigger if exists bank_tx_after_import on bank_transactions;
create trigger bank_tx_after_import after insert on bank_transactions
  for each statement execute function bank_tx_after_import();

-- "not this line"
create or replace function reject_claim_suggestion(p_claim_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update expense_claims set suggested_tx_id = null where id = p_claim_id;
end $$;

-- ───────────────────────── 9. the member's side ─────────────────────────
-- their bank account for reimbursements (clearing 4–5 digits, account digits only)
create or replace function save_bank_account(p_clearing text, p_account text, p_bank text default null, p_holder text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := current_member_id();
  v_clearing text := regexp_replace(coalesce(p_clearing, ''), '[^0-9]', '', 'g');
  v_account text := regexp_replace(coalesce(p_account, ''), '[^0-9]', '', 'g');
begin
  if v_me is null then raise exception 'Log in first'; end if;
  if v_clearing !~ '^[0-9]{4,5}$' then raise exception 'The clearing number is 4 digits (5 for Swedbank)'; end if;
  if v_account !~ '^[0-9]{1,12}$' then raise exception 'Type the account number, digits only'; end if;
  insert into member_bank_accounts (member_id, clearing, account, bank, holder, updated_at)
  values (v_me, v_clearing, v_account, nullif(trim(coalesce(p_bank, '')), ''), nullif(trim(coalesce(p_holder, '')), ''), now())
  on conflict (member_id) do update
    set clearing = excluded.clearing, account = excluded.account, bank = excluded.bank, holder = excluded.holder, updated_at = now();
end $$;

-- other addresses the member sends receipts from
create or replace function set_my_extra_emails(p_emails text[]) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := current_member_id();
begin
  if v_me is null then raise exception 'Log in first'; end if;
  update members set extra_emails = coalesce(
      (select array_agg(distinct e) from unnest(p_emails) e0, lateral (select clean_email(e0) e) x
        where e is not null and e ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'), '{}')
   where id = v_me;
end $$;

-- ───────────────────────── 10. a convenient read ─────────────────────────
create or replace view claims_view with (security_invoker = true) as
select c.id, c.code, c.status, c.source, c.member_id, c.sender_email, c.sender_name, c.subject, c.body_text, c.received_at,
       c.merchant, c.purchased_on, c.receipt_total, c.receipt_currency, c.amount_sek, c.vat_sek, c.purpose, c.category_code,
       c.acked_at, c.ai_json, c.ai_note, c.read_at, c.duplicate_of, c.approved_amount_sek, c.reviewed_at, c.reply, c.note,
       c.paid_at, c.bank_tx_id, c.suggested_tx_id, c.created_at, c.updated_at,
       m.name  as member_name,
       m.email as member_email,
       lc.name as category_name,
       lc.bas  as category_bas,
       d.code  as duplicate_code,
       (select count(*)::int from claim_files f where f.claim_id = c.id) as file_count,
       (select f.path from claim_files f where f.claim_id = c.id order by f.sort limit 1) as first_path,
       (select f.content_type from claim_files f where f.claim_id = c.id order by f.sort limit 1) as first_type,
       t.booked_on as bank_date, t.counterparty as bank_name, t.amount_sek as bank_amount, t.message as bank_message,
       s.booked_on as suggested_date, s.counterparty as suggested_name, s.amount_sek as suggested_amount, s.message as suggested_message,
       ba.clearing, ba.account, ba.bank as account_bank, ba.holder as account_holder
  from expense_claims c
  left join members m on m.id = c.member_id
  left join ledger_categories lc on lc.code = c.category_code
  left join expense_claims d on d.id = c.duplicate_of
  left join bank_transactions t on t.id = c.bank_tx_id
  left join bank_transactions s on s.id = c.suggested_tx_id
  left join member_bank_accounts ba on ba.member_id = c.member_id;

-- ───────────────────────── 11. RLS ─────────────────────────
alter table ledger_categories enable row level security;
drop policy if exists ledger_categories_read on ledger_categories;
create policy ledger_categories_read on ledger_categories for select using (auth.uid() is not null);
drop policy if exists ledger_categories_treasurer on ledger_categories;
create policy ledger_categories_treasurer on ledger_categories for all using (can_use_payments()) with check (can_use_payments());

alter table member_bank_accounts enable row level security;
drop policy if exists bank_accounts_own on member_bank_accounts;
create policy bank_accounts_own on member_bank_accounts for all
  using (member_id = current_member_id() or can_use_payments()) with check (member_id = current_member_id() or can_use_payments());

alter table expense_claims enable row level security;
drop policy if exists claims_read on expense_claims;
create policy claims_read on expense_claims for select using (member_id = current_member_id() or can_use_payments());
drop policy if exists claims_treasurer on expense_claims;
create policy claims_treasurer on expense_claims for all using (can_use_payments()) with check (can_use_payments());

alter table claim_files enable row level security;
drop policy if exists claim_files_read on claim_files;
create policy claim_files_read on claim_files for select
  using (can_use_payments() or exists (select 1 from expense_claims c where c.id = claim_id and c.member_id = current_member_id()));
drop policy if exists claim_files_treasurer on claim_files;
create policy claim_files_treasurer on claim_files for all using (can_use_payments()) with check (can_use_payments());

grant select on claims_view to authenticated;
grant select, insert, update, delete on ledger_categories, member_bank_accounts, expense_claims, claim_files to authenticated;
grant usage, select on sequence claim_code_seq to authenticated;
