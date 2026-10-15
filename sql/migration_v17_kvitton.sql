-- Migration v17 — Kvitton: a receipt for every payment the association receives (2026-10-15)
-- Run once in Supabase SQL Editor (after v16.4). Safe to run again.
--
-- What changes
--   * settings: the association's details printed on the receipt — name, organisation number, address,
--     e-mail, and a note (today: not registered for VAT). Admin fills them in under Settings → Receipts.
--   * sales_receipts: one receipt (kvitto) per payment, made the moment the payment becomes "Paid" —
--     the treasurer confirms a Swish payment (by hand or from a bank line), or credits cover the whole
--     amount. Seats, monthly passes and Store orders alike. The row is a snapshot: what was bought, the
--     member's name, the association's details as they were — a receipt never changes once issued.
--   * Numbers: K2026-0001, K2026-0002 … in the order they are issued, one series per year, no gaps.
--     A confirmation taken back (Undo) marks the receipt void (annullerad) — the number stays taken;
--     confirming again issues a new receipt. A refund does not void a receipt (the money did come in;
--     the refund is its own event).
--   * Paid wholly or partly with credits: the receipt says so and names where the credits came from
--     (a cancelled seat, an activity) — until then the credits were what the association owed the member.
--   * Google Drive: the PDF goes to "Minhwa — Bokföring / Kvitton" (the app does it after each
--     confirmation; Payments → Kvitton can do it again). drive_token() now also answers the app's own
--     key (service role), because a member paying with credits confirms a payment without a treasurer.
--   * Every payment already confirmed gets its receipt now, in the order they were confirmed.
--   * Issuing can never stop a confirmation: if making the receipt fails, the payment is still confirmed
--     and Payments → Kvitton offers "Issue missing".

do $$
begin
  if to_regclass('public.drive_connection') is null then
    raise exception 'Run migration_v16_4_drive.sql first';
  end if;
end $$;

-- ───────────────────────── 1. the association on the receipt ─────────────────────────
alter table settings add column if not exists org_name     text not null default 'Minhwa Association';
alter table settings add column if not exists org_number   text not null default '';
alter table settings add column if not exists org_address  text not null default '';
alter table settings add column if not exists org_email    text not null default 'manager@minhwa.org';
alter table settings add column if not exists receipt_note text not null default 'The association is not registered for VAT — no VAT is included.';

-- ───────────────────────── 2. receipts ─────────────────────────
create table if not exists sales_receipt_counters (
  year int primary key,
  last int not null default 0
);

create table if not exists sales_receipts (
  id             uuid primary key default gen_random_uuid(),
  number         text not null unique,                       -- K2026-0001
  year           int  not null,
  seq            int  not null,
  payment_id     uuid not null references payments(id),
  member_id      uuid references members(id),
  member_name    text not null,                              -- as it was when issued
  kind           text not null,                              -- seat / pass / material / membership
  payment_code   text,                                       -- S0231 — the Swish message code, for reference
  title          text not null,                              -- "Painting session" · "Monthly pass" · "Store order"
  description    text not null,                              -- "Mon 05 Oct 2026 · Day session 10:00–16:00 · Teacher …"
  lines          jsonb not null default '[]',                -- [{text, amount_sek}]
  total_sek      numeric(12,2) not null,
  swish_sek      numeric(12,2) not null,                     -- paid with Swish
  credit_sek     int not null default 0,                     -- paid with credits
  credit_source  text,                                       -- where those credits came from
  paid_on        date not null,                              -- the bank line's day, or the day it was confirmed
  bank_tx_id     uuid references bank_transactions(id) on delete set null,
  org_name       text not null,
  org_number     text not null default '',
  org_address    text not null default '',
  org_email      text not null default '',
  swish_number   text not null default '',
  note           text not null default '',
  issued_at      timestamptz not null default now(),
  issued_by      uuid references members(id) on delete set null,   -- the treasurer who confirmed; null = by itself
  voided_at      timestamptz,
  void_reason    text,
  drive_file_id  text,
  drive_saved_at timestamptz,
  unique (year, seq)
);
create unique index if not exists sales_receipts_live_payment on sales_receipts (payment_id) where voided_at is null;
create index if not exists sales_receipts_member_idx on sales_receipts (member_id, issued_at desc);
create index if not exists sales_receipts_drive_idx on sales_receipts (issued_at) where drive_file_id is null and voided_at is null;

alter table sales_receipts enable row level security;
drop policy if exists sales_receipts_read on sales_receipts;
-- members see their own; treasurer and admin see all. Writing goes through the functions below only.
create policy sales_receipts_read on sales_receipts for select using (member_id = current_member_id() or can_use_payments());
alter table sales_receipt_counters enable row level security;   -- no policies: functions only
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant select on sales_receipts to authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select, update on sales_receipts to service_role; end if;
end $$;

-- the app's own key (SUPABASE_SERVICE_ROLE_KEY) — for work with no logged-in treasurer behind it
create or replace function is_service_role() returns boolean
language sql stable set search_path = public as $$
  select coalesce(auth.role(), '') = 'service_role';
$$;

