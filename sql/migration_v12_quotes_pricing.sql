-- Migration v12 — quotes for requested items · the price rule (₩100 = 1 kr) · cost per product
-- Run once in Supabase SQL Editor (after v11). Safe to run again.
--
--   * Members are not charged shipping, customs or VAT separately: a piece that costs ₩10,000 in Korea is
--     sold for 100 kr, and the gap to the real exchange rate covers the logistics. The rule lives in
--     settings.price_krw_per_sek (100) so the treasurer can change it.
--   * products.cost_krw = the latest purchase price per piece (copied from the group order on arrival, or typed).
--   * A request for something that is not on the list can be quoted: the treasurer names it and sets a price →
--     a hidden product (only for this member) and an order awaiting payment are created. From there it is an
--     ordinary order: Swish → confirmed → no stock → group order → arrived → ready to collect.

do $$
begin
  if to_regclass('public.requests') is null then raise exception 'Run migration_v11_group_orders.sql first'; end if;
end $$;

-- ───────────────────────── 1. price rule and cost ─────────────────────────
alter table settings add column if not exists price_krw_per_sek int not null default 100 check (price_krw_per_sek > 0);
alter table products add column if not exists cost_krw numeric(12,0);   -- latest purchase price per piece, in won

-- ₩12,340 → 123 kr (whole kronor)
create or replace function price_from_cost(p_cost_krw numeric) returns int
language sql stable security definer set search_path = public as $$
  select case when p_cost_krw is null or p_cost_krw <= 0 then null
              else round(p_cost_krw / (select price_krw_per_sek from settings where id = 1))::int end;
$$;

