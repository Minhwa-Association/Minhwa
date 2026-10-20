-- Migration v19.2 — holidays: close days (or only the Day or Evening session) so nobody can book (2026-10-20)
-- Run once in Supabase SQL Editor (after v16.2 — it does not need v17–v19). Safe to run again.
--
-- What this adds
--   * closures — a holiday: first day · last day · the whole day, or only Day / only Evening · a short reason
--     members see ("Christmas", "Höstlov"). Only the admin sets one (Admin → Holidays).
--   * On a holiday nobody can book a seat or join a waiting list (the same check as "no teacher", v16.1),
--     and a freed seat never goes to a waiting list.
--   * Setting a holiday cancels the seats already booked in it, exactly like the admin's ×:
--       paid (confirmed)            → the whole price back as credits (v16.2)
--       "I have paid", not confirmed → stays claimed; credits when the treasurer confirms it (v16.2)
--       not paid                    → cancelled
--       on a monthly pass           → freed (counts no more for the week / the upcoming cap)
--     Waiting lists on those days are closed. Each cancelled seat and closed list entry remembers the holiday,
--     so My seats can say why.
--   * Reopening a holiday (Admin → Holidays → Reopen) lets members book again. Seats it cancelled stay
--     cancelled (credits stay with the member) — members book again themselves.
--   * week_board gains closed_reason: the board shows "Holiday · <reason>" instead of seats.

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'seat_paid_to_credits') then
    raise exception 'Run migration_v16_2_cancel_credits.sql first';
  end if;
end $$;

-- ───────────────────────── 1. the holidays ─────────────────────────
create table if not exists closures (
  id          uuid primary key default gen_random_uuid(),
  date_from   date not null,
  date_to     date not null,
  session     session_kind,                                   -- null = the whole day
  reason      text not null,
  created_by  uuid references members(id),
  created_at  timestamptz not null default now(),
  reopened_at timestamptz,                                    -- set → no longer closed (kept for the record)
  reopened_by uuid references members(id),
  constraint closures_dates check (date_to >= date_from),
  constraint closures_reason check (length(btrim(reason)) between 1 and 60)
);
create index if not exists closures_live on closures (date_from, date_to) where reopened_at is null;

-- which holiday cancelled a seat / closed a waiting-list entry
alter table bookings add column if not exists closure_id uuid references closures(id);
alter table waitlist add column if not exists closure_id uuid references closures(id);

-- everyone logged in reads them (the board, the seat page, My seats); changes only through the functions below
alter table closures enable row level security;
drop policy if exists closures_read on closures;
create policy closures_read on closures for select using (auth.uid() is not null);
grant select on closures to authenticated;

-- the live holiday for a session on a date (null when open)
create or replace function closure_for(p_slot_id uuid, p_date date) returns closures
language sql stable security definer set search_path = public as $$
  select c.* from closures c join slots s on s.id = p_slot_id
   where c.reopened_at is null
     and p_date between c.date_from and c.date_to
     and (c.session is null or c.session = s.session)
   order by c.created_at
   limit 1;
$$;

-- ───────────────────────── 2. nobody books on a holiday ─────────────────────────
-- as in v16.1 (no teacher = closed) + a holiday. Runs before every new seat and every new waiting-list entry,
-- so book_seat and join_waitlist both stop with this message.
create or replace function guard_closed_slot() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_c closures;
begin
  if exists (select 1 from slots where id = new.slot_id and instructor_id is null) then
    raise exception 'This session has no teacher yet, so it is not open for booking';
  end if;
  v_c := closure_for(new.slot_id, new.date);
  if v_c.id is not null then
    raise exception 'Closed for a holiday (%) — nobody can book this session', v_c.reason;
  end if;
  return new;
end $$;

drop trigger if exists bookings_closed_slot on bookings;
create trigger bookings_closed_slot before insert on bookings
  for each row when (new.status = 'booked') execute function guard_closed_slot();

drop trigger if exists waitlist_closed_slot on waitlist;
create trigger waitlist_closed_slot before insert on waitlist
  for each row when (new.status = 'waiting') execute function guard_closed_slot();

-- waitlist_fill as in v16.1 + a holiday gives no seats from its list (so cancelling there never trips the check)
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
  if exists (select 1 from slots where id = p_slot_id and instructor_id is null) then return null; end if;   -- v16.1: closed
  if (closure_for(p_slot_id, p_date)).id is not null then return null; end if;                            -- v19.2: holiday
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

