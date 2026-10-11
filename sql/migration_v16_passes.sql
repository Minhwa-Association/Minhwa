-- Migration v16 — Monthly passes
-- Run once in Supabase SQL Editor (after v15). Safe to run again.
--
-- What changes
--   * Paying 100 kr per session stays. On top of it a member can buy a monthly pass:
--       twice     "Twice a week"    550 kr — up to 2 sessions in a Mon–Fri week; the 3rd in a week is 100 kr
--       unlimited "Unlimited"      1000 kr — any number, but at most 4 upcoming seats held at a time
--       crew      "Crew Unlimited"  550 kr — the same as Unlimited, for members the admin gives the Crew rate
--                                          (members.crew_rate_until — buyable while that date has not passed)
--   * Every pass covers one period: from settings.pass_start_day (1 → 1 Nov – 30 Nov) to the day before the
--     next one. All members share the same periods. The first period is settings.passes_from (2026-11-01).
--     The next period's pass can be bought settings.pass_presale_days (7) before it starts.
--   * A pass is one payment (kind 'pass', code P0412, Swish message "P0412 Pass Nov Unlimited Rock").
--     It works from the moment the member taps "I have paid" (claimed) — the treasurer confirms it as usual.
--     Credits cannot be used for a pass.
--   * A seat covered by the pass has no payment: bookings.pass_id is set, bookings.payment_id is null.
--     Seats already booked in the period and not paid yet are moved onto the pass when it starts working.
--   * The treasurer can cancel a pass whose money never came (cancelled → every seat on it gets its normal
--     100 kr payment back) or refund one (refunded → only seats from today on go back to 100 kr).

do $$
begin
  if to_regclass('public.waitlist') is null then raise exception 'Run migration_v15_waitlist.sql first'; end if;
  if to_regclass('public.credit_movements') is null then raise exception 'Run migration_v14_credits.sql first'; end if;
end $$;

-- ───────────────────────── 1. settings, members, payments ─────────────────────────
alter table settings add column if not exists pass_twice_sek      int  not null default 550;
alter table settings add column if not exists pass_unlimited_sek  int  not null default 1000;
alter table settings add column if not exists pass_crew_sek       int  not null default 550;
alter table settings add column if not exists pass_twice_per_week int  not null default 2;
alter table settings add column if not exists pass_max_upcoming   int  not null default 4;
alter table settings add column if not exists pass_start_day      int  not null default 1;
alter table settings add column if not exists passes_from         date not null default '2026-11-01';
alter table settings add column if not exists pass_presale_days   int  not null default 7;
alter table settings drop constraint if exists settings_pass_check;
alter table settings add constraint settings_pass_check check (
  pass_twice_sek >= 0 and pass_unlimited_sek >= 0 and pass_crew_sek >= 0
  and pass_twice_per_week between 1 and 10 and pass_max_upcoming between 1 and 50
  and pass_start_day between 1 and 28 and pass_presale_days between 0 and 27);

-- the Crew rate: set by the admin, per member, with an end date
alter table members add column if not exists crew_rate_until date;

alter table payments drop constraint if exists payments_kind_check;
alter table payments add constraint payments_kind_check check (kind in ('seat','material','membership','pass'));

-- a member may still change only their own name (+ v16: the Crew rate is admin only)
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
  or new.crew_rate_until is distinct from old.crew_rate_until
  or new.id      is distinct from old.id then
    raise exception 'Only an admin can change this';
  end if;
  if new.bank_names is distinct from old.bank_names and not can_use_payments() then
    raise exception 'Only the treasurer can change this';
  end if;
  return new;
end $$;

-- ───────────────────────── 2. passes ─────────────────────────
create table if not exists passes (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references members(id),
  kind          text not null check (kind in ('twice','unlimited','crew')),
  period_start  date not null,
  period_end    date not null,
  price_sek     int  not null,
  payment_id    uuid references payments(id),
  status        text not null default 'active' check (status in ('active','cancelled')),
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  cancelled_by  uuid references members(id) on delete set null,
  constraint passes_period_check check (period_end >= period_start)
);
create unique index if not exists passes_live_unique on passes (member_id, period_start) where status = 'active';
create index if not exists passes_period_idx on passes (period_start, status);

