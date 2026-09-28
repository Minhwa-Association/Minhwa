-- Migration v14 — Credits: Crew help with the association's activities and get credits instead of pay
-- Run once in Supabase SQL Editor (after v13). Safe to run again.
--
--   * 1 credit = 1 kr. The Treasurer (or Admin) gives credits to a member for an activity (optionally tied
--     to a Calendar event). Credits do not expire.
--   * credit_movements is the whole story: grant (+) · spend (−, on a payment) · return (+, a cancelled or
--     refunded payment) · adjust (±, a correction). The balance is the sum and can never go below 0.
--     A grant that is not used yet can be taken back (voided).
--   * Spending: a member can put their credits on any of their unpaid payments — a Store order (the Store
--     form ticks "use my credits" by default) or a seat ("Pay with credits" on the pay page). Credits cover
--     as much as they can, Swish pays the rest. payments.amount_sek stays "what to pay with Swish", so the
--     bank matching is unchanged; payments.credit_sek is the part paid with credits. Nothing left to pay
--     → the payment is confirmed at once (order lines turn "paid").
--   * Giving back: cancelling an order or booking returns the credits on it; refunding an order line gives
--     credits back first, and only the rest is sent with Swish. A cancelled seat that was paid with credits
--     gets its credits back (the Swish part follows the usual rule).
--   * Unused credits are what the association owes its members — shown on Payments → Credits.

do $$
begin
  if to_regclass('public.payments') is null or to_regclass('public.bank_transactions') is null then raise exception 'Run migration_v8_payments.sql first'; end if;
  if to_regclass('public.order_items') is null then raise exception 'Run migration_v9_store.sql first'; end if;
  if to_regclass('public.purchase_batches') is null then raise exception 'Run migration_v11_group_orders.sql first'; end if;
  if to_regclass('public.expense_claims') is null then raise exception 'Run migration_v13_receipts.sql first'; end if;
end $$;

-- ───────────────────────── 1. tables ─────────────────────────
create table if not exists credit_movements (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members(id),
  amount      int  not null check (amount <> 0),                   -- + in · − out (1 credit = 1 kr)
  kind        text not null check (kind in ('grant','spend','return','adjust')),
  note        text,                                                -- "Art fair booth, Saturday" · "O0012 · Store"
  event_id    uuid references events(id) on delete set null,       -- grant: the activity in the Calendar
  payment_id  uuid references payments(id) on delete set null,     -- spend / return: the payment
  order_item_id uuid references order_items(id) on delete set null,-- return for one refunded line
  created_by  uuid references members(id) on delete set null,
  created_at  timestamptz not null default now(),
  voided_at   timestamptz,                                         -- a grant taken back (not counted)
  voided_by   uuid references members(id) on delete set null,
  constraint credit_sign_check check (
       (kind in ('grant','return') and amount > 0)
    or (kind = 'spend' and amount < 0)
    or  kind = 'adjust'),
  constraint credit_void_check check (voided_at is null or kind in ('grant','adjust'))
);
create index if not exists credit_movements_member_idx on credit_movements (member_id, created_at);
create index if not exists credit_movements_payment_idx on credit_movements (payment_id) where payment_id is not null;

-- the part of a payment paid with credits, and how much of it has gone back
alter table payments add column if not exists credit_sek          int not null default 0;
alter table payments add column if not exists credit_returned_sek int not null default 0;
alter table payments drop constraint if exists payments_credit_check;
alter table payments add constraint payments_credit_check
  check (credit_sek >= 0 and credit_returned_sek >= 0 and credit_returned_sek <= credit_sek);

-- ───────────────────────── 2. balance ─────────────────────────
-- internal: anyone's balance (the functions below only)
create or replace function credit_balance_of(p_member_id uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0)::int from credit_movements where member_id = p_member_id and voided_at is null;
$$;

create or replace function my_credits() returns int
language sql stable security definer set search_path = public as $$
  select credit_balance_of(current_member_id());
$$;

-- the balance may never go below 0 — whatever wrote the row
create or replace function credit_balance_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  v := credit_balance_of(new.member_id);
  if v < 0 then
    raise exception 'Not enough credits — the balance would be % credits', v;
  end if;
  return null;
end $$;
drop trigger if exists credit_balance_guard on credit_movements;
create trigger credit_balance_guard after insert or update on credit_movements
  for each row execute function credit_balance_guard();

