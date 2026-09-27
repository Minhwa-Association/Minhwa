-- Migration v8 — payments + bank statement (Nordea) reconciliation + Treasurer role
-- Run once in Supabase SQL Editor (after v7). Safe to run again.
--
-- What changes
--   * The old "charges" table becomes "payments" — one table for every amount a member owes
--     (kind: seat now, material / membership later). The unused v1 "payments" table is dropped.
--   * Every payment gets a short code (S0001 = seat, O… = order, M… = membership) that goes
--     first in the Swish message: "S0231 05/10 Mon Day Rock".
--   * Status: pending (not paid) → claimed (member tapped "I have paid") → confirmed (treasurer)
--             → refunded; cancelled = booking cancelled before it was paid.
--   * bank_transactions: lines pasted from the Nordea statement (CSV export or copied rows).
--     A fingerprint of date + amount + text + name + message (+ position among identical lines) stops
--     the same line being added twice. Nordea's export has no reference number and no Swish message —
--     an incoming Swish shows only the payer's name — and the balance is written on one line per day.
--   * Matching: ① a payment code in the line = matched, ② same amount + payer name ≈ member
--     name (or a saved bank name) + date within the window = suggested, ③ otherwise the line
--     waits for the treasurer (attach to a payment / ignore).
--   * New role "treasurer" (kassör): sees the Payments tab. Admin can do the same.

-- ───────────────────────── 1. charges → payments ─────────────────────────
-- First run: "charges" still exists → the empty v1 "payments" table goes, "charges" takes its name.
-- Later runs: "charges" is gone and "payments" holds the real rows → nothing happens here.
do $$
begin
  if to_regclass('public.charges') is not null then
    if to_regclass('public.payments') is not null then
      if exists (select 1 from payments limit 1) then
        raise exception 'The old v1 payments table is not empty — stop and check before running v8';
      end if;
      drop table payments cascade;
    end if;
    alter table charges rename to payments;
  end if;
end $$;
drop type if exists payment_method;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'charges_pkey') then
    alter table payments rename constraint charges_pkey to payments_pkey;
  end if;
  if exists (select 1 from pg_constraint where conname = 'charges_member_id_fkey') then
    alter table payments rename constraint charges_member_id_fkey to payments_member_id_fkey;
  end if;
end $$;

-- the read view (section 7) depends on these columns — drop it first, it is recreated below
drop view if exists payments_view;

-- kind: enum → text (seat / material / membership); status: enum → text with the new names.
-- Only while the columns are still the v1 enums — on a re-run they are already text and are left alone
-- (the old and new names overlap: old "pending" = new "claimed").
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'payments' and column_name = 'kind' and udt_name = 'charge_kind') then
    alter table payments alter column kind type text using (case kind::text when 'order' then 'material' else kind::text end);
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'payments' and column_name = 'status' and udt_name = 'charge_status') then
    alter table payments alter column status drop default;
    alter table payments alter column status type text using (
      case status::text when 'unpaid' then 'pending' when 'pending' then 'claimed'
                        when 'paid' then 'confirmed' when 'waived' then 'cancelled' else status::text end);
  end if;
end $$;
alter table payments drop constraint if exists payments_kind_check;
alter table payments add constraint payments_kind_check check (kind in ('seat','material','membership'));
drop type if exists charge_kind;
alter table payments alter column status set default 'pending';
alter table payments drop constraint if exists payments_status_check;
alter table payments add constraint payments_status_check
  check (status in ('pending','claimed','confirmed','refunded','cancelled'));
drop type if exists charge_status;

-- new columns
alter table payments add column if not exists code         text unique;
alter table payments add column if not exists claimed_at   timestamptz;
alter table payments add column if not exists confirmed_at timestamptz;
alter table payments add column if not exists refunded_at  timestamptz;

-- bookings.charge_id → payment_id
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'bookings' and column_name = 'charge_id') then
    alter table bookings rename column charge_id to payment_id;
    alter table bookings rename constraint bookings_charge_id_fkey to bookings_payment_id_fkey;
  end if;
end $$;

-- payment codes: one running number, letter = kind
create sequence if not exists payment_code_seq start 1;

create or replace function next_payment_code(p_kind text) returns text
language sql volatile set search_path = public as $$
  select case p_kind when 'seat' then 'S' when 'material' then 'O' when 'membership' then 'M' else 'P' end
         || lpad(nextval('payment_code_seq')::text, 4, '0');
