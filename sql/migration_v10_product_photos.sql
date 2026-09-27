-- Migration v10 — two photos per product
-- Run once in Supabase SQL Editor (after v9). Safe to run again.
--
--   * products.photos: up to two storage paths, in order (first = main picture).
--   * Storage bucket "product-photos": public to read (the Store shows them to logged-in members and
--     the pictures carry no personal data), written only by the Treasurer / Admin.
--     The browser shrinks each picture before uploading (1200 px + a 240 px thumbnail), so uploads stay small.

do $$
begin
  if to_regclass('public.products') is null then raise exception 'Run migration_v9_store.sql first'; end if;
end $$;

alter table products add column if not exists photos text[] not null default '{}';
alter table products drop constraint if exists products_photos_check;
alter table products add constraint products_photos_check check (cardinality(photos) <= 2);

-- bucket (4 MB per file — the browser sends ~200 KB anyway)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-photos', 'product-photos', true, 4194304, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- who may do what with the files
drop policy if exists "product photos: anyone can view" on storage.objects;
create policy "product photos: anyone can view" on storage.objects
  for select using (bucket_id = 'product-photos');

drop policy if exists "product photos: treasurer uploads" on storage.objects;
create policy "product photos: treasurer uploads" on storage.objects
  for insert to authenticated with check (bucket_id = 'product-photos' and public.can_use_payments());

drop policy if exists "product photos: treasurer replaces" on storage.objects;
create policy "product photos: treasurer replaces" on storage.objects
  for update to authenticated using (bucket_id = 'product-photos' and public.can_use_payments())
  with check (bucket_id = 'product-photos' and public.can_use_payments());

drop policy if exists "product photos: treasurer removes" on storage.objects;
create policy "product photos: treasurer removes" on storage.objects
  for delete to authenticated using (bucket_id = 'product-photos' and public.can_use_payments());
