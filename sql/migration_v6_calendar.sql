-- Migration v6 — shared calendar
-- Run once in Supabase SQL Editor (after v5). Safe to run again.
--
-- * events: activities the association prepares (exhibitions, fairs, meetings…)
--   - Crew and Admin can add / edit / delete
--   - each event has an audience: everyone, or only some roles (Admin always sees all)
-- * calendar_tokens: one private link per member for their phone calendar (webcal / ICS feed)

-- 1. events -----------------------------------------------------------------
create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  date        date not null,
  end_date    date,                              -- multi-day: last day (inclusive); null = one day
  start_time  time,                              -- null = all day
  end_time    time,
  location    text,
  notes       text,
  audience    text[] not null default '{}',      -- {} = everyone; else roles who can see it
  created_by  uuid references members(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint events_audience_check check (audience <@ array['teacher','crew']),
  constraint events_dates_check    check (end_date is null or end_date >= date),
  constraint events_times_check    check (end_date is not null or start_time is null or end_time is null or end_time > start_time)
);
create index if not exists events_date_idx on events (date);

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists events_touch on events;
create trigger events_touch before update on events
  for each row execute function touch_updated_at();

-- 2. helpers ----------------------------------------------------------------
create or replace function my_roles() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce((select roles from members where auth_id = auth.uid()), '{}'::text[]);
$$;

create or replace function can_edit_events() returns boolean
language sql stable security definer set search_path = public as $$
  select my_roles() && array['crew','admin'];
$$;

-- 3. who sees / edits what --------------------------------------------------
alter table events enable row level security;

drop policy if exists events_read on events;
create policy events_read on events for select using (
  auth.uid() is not null and (
       audience = '{}'
    or audience && my_roles()
    or 'admin' = any(my_roles())
    or created_by = current_member_id()
  )
);
drop policy if exists events_insert on events;
create policy events_insert on events for insert with check (can_edit_events());
drop policy if exists events_update on events;
create policy events_update on events for update using (can_edit_events()) with check (can_edit_events());
drop policy if exists events_delete on events;
create policy events_delete on events for delete using (can_edit_events());

-- 4. personal calendar links ------------------------------------------------
create table if not exists calendar_tokens (
  member_id   uuid primary key references members(id) on delete cascade,
  token       uuid not null unique default gen_random_uuid(),
  created_at  timestamptz not null default now()
);
alter table calendar_tokens enable row level security;
drop policy if exists caltok_own on calendar_tokens;
create policy caltok_own on calendar_tokens for select using (member_id = current_member_id());

-- my link (created on first use)
create or replace function my_calendar_token() returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := current_member_id();
  v    uuid;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  insert into calendar_tokens (member_id) values (v_me) on conflict (member_id) do nothing;
  select token into v from calendar_tokens where member_id = v_me;
  return v;
end $$;

-- new link; the old one stops working
create or replace function reset_calendar_token() returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := current_member_id();
  v    uuid;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  insert into calendar_tokens (member_id, token) values (v_me, gen_random_uuid())
  on conflict (member_id) do update set token = gen_random_uuid()
  returning token into v;
  return v;
end $$;

-- events for one link — called by the phone's calendar app, without login
create or replace function events_for_token(p_token uuid)
returns setof events
language plpgsql stable security definer set search_path = public as $$
declare
  m members%rowtype;
begin
  select mm.* into m
    from members mm join calendar_tokens t on t.member_id = mm.id
    where t.token = p_token and mm.active;
  if not found then raise exception 'Unknown calendar link'; end if;
  return query
    select e.* from events e
    where e.audience = '{}' or e.audience && m.roles or 'admin' = any(m.roles) or e.created_by = m.id
    order by e.date, e.start_time;
end $$;
