-- Migration v15 — Waiting list for full sessions
-- Run once in Supabase SQL Editor (after v14). Safe to run again.
--
-- What changes
--   * A session whose seats are all taken no longer sells "extra seats". Members join a **waiting list**
--     instead (free, first come first served). When a seat frees up — a member cancels, or the admin
--     removes a booking — the first member on the list gets it automatically: a normal booking with a
--     payment to pay, exactly as if they had booked it themselves. The one who cancelled is told who got
--     the seat, so they can say so in the WhatsApp group.
--   * The session page shows the waiting list (names, in order) to everyone; the board shows "n waiting".
--   * A seat that came from the waiting list can be declined (cancelled) at any time until it is paid —
--     the free-cancellation deadline applies to seats the member booked themselves and to paid seats.
--   * book_seat() stops at the capacity (5). settings.max_extra_seats stays in the table but is no longer
--     read; existing bookings beyond the capacity are left as they are (shown as "extra" until they pass).
--   * cancel_booking() now returns text: the name(s) of whoever got the seat from the waiting list, or null.

do $$
begin
  if to_regclass('public.payments') is null or to_regprocedure('next_payment_code(text)') is null then
    raise exception 'Run migration_v8_payments.sql first';
  end if;
  if to_regclass('public.credit_movements') is null then raise exception 'Run migration_v14_credits.sql first'; end if;
end $$;

-- ───────────────────────── 1. tables ─────────────────────────
create table if not exists waitlist (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members(id),
  slot_id     uuid not null references slots(id),
  date        date not null,
  status      text not null default 'waiting' check (status in ('waiting','promoted','left')),
  created_at  timestamptz not null default now(),          -- the order of the list
  ended_at    timestamptz,                                 -- promoted to a seat, or left the list
  booking_id  uuid references bookings(id)                 -- the seat it turned into
);
create unique index if not exists waitlist_live_unique on waitlist (member_id, slot_id, date) where status = 'waiting';
create index if not exists waitlist_open on waitlist (slot_id, date, created_at) where status = 'waiting';

-- set when the seat came from the waiting list (not booked by the member themselves)
alter table bookings add column if not exists promoted_at timestamptz;

