-- Minhwa Association member app — schema v1
-- Core (members / charges / payments / settings) + Seats module (slots / bookings / regular_seats)
-- Run once in Supabase SQL Editor on a fresh project.

create extension if not exists "pgcrypto";

-- ───────────────────────── CORE ─────────────────────────

create type member_role as enum ('member', 'instructor', 'admin');
create type charge_kind as enum ('seat', 'order');
create type charge_status as enum ('unpaid', 'pending', 'paid', 'waived');
create type payment_method as enum ('swish', 'credit', 'bank');

create table members (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  phone       text unique,                  -- E.164, e.g. +46701234567 (login key)
  email       text unique,                  -- for linking to minhwa.org later
  role        member_role not null default 'member',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table settings (
  id                    int primary key default 1 check (id = 1),   -- single row
  seat_price_sek        int not null default 100,
  swish_number          text not null default '1231968098',
  swish_payee_name      text not null default 'Minhwa Association',
  booking_window_weeks  int not null default 2,     -- how far ahead members can book
  cancel_deadline_days  int not null default 1,     -- free cancel until N days before
  max_extra_seats       int not null default 3      -- bookings allowed beyond capacity (shown as "extra")
);
insert into settings (id) values (1);

create table charges (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members(id),
  kind        charge_kind not null,
  ref_id      uuid,                          -- bookings.id or (later) orders.id
  amount_sek  int not null,
  status      charge_status not null default 'unpaid',
  note        text,                          -- e.g. "22/9 Tue Day · Anna" (Swish message)
  created_at  timestamptz not null default now()
);

create table payments (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid references members(id),  -- null until matched
  charge_id    uuid references charges(id),  -- null until matched
  method       payment_method not null,
  amount_sek   int not null,
  payer_phone  text,                         -- from Swish statement
  message      text,                         -- from Swish statement
  paid_at      timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- ───────────────────────── SEATS ─────────────────────────

create type session_kind as enum ('day', 'evening');
create type booking_status as enum ('booked', 'cancelled');

create table slots (
  id             uuid primary key default gen_random_uuid(),
  weekday        int not null check (weekday between 1 and 5),   -- 1 = Mon … 5 = Fri
  session        session_kind not null,
  start_time     time not null,
  end_time       time not null,
  capacity       int not null default 5,                         -- members (instructor not counted)
  instructor_id  uuid references members(id),
  unique (weekday, session)
);

insert into slots (weekday, session, start_time, end_time)
select d, s, case s when 'day' then '10:00' else '17:00' end::time,
             case s when 'day' then '16:00' else '20:00' end::time
from generate_series(1, 5) d, unnest(array['day','evening']::session_kind[]) s;

create table bookings (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members(id),
  slot_id     uuid not null references slots(id),
  date        date not null,
  status      booking_status not null default 'booked',
  charge_id   uuid references charges(id),
  created_at  timestamptz not null default now(),
  cancelled_at timestamptz
);
-- one live booking per member per slot-date
create unique index bookings_live_unique
  on bookings (member_id, slot_id, date) where status = 'booked';

create table regular_seats (
  member_id  uuid primary key references members(id) on delete cascade,
  slot_id    uuid not null references slots(id)
);

-- ───────────────────────── HELPERS ─────────────────────────

create or replace function is_admin() returns boolean
language sql stable security definer as $$
  select exists (select 1 from members where id = auth.uid() and role = 'admin');
$$;

-- New auth user (phone login) → members row
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, auth as $$
begin
  insert into public.members (id, phone, name)
  values (
    new.id,
    case when new.phone is null then null
         when left(new.phone, 1) = '+' then new.phone
         else '+' || new.phone end,
    coalesce(new.raw_user_meta_data->>'name', 'New member')
  )
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function handle_new_user();

-- Weekly board: one row per slot × date for the week starting on week_start (a Monday)
create or replace function week_board(week_start date)
returns table (slot_id uuid, date date, weekday int, session session_kind,
               start_time time, end_time time, capacity int,
               instructor_name text, taken int, seats_left int)
language sql stable as $$
  select s.id, week_start + (s.weekday - 1), s.weekday, s.session,
         s.start_time, s.end_time, s.capacity,
         i.name,
         count(b.id)::int,
         (s.capacity - count(b.id))::int
  from slots s
  left join members i on i.id = s.instructor_id
  left join bookings b on b.slot_id = s.id
       and b.date = week_start + (s.weekday - 1) and b.status = 'booked'
  group by s.id, i.name
  order by s.weekday, s.session;
$$;

-- Book a seat: checks window, capacity, duplicates; creates charge; returns booking id
create or replace function book_seat(p_slot_id uuid, p_date date)
returns uuid language plpgsql security definer as $$
declare
  v_slot   slots%rowtype;
  v_set    settings%rowtype;
  v_taken  int;
  v_charge uuid;
  v_book   uuid;
  v_name   text;
begin
  select * into v_slot from slots where id = p_slot_id;
  select * into v_set  from settings where id = 1;
  if extract(isodow from p_date) <> v_slot.weekday then
    raise exception 'Date does not match slot weekday';
  end if;
  if p_date < current_date or p_date > current_date + v_set.booking_window_weeks * 7 then
    raise exception 'Outside booking window';
  end if;
  select count(*) into v_taken from bookings
    where slot_id = p_slot_id and date = p_date and status = 'booked';
  -- capacity is a display threshold ("Full"), not a hard stop; extra seats allowed up to max_extra_seats
  if v_taken >= v_slot.capacity + v_set.max_extra_seats then
    raise exception 'No more seats (including extra)';
  end if;

  select name into v_name from members where id = auth.uid();
  insert into charges (member_id, kind, amount_sek, note)
  values (auth.uid(), 'seat', v_set.seat_price_sek,
          to_char(p_date, 'DD/MM') || ' ' || to_char(p_date, 'Dy') || ' ' ||
          initcap(v_slot.session::text) || ' - ' || v_name)
  returning id into v_charge;

  insert into bookings (member_id, slot_id, date, charge_id)
  values (auth.uid(), p_slot_id, p_date, v_charge)
  returning id into v_book;

  update charges set ref_id = v_book where id = v_charge;
  return v_book;
end $$;

-- Cancel: free until (date - cancel_deadline_days); admins always
create or replace function cancel_booking(p_booking_id uuid)
returns void language plpgsql security definer as $$
declare
  v_b   bookings%rowtype;
  v_set settings%rowtype;
begin
  select * into v_b from bookings where id = p_booking_id;
  select * into v_set from settings where id = 1;
  if v_b.member_id <> auth.uid() and not is_admin() then
    raise exception 'Not your booking';
  end if;
  if not is_admin() and current_date > v_b.date - v_set.cancel_deadline_days then
    raise exception 'Too late to cancel for free';
  end if;
  update bookings set status = 'cancelled', cancelled_at = now() where id = p_booking_id;
  update charges set status = 'waived' where id = v_b.charge_id and status <> 'paid';
end $$;

-- Member says "I paid" → pending; admin confirms → paid
create or replace function mark_pending(p_charge_id uuid) returns void
language sql security definer as $$
  update charges set status = 'pending'
  where id = p_charge_id and member_id = auth.uid() and status = 'unpaid';
$$;

create or replace function confirm_paid(p_charge_id uuid) returns void
language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'Admin only'; end if;
  update charges set status = 'paid' where id = p_charge_id;
end $$;

-- ───────────────────────── RLS ─────────────────────────

alter table members       enable row level security;
alter table settings      enable row level security;
alter table charges       enable row level security;
alter table payments      enable row level security;
alter table slots         enable row level security;
alter table bookings      enable row level security;
alter table regular_seats enable row level security;

-- everyone logged in can read who's who (names on the roster); only self / admin can edit
create policy members_read   on members for select using (auth.uid() is not null);
create policy members_self   on members for update using (id = auth.uid() or is_admin());
create policy members_admin  on members for all using (is_admin());

create policy settings_read  on settings for select using (auth.uid() is not null);
create policy settings_admin on settings for update using (is_admin());

create policy slots_read     on slots for select using (auth.uid() is not null);
create policy slots_admin    on slots for all using (is_admin());

-- bookings visible to all members (roster), written only through book_seat / cancel_booking
create policy bookings_read  on bookings for select using (auth.uid() is not null);
create policy bookings_admin on bookings for all using (is_admin());

create policy regular_read   on regular_seats for select using (auth.uid() is not null);
create policy regular_self   on regular_seats for all using (member_id = auth.uid() or is_admin());

create policy charges_own    on charges for select using (member_id = auth.uid() or is_admin());
create policy charges_admin  on charges for all using (is_admin());

create policy payments_own   on payments for select using (member_id = auth.uid() or is_admin());
create policy payments_admin on payments for all using (is_admin());
