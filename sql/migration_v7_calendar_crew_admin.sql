-- Migration v7 — calendar is for Crew and Admin only
-- Run once in Supabase SQL Editor (after v6). Safe to run again.
--
-- Members and teachers no longer see the calendar at all.
-- An event's audience is now either {} (Crew and Admin) or {admin} (Admin only).

-- 1. existing events: everything becomes "Crew and Admin"
alter table events drop constraint if exists events_audience_check;
update events set audience = '{}' where audience <> '{admin}';
alter table events add constraint events_audience_check check (audience <@ array['admin']);

-- 2. who can open the calendar at all
create or replace function can_use_calendar() returns boolean
language sql stable security definer set search_path = public as $$
  select my_roles() && array['crew','admin'];
$$;

-- 3. read rule: must be Crew/Admin; "Admin only" events need admin (or being the creator)
drop policy if exists events_read on events;
create policy events_read on events for select using (
  can_use_calendar() and (
       audience = '{}'
    or 'admin' = any(my_roles())
    or created_by = current_member_id()
  )
);

-- 4. calendar links: only Crew/Admin get one, and a link stops working if the role is removed
create or replace function my_calendar_token() returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := current_member_id();
  v    uuid;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  if not can_use_calendar() then raise exception 'Calendar is for Crew and Admin'; end if;
  insert into calendar_tokens (member_id) values (v_me) on conflict (member_id) do nothing;
  select token into v from calendar_tokens where member_id = v_me;
  return v;
end $$;

create or replace function events_for_token(p_token uuid)
returns setof events
language plpgsql stable security definer set search_path = public as $$
declare
  m members%rowtype;
begin
  select mm.* into m
    from members mm join calendar_tokens t on t.member_id = mm.id
    where t.token = p_token and mm.active and mm.roles && array['crew','admin'];
  if not found then raise exception 'Unknown calendar link'; end if;
  return query
    select e.* from events e
    where e.audience = '{}' or 'admin' = any(m.roles) or e.created_by = m.id
    order by e.date, e.start_time;
end $$;
