-- Migration v11 — Store, step 2b: group orders from Korea · requests · refunds
-- Run once in Supabase SQL Editor (after v10). Safe to run again.
--
--   * purchase_batches: one group order ("2026-10 Korea") at a time: open → ordered → arrived.
--     Paid order lines that cannot be handed out from stock are put in the open batch (line status group_buy);
--     restock quantities for low-stock products are added per product (purchase_lines).
--     "Ordered" freezes it; "Arrived" books the goods into stock (purchase), hands the member lines out
--     straight away (sale) and marks them ready to collect. Costs (KRW, rate, shipping, customs, VAT) give
--     the batch result against what members paid.
--   * requests: a member asks for something that is not on the list; the treasurer adds it as a product
--     (and links the request) or declines. The member sees the outcome under My orders.
--   * refunds: per order line, after the treasurer has sent the money back with Swish. When every line of an
--     order is refunded (or cancelled) the payment itself becomes refunded.

do $$
begin
  if to_regclass('public.order_items') is null then raise exception 'Run migration_v9_store.sql (and v10) first'; end if;
end $$;

-- ───────────────────────── 1. tables ─────────────────────────
create table if not exists purchase_batches (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,                                   -- "2026-10 Korea"
  status         text not null default 'open' check (status in ('open','ordered','arrived')),
  ordered_at     timestamptz,
  arrived_at     timestamptz,
  cost_krw       numeric(14,0) not null default 0,                -- goods, in Korean won
  fx_sek_per_krw numeric(12,6),                                   -- e.g. 0.0072
  shipping_sek   int not null default 0,
  customs_sek    int not null default 0,
  vat_sek        int not null default 0,
  notes          text,
  created_by     uuid references members(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- only one batch collecting at a time
create unique index if not exists purchase_batches_one_open on purchase_batches ((status)) where status = 'open';
drop trigger if exists purchase_batches_touch on purchase_batches;
create trigger purchase_batches_touch before update on purchase_batches
  for each row execute function touch_updated_at();

create table if not exists purchase_lines (
  id             uuid primary key default gen_random_uuid(),
  batch_id       uuid not null references purchase_batches(id) on delete cascade,
  product_id     uuid not null references products(id),
  restock_qty    int not null default 0 check (restock_qty >= 0),  -- extra pieces for the shelf, on top of members' lines
  unit_cost_krw  numeric(12,0),                                    -- optional, per piece
  note           text,
  unique (batch_id, product_id)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_batch_id_fkey') then
    alter table order_items add constraint order_items_batch_id_fkey
      foreign key (batch_id) references purchase_batches(id) on delete set null;
  end if;
end $$;

create table if not exists requests (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members(id),
  text        text not null,
  status      text not null default 'open' check (status in ('open','added','declined')),
  product_id  uuid references products(id) on delete set null,    -- when added to the list
  reply       text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  uuid references members(id) on delete set null
);

-- ───────────────────────── 2. the open batch ─────────────────────────
create or replace function open_batch_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from purchase_batches where status = 'open' limit 1;
$$;

create or replace function start_batch(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  if open_batch_id() is not null then raise exception 'There is already an open group order — mark it as ordered first'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the group order a name, e.g. 2026-10 Korea'; end if;
  insert into purchase_batches (name, created_by) values (trim(p_name), current_member_id()) returning id into v_id;
  return v_id;
end $$;

-- a paid line goes on the open group order
create or replace function add_line_to_batch(p_item_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_b uuid := open_batch_id(); v_i order_items%rowtype;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  if v_b is null then raise exception 'Start a group order first'; end if;
  select * into v_i from order_items where id = p_item_id for update;
  if not found then raise exception 'Line not found'; end if;
  if v_i.status <> 'paid' then raise exception 'Only a paid line can go on the group order (this one is %)', replace(v_i.status, '_', ' '); end if;
  update order_items set status = 'group_buy', batch_id = v_b where id = p_item_id;
  insert into purchase_lines (batch_id, product_id) values (v_b, v_i.product_id) on conflict (batch_id, product_id) do nothing;
end $$;

-- every paid line that cannot be handed out from stock → open group order; returns how many
create or replace function add_all_waiting_to_batch() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  if open_batch_id() is null then raise exception 'Start a group order first'; end if;
  for r in
    select i.id from order_items i join products p on p.id = i.product_id
     where i.status = 'paid' and p.stock < i.qty
     order by i.updated_at
  loop
    perform add_line_to_batch(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- back to "paid" (only while the batch is still open)
create or replace function remove_line_from_batch(p_item_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_i order_items%rowtype; v_status text;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select * into v_i from order_items where id = p_item_id for update;
  if not found or v_i.status <> 'group_buy' then raise exception 'This line is not on a group order'; end if;
  select status into v_status from purchase_batches where id = v_i.batch_id;
  if v_status <> 'open' then raise exception 'That group order is already %', v_status; end if;
  update order_items set status = 'paid', batch_id = null where id = p_item_id;
end $$;

-- restock pieces for the shelf, per product
create or replace function set_restock(p_batch_id uuid, p_product_id uuid, p_qty int, p_unit_cost_krw numeric default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select status into v_status from purchase_batches where id = p_batch_id;
  if v_status is null then raise exception 'Group order not found'; end if;
  if v_status <> 'open' then raise exception 'That group order is already %', v_status; end if;
  if p_qty is null or p_qty < 0 then raise exception 'Restock must be 0 or more'; end if;
  insert into purchase_lines (batch_id, product_id, restock_qty, unit_cost_krw)
  values (p_batch_id, p_product_id, p_qty, p_unit_cost_krw)
  on conflict (batch_id, product_id) do update set restock_qty = excluded.restock_qty, unit_cost_krw = coalesce(excluded.unit_cost_krw, purchase_lines.unit_cost_krw);
  -- a product with nothing on it drops off the list
  delete from purchase_lines pl where pl.batch_id = p_batch_id and pl.product_id = p_product_id and pl.restock_qty = 0
     and not exists (select 1 from order_items i where i.batch_id = p_batch_id and i.product_id = p_product_id and i.status = 'group_buy');
end $$;

-- fill restock for every product on the list that is at or below its minimum (only where nothing is set yet); returns how many
create or replace function suggest_restock(p_batch_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  if (select status from purchase_batches where id = p_batch_id) <> 'open' then raise exception 'That group order is not open'; end if;
  for r in
    select p.id, greatest(p.min_stock - p.stock, 0) as want
      from products p
     where p.active and p.stock <= p.min_stock
       and not exists (select 1 from purchase_lines pl where pl.batch_id = p_batch_id and pl.product_id = p.id and pl.restock_qty > 0)
  loop
    if r.want > 0 then
      insert into purchase_lines (batch_id, product_id, restock_qty) values (p_batch_id, r.id, r.want)
      on conflict (batch_id, product_id) do update set restock_qty = excluded.restock_qty;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function save_batch_costs(p_batch_id uuid, p_cost_krw numeric, p_fx numeric, p_shipping int, p_customs int, p_vat int, p_notes text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update purchase_batches
     set cost_krw = coalesce(p_cost_krw, 0), fx_sek_per_krw = p_fx,
         shipping_sek = coalesce(p_shipping, 0), customs_sek = coalesce(p_customs, 0), vat_sek = coalesce(p_vat, 0),
         notes = nullif(trim(coalesce(p_notes, '')), '')
   where id = p_batch_id;
  if not found then raise exception 'Group order not found'; end if;
end $$;

create or replace function mark_batch_ordered(p_batch_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update purchase_batches set status = 'ordered', ordered_at = now() where id = p_batch_id and status = 'open';
  if not found then raise exception 'Only an open group order can be marked as ordered'; end if;
end $$;

-- the goods are here: everything on the list goes into stock, members' lines are handed out and ready to collect
create or replace function mark_batch_arrived(p_batch_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_b purchase_batches%rowtype; r record; v_me uuid := current_member_id();
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select * into v_b from purchase_batches where id = p_batch_id for update;
  if not found then raise exception 'Group order not found'; end if;
  if v_b.status <> 'ordered' then raise exception 'Mark the group order as ordered first'; end if;
  -- stock in: members' pieces + restock, per product
  for r in
    select p.id as product_id,
           coalesce((select sum(i.qty) from order_items i where i.batch_id = p_batch_id and i.product_id = p.id and i.status = 'group_buy'), 0)
           + coalesce((select pl.restock_qty from purchase_lines pl where pl.batch_id = p_batch_id and pl.product_id = p.id), 0) as total
      from products p
     where exists (select 1 from purchase_lines pl where pl.batch_id = p_batch_id and pl.product_id = p.id)
        or exists (select 1 from order_items i where i.batch_id = p_batch_id and i.product_id = p.id and i.status = 'group_buy')
  loop
    if r.total > 0 then
      insert into stock_movements (product_id, qty, kind, note, created_by)
      values (r.product_id, r.total, 'purchase', 'Group order ' || v_b.name, v_me);
    end if;
  end loop;
  -- members' lines: out of stock again, ready to collect
  for r in select i.id, i.product_id, i.qty from order_items i where i.batch_id = p_batch_id and i.status = 'group_buy' loop
    insert into stock_movements (product_id, qty, kind, order_item_id, note, created_by)
    values (r.product_id, -r.qty, 'sale', r.id, 'Group order ' || v_b.name, v_me);
    update order_items set status = 'ready' where id = r.id;
  end loop;
  update purchase_batches set status = 'arrived', arrived_at = now() where id = p_batch_id;
end $$;

-- ───────────────────────── 3. refunds ─────────────────────────
-- the treasurer has sent the money back with Swish → the line is refunded; when nothing is left open, the payment too
create or replace function refund_order_item(p_item_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_i order_items%rowtype; v_pay uuid; v_left int;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select * into v_i from order_items where id = p_item_id for update;
  if not found then raise exception 'Line not found'; end if;
  if v_i.status not in ('paid','group_buy') then raise exception 'Only a paid line that has not been handed out can be refunded (this one is %)', replace(v_i.status, '_', ' '); end if;
  update order_items set status = 'refunded', batch_id = null where id = p_item_id;
  select o.payment_id into v_pay from orders o where o.id = v_i.order_id;
  select count(*) into v_left from order_items where order_id = v_i.order_id and status not in ('refunded','cancelled');
  if v_left = 0 then
    update payments set status = 'refunded', refunded_at = now() where id = v_pay and status = 'confirmed';
  end if;
  if p_note is not null and trim(p_note) <> '' then
    update orders set note = coalesce(note || ' · ', '') || 'Refund: ' || trim(p_note) where id = v_i.order_id;
  end if;
end $$;

-- ───────────────────────── 4. requests ─────────────────────────
create or replace function create_request(p_text text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me uuid := current_member_id(); v_id uuid;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  if length(coalesce(trim(p_text), '')) < 3 then raise exception 'Tell us what you are looking for'; end if;
  insert into requests (member_id, text) values (v_me, left(trim(p_text), 500)) returning id into v_id;
  return v_id;
end $$;

create or replace function decide_request(p_id uuid, p_status text, p_product_id uuid default null, p_reply text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  if p_status not in ('added','declined','open') then raise exception 'Unknown decision'; end if;
  if p_status = 'added' and p_product_id is null then raise exception 'Pick the product that was added for this request'; end if;
  update requests
     set status = p_status, product_id = case when p_status = 'added' then p_product_id else null end,
         reply = nullif(trim(coalesce(p_reply, '')), ''),
         decided_at = case when p_status = 'open' then null else now() end,
         decided_by = case when p_status = 'open' then null else current_member_id() end
   where id = p_id;
  if not found then raise exception 'Request not found'; end if;
end $$;

-- ───────────────────────── 5. views ─────────────────────────
-- the shopping list of a group order: one row per product with members' pieces, restock and value
create or replace view purchase_list_view with (security_invoker = true) as
with member_lines as (
  select i.batch_id, i.product_id,
         coalesce((sum(i.qty) filter (where i.status = 'group_buy')), 0)::int as waiting_qty,
         sum(i.qty)::int as member_qty,
         sum(i.qty * i.unit_price_sek)::int as member_value_sek,
         count(distinct i.order_id)::int as orders
    from order_items i
   where i.batch_id is not null and i.status in ('group_buy','ready','collected')
   group by i.batch_id, i.product_id
)
select b.id as batch_id, b.status as batch_status,
       p.id as product_id, p.code, p.name, p.variant, p.maker, p.category, p.subcategory, p.price_sek, p.stock, p.min_stock, p.sort,
       coalesce(m.member_qty, 0) as member_qty,
       coalesce(m.waiting_qty, 0) as waiting_qty,
       coalesce(m.member_value_sek, 0) as member_value_sek,
       coalesce(m.orders, 0) as orders,
       coalesce(pl.restock_qty, 0) as restock_qty,
       pl.unit_cost_krw,
       coalesce(m.member_qty, 0) + coalesce(pl.restock_qty, 0) as total_qty
  from purchase_batches b
  join products p on true
  left join purchase_lines pl on pl.batch_id = b.id and pl.product_id = p.id
  left join member_lines m on m.batch_id = b.id and m.product_id = p.id
 where pl.id is not null or m.member_qty > 0;

-- what members may know about group orders (no costs); runs as the owner, so RLS on the table does not hide it
create or replace view group_orders_public as
  select id, name, status, ordered_at, arrived_at from purchase_batches where auth.uid() is not null;
grant select on group_orders_public to authenticated;

create or replace view requests_view with (security_invoker = true) as
select r.id, r.member_id, m.name as member_name, r.text, r.status, r.product_id, r.reply, r.created_at, r.decided_at,
       p.name as product_name, p.variant as product_variant, p.maker as product_maker, p.active as product_active
  from requests r
  join members m on m.id = r.member_id
  left join products p on p.id = r.product_id;

-- ───────────────────────── 6. who sees what ─────────────────────────
alter table purchase_batches enable row level security;
drop policy if exists batches_treasurer on purchase_batches;
create policy batches_treasurer on purchase_batches for all using (can_use_payments()) with check (can_use_payments());

alter table purchase_lines enable row level security;
drop policy if exists plines_treasurer on purchase_lines;
create policy plines_treasurer on purchase_lines for all using (can_use_payments()) with check (can_use_payments());

alter table requests enable row level security;
drop policy if exists requests_read on requests;
create policy requests_read on requests for select using (member_id = current_member_id() or can_use_payments());
drop policy if exists requests_treasurer on requests;
create policy requests_treasurer on requests for all using (can_use_payments()) with check (can_use_payments());