create or replace function set_product_price(p_product_id uuid, p_price_sek int, p_cost_krw numeric default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  if p_price_sek is null or p_price_sek < 0 then raise exception 'Price must be 0 or more'; end if;
  update products set price_sek = p_price_sek, cost_krw = coalesce(p_cost_krw, cost_krw) where id = p_product_id;
  if not found then raise exception 'Product not found'; end if;
end $$;

-- on arrival the group order's cost per piece becomes the product's latest cost
create or replace function mark_batch_arrived(p_batch_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_b purchase_batches%rowtype; r record; v_me uuid := current_member_id();
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select * into v_b from purchase_batches where id = p_batch_id for update;
  if not found then raise exception 'Group order not found'; end if;
  if v_b.status <> 'ordered' then raise exception 'Mark the group order as ordered first'; end if;
  for r in
    select p.id as product_id,
           coalesce((select sum(i.qty) from order_items i where i.batch_id = p_batch_id and i.product_id = p.id and i.status = 'group_buy'), 0)
           + coalesce((select pl.restock_qty from purchase_lines pl where pl.batch_id = p_batch_id and pl.product_id = p.id), 0) as total,
           (select pl.unit_cost_krw from purchase_lines pl where pl.batch_id = p_batch_id and pl.product_id = p.id) as unit_cost
      from products p
     where exists (select 1 from purchase_lines pl where pl.batch_id = p_batch_id and pl.product_id = p.id)
        or exists (select 1 from order_items i where i.batch_id = p_batch_id and i.product_id = p.id and i.status = 'group_buy')
  loop
    if r.total > 0 then
      insert into stock_movements (product_id, qty, kind, note, created_by)
      values (r.product_id, r.total, 'purchase', 'Group order ' || v_b.name, v_me);
    end if;
    if r.unit_cost is not null and r.unit_cost > 0 then
      update products set cost_krw = r.unit_cost where id = r.product_id;
    end if;
  end loop;
  for r in select i.id, i.product_id, i.qty from order_items i where i.batch_id = p_batch_id and i.status = 'group_buy' loop
    insert into stock_movements (product_id, qty, kind, order_item_id, note, created_by)
    values (r.product_id, -r.qty, 'sale', r.id, 'Group order ' || v_b.name, v_me);
    update order_items set status = 'ready' where id = r.id;
  end loop;
  update purchase_batches set status = 'arrived', arrived_at = now() where id = p_batch_id;
end $$;

-- ───────────────────────── 2. quotes for requests ─────────────────────────
alter table requests drop constraint if exists requests_status_check;
alter table requests add constraint requests_status_check check (status in ('open','quoted','added','declined'));
alter table requests add column if not exists order_id uuid references orders(id) on delete set null;
alter table requests add column if not exists quote_sek int;

-- "We can buy this for you for X kr": a hidden product for this member + an order to pay
create or replace function quote_request(p_request_id uuid, p_name text, p_price_sek int, p_qty int default 1, p_cost_krw numeric default null, p_reply text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_r     requests%rowtype;
  v_name  text;
  v_prod  uuid;
  v_code  text;
  v_pay   uuid;
  v_order uuid;
  v_qty   int := coalesce(p_qty, 1);
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select * into v_r from requests where id = p_request_id for update;
  if not found then raise exception 'Request not found'; end if;
  if v_r.status <> 'open' then raise exception 'This request is already %', v_r.status; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the item a name'; end if;
  if p_price_sek is null or p_price_sek <= 0 then raise exception 'Set the price in kronor'; end if;
  if v_qty <= 0 then raise exception 'Quantity must be at least 1'; end if;
  select name into v_name from members where id = v_r.member_id;

  -- hidden product, only reachable through this order
  insert into products (code, category, subcategory, name, variant, maker, price_sek, cost_krw, min_stock, active, sort, notes)
  values ('REQ-' || left(replace(p_request_id::text, '-', ''), 8), 'Special', 'Request', left(trim(p_name), 120), null, null,
          p_price_sek, p_cost_krw, 0, false, 9000, 'Requested by ' || coalesce(v_name, 'a member'))
  returning id into v_prod;

  v_code := next_payment_code('material');
  insert into payments (member_id, kind, amount_sek, code, note)
  values (v_r.member_id, 'material', p_price_sek * v_qty, v_code, v_code || ' Store ' || coalesce(v_name, ''))
  returning id into v_pay;
  insert into orders (member_id, payment_id, note) values (v_r.member_id, v_pay, 'Requested: ' || left(v_r.text, 200))
  returning id into v_order;
  update payments set ref_id = v_order where id = v_pay;
  insert into order_items (order_id, product_id, qty, unit_price_sek, name)
  values (v_order, v_prod, v_qty, p_price_sek, left(trim(p_name), 120));

  update requests
     set status = 'quoted', product_id = v_prod, order_id = v_order, quote_sek = p_price_sek * v_qty,
         reply = nullif(trim(coalesce(p_reply, '')), ''), decided_at = now(), decided_by = current_member_id()
   where id = p_request_id;
  return v_order;
end $$;

-- decide_request: 'quoted' can go back to open only if its order is not paid (the order gets cancelled)
create or replace function decide_request(p_id uuid, p_status text, p_product_id uuid default null, p_reply text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_r requests%rowtype; v_pstatus text;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  if p_status not in ('added','declined','open') then raise exception 'Unknown decision'; end if;
  select * into v_r from requests where id = p_id for update;
  if not found then raise exception 'Request not found'; end if;
  if p_status = 'added' and p_product_id is null then raise exception 'Pick the product that was added for this request'; end if;
  if v_r.status = 'quoted' and v_r.order_id is not null then
    select p.status into v_pstatus from orders o join payments p on p.id = o.payment_id where o.id = v_r.order_id;
    if v_pstatus in ('pending','claimed') then
      perform cancel_order(v_r.order_id);
    elsif v_pstatus = 'confirmed' then
      raise exception 'The member has paid for this quote — refund the order line first';
    end if;
  end if;
  update requests
     set status = p_status,
         product_id = case when p_status = 'added' then p_product_id else null end,
         order_id = case when p_status = 'open' then null else order_id end,
         quote_sek = case when p_status = 'open' then null else quote_sek end,
         reply = nullif(trim(coalesce(p_reply, '')), ''),
         decided_at = case when p_status = 'open' then null else now() end,
         decided_by = case when p_status = 'open' then null else current_member_id() end
   where id = p_id;
end $$;

-- requests_view: same columns as v11 plus the quote
create or replace view requests_view with (security_invoker = true) as
select r.id, r.member_id, m.name as member_name, r.text, r.status, r.product_id, r.reply, r.created_at, r.decided_at,
       p.name as product_name, p.variant as product_variant, p.maker as product_maker, p.active as product_active,
       r.order_id, r.quote_sek,
       ov.status as order_status, ov.payment_status
  from requests r
  join members m on m.id = r.member_id
  left join products p on p.id = r.product_id
  left join orders_view ov on ov.id = r.order_id;