-- the seat a pass covers (payment_id stays null for it)
alter table bookings add column if not exists pass_id uuid references passes(id);
create index if not exists bookings_pass_idx on bookings (pass_id) where pass_id is not null;

-- ───────────────────────── 3. periods and labels ─────────────────────────
-- the first day of the period a date falls in (start day 1 → 1st of the month; 15 → the 15th)
create or replace function pass_period_start(p_date date) returns date
language sql stable set search_path = public as $$
  select case when extract(day from p_date) >= s.pass_start_day
              then make_date(extract(year from p_date)::int, extract(month from p_date)::int, s.pass_start_day)
              else (make_date(extract(year from p_date)::int, extract(month from p_date)::int, s.pass_start_day) - interval '1 month')::date end
  from settings s where s.id = 1;
$$;

create or replace function pass_period_end(p_start date) returns date
language sql immutable as $$ select ((p_start + interval '1 month')::date - 1); $$;

create or replace function pass_label(p_kind text) returns text
language sql immutable as $$
  select case p_kind when 'twice' then 'Twice a week' when 'unlimited' then 'Unlimited' when 'crew' then 'Crew Unlimited' else p_kind end;
$$;

-- the pass that works for a member on a date: active, and paid or "I have paid"
create or replace function pass_usable(p_member uuid, p_date date) returns passes
language sql stable security definer set search_path = public as $$
  select p.* from passes p join payments y on y.id = p.payment_id
   where p.member_id = p_member and p.status = 'active' and y.status in ('claimed','confirmed')
     and p_date between p.period_start and p.period_end
   limit 1;
$$;

-- Does the member's pass cover a seat on this date? → the pass id, or null (pay 100 kr as usual).
--   twice: fewer than pass_twice_per_week seats on this pass in that Mon–Fri week
--   unlimited / crew: fewer than pass_max_upcoming seats from today on (p_ignore_cap: the waiting list
--   gives the seat anyway — the member asked for it before)
create or replace function pass_covers(p_member uuid, p_date date, p_ignore_cap boolean default false) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_p   passes;
  v_set settings%rowtype;
  v_n   int;
begin
  v_p := pass_usable(p_member, p_date);
  if v_p.id is null then return null; end if;
  select * into v_set from settings where id = 1;
  if v_p.kind = 'twice' then
    select count(*) into v_n from bookings
     where pass_id = v_p.id and status = 'booked'
       and date between date_trunc('week', p_date)::date and date_trunc('week', p_date)::date + 6;
    return case when v_n < v_set.pass_twice_per_week then v_p.id end;
  end if;
  if p_ignore_cap then return v_p.id; end if;
  select count(*) into v_n from bookings
   where pass_id = v_p.id and status = 'booked' and date >= current_date;
  return case when v_n < v_set.pass_max_upcoming then v_p.id end;
end $$;

