-- Migration v19.5 — a Saturday class (2026-11-02)
-- Run once in Supabase SQL Editor (after v19.2). Safe to run again.
--
-- What changes
--   * Slots may now be on Saturday (weekday 6) as well as Monday–Friday.
--   * One new session: Saturday "Day" 14:00–17:00, 5 members (the weekday sessions stay at 6).
--     It is closed (0/0) until the admin picks its teacher in Settings → Teachers per slot, like any session.
--   * Nothing else changes: the week on the board runs Monday–Saturday, a "Twice a week" pass counts
--     Saturday in the same week, holidays and the waiting list work the same.

do $$
begin
  if to_regclass('public.closures') is null then raise exception 'Run migration_v19_2_holidays.sql first'; end if;
end $$;

-- 1. Saturday allowed
alter table slots drop constraint if exists slots_weekday_check;
alter table slots add constraint slots_weekday_check check (weekday between 1 and 6);

-- 2. the new session (left alone when it already exists — change times or seats in the table if needed)
insert into slots (weekday, session, start_time, end_time, capacity)
values (6, 'day', '14:00', '17:00', 5)
on conflict (weekday, session) do nothing;
