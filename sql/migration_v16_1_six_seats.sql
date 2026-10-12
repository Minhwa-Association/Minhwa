-- Migration v16.1 — six seats per session · a session without a teacher is closed (2026-10-13)
-- Run once in Supabase SQL Editor (after v16). Safe to run again.
--
-- What changes
--   * Every session takes 6 members (slots.capacity 5 → 6; the teacher is not counted). New sessions get 6.
--     Waiting lists of upcoming sessions move up at once into the new 6th seat (normal booking + payment,
--     as when someone cancels).
--   * A session with no teacher (slots.instructor_id empty) is closed: no new seats at all — nobody can
--     book it or join its waiting list, and its waiting list does not move up. The app shows it as 0/0
--     with no dots and it can't be opened from the board. Seats booked before the teacher was taken off
--     stay (and can still be cancelled); people on its list stay waiting. Choosing a teacher in Settings
--     opens it again (the list then moves up at the next booking or cancellation).

do $$
begin
  if to_regclass('public.passes') is null then raise exception 'Run migration_v16_passes.sql first'; end if;
end $$;

-- ───────────────────────── 1. closed when there is no teacher ─────────────────────────
-- Checked on every new seat and every new waiting-list entry — so book_seat and join_waitlist both stop
-- with this message. waitlist_fill (below) skips a closed session, so cancelling a seat there still works.
create or replace function guard_closed_slot() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from slots where id = new.slot_id and instructor_id is null) then
    raise exception 'This session has no teacher yet, so it is not open for booking';
  end if;
  return new;
end $$;

drop trigger if exists bookings_closed_slot on bookings;
create trigger bookings_closed_slot before insert on bookings
  for each row when (new.status = 'booked') execute function guard_closed_slot();

drop trigger if exists waitlist_closed_slot on waitlist;
create trigger waitlist_closed_slot before insert on waitlist
  for each row when (new.status = 'waiting') execute function guard_closed_slot();

-- waitlist_fill as in v15 + a closed session gives no seats from its list (so cancel_booking there never trips
-- the check above)
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

-- ───────────────────────── 2. six seats ─────────────────────────
alter table slots alter column capacity set default 6;
update slots set capacity = 6 where capacity <> 6;

-- the new 6th seat goes to the first in line wherever someone is waiting (upcoming sessions with a teacher)
do $$
declare r record;
begin
  for r in
    select distinct w.slot_id, w.date
      from waitlist w join slots s on s.id = w.slot_id
     where w.status = 'waiting' and w.date >= current_date and s.instructor_id is not null
  loop
    perform waitlist_fill(r.slot_id, r.date);
  end loop;
end $$;
