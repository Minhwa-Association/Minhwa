-- Migration v16.3 — a second tap on "Order & pay" / "Send request" no longer makes a second order (2026-10-15)
-- Run once in Supabase SQL Editor (after v16.2). Safe to run again.
--
-- What changes
--   * 2026-10-14 a member tapped "Order & pay" three times within six seconds (slow connection, no visible
--     reaction) and got three identical Store orders. The app now locks every "create" button while the form
--     is being sent (app/SubmitButton.tsx); on top of that the database refuses to make the same thing twice:
--   * place_order: the same member, the same items and note, within two minutes of an order that is not
--     cancelled → the order that already exists comes back (so the member lands on that order's page).
--   * create_request: the same member, the same text, within two minutes of an open request → that request.
--   Everything else is as before.

do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'payments' and column_name = 'never_came_at') then
    raise exception 'Run migration_v16_2_cancel_credits.sql first';
  end if;
end $$;

-- place_order as in v14 + the two-minute check
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
  v_sig   text;
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

  -- v16.3: the same order again within two minutes (a second tap) → the order that already exists
  with wanted as (
    select x.product_id, sum(x.qty)::int as qty
      from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(product_id uuid, qty int)
     where x.product_id is not null and coalesce(x.qty, 0) > 0
     group by x.product_id)
  select string_agg(product_id::text || ':' || qty, ',' order by product_id) into v_sig from wanted;
  select o.id into v_order
    from orders o join payments y on y.id = o.payment_id
   where o.member_id = v_me and o.created_at > now() - interval '2 minutes'
     and y.status not in ('cancelled','refunded')
     and coalesce(o.note, '') = coalesce(nullif(trim(p_note), ''), '')
     and (select string_agg(i.product_id::text || ':' || i.qty, ',' order by i.product_id) from order_items i where i.order_id = o.id) = v_sig
   order by o.created_at desc limit 1;
  if v_order is not null then return v_order; end if;

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

-- create_request as in v11 + the two-minute check
create or replace function create_request(p_text text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me uuid := current_member_id(); v_id uuid;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  if length(coalesce(trim(p_text), '')) < 3 then raise exception 'Tell us what you are looking for'; end if;
  -- v16.3: the same request again within two minutes (a second tap) → the one that already exists
  select id into v_id from requests
   where member_id = v_me and text = left(trim(p_text), 500) and status = 'open' and created_at > now() - interval '2 minutes'
   order by created_at desc limit 1;
  if v_id is not null then return v_id; end if;
  insert into requests (member_id, text) values (v_me, left(trim(p_text), 500)) returning id into v_id;
  return v_id;
end $$;
