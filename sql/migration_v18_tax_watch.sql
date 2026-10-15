-- Migration v18 — Tax check: watching the 75 % rule for business income (rörelse) during the year (2026-10-15)
-- Run once in Supabase SQL Editor (after v17). Safe to run again.
--
-- Why
--   A public-benefit association (allmännyttig ideell förening) keeps its business income tax-free only while
--   at least 75 % of that income has a natural connection to the association's purpose (course fees, material
--   sold to members, bazaars …). Income with no such connection (work for companies, a shop run like a business)
--   may be at most 25 % — one krona over and ALL business income is taxed. Membership fees, grants, gifts and
--   interest are outside the rule (always tax-free). The treasurer should see this ratio during the year, not
--   after it.
--
-- What this adds
--   * ledger_categories.tax_class — every income category is one of
--       exempt   : outside the rule (membership fee, grant, gift, interest)
--       natural  : business income with a natural connection to the purpose (counts towards the 75 %)
--       other    : business income with no natural connection (the 25 % side)
--       unsure   : not decided yet — the page counts it on the 25 % side, to be safe, and lists it apart
--     New income categories for things the app will see: monthly pass, gift, interest, Shop commission,
--     donated works sold, shipping charged, other income. BAS numbers are a first guess — the accountant decides.
--   * bank_transactions.category_code — an incoming bank line that is NOT a member payment (a grant, a gift,
--     a refund from a supplier) gets a category on the Tax check page, so it counts in the right place.
--   * tax_income_entries — income that never touches the bank statement or the app (cash at a fair, say).
--   * settings.tax_warn_pct (20) — the page turns yellow when the "other" side reaches this; red at 25.
--     settings.tax_year_start_month (1) — the association's financial year starts in this month.
--   * tax_watch(year) — one row per category and source (member payments · bank lines · entries) with the sum.
--     Member payments count when confirmed (Swish part + credits part), by the date they were confirmed.
--     Refunded payments are left out.

do $$
begin
  if to_regclass('public.sales_receipts') is null then
    raise exception 'Run migration_v17_kvitton.sql first';
  end if;
end $$;

-- ───────────────────────── 1. tax class on income categories ─────────────────────────
alter table ledger_categories add column if not exists tax_class  text not null default 'unsure'
  check (tax_class in ('exempt','natural','other','unsure'));
alter table ledger_categories add column if not exists tax_set_at timestamptz;   -- set by the treasurer (seed values leave it null)
alter table ledger_categories add column if not exists tax_note   text;

insert into ledger_categories (code, name, bas, kind, sort) values
  ('pass',            'Monthly pass',                              '3400', 'income', 35),
  ('donation',        'Gift / donation',                           '3993', 'income', 52),
  ('interest',        'Interest',                                  '8300', 'income', 54),
  ('shop_commission', 'Shop — commission on members'' works',      '3980', 'income', 56),
  ('shop_donated',    'Shop — donated works sold',                 '3980', 'income', 57),
  ('shipping_income', 'Shop — shipping charged to customers',      '3520', 'income', 58),
  ('other_income',    'Other income (work for companies etc.)',    '3990', 'income', 59)
on conflict (code) do nothing;

-- seed classes — only where the treasurer has not decided yet
update ledger_categories set tax_class = v.cls, tax_note = v.note
  from (values
    ('membership',      'exempt',  'Membership fees are always tax-free.'),
    ('grant',           'exempt',  'Grants are always tax-free.'),
    ('donation',        'exempt',  'Gifts are always tax-free.'),
    ('interest',        'exempt',  'Capital income is tax-free for a public-benefit association.'),
    ('course',          'natural', 'Course fees — natural connection to the purpose.'),
    ('seat',            'natural', 'Seat fees for the weekly painting — natural connection.'),
    ('pass',            'natural', 'Monthly passes — the same as seat fees.'),
    ('material_sale',   'natural', 'Material sold to members for the classes — like club clothing.'),
    ('shop_commission', 'unsure',  'Ask the accountant (Shop question 1 and 7).'),
    ('shop_donated',    'unsure',  'Could count as a bazaar-type sale (hävd) — ask the accountant (Shop question 3).'),
    ('shipping_income', 'unsure',  'Follows the Shop — ask the accountant.'),
    ('other_income',    'other',   'No natural connection — the 25 % side.')
  ) as v(code, cls, note)
 where ledger_categories.code = v.code and ledger_categories.tax_set_at is null;

-- ───────────────────────── 2. where income can come from ─────────────────────────
alter table bank_transactions add column if not exists category_code text references ledger_categories(code);

create table if not exists tax_income_entries (
  id             uuid primary key default gen_random_uuid(),
  booked_on      date not null,
  amount_sek     numeric(12,2) not null check (amount_sek > 0),
  category_code  text not null references ledger_categories(code),
  note           text,
  created_by     uuid references members(id) on delete set null,
  created_at     timestamptz not null default now()
);

alter table settings add column if not exists tax_warn_pct          int not null default 20 check (tax_warn_pct between 1 and 25);
alter table settings add column if not exists tax_year_start_month  int not null default 1  check (tax_year_start_month between 1 and 12);

