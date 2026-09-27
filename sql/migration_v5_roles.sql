-- Migration v5 — several roles per member + members can only change their own name
-- Run once in Supabase SQL Editor (after v4). Safe to run again.
--
-- Everyone is a member. Roles are extra hats, any combination:
--   teacher — can be set as the teacher of a slot
--   crew    — prepares and runs activities (calendar, next step)
--   admin   — admin board and settings

-- 1. roles column (the old single "role" column stays for now, unused; dropped in a later migration)
alter table members add column if not exists roles text[] not null default '{}';
alter table members drop constraint if exists members_roles_check;
alter table members add constraint members_roles_check
  check (roles <@ array['teacher','crew','admin']);

-- 2. carry the old role across — only for rows that have no roles yet
update members set roles = case role::text
    when 'admin'      then array['admin']
    when 'instructor' then array['teacher']
    else '{}'::text[] end
  where roles = '{}';

-- anyone already set as a slot's teacher keeps showing in the teacher list
update members set roles = roles || array['teacher']
  where id in (select instructor_id from slots where instructor_id is not null)
    and not ('teacher' = any(roles));

-- 3. admin check now reads roles
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where auth_id = auth.uid() and 'admin' = any(roles));
$$;

-- 4. pre-register with roles; adding the same phone again merges roles instead of replacing them
drop function if exists admin_add_member(text, text, member_role);
create or replace function admin_add_member(p_name text, p_phone text, p_roles text[] default '{}')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_phone text := norm_phone(p_phone);
  v_id uuid;
begin
  if not is_admin() then raise exception 'Admin only'; end if;
  if v_phone is null or length(v_phone) < 8 then raise exception 'Phone number looks wrong'; end if;
  insert into members (name, phone, roles) values (p_name, v_phone, coalesce(p_roles, '{}'))
  on conflict (phone) do update
    set name  = excluded.name,
        roles = array(select distinct r from unnest(members.roles || excluded.roles) r order by r)
  returning id into v_id;
  return v_id;
end $$;

-- 5. guard: a member may change only their own name.
--    roles / phone / active / email / account link → admin only.
create or replace function guard_member_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- admin, or server-side work with no logged-in user (SQL Editor, first-login linking)
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
  return new;
end $$;

drop trigger if exists members_guard on members;
create trigger members_guard before update on members
  for each row execute function guard_member_columns();
