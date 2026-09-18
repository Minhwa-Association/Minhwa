-- Migration v2 — pre-registration
-- Admin can add members/teachers by name + phone before they ever log in.
-- On first login the auth user is linked to the pre-registered row by phone.
-- Run once in Supabase SQL Editor (after schema_v1.sql).

-- 1. members.id becomes an independent id; auth user is linked via auth_id
alter table members drop constraint if exists members_id_fkey;
alter table members alter column id set default gen_random_uuid();
alter table members add column if not exists auth_id uuid unique references auth.users(id) on delete set null;
update members set auth_id = id where auth_id is null
  and exists (select 1 from auth.users u where u.id = members.id);

-- 2. helpers
create or replace function norm_phone(p text) returns text
language sql immutable as $$
  select case
    when p is null then null
    when left(regexp_replace(p, '[^0-9+]', '', 'g'), 2) = '00' then '+' || substr(regexp_replace(p, '[^0-9+]', '', 'g'), 3)
    when left(regexp_replace(p, '[^0-9+]', '', 'g'), 1) = '0'  then '+46' || substr(regexp_replace(p, '[^0-9+]', '', 'g'), 2)
    when left(regexp_replace(p, '[^0-9+]', '', 'g'), 1) = '+'  then regexp_replace(p, '[^0-9+]', '', 'g')
    else '+' || regexp_replace(p, '[^0-9+]', '', 'g') end;
$$;

create or replace function current_member_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from members where auth_id = auth.uid();
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where auth_id = auth.uid() and role = 'admin');
$$;

-- 3. new auth user → link to pre-registered row by phone, else create
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, auth as $$
declare
  v_phone text := norm_phone(new.phone);
  v_id uuid;
begin
  update public.members set auth_id = new.id
    where phone = v_phone and auth_id is null
    returning id into v_id;
  if v_id is null then
    insert into public.members (auth_id, phone, name)
    values (new.id, v_phone, coalesce(new.raw_user_meta_data->>'name', 'New member'))
    on conflict (auth_id) do nothing;
  end if;
  return new;
end $$;

-- 4. admin pre-registers (or updates) a member by phone
create or replace function admin_add_member(p_name text, p_phone text, p_role member_role default 'member')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_phone text := norm_phone(p_phone);
  v_id uuid;
begin
  if not is_admin() then raise exception 'Admin only'; end if;
  if v_phone is null or length(v_phone) < 8 then raise exception 'Phone number looks wrong'; end if;
  insert into members (name, phone, role) values (p_name, v_phone, p_role)
  on conflict (phone) do update set name = excluded.name, role = excluded.role
  returning id into v_id;
  return v_id;
end $$;

-- 5. functions that used auth.uid() as the member id
create or replace function book_seat(p_slot_id uuid, p_date date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me     uuid := current_member_id();
  v_slot   slots%rowtype;
  v_set    settings%rowtype;
  v_taken  int;
  v_charge uuid;
  v_book   uuid;
  v_name   text;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
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
  if v_taken >= v_slot.capacity + v_set.max_extra_seats then
    raise exception 'No more seats (including extra)';
  end if;
  select name into v_name from members where id = v_me;
  insert into charges (member_id, kind, amount_sek, note)
  values (v_me, 'seat', v_set.seat_price_sek,
          to_char(p_date, 'DD/MM') || ' ' || to_char(p_date, 'Dy') || ' ' ||
          initcap(v_slot.session::text) || ' - ' || v_name)
  returning id into v_charge;
  insert into bookings (member_id, slot_id, date, charge_id)
  values (v_me, p_slot_id, p_date, v_charge)
  returning id into v_book;
  update charges set ref_id = v_book where id = v_charge;
  return v_book;
end $$;

create or replace function cancel_booking(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_b   bookings%rowtype;
  v_set settings%rowtype;
begin
  select * into v_b from bookings where id = p_booking_id;
  select * into v_set from settings where id = 1;
  if v_b.member_id <> current_member_id() and not is_admin() then
    raise exception 'Not your booking';
  end if;
  if not is_admin() and current_date > v_b.date - v_set.cancel_deadline_days then
    raise exception 'Too late to cancel for free';
  end if;
  update bookings set status = 'cancelled', cancelled_at = now() where id = p_booking_id;
  update charges set status = 'waived' where id = v_b.charge_id and status <> 'paid';
end $$;

create or replace function mark_pending(p_charge_id uuid) returns void
language sql security definer set search_path = public as $$
  update charges set status = 'pending'
  where id = p_charge_id and member_id = current_member_id() and status = 'unpaid';
$$;

-- 6. policies that compared ids with auth.uid()
drop policy if exists members_self  on members;
create policy members_self  on members for update using (auth_id = auth.uid() or is_admin());
drop policy if exists regular_self  on regular_seats;
create policy regular_self  on regular_seats for all using (member_id = current_member_id() or is_admin());
drop policy if exists charges_own   on charges;
create policy charges_own   on charges for select using (member_id = current_member_id() or is_admin());
drop policy if exists payments_own  on payments;
create policy payments_own  on payments for select using (member_id = current_member_id() or is_admin());