-- ───────────────────────── 4. seats: the pass first ─────────────────────────
-- the normal 100 kr payment for a booking (code S0231, message "S0231 05/10 Mon Day Rock")
create or replace function seat_charge(p_booking uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_b    bookings%rowtype;
  v_slot slots%rowtype;
  v_set  settings%rowtype;
  v_name text;
  v_code text;
  v_pay  uuid;
begin
  select * into v_b from bookings where id = p_booking;
  select * into v_slot from slots where id = v_b.slot_id;
  select * into v_set from settings where id = 1;
  select name into v_name from members where id = v_b.member_id;
  v_code := next_payment_code('seat');
  insert into payments (member_id, kind, amount_sek, code, note, ref_id)
  values (v_b.member_id, 'seat', v_set.seat_price_sek, v_code,
          v_code || ' ' || to_char(v_b.date, 'DD/MM') || ' ' || to_char(v_b.date, 'Dy') || ' ' ||
          initcap(v_slot.session::text) || ' ' || v_name, p_booking)
  returning id into v_pay;
  update bookings set payment_id = v_pay, pass_id = null where id = p_booking;
  return v_pay;
end $$;

-- one booking: on the pass when it covers the date, otherwise with its 100 kr payment
create or replace function seat_create(p_member uuid, p_slot_id uuid, p_date date, p_from_waitlist boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_pass uuid := pass_covers(p_member, p_date, p_from_waitlist);
  v_book uuid;
begin
  insert into bookings (member_id, slot_id, date, pass_id, promoted_at)
  values (p_member, p_slot_id, p_date, v_pass, case when p_from_waitlist then now() end)
  returning id into v_book;
  if v_pass is null then
    perform seat_charge(v_book);
  end if;
  return v_book;
end $$;

-- book_seat as in v15 + an Unlimited pass at its cap says so instead of charging 100 kr
create or replace function book_seat(p_slot_id uuid, p_date date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me    uuid := current_member_id();
  v_slot  slots%rowtype;
  v_set   settings%rowtype;
  v_taken int;
  v_book  uuid;
  v_p     passes;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  select * into v_slot from slots where id = p_slot_id for update;   -- one booking at a time per slot
  if not found then raise exception 'Session not found'; end if;
  select * into v_set from settings where id = 1;
  if v_slot.instructor_id = v_me then
    raise exception 'You are the teacher for this session';
  end if;
  if extract(isodow from p_date) <> v_slot.weekday then
    raise exception 'Date does not match slot weekday';
  end if;
  if p_date < current_date or p_date > current_date + v_set.booking_window_weeks * 7 then
    raise exception 'Outside booking window';
  end if;
  perform waitlist_fill(p_slot_id, p_date);
  select id into v_book from bookings where member_id = v_me and slot_id = p_slot_id and date = p_date and status = 'booked';
  if found then return v_book; end if;
  select count(*) into v_taken from bookings where slot_id = p_slot_id and date = p_date and status = 'booked';
  if v_taken >= v_slot.capacity then
    raise exception 'This session is full — join the waiting list instead';
  end if;
  v_p := pass_usable(v_me, p_date);
  if v_p.id is not null and v_p.kind in ('unlimited','crew') and pass_covers(v_me, p_date) is null then
    raise exception 'Your pass holds % upcoming seats already — cancel one, or book again after one has passed', v_set.pass_max_upcoming;
  end if;
  v_book := seat_create(v_me, p_slot_id, p_date, false);
  update waitlist set status = 'promoted', ended_at = now(), booking_id = v_book
    where member_id = v_me and slot_id = p_slot_id and date = p_date and status = 'waiting';
  return v_book;
end $$;

-- what booking this seat would cost me: 'pass' (covered) · 'week_used' (twice: this week's are used — 100 kr)
-- · 'cap' (unlimited: too many upcoming) · 'unpaid' (a pass for that date, not paid yet) · 'none'
create or replace function my_pass_cover(p_date date) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := current_member_id();
  v_p  passes;
begin
  if v_me is null then return 'none'; end if;
  v_p := pass_usable(v_me, p_date);
  if v_p.id is null then
    if exists (select 1 from passes p join payments y on y.id = p.payment_id
                where p.member_id = v_me and p.status = 'active' and y.status = 'pending'
                  and p_date between p.period_start and p.period_end) then
      return 'unpaid';
    end if;
    return 'none';
  end if;
  if pass_covers(v_me, p_date) is not null then return 'pass'; end if;
  return case when v_p.kind = 'twice' then 'week_used' else 'cap' end;
end $$;

-- ───────────────────────── 5. the pass starts working / stops ─────────────────────────
-- unpaid seats already booked in the period move onto the pass (their 100 kr payment is cancelled;
-- credits on it come back through the v14 trigger)
create or replace function pass_absorb(p_pass uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_p passes%rowtype;
  r   record;
  n   int := 0;
begin
  select * into v_p from passes where id = p_pass;
  for r in
    select b.id, b.date, b.payment_id from bookings b join payments y on y.id = b.payment_id
     where b.member_id = v_p.member_id and b.status = 'booked' and b.pass_id is null
       and b.date between v_p.period_start and v_p.period_end
       and y.status = 'pending' and y.kind = 'seat'
     order by b.date, b.created_at
  loop
    if pass_covers(v_p.member_id, r.date, true) = p_pass then
      update bookings set pass_id = p_pass, payment_id = null where id = r.id;
      update payments set status = 'cancelled' where id = r.payment_id and status = 'pending';
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- the pass ends early: every seat on it gets its 100 kr payment back
-- (cancelled = the money never came → all its seats · refunded → seats from today on)
create or replace function pass_release(p_pass uuid, p_all boolean) returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  update passes set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()),
                    cancelled_by = coalesce(cancelled_by, current_member_id())
   where id = p_pass and status = 'active';
  for r in select id from bookings
            where pass_id = p_pass and status = 'booked' and (p_all or date >= current_date)
            order by date
  loop
    perform seat_charge(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function payments_pass_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_pass uuid;
begin
  if new.kind <> 'pass' or old.status is not distinct from new.status then return null; end if;
  select id into v_pass from passes where payment_id = new.id;
  if v_pass is null then return null; end if;
  if old.status = 'pending' and new.status in ('claimed','confirmed') then
    perform pass_absorb(v_pass);
  elsif new.status in ('cancelled','refunded') then
    perform pass_release(v_pass, new.status = 'cancelled');
  end if;
  return null;
end $$;
drop trigger if exists payments_pass_status on payments;
create trigger payments_pass_status after update of status on payments
  for each row execute function payments_pass_status();

-- only the functions in this file call these
do $$
declare r text; f text;
begin
  foreach f in array array['pass_usable(uuid, date)', 'pass_covers(uuid, date, boolean)', 'seat_charge(uuid)',
                           'pass_absorb(uuid)', 'pass_release(uuid, boolean)',
                           'seat_create(uuid, uuid, date, boolean)'] loop
    execute format('revoke execute on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke execute on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
end $$;

-- ───────────────────────── 6. buying and cancelling ─────────────────────────
-- the periods a member can look at: the current one and the next (with prices and whether they are open)
create or replace function pass_offer() returns table (period_start date, period_end date, buy_from date, open boolean)
language sql stable security definer set search_path = public as $$
  with s as (select * from settings where id = 1),
       cur as (select greatest(pass_period_start(current_date), (select passes_from from s)) as st)
  select st, pass_period_end(st), st - (select pass_presale_days from s),
         current_date between st - (select pass_presale_days from s) and pass_period_end(st)
    from (select st from cur
          union select (st + interval '1 month')::date from cur where st <= current_date) x
   order by 1;
$$;

-- Buy a pass for a period (default: the one running today). Returns the pass id — also when the member
-- already has the same pass for that period. A pass not paid yet can be swapped for another kind.
create or replace function buy_pass(p_kind text, p_period_start date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me    uuid := current_member_id();
  v_m     members%rowtype;
  v_set   settings%rowtype;
  v_start date;
  v_end   date;
  v_old   passes%rowtype;
  v_oldst text;
  v_price int;
  v_code  text;
  v_pay   uuid;
  v_id    uuid;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  if p_kind not in ('twice','unlimited','crew') then raise exception 'Unknown pass'; end if;
  select * into v_m from members where id = v_me for update;          -- one purchase at a time per member
  select * into v_set from settings where id = 1;
  v_start := coalesce(p_period_start, pass_period_start(current_date));
  if v_start <> pass_period_start(v_start) then raise exception 'That is not the first day of a pass period'; end if;
  if v_start < v_set.passes_from then
    raise exception 'Monthly passes start on %', to_char(v_set.passes_from, 'FMDD FMMonth YYYY');
  end if;
  v_end := pass_period_end(v_start);
  if current_date > v_end then raise exception 'That period is over'; end if;
  if current_date < v_start - v_set.pass_presale_days then
    raise exception 'The pass from % can be bought from %', to_char(v_start, 'FMDD FMMonth'),
                    to_char(v_start - v_set.pass_presale_days, 'FMDD FMMonth');
  end if;
  if p_kind = 'crew' and (v_m.crew_rate_until is null or v_m.crew_rate_until < current_date) then
    raise exception 'The Crew rate is not active for you — ask the admin';
  end if;

  select * into v_old from passes where member_id = v_me and period_start = v_start and status = 'active';
  if found then
    select status into v_oldst from payments where id = v_old.payment_id;
    if v_old.kind = p_kind then return v_old.id; end if;
    if v_oldst <> 'pending' then
      raise exception 'You already have a % pass for this period', pass_label(v_old.kind);
    end if;
    update payments set status = 'cancelled' where id = v_old.payment_id;   -- the trigger closes the old pass
  end if;

  v_price := case p_kind when 'twice' then v_set.pass_twice_sek when 'unlimited' then v_set.pass_unlimited_sek else v_set.pass_crew_sek end;
  v_code := next_payment_code('pass');
  insert into payments (member_id, kind, amount_sek, code, note)
  values (v_me, 'pass', v_price, v_code,
          v_code || ' Pass ' || case when v_set.pass_start_day = 1 then to_char(v_start, 'Mon') else to_char(v_start, 'DD/MM') end
                 || ' ' || case p_kind when 'twice' then 'Twice' when 'unlimited' then 'Unlimited' else 'Crew' end
                 || ' ' || v_m.name)
  returning id into v_pay;
  insert into passes (member_id, kind, period_start, period_end, price_sek, payment_id)
  values (v_me, p_kind, v_start, v_end, v_price, v_pay)
  returning id into v_id;
  update payments set ref_id = v_id where id = v_pay;
  return v_id;
end $$;

-- Cancel a pass. The member: only before paying. The treasurer / admin: not paid → cancelled (every seat on
-- it goes back to 100 kr) · paid → refunded (seats from today on go back to 100 kr; send the money back
-- with Swish yourself).
create or replace function cancel_pass(p_pass_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_p passes%rowtype;
  v_y payments%rowtype;
begin
  select * into v_p from passes where id = p_pass_id;
  if not found then raise exception 'Pass not found'; end if;
  if v_p.status <> 'active' then return; end if;
  select * into v_y from payments where id = v_p.payment_id for update;
  if can_use_payments() then
    if v_y.status in ('pending','claimed') then
      update payments set status = 'cancelled' where id = v_y.id;
    elsif v_y.status = 'confirmed' then
      update payments set status = 'refunded', refunded_at = now() where id = v_y.id;
    end if;
    return;
  end if;
  if v_p.member_id is distinct from current_member_id() then raise exception 'Not your pass'; end if;
  if v_y.status <> 'pending' then raise exception 'This pass is already paid — ask the treasurer'; end if;
  update payments set status = 'cancelled' where id = v_y.id;
end $$;

-- ───────────────────────── 7. credits are not for passes ─────────────────────────
create or replace function apply_credits(p_payment_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_p payments%rowtype;
begin
  select * into v_p from payments where id = p_payment_id;
  if not found then raise exception 'Payment not found'; end if;
  if v_p.member_id is distinct from current_member_id() then raise exception 'Not your payment'; end if;
  if v_p.kind = 'pass' then raise exception 'Credits cannot be used for a monthly pass'; end if;
  if v_p.status = 'claimed' then raise exception 'You have already said you paid this with Swish — ask the treasurer'; end if;
  if v_p.status <> 'pending' then raise exception 'This is already %', v_p.status; end if;
  if credit_balance_of(v_p.member_id) <= 0 then raise exception 'You have no credits'; end if;
  return credits_use(p_payment_id);
end $$;

-- ───────────────────────── 8. reading ─────────────────────────
-- passes with the payment and how many seats are on them
create or replace view passes_view with (security_invoker = true) as
select p.id, p.member_id, m.name as member_name, p.kind, pass_label(p.kind) as label,
       p.period_start, p.period_end, p.price_sek, p.status, p.created_at, p.cancelled_at,
       y.id as payment_id, y.code, y.status as payment_status, y.claimed_at, y.confirmed_at,
       (select count(*)::int from bookings b where b.pass_id = p.id and b.status = 'booked') as seats,
       (select count(*)::int from bookings b where b.pass_id = p.id and b.status = 'booked' and b.date >= current_date) as seats_upcoming
from passes p
join members m on m.id = p.member_id
left join payments y on y.id = p.payment_id;

alter table passes enable row level security;
drop policy if exists passes_read on passes;
create policy passes_read on passes for select using (member_id = current_member_id() or can_use_payments());
drop policy if exists passes_admin on passes;
create policy passes_admin on passes for all using (is_admin());
grant select on passes, passes_view to authenticated;