-- join_waitlist as in v15 + a holiday says so first (otherwise its empty seats would say "book it instead")
create or replace function join_waitlist(p_slot_id uuid, p_date date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me    uuid := current_member_id();
  v_slot  slots%rowtype;
  v_set   settings%rowtype;
  v_taken int;
  v_id    uuid;
  v_c     closures;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  select * into v_slot from slots where id = p_slot_id for update;
  if not found then raise exception 'Session not found'; end if;
  v_c := closure_for(p_slot_id, p_date);
  if v_c.id is not null then
    raise exception 'Closed for a holiday (%) — nobody can book this session', v_c.reason;
  end if;
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

-- ───────────────────────── 3. the admin: look first · close · reopen ─────────────────────────
-- What closing these days would do: one row per seat booked (state paid / claimed / unpaid / pass) and per
-- waiting-list entry (state waiting), from today on. Changes nothing.
create or replace function closure_preview(p_from date, p_to date, p_session session_kind default null)
returns table (date date, session session_kind, member_name text, state text, amount int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only the admin can set holidays'; end if;
  return query
    select b.date, s.session, coalesce(m.name, 'Member'),
           case when b.payment_id is null then 'pass'
                when p.status = 'confirmed' then 'paid'
                when p.status = 'claimed' then 'claimed'
                else 'unpaid' end,
           coalesce(p.amount_sek + coalesce(p.credit_sek, 0), 0)::int
      from bookings b
      join slots s on s.id = b.slot_id
      left join members m on m.id = b.member_id
      left join payments p on p.id = b.payment_id
     where b.status = 'booked'
       and b.date between greatest(p_from, current_date) and p_to
       and (p_session is null or s.session = p_session)
    union all
    select w.date, s.session, coalesce(m.name, 'Member'), 'waiting', 0
      from waitlist w
      join slots s on s.id = w.slot_id
      left join members m on m.id = w.member_id
     where w.status = 'waiting'
       and w.date between greatest(p_from, current_date) and p_to
       and (p_session is null or s.session = p_session)
    order by 1, 2, 4, 3;
end $$;

-- Close the days. Returns what it did: {"id", "cancelled", "credits" (given now), "claimed", "waiting"}.
create or replace function create_closure(p_from date, p_to date, p_session session_kind, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid;
  v_b       record;
  v_n       int := 0;
  v_credits int := 0;
  v_claimed int := 0;
  v_w       int := 0;
  v_before  int;
begin
  if not is_admin() then raise exception 'Only the admin can set holidays'; end if;
  if p_from is null or p_to is null then raise exception 'Choose the first and the last day'; end if;
  if p_to < p_from then raise exception 'The last day is before the first day'; end if;
  if p_to < current_date then raise exception 'These days have passed already'; end if;
  if p_to > p_from + 366 then raise exception 'At most one year at a time'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Write a short reason — members see it on the board'; end if;
  if length(btrim(p_reason)) > 60 then raise exception 'Keep the reason short (60 letters at most)'; end if;

  insert into closures (date_from, date_to, session, reason, created_by)
  values (p_from, p_to, p_session, btrim(p_reason), current_member_id())
  returning id into v_id;

  -- seats already booked: cancelled like the admin's × (v16.2) — the holiday is in place first, so no
  -- freed seat goes to a waiting list
  for v_b in
    select b.id, b.member_id, b.payment_id
      from bookings b join slots s on s.id = b.slot_id
     where b.status = 'booked'
       and b.date between greatest(p_from, current_date) and p_to
       and (p_session is null or s.session = p_session)
     order by b.date, s.session, b.created_at
     for update of b
  loop
    v_before := credit_balance_of(v_b.member_id);
    perform cancel_booking(v_b.id);
    v_credits := v_credits + (credit_balance_of(v_b.member_id) - v_before);
    if exists (select 1 from payments where id = v_b.payment_id and status = 'claimed') then
      v_claimed := v_claimed + 1;
    end if;
    update bookings set closure_id = v_id where id = v_b.id;
    v_n := v_n + 1;
  end loop;

  -- waiting lists on those days are closed
  update waitlist w set status = 'left', ended_at = now(), closure_id = v_id
    from slots s
   where s.id = w.slot_id and w.status = 'waiting'
     and w.date between greatest(p_from, current_date) and p_to
     and (p_session is null or s.session = p_session);
  get diagnostics v_w = row_count;

  return jsonb_build_object('id', v_id, 'cancelled', v_n, 'credits', v_credits, 'claimed', v_claimed, 'waiting', v_w);
end $$;

-- Open the days again. Seats it cancelled stay cancelled; members book again themselves.
create or replace function reopen_closure(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only the admin can change holidays'; end if;
  update closures set reopened_at = now(), reopened_by = current_member_id()
   where id = p_id and reopened_at is null;
end $$;

-- ───────────────────────── 4. the board ─────────────────────────
-- week_board as in v15 + closed_reason (the return type changes → drop first)
drop function if exists week_board(date);
create function week_board(week_start date)
returns table (slot_id uuid, date date, weekday int, session session_kind,
               start_time time, end_time time, capacity int,
               instructor_name text, taken int, seats_left int, waiting int,
               closed_reason text)
language sql stable as $$
  select s.id, week_start + (s.weekday - 1), s.weekday, s.session,
         s.start_time, s.end_time, s.capacity,
         i.name,
         count(b.id)::int,
         (s.capacity - count(b.id))::int,
         (select count(*)::int from waitlist w
            where w.slot_id = s.id and w.date = week_start + (s.weekday - 1) and w.status = 'waiting'),
         (select c.reason from closures c
            where c.reopened_at is null
              and week_start + (s.weekday - 1) between c.date_from and c.date_to
              and (c.session is null or c.session = s.session)
            order by c.created_at limit 1)
  from slots s
  left join members i on i.id = s.instructor_id
  left join bookings b on b.slot_id = s.id
       and b.date = week_start + (s.weekday - 1) and b.status = 'booked'
  group by s.id, i.name
  order by s.weekday, s.session;
$$;
