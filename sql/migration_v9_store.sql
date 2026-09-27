-- Migration v9 — Store, step 2a: products · stock · orders paid with Swish
-- Run once in Supabase SQL Editor (after v8). Safe to run again.
--
-- What this adds
--   * products: the materials list (imported from the old inventory app, 25 items, 2026-09-27).
--     On the list (active) = can be ordered even at stock 0 — it then waits for the next group order.
--   * stock_movements: every change of stock (opening · adjust · sale · purchase · return); products.stock follows.
--   * orders + order_items: a member picks quantities → one order, one payment (kind = material, code O0001…,
--     Swish message "O0001 Store <name>") → "I have paid" → the treasurer confirms in Payments (v8) →
--     lines become "paid" → treasurer hands them out from stock ("ready") → member collects ("collected").
--     Lines that are not in stock wait for the group order (step 2b: purchase batches, requests).
--   * payments_view gains order columns; orders_view for lists.

do $$
begin
  if to_regclass('public.payments') is null or to_regclass('public.bank_transactions') is null then
    raise exception 'Run migration_v8_payments.sql first';
  end if;
end $$;

-- ───────────────────────── 1. products ─────────────────────────
create table if not exists products (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,                 -- the old app's product string, e.g. "BarimBrush-백산S"
  category     text not null,                        -- Brush · Paper · Colour
  subcategory  text,                                 -- Colour brush · Barim brush · Line brush · Accessory · Hanji · Bongchae · Bunchae
  name         text not null,                        -- "Barim brush"
  variant      text,                                 -- "S" · "중 (M)" · "12 colours" · "15호"
  maker        text,                                 -- "백산" · "유시덕" · "구하산방"
  price_sek    int not null check (price_sek >= 0),  -- member price, whole kronor
  stock        int not null default 0,               -- kept in step with stock_movements (trigger)
  min_stock    int not null default 5,               -- at or below = "Low"; 0 = "Out"
  active       boolean not null default true,        -- on the Store list
  sort         int not null default 0,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
drop trigger if exists products_touch on products;
create trigger products_touch before update on products
  for each row execute function touch_updated_at();

create table if not exists stock_movements (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references products(id) on delete cascade,
  qty            int not null check (qty <> 0),      -- + in, − out
  kind           text not null check (kind in ('opening','adjust','sale','purchase','return')),
  order_item_id  uuid,                                -- for 'sale' (FK added below)
  note           text,
  created_by     uuid references members(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists stock_movements_product_idx on stock_movements (product_id, created_at);

create or replace function stock_movement_apply() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update products set stock = stock + new.qty where id = new.product_id;
  return new;
end $$;
drop trigger if exists stock_movement_apply on stock_movements;
create trigger stock_movement_apply after insert on stock_movements
  for each row execute function stock_movement_apply();

-- ───────────────────────── 2. orders ─────────────────────────
create table if not exists orders (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members(id),
  payment_id  uuid unique references payments(id),   -- one payment per order (kind = material)
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists orders_touch on orders;
create trigger orders_touch before update on orders
  for each row execute function touch_updated_at();

create table if not exists order_items (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id) on delete cascade,
  product_id      uuid not null references products(id),
  qty             int not null check (qty > 0),
  unit_price_sek  int not null,                       -- price when ordered
  name            text not null,                      -- "Barim brush · S · 백산" when ordered
  status          text not null default 'awaiting_payment'
                  check (status in ('awaiting_payment','paid','preparing','group_buy','ready','collected','cancelled','refunded')),
  batch_id        uuid,                               -- step 2b: purchase_batches
  updated_at      timestamptz not null default now()
);
create index if not exists order_items_order_idx on order_items (order_id);
create index if not exists order_items_status_idx on order_items (status);
drop trigger if exists order_items_touch on order_items;
create trigger order_items_touch before update on order_items
  for each row execute function touch_updated_at();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_movements_order_item_id_fkey') then
    alter table stock_movements add constraint stock_movements_order_item_id_fkey
      foreign key (order_item_id) references order_items(id) on delete set null;
  end if;
end $$;

-- ───────────────────────── 3. payment status → order lines ─────────────────────────
-- confirmed → lines "paid" · cancelled/refunded → lines follow · confirmation undone → lines back to awaiting
create or replace function payments_to_order_items() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_order uuid;
begin
  if new.kind <> 'material' or new.status = old.status then return new; end if;
  select id into v_order from orders where payment_id = new.id;
  if v_order is null then return new; end if;
  if new.status = 'confirmed' then
    update order_items set status = 'paid' where order_id = v_order and status = 'awaiting_payment';
  elsif new.status in ('cancelled','refunded') then
    update order_items set status = new.status where order_id = v_order and status in ('awaiting_payment','paid');
  elsif new.status in ('pending','claimed') and old.status = 'confirmed' then
    update order_items set status = 'awaiting_payment' where order_id = v_order and status = 'paid';
  end if;
  return new;
end $$;
drop trigger if exists payments_to_order_items on payments;
create trigger payments_to_order_items after update of status on payments
  for each row execute function payments_to_order_items();

-- taking a confirmation back is only possible while nothing has been handed out
create or replace function undo_confirmation(p_payment_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
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

-- ───────────────────────── 4. member: order · cancel ─────────────────────────
-- p_items: [{"product_id": "...", "qty": 2}, …]  → returns the order id
create or replace function place_order(p_items jsonb, p_note text default null) returns uuid
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
  return v_order;
end $$;

-- a member can cancel while the order is not paid; the treasurer too (a paid order needs a refund — later step)
create or replace function cancel_order(p_order_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_o orders%rowtype; v_p payments%rowtype;
begin
  select * into v_o from orders where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;
  if v_o.member_id <> current_member_id() and not can_use_payments() then raise exception 'Not your order'; end if;
  select * into v_p from payments where id = v_o.payment_id;
  if v_p.status not in ('pending','claimed') then
    raise exception 'This order is already paid — ask the treasurer';
  end if;
  update payments set status = 'cancelled' where id = v_p.id;   -- the trigger cancels the lines
end $$;

-- ───────────────────────── 5. treasurer: stock · hand out · collected ─────────────────────────
create or replace function adjust_stock(p_product_id uuid, p_qty int, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  if p_qty is null or p_qty = 0 then raise exception 'Enter how many to add (+) or take away (−)'; end if;
  insert into stock_movements (product_id, qty, kind, note, created_by)
  values (p_product_id, p_qty, 'adjust', nullif(trim(p_note), ''), current_member_id());
end $$;

-- a paid line taken from the shelf → stock goes down, line is ready to collect
create or replace function fulfil_from_stock(p_item_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_i order_items%rowtype; v_stock int; v_code text;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select * into v_i from order_items where id = p_item_id for update;
  if not found then raise exception 'Line not found'; end if;
  if v_i.status <> 'paid' then raise exception 'This line is %', replace(v_i.status, '_', ' '); end if;
  select stock into v_stock from products where id = v_i.product_id for update;
  if v_stock < v_i.qty then
    raise exception 'Only % in stock — this line waits for the next group order', v_stock;
  end if;
  select p.code into v_code from orders o join payments p on p.id = o.payment_id where o.id = v_i.order_id;
  insert into stock_movements (product_id, qty, kind, order_item_id, note, created_by)
  values (v_i.product_id, -v_i.qty, 'sale', v_i.id, 'Order ' || coalesce(v_code, ''), current_member_id());
  update order_items set status = 'ready' where id = p_item_id;
end $$;

create or replace function mark_collected(p_item_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update order_items set status = 'collected' where id = p_item_id and status = 'ready';
  if not found then raise exception 'Only a line that is ready can be marked as collected'; end if;
end $$;

-- ───────────────────────── 6. views ─────────────────────────
-- payments_view: same columns as v8, plus the order behind a material payment
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
       (select string_agg(i.qty || '× ' || i.name, ', ' order by i.name) from order_items i where i.order_id = o.id) as items_summary
from payments p
left join members m on m.id = p.member_id
left join bookings b on b.id = p.ref_id and p.kind = 'seat'
left join slots s on s.id = b.slot_id
left join bank_transactions t on t.payment_id = p.id
left join orders o on o.payment_id = p.id;

create or replace view orders_view with (security_invoker = true) as
select o.id, o.member_id, m.name as member_name, o.note, o.created_at,
       p.id as payment_id, p.code, p.status as payment_status, p.amount_sek as total_sek, p.claimed_at, p.confirmed_at,
       (select count(*)::int from order_items i where i.order_id = o.id) as item_count,
       (select string_agg(i.qty || '× ' || i.name, ', ' order by i.name) from order_items i where i.order_id = o.id) as items_summary,
       case
         when p.status in ('cancelled','refunded') then p.status
         when p.status in ('pending','claimed') then 'awaiting_payment'
         when exists (select 1 from order_items i where i.order_id = o.id and i.status = 'ready') then 'ready'
         when exists (select 1 from order_items i where i.order_id = o.id and i.status in ('paid','preparing','group_buy')) then 'in_progress'
         else 'collected'
       end as status
from orders o
join members m on m.id = o.member_id
left join payments p on p.id = o.payment_id;

-- ───────────────────────── 7. who sees what ─────────────────────────
alter table products enable row level security;
drop policy if exists products_read on products;
create policy products_read on products for select using (auth.uid() is not null and (active or can_use_payments()));
drop policy if exists products_treasurer on products;
create policy products_treasurer on products for all using (can_use_payments()) with check (can_use_payments());

alter table stock_movements enable row level security;
drop policy if exists stock_treasurer on stock_movements;
create policy stock_treasurer on stock_movements for all using (can_use_payments()) with check (can_use_payments());

alter table orders enable row level security;
drop policy if exists orders_read on orders;
create policy orders_read on orders for select using (member_id = current_member_id() or can_use_payments());
drop policy if exists orders_treasurer on orders;
create policy orders_treasurer on orders for all using (can_use_payments()) with check (can_use_payments());

alter table order_items enable row level security;
drop policy if exists order_items_read on order_items;
create policy order_items_read on order_items for select using (
  exists (select 1 from orders o where o.id = order_id and (o.member_id = current_member_id() or can_use_payments())));
drop policy if exists order_items_treasurer on order_items;
create policy order_items_treasurer on order_items for all using (can_use_payments()) with check (can_use_payments());

-- ───────────────────────── 8. the list as of 2026-09-27 (old inventory app export) ─────────────────────────
-- Stock starts at 0 here; the opening stock is booked as a movement right below, once.
insert into products (code, category, subcategory, name, variant, maker, price_sek, stock, min_stock, active, sort) values
  ('Brush roll', 'Brush', 'Accessory', 'Brush roll', null, null, 50, 0, 5, true, 10),
  ('Hanji-Lacquered-M', 'Paper', 'Hanji', 'Hanji, lacquered', 'M', null, 80, 0, 5, true, 20),
  ('Hanji-배접용s', 'Paper', 'Hanji', 'Hanji, backing paper (배접용)', 'S', null, 25, 0, 5, true, 30),
  ('Hanji-배접용', 'Paper', 'Hanji', 'Hanji, backing paper (배접용)', null, null, 70, 0, 5, true, 40),
  ('Bongchae-12', 'Colour', 'Bongchae', 'Bongchae stick pigments (봉채)', '12 colours', null, 900, 0, 5, false, 50),
  ('Bongchae-44', 'Colour', 'Bongchae', 'Bongchae stick pigments (봉채)', '44 colours', null, 3300, 0, 5, true, 60),
  ('Bunchae-12-유시덕', 'Colour', 'Bunchae', 'Bunchae powder pigments (분채)', '12 colours', '유시덕', 720, 0, 5, true, 70),
  ('Bunchae-24-유시덕', 'Colour', 'Bunchae', 'Bunchae powder pigments (분채)', '24 colours', '유시덕', 1440, 0, 5, true, 80),
  ('ColourBrush-천호필M', 'Brush', 'Colour brush', 'Colour brush 천호필', 'M', null, 250, 0, 5, true, 90),
  ('BarimBrush-백산S', 'Brush', 'Barim brush', 'Barim brush', 'S', '백산', 450, 0, 5, true, 100),
  ('BarimBrush-백산M', 'Brush', 'Barim brush', 'Barim brush', 'M', '백산', 500, 0, 5, true, 110),
  ('Linebrush-FoxEarHair-S-백산', 'Brush', 'Line brush', 'Line brush, fox-ear hair', 'S', '백산', 350, 0, 5, true, 120),
  ('Linebrush-FoxEarHair-M-백산', 'Brush', 'Line brush', 'Line brush, fox-ear hair', 'M', '백산', 450, 0, 5, true, 130),
  ('Linebrush-FoxEarHair-L-백산', 'Brush', 'Line brush', 'Line brush, fox-ear hair', 'L', '백산', 550, 0, 5, true, 140),
  ('ColourBrush-조자필-중', 'Brush', 'Colour brush', 'Colour brush 조자필', '중 (M)', null, 165, 0, 5, true, 150),
  ('ColourBrush-조자필-대', 'Brush', 'Colour brush', 'Colour brush 조자필', '대 (L)', null, 187, 0, 5, true, 160),
  ('ColourBrush-수채색15호', 'Brush', 'Colour brush', 'Colour brush 수채색', '15호', null, 170, 0, 5, true, 170),
  ('ColourBrush-수채색13호', 'Brush', 'Colour brush', 'Colour brush 수채색', '13호', null, 170, 0, 5, true, 180),
  ('BarimBrush-하바림9중', 'Brush', 'Barim brush', 'Barim brush 하바림 9', '중 (M)', null, 250, 0, 5, true, 190),
  ('BarimBrush-강바림', 'Brush', 'Barim brush', 'Barim brush 강바림', null, null, 250, 0, 5, true, 200),
  ('LineBrush-금선필', 'Brush', 'Line brush', 'Line brush 금선필', null, null, 150, 0, 5, true, 210),
  ('ColourBrush-비천', 'Brush', 'Colour brush', 'Colour brush 비천', null, null, 170, 0, 5, true, 220),
  ('ColourBrush-채화-중-구하산방', 'Brush', 'Colour brush', 'Colour brush 채화', '중 (M)', '구하산방', 300, 0, 5, true, 230),
  ('BarimBrush-명암미', 'Brush', 'Barim brush', 'Barim brush 명암미', null, null, 550, 0, 5, true, 240),
  ('Hanji-Lacquered', 'Paper', 'Hanji', 'Hanji, lacquered', null, null, 150, 0, 5, true, 250)
on conflict (code) do nothing;

-- opening stock (inventory-all-2026-09-27.csv) — booked once per product, only where there was any
insert into stock_movements (product_id, qty, kind, note)
select p.id, v.qty, 'opening', 'Inventory 2026-09-27'
  from (values
    ('Hanji-배접용', 40), ('Bongchae-44', 1), ('Bunchae-12-유시덕', 12), ('Bunchae-24-유시덕', 3),
    ('ColourBrush-천호필M', 5), ('BarimBrush-백산S', 1), ('BarimBrush-백산M', 2),
    ('Linebrush-FoxEarHair-S-백산', 1), ('Linebrush-FoxEarHair-M-백산', 3), ('Linebrush-FoxEarHair-L-백산', 2),
    ('ColourBrush-조자필-중', 1), ('ColourBrush-조자필-대', 1), ('ColourBrush-수채색15호', 1), ('ColourBrush-수채색13호', 1),
    ('BarimBrush-하바림9중', 15), ('BarimBrush-강바림', 1), ('LineBrush-금선필', 3), ('ColourBrush-비천', 1),
    ('ColourBrush-채화-중-구하산방', 6), ('BarimBrush-명암미', 1), ('Hanji-Lacquered', 100)
  ) as v(code, qty)
  join products p on p.code = v.code
 where not exists (select 1 from stock_movements s where s.product_id = p.id and s.kind = 'opening');