$$;

-- backfill: existing rows get a code (oldest first); unpaid ones get it in the Swish message too
do $$
declare r record;
begin
  for r in select id, kind, note, status from payments where code is null order by created_at, id loop
    update payments set code = next_payment_code(r.kind) where id = r.id;
  end loop;
  update payments set note = code || ' ' || replace(note, ' - ', ' ')
    where status = 'pending' and note is not null and note not like code || ' %';
end $$;

-- ───────────────────────── 2. roles: treasurer ─────────────────────────
alter table members drop constraint if exists members_roles_check;
alter table members add constraint members_roles_check
  check (roles <@ array['teacher','crew','admin','treasurer']);

-- names this member's Swish payments show up under in the bank (learned when the treasurer
-- attaches a bank line by hand) — stored as lower-case sorted words, e.g. 'jisu park'
alter table members add column if not exists bank_names text[] not null default '{}';

create or replace function can_use_payments() returns boolean
language sql stable security definer set search_path = public as $$
  select my_roles() && array['treasurer','admin'];
$$;

-- a member may still change only their own name; the treasurer may also change bank_names
create or replace function guard_member_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or is_admin() then return new; end if;
  if new.roles   is distinct from old.roles
  or new.role    is distinct from old.role
  or new.phone   is distinct from old.phone
  or new.active  is distinct from old.active
  or new.email   is distinct from old.email
  or new.auth_id is distinct from old.auth_id
  or new.id      is distinct from old.id then
    raise exception 'Only an admin can change this';
  end if;
  if new.bank_names is distinct from old.bank_names and not can_use_payments() then
    raise exception 'Only the treasurer can change this';
  end if;
  return new;
end $$;