-- ───────────────────────── 3. helpers ─────────────────────────
-- which ledger category a member payment belongs to
create or replace function payment_category(p_kind text) returns text
language sql immutable as $$
  select case p_kind when 'seat' then 'seat' when 'pass' then 'pass' when 'material' then 'material_sale'
                     when 'membership' then 'membership' else 'other_income' end
$$;

-- the financial year a date belongs to, named by the year it starts in
create or replace function tax_year(p_date date) returns int
language sql stable security definer set search_path = public as $$
  select case when extract(month from p_date) >= (select tax_year_start_month from settings where id = 1)
              then extract(year from p_date)::int else extract(year from p_date)::int - 1 end
$$;

-- ───────────────────────── 4. the numbers ─────────────────────────
create or replace function tax_watch(p_year int)
returns table (category_code text, name text, bas text, tax_class text, source text, amount_sek numeric, n int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  return query
  with src as (
    -- member payments the treasurer confirmed (Swish + credits), by confirmation date
    select payment_category(p.kind) as code, 'payments'::text as source,
           (p.amount_sek + coalesce(p.credit_sek, 0))::numeric as amount
      from payments p
     where p.status = 'confirmed' and p.confirmed_at is not null
       and tax_year(p.confirmed_at::date) = p_year
    union all
    -- incoming bank lines that are not a member payment, given a category on the Tax check page
    select t.category_code, 'bank', t.amount_sek
      from bank_transactions t
     where t.payment_id is null and t.category_code is not null and t.amount_sek > 0
       and tax_year(t.booked_on) = p_year
    union all
    -- entries typed in by hand
    select e.category_code, 'entries', e.amount_sek
      from tax_income_entries e
     where tax_year(e.booked_on) = p_year
  )
  select c.code, c.name, c.bas, c.tax_class, s.source, sum(s.amount)::numeric(12,2), count(*)::int
    from src s join ledger_categories c on c.code = s.code
   group by c.code, c.name, c.bas, c.tax_class, s.source, c.sort
   order by c.sort, s.source;
end $$;

-- years that have any income, newest first (always includes the current one)
create or replace function tax_watch_years() returns setof int
language sql stable security definer set search_path = public as $$
  select y from (
    select tax_year(current_date) as y
    union select tax_year(confirmed_at::date) from payments where status = 'confirmed' and confirmed_at is not null
    union select tax_year(booked_on) from bank_transactions where payment_id is null and category_code is not null and amount_sek > 0
    union select tax_year(booked_on) from tax_income_entries
  ) t where can_use_payments() order by y desc
$$;

-- ───────────────────────── 5. what the treasurer can change ─────────────────────────
create or replace function set_tax_class(p_code text, p_class text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  if p_class not in ('exempt','natural','other','unsure') then raise exception 'Unknown class'; end if;
  update ledger_categories set tax_class = p_class, tax_set_at = now(),
         tax_note = case when p_note is null then tax_note else nullif(trim(p_note), '') end
   where code = p_code and kind = 'income';
  if not found then raise exception 'Income category not found'; end if;
end $$;

create or replace function set_bank_tx_category(p_tx_id uuid, p_code text) returns void
language plpgsql security definer set search_path = public as $$
declare v_t bank_transactions%rowtype;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  select * into v_t from bank_transactions where id = p_tx_id;
  if not found then raise exception 'Bank line not found'; end if;
  if v_t.payment_id is not null then raise exception 'This line is a member payment — it is counted already'; end if;
  if v_t.amount_sek <= 0 then raise exception 'Only money coming in gets an income category'; end if;
  if p_code is not null and not exists (select 1 from ledger_categories where code = p_code and kind = 'income' and active) then
    raise exception 'Unknown income category';
  end if;
  update bank_transactions set category_code = p_code where id = p_tx_id;
end $$;

create or replace function add_income_entry(p_date date, p_amount numeric, p_code text, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount'; end if;
  if not exists (select 1 from ledger_categories where code = p_code and kind = 'income' and active) then
    raise exception 'Choose an income category';
  end if;
  insert into tax_income_entries (booked_on, amount_sek, category_code, note, created_by)
  values (p_date, round(p_amount, 2), p_code, nullif(trim(p_note), ''), current_member_id())
  returning id into v_id;
  return v_id;
end $$;

create or replace function delete_income_entry(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  delete from tax_income_entries where id = p_id;
  if not found then raise exception 'Entry not found'; end if;
end $$;

create or replace function set_tax_settings(p_warn_pct int, p_start_month int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_payments() then raise exception 'Treasurer or Admin only'; end if;
  update settings set tax_warn_pct = p_warn_pct, tax_year_start_month = p_start_month where id = 1;
end $$;

-- ───────────────────────── 6. who sees what ─────────────────────────
alter table tax_income_entries enable row level security;
drop policy if exists tax_entries_treasurer on tax_income_entries;
create policy tax_entries_treasurer on tax_income_entries for all using (can_use_payments()) with check (can_use_payments());
grant select, insert, update, delete on tax_income_entries to authenticated;
