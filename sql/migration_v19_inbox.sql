-- Migration v19 — Inbox: the association's conversations in one place (2026-10-16)
-- Run once in Supabase SQL Editor (after v18). Safe to run again.
--
-- What this adds
--   * A "manager" role (runs the inbox) and members.inbox_access (a Crew member who may see the inbox).
--     Who sees the Inbox tab: Admin · Manager · Crew with inbox_access.
--   * comms_threads / comms_messages — one model for every channel:
--       instagram : DMs to the association's Instagram account (Meta webhook → /api/inbound/instagram)
--       email     : mail to manager@minhwa.org (Google routing copy → Resend → /api/inbound/mail)
--     A thread is one counterpart (an Instagram user, or an e-mail conversation); messages hang off it.
--   * comms_tasks — the manager's to-do list. Claude may suggest one (status 'suggested'); it becomes
--     'open' only when a person approves it.
--   * comms_templates — quick replies (sv / en / ko).
--   * comms_digests — the morning summary ("what is going on"), written by Claude on request.
--   * settings: ig_token_expires_at · notify_domains (senders filed as notifications, folded away) ·
--     inbox_retention_months (12).

do $$
begin
  if to_regclass('public.tax_income_entries') is null then
    raise exception 'Run migration_v18_tax_watch.sql first';
  end if;
end $$;

-- ───────────────────────── 1. roles and access ─────────────────────────
alter table members drop constraint if exists members_roles_check;
alter table members add constraint members_roles_check
  check (roles <@ array['teacher','crew','admin','treasurer','manager']);

alter table members add column if not exists inbox_access boolean not null default false;
alter table members add column if not exists instagram    text;        -- @username, for linking DMs to a member
create unique index if not exists members_instagram_key on members (lower(instagram)) where instagram is not null;

create or replace function can_use_inbox() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members
     where auth_id = auth.uid()
       and (roles && array['admin','manager'] or ('crew' = any(roles) and inbox_access))
  );
$$;

-- roles · inbox_access · instagram handle → admin only (same guard as before, two columns more)
create or replace function guard_member_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or is_admin() then return new; end if;
  if new.roles        is distinct from old.roles
  or new.role         is distinct from old.role
  or new.phone        is distinct from old.phone
  or new.active       is distinct from old.active
  or new.email        is distinct from old.email
  or new.auth_id      is distinct from old.auth_id
  or new.inbox_access is distinct from old.inbox_access
  or new.instagram    is distinct from old.instagram
  or new.id           is distinct from old.id then
    raise exception 'Only an admin can change this';
  end if;
  if new.bank_names is distinct from old.bank_names and not can_use_payments() then
    raise exception 'Only the treasurer can change this';
  end if;
  return new;
end $$;

-- ───────────────────────── 2. settings ─────────────────────────
alter table settings add column if not exists ig_token_expires_at     date;
alter table settings add column if not exists notify_domains          text[] not null default array['fortnox.se','squarespace.com','godaddy.com','google.com','meta.com','facebook.com','instagram.com','vercel.com','supabase.com','resend.com'];
alter table settings add column if not exists inbox_retention_months  int not null default 12 check (inbox_retention_months between 1 and 60);

-- ───────────────────────── 3. threads and messages ─────────────────────────
create table if not exists comms_threads (
  id                 uuid primary key default gen_random_uuid(),
  channel            text not null check (channel in ('instagram','email')),
  mailbox            text,                                   -- 'manager' for e-mail; null for Instagram
  external_id        text not null,                          -- Instagram-scoped user id · e-mail thread key
  counterpart_name   text,
  counterpart_handle text,                                   -- @username · e-mail address
  profile_pic        text,
  member_id          uuid references members(id) on delete set null,
  subject            text,
  topic              text not null default 'unsorted'
                     check (topic in ('unsorted','booking','class','material','partner','admin','notice','other')),
  gist               text,                                   -- one line by Claude, or by a person
  status             text not null default 'open' check (status in ('open','waiting','done')),
  assigned_to        uuid references members(id) on delete set null,
  last_in_at         timestamptz,                            -- the counterpart's last message (24 h rule for Instagram)
  last_out_at        timestamptz,
  last_message_at    timestamptz,
  last_preview       text,
  unread             int not null default 0,
  created_at         timestamptz not null default now(),
  unique (channel, external_id)
);
create index if not exists comms_threads_order on comms_threads (status, last_message_at desc);

