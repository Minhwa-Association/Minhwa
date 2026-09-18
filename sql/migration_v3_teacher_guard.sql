-- Migration v3 — a slot's teacher cannot book a member seat in their own slot
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
  if v_slot.instructor_id = v_me then
    raise exception 'You are the teacher for this session';
  end if;
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