-- the next number in this year's series (the counter row is locked → one at a time; a rolled-back
-- confirmation gives the number back, so the series has no gaps)
create or replace function next_sales_receipt_seq(p_year int) returns int
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  insert into sales_receipt_counters (year, last) values (p_year, 0) on conflict (year) do nothing;
  update sales_receipt_counters set last = last + 1 where year = p_year returning last into v;
  return v;
end $$;

-- internal: the receipt for a confirmed payment (the one already there, if any)
create or replace function issue_sales_receipt(p_payment_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_p        payments%rowtype;
  v_set      settings%rowtype;
  v_name     text;
  v_title    text;
  v_desc     text;
  v_lines    jsonb := '[]'::jsonb;
  v_sum      numeric(12,2);
  v_total    numeric(12,2);
  v_paid_on  date;
  v_tx       uuid;
  v_year     int;
  v_seq      int;
  v_id       uuid;
  v_src      text;
  v_spend_at timestamptz;
begin
  select * into v_p from payments where id = p_payment_id;
  if not found or v_p.status <> 'confirmed' then return null; end if;
  select id into v_id from sales_receipts where payment_id = p_payment_id and voided_at is null;
  if v_id is not null then return v_id; end if;

  select * into v_set from settings where id = 1;
  select name into v_name from members where id = v_p.member_id;

  -- the day the money came: the bank line's day, otherwise the day it was confirmed (Stockholm)
  select t.id, t.booked_on into v_tx, v_paid_on
    from bank_transactions t where t.payment_id = v_p.id and t.status = 'confirmed' limit 1;
  if v_paid_on is null then
    v_paid_on := (coalesce(v_p.confirmed_at, now()) at time zone 'Europe/Stockholm')::date;
  end if;

  v_total := v_p.amount_sek + v_p.credit_sek;

  if v_p.kind = 'seat' then
    v_title := 'Painting session';
    select to_char(b.date, 'Dy DD Mon YYYY') || ' · ' || initcap(s.session::text) || ' session '
           || left(s.start_time::text, 5) || '–' || left(s.end_time::text, 5)
           || coalesce(' · Teacher ' || i.name, '')
      into v_desc
      from bookings b
      join slots s on s.id = b.slot_id
      left join members i on i.id = s.instructor_id
     where b.id = v_p.ref_id;
    v_desc := coalesce(v_desc, 'Seat');
  elsif v_p.kind = 'pass' then
    v_title := 'Monthly pass';
    select case ps.kind when 'twice' then 'Twice a week' when 'unlimited' then 'Unlimited' when 'crew' then 'Crew Unlimited' else ps.kind end
           || ' · ' || to_char(ps.period_start, 'DD Mon') || ' – ' || to_char(ps.period_end, 'DD Mon YYYY')
      into v_desc
      from passes ps where ps.payment_id = v_p.id;
    v_desc := coalesce(v_desc, 'Pass');
  elsif v_p.kind = 'material' then
    v_title := 'Store order';
    select coalesce(jsonb_agg(jsonb_build_object('text', i.qty || ' × ' || i.name, 'amount_sek', i.qty * i.unit_price_sek) order by i.name), '[]'::jsonb),
           coalesce(sum(i.qty * i.unit_price_sek), 0),
           count(*) || case when count(*) = 1 then ' item' else ' items' end
      into v_lines, v_sum, v_desc
      from order_items i
      join orders o on o.id = i.order_id
     where o.payment_id = v_p.id and i.status <> 'cancelled';
    if v_lines = '[]'::jsonb then v_desc := 'Order'; end if;
    if v_sum <> v_total then v_lines := '[]'::jsonb; end if;   -- lines that do not add up to what was paid: one line for the total
  else
    v_title := initcap(v_p.kind);
    v_desc := coalesce(nullif(trim(v_p.note), ''), v_p.kind);
  end if;
  if v_lines = '[]'::jsonb then
    v_lines := jsonb_build_array(jsonb_build_object('text', v_title || ' · ' || v_desc, 'amount_sek', v_total));
  end if;

  -- credits on it: the latest credits the member got before spending them (newest first, up to three)
  if v_p.credit_sek > 0 then
    select max(created_at) into v_spend_at from credit_movements where payment_id = v_p.id and kind = 'spend';
    select string_agg(
             case y.kind when 'grant' then 'activity: ' || coalesce(y.note, '')
                         when 'return' then 'returned from ' || coalesce(y.note, 'a cancelled payment')
                         else 'adjustment' || coalesce(': ' || y.note, '') end,
             '; ' order by y.created_at desc)
      into v_src
      from (
        select x.*, row_number() over (order by x.created_at desc) as rn
          from (
            select cm.note, cm.kind, cm.amount, cm.created_at,
                   sum(cm.amount) over (order by cm.created_at desc, cm.id rows between unbounded preceding and current row) as running
              from credit_movements cm
             where cm.member_id = v_p.member_id and cm.voided_at is null and cm.amount > 0
               and cm.kind in ('return', 'grant', 'adjust')
               and cm.created_at <= coalesce(v_spend_at, now())
          ) x
         where x.running - x.amount < v_p.credit_sek
      ) y
     where y.rn <= 3;
  end if;

  v_year := extract(year from v_paid_on)::int;
  v_seq  := next_sales_receipt_seq(v_year);
  insert into sales_receipts (number, year, seq, payment_id, member_id, member_name, kind, payment_code, title, description, lines,
                              total_sek, swish_sek, credit_sek, credit_source, paid_on, bank_tx_id,
                              org_name, org_number, org_address, org_email, swish_number, note, issued_by)
  values ('K' || v_year || '-' || lpad(v_seq::text, 4, '0'), v_year, v_seq, v_p.id, v_p.member_id, coalesce(v_name, 'Member'), v_p.kind, v_p.code,
          v_title, v_desc, v_lines, v_total, v_p.amount_sek, v_p.credit_sek, v_src, v_paid_on, v_tx,
          v_set.org_name, v_set.org_number, v_set.org_address, v_set.org_email, v_set.swish_number, v_set.receipt_note, current_member_id())
  returning id into v_id;
  return v_id;
end $$;

-- paid → a receipt · confirmation taken back → the receipt is void
create or replace function payments_sales_receipt() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'confirmed' and old.status is distinct from 'confirmed' then
    begin
      perform issue_sales_receipt(new.id);
    exception when others then
      raise warning 'sales receipt for payment % not issued: %', new.id, sqlerrm;   -- the confirmation stands
    end;
  elsif old.status = 'confirmed' and new.status in ('pending', 'claimed', 'cancelled') then
    update sales_receipts set voided_at = now(), void_reason = 'confirmation taken back'
     where payment_id = new.id and voided_at is null;
  end if;
  return null;
end $$;
drop trigger if exists payments_sales_receipt on payments;
create trigger payments_sales_receipt after update of status on payments
  for each row execute function payments_sales_receipt();

-- treasurer / admin: receipts for confirmed payments that have none (after a failure) — returns how many
create or replace function issue_missing_sales_receipts() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  for r in select p.id from payments p
            where p.status = 'confirmed'
              and not exists (select 1 from sales_receipts s where s.payment_id = p.id and s.voided_at is null)
            order by p.confirmed_at nulls last, p.created_at loop
    if issue_sales_receipt(r.id) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- treasurer / admin / the app itself: this receipt's PDF is now in Drive (or, with null, no longer)
create or replace function sales_receipt_in_drive(p_id uuid, p_drive_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (can_use_payments() or is_service_role()) then raise exception 'Treasurer or Admin only'; end if;
  update sales_receipts
     set drive_file_id  = nullif(trim(coalesce(p_drive_id, '')), ''),
         drive_saved_at = case when nullif(trim(coalesce(p_drive_id, '')), '') is null then null else now() end
   where id = p_id;
  if not found then raise exception 'No such receipt'; end if;
end $$;

-- only the trigger and the functions above call these
do $$
declare r text; f text;
begin
  foreach f in array array['issue_sales_receipt(uuid)', 'next_sales_receipt_seq(int)'] loop
    execute format('revoke execute on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke execute on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
end $$;

-- ───────────────────────── 3. Google Drive: the Kvitton folder, and the app's own key ─────────────────────────
alter table drive_connection add column if not exists kvitton_folder_id text;   -- "Minhwa — Bokföring / Kvitton"

drop function if exists drive_status();
create or replace function drive_status()
returns table (email text, connected boolean, connected_at timestamptz, root_folder_id text, receipts_folder_id text, kvitton_folder_id text)
language sql stable security definer set search_path = public as $$
  select d.email, d.token_enc is not null, d.connected_at, d.root_folder_id, d.receipts_folder_id, d.kvitton_folder_id
    from drive_connection d where can_use_payments();
$$;

drop function if exists drive_token();
create or replace function drive_token()
returns table (email text, token_enc text, root_folder_id text, receipts_folder_id text, kvitton_folder_id text)
language sql stable security definer set search_path = public as $$
  select d.email, d.token_enc, d.root_folder_id, d.receipts_folder_id, d.kvitton_folder_id
    from drive_connection d where (can_use_payments() or is_service_role()) and d.token_enc is not null;
$$;

-- the folders were made (again) — one function, all three, so the app never has to pick an overload
drop function if exists drive_set_folders(text, text);
create or replace function drive_set_folders(p_root text, p_receipts text, p_kvitton text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (can_use_payments() or is_service_role()) then raise exception 'Treasurer or Admin only'; end if;
  update drive_connection
     set root_folder_id = p_root, receipts_folder_id = p_receipts, kvitton_folder_id = coalesce(p_kvitton, kvitton_folder_id)
   where id = 1;
end $$;

-- ───────────────────────── 4. receipts for what is already paid ─────────────────────────
do $$
declare r record;
begin
  for r in select p.id from payments p
            where p.status = 'confirmed'
              and not exists (select 1 from sales_receipts s where s.payment_id = p.id and s.voided_at is null)
            order by p.confirmed_at nulls last, p.created_at loop
    perform issue_sales_receipt(r.id);
  end loop;
end $$;
