-- Migration v4 — WhatsApp group link per slot + phone normalisation fix

-- each slot (session) can carry its WhatsApp group invite link
alter table slots add column if not exists whatsapp_url text;

-- "760643610" (9 digits, no leading 0) is a Swedish mobile too → +46…
create or replace function norm_phone(p text) returns text
language sql immutable as $$
  select case
    when p is null then null
    when d like '00%'                      then '+' || substr(d, 3)
    when d like '0%'                       then '+46' || substr(d, 2)
    when d like '+%'                       then d
    when length(d) = 9 and d like '7%'     then '+46' || d
    else '+' || d end
  from (select regexp_replace(p, '[^0-9+]', '', 'g') as d) x;
$$;