-- ───────────────────────── 3. bank_transactions ─────────────────────────
create table if not exists bank_transactions (
  id            uuid primary key default gen_random_uuid(),
  booked_on     date not null,                 -- Bokföringsdag
  amount_sek    numeric(12,2) not null,        -- Belopp (+ in, − out)
  title         text not null,                 -- "Swish inbetalning Jisu Park" (personal) · "Inbetalning Swish Företag" · "Nordea · Woo Bock Lee"
  counterparty  text,                          -- the other party's name, e.g. "Jisu Park" · "LEE, KAEUN" (bank spelling, cut at 20 chars)
  message       text,                          -- Meddelande as the bank gives it (for Swish it is the payer's name again, not the Swish message)
  own_notes     text,                          -- Egna anteckningar — notes written in the internet bank
  balance_sek   numeric(12,2),                 -- Saldo — Nordea writes it on one line per day only
  fingerprint   text not null unique,          -- md5(date | amount | title | name | message | seq): the same line is never added twice
  raw           text,                          -- the pasted line as it was
  status        text not null default 'unmatched'
                check (status in ('unmatched','suggested','matched','confirmed','ignored','outgoing')),
  payment_id    uuid references payments(id) on delete set null,   -- suggested / matched / confirmed payment
  imported_by   uuid references members(id) on delete set null,
  imported_at   timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid references members(id) on delete set null
);
alter table bank_transactions add column if not exists own_notes text;   -- for databases that got the table before this column
create index if not exists bank_transactions_status_idx on bank_transactions (status, booked_on);
-- one bank line per payment
create unique index if not exists bank_transactions_payment_unique on bank_transactions (payment_id) where payment_id is not null;

-- money going out is kept for the ledger (next step) but stays out of the matching lists
create or replace function bank_tx_before_insert() returns trigger
language plpgsql as $$
begin
  if new.amount_sek <= 0 then new.status := 'outgoing'; end if;
  return new;
end $$;
drop trigger if exists bank_tx_before_insert on bank_transactions;
create trigger bank_tx_before_insert before insert on bank_transactions
  for each row execute function bank_tx_before_insert();

-- ───────────────────────── 4. name matching helpers ─────────────────────────
-- "Jisu PARK" → {jisu, park}   (letters only, lower-case, sorted, words of 2+ letters)
create or replace function name_tokens(t text) returns text[]
language sql immutable as $$
  select coalesce(
    array(select x from unnest(regexp_split_to_array(trim(regexp_replace(lower(coalesce(t, '')), '[^[:alpha:]]+', ' ', 'g')), '\s+')) x
          where length(x) >= 2 order by x),
    '{}'::text[]);
$$;

create or replace function name_key(t text) returns text
language sql immutable as $$
  select array_to_string(name_tokens(t), ' ');
$$;

-- same words, or one name (2+ words) contained in the other:
--   "Jisu Park" ~ "Park Jisu" ✓   "Jisu Park" ~ "Swish inbetalning Jisu Park" ✓   "Park" ~ "Jisu Park" ✗
create or replace function names_match(a text, b text) returns boolean
language sql immutable as $$
  select case
    when cardinality(ta) = 0 or cardinality(tb) = 0 then false
    when ta = tb then true
    when cardinality(ta) >= 2 and ta <@ tb then true
    when cardinality(tb) >= 2 and tb <@ ta then true
    else false end
  from (select name_tokens(a) ta, name_tokens(b) tb) x;
$$;

-- Nordea cuts Swish payer names at 20 characters ("FRANCESCA RADOCHINSK", "HALÉN FREDELL,FELICI"):
-- every word of the bank name must be a word of the member's name or the beginning of one (2+ words each)
create or replace function name_prefix_match(bank text, member text) returns boolean
language sql immutable as $$
  select cardinality(tb) >= 2 and cardinality(tm) >= 2
     and not exists (select 1 from unnest(tb) x
                      where not exists (select 1 from unnest(tm) y where y = x or (length(x) >= 3 and y like x || '%')))
  from (select name_tokens(bank) tb, name_tokens(member) tm) z;
$$;

-- ───────────────────────── 5. booking / paying (rewritten for payments) ─────────────────────────
drop function if exists mark_pending(uuid);
drop function if exists confirm_paid(uuid);

create or replace function book_seat(p_slot_id uuid, p_date date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me     uuid := current_member_id();
  v_slot   slots%rowtype;
  v_set    settings%rowtype;
  v_taken  int;
  v_pay    uuid;
  v_code   text;
  v_book   uuid;
  v_name   text;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  select * into v_slot from slots where id = p_slot_id;
  select * into v_set  from settings where id = 1;
  if v_slot.instructor_id = v_me then
    raise exception 'You are the teacher for this session';
  end if;
  if extract(isodow from p_date) <> v_slot.weekday then
    raise exception 'Date does not match slot weekday';
  end if;
  if p_date < current_date or p_date > current_date + v_set.booking_window_weeks * 7 then
    raise exception 'Outside booking window';
  end if;
  select count(*) into v_taken from bookings
    where slot_id = p_slot_id and date = p_date and status = 'booked';
  if v_taken >= v_slot.capacity + v_set.max_extra_seats then
    raise exception 'No more seats (including extra)';
  end if;
  select name into v_name from members where id = v_me;
  v_code := next_payment_code('seat');
  -- Swish message: "S0231 05/10 Mon Day Rock"
  insert into payments (member_id, kind, amount_sek, code, note)
  values (v_me, 'seat', v_set.seat_price_sek, v_code,
          v_code || ' ' || to_char(p_date, 'DD/MM') || ' ' || to_char(p_date, 'Dy') || ' ' ||
          initcap(v_slot.session::text) || ' ' || v_name)
  returning id into v_pay;
  insert into bookings (member_id, slot_id, date, payment_id)
  values (v_me, p_slot_id, p_date, v_pay)
  returning id into v_book;
  update payments set ref_id = v_book where id = v_pay;
  return v_book;
end $$;

create or replace function cancel_booking(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_b   bookings%rowtype;
  v_set settings%rowtype;
begin
  select * into v_b from bookings where id = p_booking_id;
  select * into v_set from settings where id = 1;
  if v_b.member_id <> current_member_id() and not is_admin() then
    raise exception 'Not your booking';
  end if;
  if not is_admin() and current_date > v_b.date - v_set.cancel_deadline_days then
    raise exception 'Too late to cancel for free';
  end if;
  update bookings set status = 'cancelled', cancelled_at = now() where id = p_booking_id;
  -- a paid seat stays "confirmed" (the money is in the account; a refund is a separate step)
  update payments set status = 'cancelled' where id = v_b.payment_id and status in ('pending','claimed');
end $$;

-- member: "I have paid"
create or replace function claim_payment(p_payment_id uuid) returns void
language sql security definer set search_path = public as $$
  update payments set status = 'claimed', claimed_at = now()
  where id = p_payment_id and member_id = current_member_id() and status = 'pending';
$$;

-- treasurer / admin: the money is in — optionally tied to the bank line that shows it
create or replace function confirm_payment(p_payment_id uuid, p_tx_id uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := current_member_id();
  v_p  payments%rowtype;
  v_t  bank_transactions%rowtype;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select * into v_p from payments where id = p_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_p.status not in ('pending','claimed','confirmed') then
    raise exception 'This payment is %', v_p.status;
  end if;
  if p_tx_id is not null then
    select * into v_t from bank_transactions where id = p_tx_id for update;
    if not found then raise exception 'Bank line not found'; end if;
    if v_t.status = 'outgoing' then raise exception 'That line is money going out'; end if;
    if v_t.status = 'confirmed' and v_t.payment_id is distinct from p_payment_id then
      raise exception 'That bank line is already used for another payment';
    end if;
    if exists (select 1 from bank_transactions x where x.payment_id = p_payment_id and x.id <> p_tx_id) then
      raise exception 'This payment is already tied to another bank line';
    end if;
    update bank_transactions
       set status = 'confirmed', payment_id = p_payment_id, decided_at = now(), decided_by = v_me
     where id = p_tx_id;
    -- remember the name the bank shows for this member, so the next line matches by itself
    if v_p.member_id is not null and name_key(v_t.counterparty) <> '' then
      update members
         set bank_names = array(select distinct x from unnest(bank_names || array[name_key(v_t.counterparty)]) x order by x)
       where id = v_p.member_id and not (name_key(v_t.counterparty) = any(bank_names));
    end if;
  end if;
  update payments
     set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now())
   where id = p_payment_id;
end $$;

-- treasurer: confirm every line that was matched by its payment code
create or replace function confirm_matched() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  for r in select id, payment_id from bank_transactions where status = 'matched' and payment_id is not null loop
    perform confirm_payment(r.payment_id, r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- treasurer: "not this one" — the line goes back to waiting
create or replace function reject_match(p_tx_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update bank_transactions set status = 'unmatched', payment_id = null, decided_at = now(), decided_by = current_member_id()
   where id = p_tx_id and status in ('suggested','matched');
end $$;

-- treasurer: this line is not a member payment (fee, refund, deposit…) — or bring it back
create or replace function ignore_transaction(p_tx_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update bank_transactions set status = 'ignored', payment_id = null, decided_at = now(), decided_by = current_member_id()
   where id = p_tx_id and status in ('unmatched','suggested','matched');
end $$;

create or replace function restore_transaction(p_tx_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update bank_transactions set status = 'unmatched', decided_at = null, decided_by = null
   where id = p_tx_id and status = 'ignored';
end $$;

-- treasurer: take a confirmation back (wrong line, wrong member)
create or replace function undo_confirmation(p_payment_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update bank_transactions set status = 'unmatched', payment_id = null, decided_at = null, decided_by = null
   where payment_id = p_payment_id and status = 'confirmed';
  update payments
     set status = case when claimed_at is not null then 'claimed' else 'pending' end, confirmed_at = null
   where id = p_payment_id and status = 'confirmed';
end $$;

-- ───────────────────────── 6. import + automatic matching ─────────────────────────
-- Runs over every waiting line:
--   ① a payment code (S0231 / O0012 / M0003) in the message or title → matched
--   ② same amount, payer name ≈ member name (or a saved bank name), booked within the window → suggested
create or replace function match_bank_transactions() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t record;
  v_pay uuid;
  v_code text;
  v_matched int := 0;
  v_suggested int := 0;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  for t in select * from bank_transactions where status = 'unmatched' and amount_sek > 0 order by booked_on, imported_at, id loop
    v_pay := null;
    v_code := substring(upper(coalesce(t.message, '') || ' ' || t.title) from '\m([SOM]\d{4,6})\M');
    if v_code is not null then
      select p.id into v_pay from payments p
       where p.code = v_code and p.status in ('pending','claimed')
         and not exists (select 1 from bank_transactions x where x.payment_id = p.id);
      if v_pay is not null then
        update bank_transactions set status = 'matched', payment_id = v_pay where id = t.id;
        v_matched := v_matched + 1;
        continue;
      end if;
    end if;

    select p.id into v_pay
      from payments p
      join members m on m.id = p.member_id
      left join bookings b on b.id = p.ref_id and p.kind = 'seat'
      cross join lateral (select (p.created_at at time zone 'Europe/Stockholm')::date as created_on) c
     where p.status in ('pending','claimed')
       and p.amount_sek = t.amount_sek
       and not exists (select 1 from bank_transactions x where x.payment_id = p.id)
       and (names_match(t.counterparty, m.name)
            or name_key(t.counterparty) = any(m.bank_names)
            or (length(t.counterparty) >= 19 and name_prefix_match(t.counterparty, m.name)))
       and t.booked_on between c.created_on - 1
                           and greatest(c.created_on, coalesce(b.date, c.created_on + 23)) + 7
     order by (p.status = 'claimed') desc, p.created_at
     limit 1;
    if v_pay is not null then
      update bank_transactions set status = 'suggested', payment_id = v_pay where id = t.id;
      v_suggested := v_suggested + 1;
    end if;
  end loop;
  return jsonb_build_object('matched', v_matched, 'suggested', v_suggested);
end $$;

-- rows: [{booked_on, amount_sek, title, counterparty, message, own_notes, balance_sek, seq, raw}, …]
--   seq = 1, 2, … among lines in the same paste that are otherwise identical (the balance is not on every line,
--   so it is not part of the identity; two identical lines on one day are kept as two)
-- returns {added, duplicates, matched, suggested}
create or replace function import_bank_rows(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := current_member_id();
  v_total int;
  v_added int;
  v_match jsonb;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select count(*) into v_total from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb));
  insert into bank_transactions (booked_on, amount_sek, title, counterparty, message, own_notes, balance_sek, raw, fingerprint, imported_by)
  select r.booked_on, r.amount_sek, trim(r.title), nullif(trim(r.counterparty), ''), nullif(trim(r.message), ''), nullif(trim(r.own_notes), ''), r.balance_sek, r.raw,
         md5(to_char(r.booked_on, 'YYYY-MM-DD') || '|' || r.amount_sek::text || '|' || lower(trim(r.title)) || '|'
             || lower(coalesce(trim(r.counterparty), '')) || '|' || lower(coalesce(trim(r.message), '')) || '|' || coalesce(r.seq, 1)::text),
         v_me
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
      as r(booked_on date, amount_sek numeric(12,2), title text, counterparty text, message text, own_notes text, balance_sek numeric(12,2), seq int, raw text)
   where r.booked_on is not null and r.amount_sek is not null and coalesce(trim(r.title), '') <> ''
  on conflict (fingerprint) do nothing;
  get diagnostics v_added = row_count;
  v_match := match_bank_transactions();
  return jsonb_build_object('added', v_added, 'duplicates', v_total - v_added) || v_match;
end $$;

-- ───────────────────────── 7. a convenient read: payments with names and dates ─────────────────────────
create or replace view payments_view with (security_invoker = true) as
select p.id, p.code, p.kind, p.status, p.amount_sek, p.note, p.member_id, p.ref_id,
       p.created_at, p.claimed_at, p.confirmed_at, p.refunded_at,
       m.name  as member_name,
       b.date  as booking_date,
       b.status as booking_status,
       s.session, s.weekday,
       t.id    as bank_tx_id,
       t.booked_on as bank_date,
       t.counterparty as bank_name
from payments p
left join members m on m.id = p.member_id
left join bookings b on b.id = p.ref_id and p.kind = 'seat'
left join slots s on s.id = b.slot_id
left join bank_transactions t on t.payment_id = p.id;

-- ───────────────────────── 8. who sees what ─────────────────────────
drop policy if exists charges_own   on payments;
drop policy if exists charges_admin on payments;
drop policy if exists payments_own  on payments;
drop policy if exists payments_read on payments;
drop policy if exists payments_admin on payments;
-- members see their own; treasurer and admin see all. Writing goes through the functions above.
create policy payments_read  on payments for select using (member_id = current_member_id() or can_use_payments());
create policy payments_admin on payments for all using (is_admin());

alter table bank_transactions enable row level security;
drop policy if exists bank_tx_treasurer on bank_transactions;
create policy bank_tx_treasurer on bank_transactions for all using (can_use_payments()) with check (can_use_payments());
