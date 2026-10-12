-- Migration v16.2 — a paid seat that is cancelled gives its money back as credits (2026-10-13)
-- Run once in Supabase SQL Editor (after v16.1). Safe to run again.
--
-- What changes (1 credit = 1 kr; credits work for seats and the Store)
--   * Cancel a seat whose money the treasurer has confirmed (the member before the deadline, or the admin):
--     the whole price comes back as credits — the credits put on it, as before, and now the Swish part too.
--     The money stays in the association's account: the payment stays "confirmed", payments.credited_sek
--     says how much of the Swish part became credits, and the credits are what the association now owes.
--   * Cancel a seat the member said they paid ("I have paid"), not confirmed yet: the payment stays "claimed"
--     so the bank line can still find it. Credits on it come back at once; the Swish part comes back as
--     credits when the treasurer confirms it (bank line, or by hand). Money never came → the treasurer taps
--     "Never came" (drop_claimed_payment) → cancelled.
--   * Cancel a seat nobody said was paid: the payment is cancelled as before — but if the money turns up in the
--     bank after all, the line still finds it (code, or amount + name + date, after open payments) and the
--     treasurer can pick it by hand. Confirming it gives the credits.
--   * Taking such a confirmation back (Undo) takes those credits back — only while the member still has them.
--   * Seats cancelled earlier after "I have paid" (set to cancelled by the old rule) go back to claimed, so the
--     treasurer sees them under Waiting for confirmation and decides: confirm (→ credits) or Never came.
--   * Nothing changes for seats on a monthly pass (nothing was paid) or for cancelling after the deadline.

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'bookings_closed_slot') then
    raise exception 'Run migration_v16_1_six_seats.sql first';
  end if;
end $$;

-- ───────────────────────── 1. how much of the Swish part became credits ─────────────────────────
alter table payments add column if not exists credited_sek int not null default 0;
alter table payments add column if not exists never_came_at timestamptz;      -- "Never came" (treasurer)
alter table payments drop constraint if exists payments_credited_check;
alter table payments add constraint payments_credited_check check (credited_sek >= 0 and credited_sek <= amount_sek);

-- a seat payment that was never confirmed and whose booking was cancelled — money for it may still turn up
create or replace function seat_cancelled_unpaid(p payments) returns boolean
language sql stable security definer set search_path = public as $$
  select p.kind = 'seat' and p.status = 'cancelled' and p.credited_sek = 0
     and exists (select 1 from bookings b where b.id = p.ref_id and b.status = 'cancelled');
$$;