create table if not exists comms_messages (
  id            uuid primary key default gen_random_uuid(),
  thread_id     uuid not null references comms_threads(id) on delete cascade,
  channel       text not null check (channel in ('instagram','email')),
  external_id   text not null unique,                        -- Instagram mid · e-mail Message-ID
  direction     text not null check (direction in ('in','out')),
  from_name     text,
  from_handle   text,
  to_handle     text,
  subject       text,
  text          text,
  html          text,
  attachments   jsonb not null default '[]'::jsonb,          -- [{type, url, name}]
  is_echo       boolean not null default false,              -- sent from the Instagram app itself
  sent_by       uuid references members(id) on delete set null,   -- sent from this app by …
  sent_at       timestamptz not null,
  raw           jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists comms_messages_thread on comms_messages (thread_id, sent_at);

-- ───────────────────────── 4. tasks · templates · digests ─────────────────────────
create table if not exists comms_tasks (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  detail           text,
  owner_id         uuid references members(id) on delete set null,
  due_on           date,
  status           text not null default 'open' check (status in ('suggested','open','done','dropped')),
  source_thread_id uuid references comms_threads(id) on delete set null,
  created_by       uuid references members(id) on delete set null,   -- null = suggested by Claude
  created_at       timestamptz not null default now(),
  done_at          timestamptz
);
create index if not exists comms_tasks_order on comms_tasks (status, due_on, created_at);

create table if not exists comms_templates (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null,
  lang       text not null default 'sv' check (lang in ('sv','en','ko')),
  channel    text not null default 'any' check (channel in ('any','instagram','email')),
  sort       int not null default 100,
  created_at timestamptz not null default now()
);

create table if not exists comms_digests (
  id         uuid primary key default gen_random_uuid(),
  for_date   date not null,
  since      timestamptz not null,
  text       text not null,
  stats      jsonb not null default '{}'::jsonb,
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists comms_digests_order on comms_digests (created_at desc);

-- ───────────────────────── 5. row-level security ─────────────────────────
alter table comms_threads   enable row level security;
alter table comms_messages  enable row level security;
alter table comms_tasks     enable row level security;
alter table comms_templates enable row level security;
alter table comms_digests   enable row level security;

drop policy if exists comms_threads_inbox   on comms_threads;
drop policy if exists comms_messages_inbox  on comms_messages;
drop policy if exists comms_tasks_inbox     on comms_tasks;
drop policy if exists comms_templates_inbox on comms_templates;
drop policy if exists comms_digests_inbox   on comms_digests;
create policy comms_threads_inbox   on comms_threads   for all using (can_use_inbox()) with check (can_use_inbox());
create policy comms_messages_inbox  on comms_messages  for all using (can_use_inbox()) with check (can_use_inbox());
create policy comms_tasks_inbox     on comms_tasks     for all using (can_use_inbox()) with check (can_use_inbox());
create policy comms_templates_inbox on comms_templates for all using (can_use_inbox()) with check (can_use_inbox());
create policy comms_digests_inbox   on comms_digests   for all using (can_use_inbox()) with check (can_use_inbox());

-- ───────────────────────── 6. functions ─────────────────────────
-- An inbound or outbound message arrives (service role, from the webhooks or after a send).
-- p: { channel, external_thread_id, mailbox, counterpart_name, counterpart_handle, profile_pic, subject,
--      message: { external_id, direction, from_name, from_handle, to_handle, subject, text, html,
--                 attachments, is_echo, sent_by, sent_at, raw } }
-- Returns { thread_id, message_id, created } — created=false when the message was already there.
create or replace function comms_upsert_inbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_thread  uuid;
  v_msg     uuid;
  v_m       jsonb := p->'message';
  v_dir     text  := coalesce(v_m->>'direction', 'in');
  v_at      timestamptz := coalesce((v_m->>'sent_at')::timestamptz, now());
  v_preview text  := left(regexp_replace(coalesce(v_m->>'text', ''), '\s+', ' ', 'g'), 140);
  v_member  uuid;
begin
  if auth.uid() is not null and not can_use_inbox() then raise exception 'Inbox only'; end if;

  select id into v_msg from comms_messages where external_id = v_m->>'external_id';
  if v_msg is not null then
    select thread_id into v_thread from comms_messages where id = v_msg;
    return jsonb_build_object('thread_id', v_thread, 'message_id', v_msg, 'created', false);
  end if;

  -- link to a member by Instagram handle or e-mail address, when one matches
  if p->>'channel' = 'instagram' and nullif(p->>'counterpart_handle', '') is not null then
    select id into v_member from members where lower(instagram) = lower(ltrim(p->>'counterpart_handle', '@')) limit 1;
  elsif p->>'channel' = 'email' and nullif(p->>'counterpart_handle', '') is not null then
    select id into v_member from members where lower(email) = lower(p->>'counterpart_handle') limit 1;
  end if;

  insert into comms_threads (channel, mailbox, external_id, counterpart_name, counterpart_handle, profile_pic, member_id, subject,
                             last_in_at, last_out_at, last_message_at, last_preview, unread)
  values (p->>'channel', p->>'mailbox', p->>'external_thread_id', p->>'counterpart_name', p->>'counterpart_handle', p->>'profile_pic', v_member, p->>'subject',
          case when v_dir = 'in' then v_at end, case when v_dir = 'out' then v_at end, v_at, v_preview, case when v_dir = 'in' then 1 else 0 end)
  on conflict (channel, external_id) do update set
    counterpart_name   = coalesce(excluded.counterpart_name, comms_threads.counterpart_name),
    counterpart_handle = coalesce(excluded.counterpart_handle, comms_threads.counterpart_handle),
    profile_pic        = coalesce(excluded.profile_pic, comms_threads.profile_pic),
    member_id          = coalesce(comms_threads.member_id, excluded.member_id),
    subject            = coalesce(comms_threads.subject, excluded.subject),
    last_in_at         = case when v_dir = 'in'  then greatest(coalesce(comms_threads.last_in_at,  v_at), v_at) else comms_threads.last_in_at  end,
    last_out_at        = case when v_dir = 'out' then greatest(coalesce(comms_threads.last_out_at, v_at), v_at) else comms_threads.last_out_at end,
    last_message_at    = greatest(coalesce(comms_threads.last_message_at, v_at), v_at),
    last_preview       = case when v_at >= coalesce(comms_threads.last_message_at, v_at) then v_preview else comms_threads.last_preview end,
    unread             = comms_threads.unread + case when v_dir = 'in' then 1 else 0 end,
    -- a new incoming message reopens a finished thread; our own reply marks it "waiting for them"
    status             = case when v_dir = 'in' then 'open' when comms_threads.status = 'open' then 'waiting' else comms_threads.status end
  returning id into v_thread;

  insert into comms_messages (thread_id, channel, external_id, direction, from_name, from_handle, to_handle, subject, text, html, attachments, is_echo, sent_by, sent_at, raw)
  values (v_thread, p->>'channel', v_m->>'external_id', v_dir, v_m->>'from_name', v_m->>'from_handle', v_m->>'to_handle', v_m->>'subject',
          v_m->>'text', v_m->>'html', coalesce(v_m->'attachments', '[]'::jsonb), coalesce((v_m->>'is_echo')::boolean, false),
          nullif(v_m->>'sent_by', '')::uuid, v_at, v_m->'raw')
  returning id into v_msg;

  return jsonb_build_object('thread_id', v_thread, 'message_id', v_msg, 'created', true);
end $$;

-- Opening a thread clears its unread count.
create or replace function comms_mark_read(p_thread uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_inbox() then raise exception 'Inbox only'; end if;
  update comms_threads set unread = 0 where id = p_thread and unread > 0;
end $$;

-- A person approves a suggested task (→ open), finishes one (→ done), drops one, or reopens one.
create or replace function comms_task_set_status(p_task uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_use_inbox() then raise exception 'Inbox only'; end if;
  if p_status not in ('open','done','dropped') then raise exception 'Unknown status'; end if;
  update comms_tasks
     set status  = p_status,
         done_at = case when p_status = 'done' then now() else null end,
         created_by = coalesce(created_by, case when p_status = 'open' then current_member_id() end)
   where id = p_task;
end $$;

-- Inbox settings (notification senders, retention, Instagram token date) — Admin or Manager.
create or replace function set_inbox_settings(p_domains text[], p_months int, p_expires date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (my_roles() && array['admin','manager']) then raise exception 'Admin or Manager only'; end if;
  update settings
     set notify_domains = coalesce(p_domains, '{}'),
         inbox_retention_months = coalesce(p_months, 12),
         ig_token_expires_at = p_expires
   where id = 1;
end $$;

-- Old conversations are removed after settings.inbox_retention_months (the originals stay in Gmail / Instagram).
create or replace function comms_purge_old() returns int
language plpgsql security definer set search_path = public as $$
declare v_months int; v_n int;
begin
  select inbox_retention_months into v_months from settings where id = 1;
  delete from comms_threads
   where last_message_at < now() - make_interval(months => coalesce(v_months, 12))
     and status = 'done';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ───────────────────────── 7. seed: a few quick replies ─────────────────────────
insert into comms_templates (title, body, lang, channel, sort)
select * from (values
  ('Tack — vi återkommer', 'Hej! Tack för ditt meddelande. Vi återkommer inom 1–2 dagar. / Minhwa-föreningen', 'sv', 'any', 10),
  ('Thanks — we will get back', 'Hi! Thanks for your message — we will get back to you within 1–2 days. / The Minhwa Association', 'en', 'any', 20),
  ('Lediga platser', 'Hej! Lediga platser och bokning finns i vår app: https://app.minhwa.org — säg till om du behöver hjälp att komma igång.', 'sv', 'any', 30),
  ('Open seats', 'Hi! Open seats and booking are in our app: https://app.minhwa.org — tell us if you need help getting started.', 'en', 'any', 40)
) as v(title, body, lang, channel, sort)
where not exists (select 1 from comms_templates);