-- ───────────────────────── 2. internal: create a seat, fill from the list ─────────────────────────
-- One booking + its payment (code S0231, Swish message "S0231 05/10 Mon Day Rock"). Used by book_seat and
-- by the waiting list. No checks here — the callers do them.
create or replace function seat_create(p_member uuid, p_slot_id uuid, p_date date, p_from_waitlist boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_slot slots%rowtype;
  v_set  settings%rowtype;
  v_name text;
  v_code text;
  v_pay  uuid;
  v_book uuid;
begin
  select * into v_slot from slots where id = p_slot_id;
  select * into v_set  from settings where id = 1;
  select name into v_name from members where id = p_member;
  v_code := next_payment_code('seat');
  insert into payments (member_id, kind, amount_sek, code, note)
  values (p_member, 'seat', v_set.seat_price_sek, v_code,
          v_code || ' ' || to_char(p_date, 'DD/MM') || ' ' || to_char(p_date, 'Dy') || ' ' ||
          initcap(v_slot.session::text) || ' ' || v_name)
  returning id into v_pay;
  insert into bookings (member_id, slot_id, date, payment_id, promoted_at)
  values (p_member, p_slot_id, p_date, v_pay, case when p_from_waitlist then now() end)
  returning id into v_book;
  update payments set ref_id = v_book where id = v_pay;
  return v_book;
end $$;

-- Give open seats to the waiting list, in order. Returns the names of those who got a seat ("Anna, Bo"), or
-- null when nobody did. Nothing happens for a date that has passed. The caller holds the lock on the slot row.
create or replace function waitlist_fill(p_slot_id uuid, p_date date) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_cap   int;
  v_taken int;
  v_w     waitlist%rowtype;
  v_book  uuid;
  v_name  text;
  v_names text[] := '{}';
begin
  if p_date < current_date then return null; end if;
  select capacity into v_cap from slots where id = p_slot_id;
  loop
    select count(*) into v_taken from bookings where slot_id = p_slot_id and date = p_date and status = 'booked';
    exit when v_taken >= v_cap;
    select * into v_w from waitlist
      where slot_id = p_slot_id and date = p_date and status = 'waiting'
      order by created_at, id limit 1 for update;
    exit when not found;
    if exists (select 1 from bookings where member_id = v_w.member_id and slot_id = p_slot_id and date = p_date and status = 'booked') then
      -- already has a seat (booked it another way) — the entry is just closed
      update waitlist set status = 'left', ended_at = now() where id = v_w.id;
      continue;
    end if;
    v_book := seat_create(v_w.member_id, p_slot_id, p_date, true);
    update waitlist set status = 'promoted', ended_at = now(), booking_id = v_book where id = v_w.id;
    select name into v_name from members where id = v_w.member_id;
    v_names := v_names || v_name;
  end loop;
  return nullif(array_to_string(v_names, ', '), '');
end $$;

-- only the functions in this file call these
do $$
declare r text; f text;
begin
  foreach f in array array['seat_create(uuid, uuid, date, boolean)', 'waitlist_fill(uuid, date)'] loop
    execute format('revoke execute on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke execute on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
end $$;

-- ───────────────────────── 3. the member: book · join the list · leave it · cancel ─────────────────────────
-- Book a seat. The capacity is now a hard stop: when the session is full the member joins the waiting list
-- instead. Members already on the list are served first. Returns the booking id — also when the member
-- already has a seat in that session (a second tap just opens the same seat again).
create or replace function book_seat(p_slot_id uuid, p_date date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me    uuid := current_member_id();
  v_slot  slots%rowtype;
  v_set   settings%rowtype;
  v_taken int;
  v_book  uuid;
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
  -- the waiting list goes first (an open seat with people waiting = the admin raised the capacity)
  perform waitlist_fill(p_slot_id, p_date);
  select id into v_book from bookings where member_id = v_me and slot_id = p_slot_id and date = p_date and status = 'booked';
  if found then return v_book; end if;
  select count(*) into v_taken from bookings where slot_id = p_slot_id and date = p_date and status = 'booked';
  if v_taken >= v_slot.capacity then
    raise exception 'This session is full — join the waiting list instead';
  end if;
  v_book := seat_create(v_me, p_slot_id, p_date, false);
  update waitlist set status = 'promoted', ended_at = now(), booking_id = v_book
    where member_id = v_me and slot_id = p_slot_id and date = p_date and status = 'waiting';
  return v_book;
end $$;

-- Join the waiting list of a full session. Returns the waitlist id (the existing one when already on it).
create or replace function join_waitlist(p_slot_id uuid, p_date date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me    uuid := current_member_id();
  v_slot  slots%rowtype;
  v_set   settings%rowtype;
  v_taken int;
  v_id    uuid;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  select * into v_slot from slots where id = p_slot_id for update;
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
  if exists (select 1 from bookings where member_id = v_me and slot_id = p_slot_id and date = p_date and status = 'booked') then
    raise exception 'You already have a seat in this session';
  end if;
  select id into v_id from waitlist where member_id = v_me and slot_id = p_slot_id and date = p_date and status = 'waiting';
  if found then return v_id; end if;
  select count(*) into v_taken from bookings where slot_id = p_slot_id and date = p_date and status = 'booked';
  if v_taken < v_slot.capacity then
    raise exception 'There is an open seat — book it instead';
  end if;
  insert into waitlist (member_id, slot_id, date) values (v_me, p_slot_id, p_date) returning id into v_id;
  return v_id;
end $$;

-- Leave the waiting list (own entry; the admin can remove anyone).
create or replace function leave_waitlist(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_w waitlist%rowtype;
begin
  select * into v_w from waitlist where id = p_id for update;
  if not found then raise exception 'Not on the waiting list'; end if;
  if v_w.member_id is distinct from current_member_id() and not is_admin() then
    raise exception 'Not your entry';
  end if;
  update waitlist set status = 'left', ended_at = now() where id = p_id and status = 'waiting';
end $$;

-- Cancel a seat. Free until (date − cancel_deadline_days); a seat that came from the waiting list can be
-- declined any time while it is unpaid; the admin always can. Credits come back (v14). The freed seat goes to
-- the waiting list — the names of whoever got it come back ("Anna"), or null.
drop function if exists cancel_booking(uuid);
create function cancel_booking(p_booking_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_b      bookings%rowtype;
  v_set    settings%rowtype;
  v_p      payments%rowtype;
  v_unpaid boolean;
begin
  select * into v_b from bookings where id = p_booking_id for update;
  if not found then raise exception 'Booking not found'; end if;
  if v_b.status <> 'booked' then return null; end if;                 -- already cancelled (a second tap)
  select * into v_set from settings where id = 1;
  if v_b.member_id is distinct from current_member_id() and not is_admin() then
    raise exception 'Not your booking';
  end if;
  select * into v_p from payments where id = v_b.payment_id;
  v_unpaid := (not found) or (v_p.status = 'pending');
  if not is_admin()
     and not (v_b.promoted_at is not null and v_unpaid)
     and current_date > v_b.date - v_set.cancel_deadline_days then
    raise exception 'Too late to cancel for free';
  end if;
  perform 1 from slots where id = v_b.slot_id for update;           -- same lock as book_seat
  update bookings set status = 'cancelled', cancelled_at = now() where id = p_booking_id;
  -- unpaid → cancelled (credits on it come back through the v14 trigger)
  update payments set status = 'cancelled' where id = v_b.payment_id and status in ('pending','claimed');
  -- paid: the Swish part stays (the money is in the account; a refund is a separate step), credits come back
  select * into v_p from payments where id = v_b.payment_id;
  if found and v_p.status = 'confirmed' and v_p.credit_sek > v_p.credit_returned_sek then
    perform credits_return(v_p.id, v_p.credit_sek - v_p.credit_returned_sek, 'booking cancelled');
    if v_p.amount_sek = 0 then
      update payments set status = 'refunded', refunded_at = now() where id = v_p.id;   -- nothing was paid with Swish
    end if;
  end if;
  return waitlist_fill(v_b.slot_id, v_b.date);
end $$;

-- ───────────────────────── 4. the board ─────────────────────────
-- + waiting: how many are on the list for that session (the return type changes → drop first)
drop function if exists week_board(date);
create function week_board(week_start date)
returns table (slot_id uuid, date date, weekday int, session session_kind,
               start_time time, end_time time, capacity int,
               instructor_name text, taken int, seats_left int, waiting int)
language sql stable as $$
  select s.id, week_start + (s.weekday - 1), s.weekday, s.session,
         s.start_time, s.end_time, s.capacity,
         i.name,
         count(b.id)::int,
         (s.capacity - count(b.id))::int,
         (select count(*)::int from waitlist w
            where w.slot_id = s.id and w.date = week_start + (s.weekday - 1) and w.status = 'waiting')
  from slots s
  left join members i on i.id = s.instructor_id
  left join bookings b on b.slot_id = s.id
       and b.date = week_start + (s.weekday - 1) and b.status = 'booked'
  group by s.id, i.name
  order by s.weekday, s.session;
$$;

-- ───────────────────────── 5. who sees what ─────────────────────────
-- everyone logged in sees the list (names in order, like the roster); changes go through the functions above
alter table waitlist enable row level security;
drop policy if exists waitlist_read on waitlist;
create policy waitlist_read on waitlist for select using (auth.uid() is not null);
drop policy if exists waitlist_admin on waitlist;
create policy waitlist_admin on waitlist for all using (is_admin());
grant select on waitlist to authenticated;