-- what a payment is, in a few words: "S0231 · seat 05/10 Day" · "O0012 · Store"
create or replace function credit_payment_text(p payments) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(p.code || ' · ', '') ||
    case p.kind
      when 'seat' then coalesce((select 'seat ' || to_char(b.date, 'DD/MM') || ' ' || initcap(s.session::text)
                                   from bookings b join slots s on s.id = b.slot_id where b.id = p.ref_id), 'seat')
      when 'material' then 'Store'
      when 'membership' then 'membership'
      else p.kind end;
$$;

-- ───────────────────────── 3. using and giving back (internal) ─────────────────────────
-- put as many credits as the member has on an unpaid payment; nothing left → confirmed
create or replace function credits_use(p_payment_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_p   payments%rowtype;
  v_bal int;
  v_use int;
begin
  select * into v_p from payments where id = p_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_p.status <> 'pending' then return 0; end if;
  perform 1 from members where id = v_p.member_id for update;    -- one spend at a time per member
  v_bal := credit_balance_of(v_p.member_id);
  v_use := least(v_bal, v_p.amount_sek);
  if v_use <= 0 then return 0; end if;
  insert into credit_movements (member_id, amount, kind, payment_id, note, created_by)
  values (v_p.member_id, -v_use, 'spend', v_p.id, credit_payment_text(v_p), current_member_id());
  update payments
     set amount_sek   = amount_sek - v_use,
         credit_sek   = credit_sek + v_use,
         status       = case when amount_sek - v_use = 0 then 'confirmed' else status end,
         confirmed_at = case when amount_sek - v_use = 0 then now() else confirmed_at end
   where id = v_p.id;
  return v_use;
end $$;

-- give credits back from a payment (cancelled, refunded, a refunded line)
create or replace function credits_return(p_payment_id uuid, p_amount int, p_note text, p_item_id uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_p    payments%rowtype;
  v_back int;
begin
  select * into v_p from payments where id = p_payment_id for update;
  if not found then return 0; end if;
  v_back := least(coalesce(p_amount, 0), v_p.credit_sek - v_p.credit_returned_sek);
  if v_back <= 0 then return 0; end if;
  insert into credit_movements (member_id, amount, kind, payment_id, order_item_id, note, created_by)
  values (v_p.member_id, v_back, 'return', v_p.id, p_item_id,
          credit_payment_text(v_p) || coalesce(' · ' || nullif(trim(p_note), ''), ''), current_member_id());
  update payments set credit_returned_sek = credit_returned_sek + v_back where id = v_p.id;
  return v_back;
end $$;

-- a payment that is cancelled or refunded gives back whatever credits are still on it
create or replace function payments_credit_return() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('cancelled','refunded') and old.status is distinct from new.status
     and new.credit_sek > new.credit_returned_sek then
    perform credits_return(new.id, new.credit_sek - new.credit_returned_sek,
                           case new.status when 'cancelled' then 'cancelled' else 'refunded' end);
  end if;
  return null;
end $$;
drop trigger if exists payments_credit_return on payments;
create trigger payments_credit_return after update of status on payments
  for each row execute function payments_credit_return();

-- only the functions in this file call these
do $$
declare r text; f text;
begin
  foreach f in array array['credit_balance_of(uuid)', 'credits_use(uuid)', 'credits_return(uuid, int, text, uuid)', 'credit_payment_text(payments)'] loop
    execute format('revoke execute on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke execute on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
end $$;

-- ───────────────────────── 4. the member ─────────────────────────
-- "Use my credits" on one of my unpaid payments → how many were used
create or replace function apply_credits(p_payment_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_p payments%rowtype;
begin
  select * into v_p from payments where id = p_payment_id;
  if not found then raise exception 'Payment not found'; end if;
  if v_p.member_id is distinct from current_member_id() then raise exception 'Not your payment'; end if;
  if v_p.status = 'claimed' then raise exception 'You have already said you paid this with Swish — ask the treasurer'; end if;
  if v_p.status <> 'pending' then raise exception 'This is already %', v_p.status; end if;
  if credit_balance_of(v_p.member_id) <= 0 then raise exception 'You have no credits'; end if;
  return credits_use(p_payment_id);
end $$;

-- "Pay all with Swish instead": take the credits off a payment that is still unpaid
create or replace function release_credits(p_payment_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_p payments%rowtype; v_n int;
begin
  select * into v_p from payments where id = p_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_p.member_id is distinct from current_member_id() and not can_use_payments() then raise exception 'Not your payment'; end if;
  if v_p.status <> 'pending' then raise exception 'Credits can be taken off only before paying (this is %)', v_p.status; end if;
  v_n := v_p.credit_sek - v_p.credit_returned_sek;
  if v_n <= 0 then return 0; end if;
  insert into credit_movements (member_id, amount, kind, payment_id, note, created_by)
  values (v_p.member_id, v_n, 'return', v_p.id, credit_payment_text(v_p) || ' · not used', current_member_id());
  update payments set amount_sek = amount_sek + v_n, credit_sek = credit_returned_sek where id = v_p.id;
  return v_n;
end $$;

-- ───────────────────────── 5. the Treasurer ─────────────────────────
-- give credits for an activity; note or event says what for
create or replace function give_credits(p_member_id uuid, p_amount int, p_note text default null, p_event_id uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_note text := nullif(trim(coalesce(p_note, '')), ''); v_ev events%rowtype; v_id uuid;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  if not exists (select 1 from members where id = p_member_id) then raise exception 'Member not found'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Give at least 1 credit'; end if;
  if p_amount > 10000 then raise exception 'That is more than 10 000 credits at once — check the amount'; end if;
  if p_event_id is not null then
    select * into v_ev from events where id = p_event_id;
    if not found then raise exception 'Activity not found'; end if;
    v_note := coalesce(v_note, v_ev.title || ' · ' || to_char(v_ev.date, 'DD/MM'));
  end if;
  if v_note is null then raise exception 'Say what the credits are for'; end if;
  insert into credit_movements (member_id, amount, kind, note, event_id, created_by)
  values (p_member_id, p_amount, 'grant', left(v_note, 200), p_event_id, current_member_id())
  returning id into v_id;
  return v_id;
end $$;

-- a correction, + or − (e.g. credits given on paper before the app)
create or replace function adjust_credits(p_member_id uuid, p_amount int, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'Enter a number of credits, + or −'; end if;
  if abs(p_amount) > 10000 then raise exception 'That is more than 10 000 credits at once — check the amount'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Say why the balance is corrected'; end if;
  perform 1 from members where id = p_member_id for update;
  if not found then raise exception 'Member not found'; end if;
  insert into credit_movements (member_id, amount, kind, note, created_by)
  values (p_member_id, p_amount, 'adjust', left(trim(p_note), 200), current_member_id())
  returning id into v_id;
  return v_id;
end $$;

-- take a grant (or correction) back — only while the member still has the credits
create or replace function void_credits(p_movement_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_m credit_movements%rowtype; v_bal int;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select * into v_m from credit_movements where id = p_movement_id for update;
  if not found then raise exception 'Not found'; end if;
  if v_m.kind not in ('grant','adjust') then raise exception 'Only credits that were given can be taken back'; end if;
  if v_m.voided_at is not null then raise exception 'Already taken back'; end if;
  perform 1 from members where id = v_m.member_id for update;
  v_bal := credit_balance_of(v_m.member_id);
  if v_bal - v_m.amount < 0 then
    raise exception 'Already used — the member has % credits left, this gave %', v_bal, v_m.amount;
  end if;
  update credit_movements set voided_at = now(), voided_by = current_member_id() where id = p_movement_id;
end $$;

-- activities to pick from when giving credits (last 90 days … next 30)
create or replace function credit_events() returns table (id uuid, title text, date date)
language sql stable security definer set search_path = public as $$
  select e.id, e.title, e.date from events e
   where can_use_payments()
     and e.date between current_date - 90 and current_date + 30
     and (e.audience = '{}' or is_admin())
   order by e.date desc, e.title;
$$;

-- ───────────────────────── 6. cancelling and refunding (rewritten for credits) ─────────────────────────
-- place_order gets "use my credits"
drop function if exists place_order(jsonb, text);
create or replace function place_order(p_items jsonb, p_note text default null, p_use_credits boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me    uuid := current_member_id();
  v_name  text;
  v_n     int;
  v_bad   int;
  v_total int;
  v_code  text;
  v_pay   uuid;
  v_order uuid;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  select name into v_name from members where id = v_me;

  with wanted as (
    select x.product_id, sum(x.qty)::int as qty
      from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(product_id uuid, qty int)
     where x.product_id is not null and coalesce(x.qty, 0) > 0
     group by x.product_id)
  select count(*), count(*) filter (where p.id is null or not p.active), coalesce(sum(w.qty * p.price_sek), 0)
    into v_n, v_bad, v_total
    from wanted w left join products p on p.id = w.product_id;
  if v_n = 0 then raise exception 'Nothing to order — choose at least one item'; end if;
  if v_bad > 0 then raise exception 'One of the products is no longer on the list'; end if;

  v_code := next_payment_code('material');
  insert into payments (member_id, kind, amount_sek, code, note)
  values (v_me, 'material', v_total, v_code, v_code || ' Store ' || v_name)
  returning id into v_pay;
  insert into orders (member_id, payment_id, note) values (v_me, v_pay, nullif(trim(p_note), ''))
  returning id into v_order;
  update payments set ref_id = v_order where id = v_pay;

  with wanted as (
    select x.product_id, sum(x.qty)::int as qty
      from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(product_id uuid, qty int)
     where x.product_id is not null and coalesce(x.qty, 0) > 0
     group by x.product_id)
  insert into order_items (order_id, product_id, qty, unit_price_sek, name)
  select v_order, p.id, w.qty, p.price_sek,
         p.name || coalesce(' · ' || nullif(p.variant, ''), '') || coalesce(' · ' || nullif(p.maker, ''), '')
    from wanted w join products p on p.id = w.product_id
   order by p.sort;

  if coalesce(p_use_credits, false) then
    perform credits_use(v_pay);          -- the lines exist now, so "paid" reaches them
  end if;
  return v_order;
end $$;

-- a cancelled seat paid with credits gets them back; a seat paid only with credits becomes "refunded"
create or replace function cancel_booking(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_b   bookings%rowtype;
  v_set settings%rowtype;
  v_p   payments%rowtype;
begin
  select * into v_b from bookings where id = p_booking_id;
  if not found then raise exception 'Booking not found'; end if;
  select * into v_set from settings where id = 1;
  if v_b.member_id is distinct from current_member_id() and not is_admin() then
    raise exception 'Not your booking';
  end if;
  if not is_admin() and current_date > v_b.date - v_set.cancel_deadline_days then
    raise exception 'Too late to cancel for free';
  end if;
  update bookings set status = 'cancelled', cancelled_at = now() where id = p_booking_id;
  -- unpaid → cancelled (credits on it come back through the trigger)
  update payments set status = 'cancelled' where id = v_b.payment_id and status in ('pending','claimed');
  -- paid: the Swish part stays (the money is in the account; a refund is a separate step), credits come back
  select * into v_p from payments where id = v_b.payment_id;
  if found and v_p.status = 'confirmed' and v_p.credit_sek > v_p.credit_returned_sek then
    perform credits_return(v_p.id, v_p.credit_sek - v_p.credit_returned_sek, 'booking cancelled');
    if v_p.amount_sek = 0 then
      update payments set status = 'refunded', refunded_at = now() where id = v_p.id;   -- nothing was paid with Swish
    end if;
  end if;
end $$;

-- same as v9 (credits on it come back through the trigger); "not mine" check made null-safe
create or replace function cancel_order(p_order_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_o orders%rowtype; v_p payments%rowtype;
begin
  select * into v_o from orders where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;
  if v_o.member_id is distinct from current_member_id() and not can_use_payments() then raise exception 'Not your order'; end if;
  select * into v_p from payments where id = v_o.payment_id;
  if v_p.status not in ('pending','claimed') then
    raise exception 'This order is already paid — ask the treasurer';
  end if;
  update payments set status = 'cancelled' where id = v_p.id;   -- the triggers cancel the lines and give credits back
end $$;

-- a refunded line gives credits back first; only the rest is sent with Swish
drop function if exists refund_order_item(uuid, text);
create or replace function refund_order_item(p_item_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_i order_items%rowtype; v_pay uuid; v_left int; v_value int; v_credits int := 0;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select * into v_i from order_items where id = p_item_id for update;
  if not found then raise exception 'Line not found'; end if;
  if v_i.status not in ('paid','group_buy') then raise exception 'Only a paid line that has not been handed out can be refunded (this one is %)', replace(v_i.status, '_', ' '); end if;
  update order_items set status = 'refunded', batch_id = null where id = p_item_id;
  select o.payment_id into v_pay from orders o where o.id = v_i.order_id;
  v_value := v_i.qty * v_i.unit_price_sek;
  v_credits := credits_return(v_pay, v_value, 'refund ' || v_i.qty || '× ' || v_i.name, p_item_id);
  select count(*) into v_left from order_items where order_id = v_i.order_id and status not in ('refunded','cancelled');
  if v_left = 0 then
    update payments set status = 'refunded', refunded_at = now() where id = v_pay and status = 'confirmed';
  end if;
  if p_note is not null and trim(p_note) <> '' then
    update orders set note = coalesce(note || ' · ', '') || 'Refund: ' || trim(p_note) where id = v_i.order_id;
  end if;
  return jsonb_build_object('credits', v_credits, 'swish', v_value - v_credits);
end $$;

-- a payment paid only with credits has nothing in the bank to take back
create or replace function undo_confirmation(p_payment_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  if exists (select 1 from payments where id = p_payment_id and amount_sek = 0 and credit_sek > 0) then
    raise exception 'Paid with credits — cancel the booking or refund the order line instead';
  end if;
  if exists (select 1 from order_items i join orders o on o.id = i.order_id
              where o.payment_id = p_payment_id and i.status in ('preparing','group_buy','ready','collected')) then
    raise exception 'Items of this order are already being handled — cannot undo the payment';
  end if;
  update bank_transactions set status = 'unmatched', payment_id = null, decided_at = null, decided_by = null
   where payment_id = p_payment_id and status = 'confirmed';
  update payments
     set status = case when claimed_at is not null then 'claimed' else 'pending' end, confirmed_at = null
   where id = p_payment_id and status = 'confirmed';
end $$;

-- ───────────────────────── 7. views ─────────────────────────
-- payments_view / orders_view: + the credit part (amount_sek = what is paid with Swish)
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
       p.credit_sek, p.credit_returned_sek
from payments p
left join members m on m.id = p.member_id
left join bookings b on b.id = p.ref_id and p.kind = 'seat'
left join slots s on s.id = b.slot_id
left join bank_transactions t on t.payment_id = p.id
left join orders o on o.payment_id = p.id;

create or replace view orders_view with (security_invoker = true) as
select o.id, o.member_id, m.name as member_name, o.note, o.created_at,
       p.id as payment_id, p.code, p.status as payment_status, p.amount_sek + p.credit_sek as total_sek, p.claimed_at, p.confirmed_at,
       (select count(*)::int from order_items i where i.order_id = o.id) as item_count,
       (select string_agg(i.qty || '× ' || i.name, ', ' order by i.name) from order_items i where i.order_id = o.id) as items_summary,
       case
         when p.status in ('cancelled','refunded') then p.status
         when p.status in ('pending','claimed') then 'awaiting_payment'
         when exists (select 1 from order_items i where i.order_id = o.id and i.status = 'ready') then 'ready'
         when exists (select 1 from order_items i where i.order_id = o.id and i.status in ('paid','preparing','group_buy')) then 'in_progress'
         else 'collected'
       end as status,
       p.amount_sek as swish_sek, p.credit_sek, p.credit_returned_sek
from orders o
join members m on m.id = o.member_id
left join payments p on p.id = o.payment_id;

-- one row per member who has ever had credits (a member sees only their own)
create or replace view credit_balances with (security_invoker = true) as
select m.id as member_id, m.name, m.roles, m.active,
       coalesce(sum(c.amount) filter (where c.voided_at is null), 0)::int as balance,
       coalesce(sum(c.amount) filter (where c.voided_at is null and c.kind = 'grant'
                  and c.created_at >= (date_trunc('year', now() at time zone 'Europe/Stockholm') at time zone 'Europe/Stockholm')), 0)::int as granted_this_year,
       coalesce(sum(c.amount) filter (where c.voided_at is null and c.kind = 'grant'), 0)::int as granted_total,
       max(c.created_at) as last_at
from credit_movements c
join members m on m.id = c.member_id
group by m.id, m.name, m.roles, m.active;

create or replace view credit_history with (security_invoker = true) as
select c.id, c.member_id, m.name as member_name, c.amount, c.kind, c.note, c.event_id, c.payment_id, c.order_item_id,
       c.created_at, c.voided_at,
       p.code as payment_code,
       cb.name as created_by_name,
       vb.name as voided_by_name
from credit_movements c
join members m on m.id = c.member_id
left join payments p on p.id = c.payment_id
left join members cb on cb.id = c.created_by
left join members vb on vb.id = c.voided_by;

-- ───────────────────────── 8. who sees what ─────────────────────────
-- read only: every change goes through the functions above
alter table credit_movements enable row level security;
drop policy if exists credits_read on credit_movements;
create policy credits_read on credit_movements for select using (member_id = current_member_id() or can_use_payments());

grant select on credit_movements, credit_balances, credit_history to authenticated;