-- ───────────────────────── 2. paid + cancelled → credits (internal) ─────────────────────────
-- Gives back as credits whatever is still owed on a confirmed seat payment whose booking is cancelled.
-- Does nothing for anything else, and never twice. Returns the credits given now.
create or replace function seat_paid_to_credits(p_payment_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_p payments%rowtype;
  v_n int := 0;
  v_swish int;
begin
  select * into v_p from payments where id = p_payment_id for update;
  if not found or v_p.kind <> 'seat' or v_p.status <> 'confirmed' then return 0; end if;
  if not exists (select 1 from bookings where id = v_p.ref_id and status = 'cancelled') then return 0; end if;
  if v_p.credit_sek > v_p.credit_returned_sek then
    v_n := credits_return(v_p.id, v_p.credit_sek - v_p.credit_returned_sek, 'booking cancelled');
  end if;
  v_swish := v_p.amount_sek - v_p.credited_sek;
  if v_swish > 0 then
    insert into credit_movements (member_id, amount, kind, payment_id, note, created_by)
    values (v_p.member_id, v_swish, 'return', v_p.id,
            credit_payment_text(v_p) || ' · booking cancelled — paid with Swish', current_member_id());
    update payments set credited_sek = credited_sek + v_swish where id = v_p.id;
    v_n := v_n + v_swish;
  end if;
  return v_n;
end $$;

-- confirmed later (money seen after the seat was cancelled) → credits; Undo of that → credits taken back
create or replace function payments_seat_credit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind <> 'seat' then return null; end if;
  if new.status = 'confirmed' and old.status is distinct from 'confirmed' then
    perform seat_paid_to_credits(new.id);
  elsif old.status = 'confirmed' and new.status in ('pending','claimed') and new.credited_sek > 0 then
    if credit_balance_of(new.member_id) < new.credited_sek then
      raise exception 'The member has already used the credits from this cancelled seat — it cannot be undone';
    end if;
    insert into credit_movements (member_id, amount, kind, payment_id, note, created_by)
    values (new.member_id, -new.credited_sek, 'adjust', new.id,
            credit_payment_text(new) || ' · confirmation taken back', current_member_id());
    -- back to how it was before the money was seen: claimed stays claimed, otherwise cancelled again
    update payments set credited_sek = 0,
                        status = case when new.status = 'pending' then 'cancelled' else new.status end
     where id = new.id;
  end if;
  return null;
end $$;
drop trigger if exists payments_seat_credit on payments;
create trigger payments_seat_credit after update of status on payments
  for each row execute function payments_seat_credit();

-- ───────────────────────── 3. cancel a seat ─────────────────────────
-- cancel_booking as in v15 + a claimed payment stays claimed, a confirmed one comes back as credits
create or replace function cancel_booking(p_booking_id uuid)
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
  -- not paid → cancelled (credits on it come back through the v14 trigger). If the money turns up in the bank
  -- after all, the line can still find this payment (v16.2) and confirming it gives the credits.
  update payments set status = 'cancelled' where id = v_b.payment_id and status = 'pending';
  select * into v_p from payments where id = v_b.payment_id;
  -- "I have paid", not confirmed yet (v16.2): stays claimed so the bank line can still find it. Credits on it
  -- come back now; the Swish part comes back as credits when the treasurer confirms it.
  if v_p.id is not null and v_p.status = 'claimed' and v_p.credit_sek > v_p.credit_returned_sek then
    perform credits_return(v_p.id, v_p.credit_sek - v_p.credit_returned_sek, 'booking cancelled');
  end if;
  -- confirmed (v16.2): everything comes back as credits — the credits on it and the Swish part
  if v_p.id is not null and v_p.status = 'confirmed' then
    perform seat_paid_to_credits(v_p.id);
    if v_p.amount_sek = 0 then
      update payments set status = 'refunded', refunded_at = now() where id = v_p.id;   -- nothing was paid with Swish
    end if;
  end if;
  return waitlist_fill(v_b.slot_id, v_b.date);
end $$;

-- ───────────────────────── 4. the treasurer ─────────────────────────
-- confirm_payment as in v8 + money that turns up for a cancelled, unpaid seat can be confirmed (→ credits)
create or replace function confirm_payment(p_payment_id uuid, p_tx_id uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := current_member_id();
  v_p  payments%rowtype;
  v_t  bank_transactions%rowtype;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select * into v_p from payments where id = p_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_p.status not in ('pending','claimed','confirmed') and not seat_cancelled_unpaid(v_p) then
    raise exception 'This payment is %', v_p.status;
  end if;
  if p_tx_id is not null then
    select * into v_t from bank_transactions where id = p_tx_id for update;
    if not found then raise exception 'Bank line not found'; end if;
    if v_t.status = 'outgoing' then raise exception 'That line is money going out'; end if;
    if v_t.status = 'confirmed' and v_t.payment_id is distinct from p_payment_id then
      raise exception 'That bank line is already used for another payment';
    end if;
    if exists (select 1 from bank_transactions x where x.payment_id = p_payment_id and x.id <> p_tx_id) then
      raise exception 'This payment is already tied to another bank line';
    end if;
    update bank_transactions
       set status = 'confirmed', payment_id = p_payment_id, decided_at = now(), decided_by = v_me
     where id = p_tx_id;
    -- remember the name the bank shows for this member, so the next line matches by itself
    if v_p.member_id is not null and name_key(v_t.counterparty) <> '' then
      update members
         set bank_names = array(select distinct x from unnest(bank_names || array[name_key(v_t.counterparty)]) x order by x)
       where id = v_p.member_id and not (name_key(v_t.counterparty) = any(bank_names));
    end if;
  end if;
  update payments
     set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now())
   where id = p_payment_id;
end $$;

-- match_bank_transactions as in v8 + cancelled, unpaid seats can still be found (after open payments)
create or replace function match_bank_transactions() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t record;
  v_pay uuid;
  v_code text;
  v_matched int := 0;
  v_suggested int := 0;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  for t in select * from bank_transactions where status = 'unmatched' and amount_sek > 0 order by booked_on, imported_at, id loop
    v_pay := null;
    v_code := substring(upper(coalesce(t.message, '') || ' ' || t.title) from '\m([SOM]\d{4,6})\M');
    if v_code is not null then
      select p.id into v_pay from payments p
       where p.code = v_code and (p.status in ('pending','claimed') or seat_cancelled_unpaid(p))
         and not exists (select 1 from bank_transactions x where x.payment_id = p.id);
      if v_pay is not null then
        update bank_transactions set status = 'matched', payment_id = v_pay where id = t.id;
        v_matched := v_matched + 1;
        continue;
      end if;
    end if;

    select p.id into v_pay
      from payments p
      join members m on m.id = p.member_id
      left join bookings b on b.id = p.ref_id and p.kind = 'seat'
      cross join lateral (select (p.created_at at time zone 'Europe/Stockholm')::date as created_on) c
     where (p.status in ('pending','claimed') or seat_cancelled_unpaid(p))
       and p.amount_sek = t.amount_sek
       and not exists (select 1 from bank_transactions x where x.payment_id = p.id)
       and (names_match(t.counterparty, m.name)
            or name_key(t.counterparty) = any(m.bank_names)
            or (length(t.counterparty) >= 19 and name_prefix_match(t.counterparty, m.name)))
       and t.booked_on between c.created_on - 1
                           and greatest(c.created_on, coalesce(b.date, c.created_on + 23)) + 7
     order by case p.status when 'claimed' then 0 when 'pending' then 1 else 2 end, p.created_at
     limit 1;
    if v_pay is not null then
      update bank_transactions set status = 'suggested', payment_id = v_pay where id = t.id;
      v_suggested := v_suggested + 1;
    end if;
  end loop;
  return jsonb_build_object('matched', v_matched, 'suggested', v_suggested);
end $$;

-- "Never came": a claimed payment of a cancelled seat whose money did not arrive → cancelled
create or replace function drop_claimed_payment(p_payment_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update payments set status = 'cancelled', never_came_at = now()
   where id = p_payment_id and status = 'claimed' and kind = 'seat'
     and exists (select 1 from bookings b where b.id = payments.ref_id and b.status = 'cancelled');
  if not found then raise exception 'Only a claimed payment of a cancelled seat can be closed this way'; end if;
end $$;

-- payments_view as in v14 + credited_sek
create or replace view payments_view with (security_invoker = true) as
select p.id, p.code, p.kind, p.status, p.amount_sek, p.note, p.member_id, p.ref_id,
       p.created_at, p.claimed_at, p.confirmed_at, p.refunded_at,
       m.name  as member_name,
       b.date  as booking_date,
       b.status as booking_status,
       s.session, s.weekday,
       t.id    as bank_tx_id,
       t.booked_on as bank_date,
       t.counterparty as bank_name,
       o.id    as order_id,
       (select string_agg(i.qty || '× ' || i.name, ', ' order by i.name) from order_items i where i.order_id = o.id) as items_summary,
       p.credit_sek, p.credit_returned_sek,
       p.credited_sek
from payments p
left join members m on m.id = p.member_id
left join bookings b on b.id = p.ref_id and p.kind = 'seat'
left join slots s on s.id = b.slot_id
left join bank_transactions t on t.payment_id = p.id
left join orders o on o.payment_id = p.id;

-- ───────────────────────── 5. seats cancelled before v16.2 ─────────────────────────
-- Seats cancelled after the member tapped "I have paid" were set to cancelled. Under the rule above they stay
-- claimed — so they come back to Payments → Waiting for confirmation, where the treasurer confirms them
-- (money came → credits) or taps "Never came". Not those already closed with "Never came", not those a bank
-- line is tied to — so running this file again changes nothing.
update payments p set status = 'claimed'
 where p.kind = 'seat' and p.status = 'cancelled' and p.claimed_at is not null and p.credited_sek = 0
   and p.never_came_at is null
   and exists (select 1 from bookings b where b.id = p.ref_id and b.status = 'cancelled')
   and not exists (select 1 from bank_transactions t where t.payment_id = p.id);

-- only the functions in this file call these
do $$
declare r text; f text;
begin
  foreach f in array array['seat_paid_to_credits(uuid)', 'seat_cancelled_unpaid(payments)'] loop
    execute format('revoke execute on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke execute on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
end $$;
