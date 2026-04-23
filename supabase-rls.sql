-- Trading Journal private Supabase setup
--
-- Run order:
-- 1. Deploy/open the updated app and create your Supabase account from the login form.
-- 2. In Supabase SQL Editor, run:
--      select id, email from auth.users order by created_at desc;
-- 3. Replace YOUR_AUTH_USER_ID below with your user id, then run this file.

alter table public.trades add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.notes add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.summaries add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.deposits add column if not exists user_id uuid references auth.users(id) on delete cascade;

alter table public.trades alter column user_id set default auth.uid();
alter table public.notes alter column user_id set default auth.uid();
alter table public.summaries alter column user_id set default auth.uid();
alter table public.deposits alter column user_id set default auth.uid();

-- Assign existing rows to your account. Replace this value before running.
update public.trades set user_id = 'YOUR_AUTH_USER_ID' where user_id is null;
update public.notes set user_id = 'YOUR_AUTH_USER_ID' where user_id is null;
update public.summaries set user_id = 'YOUR_AUTH_USER_ID' where user_id is null;
update public.deposits set user_id = 'YOUR_AUTH_USER_ID' where user_id is null;

alter table public.trades alter column user_id set not null;
alter table public.notes alter column user_id set not null;
alter table public.summaries alter column user_id set not null;
alter table public.deposits alter column user_id set not null;

alter table public.trades enable row level security;
alter table public.notes enable row level security;
alter table public.summaries enable row level security;
alter table public.deposits enable row level security;

drop policy if exists "public insert" on public.trades;
drop policy if exists "public read" on public.trades;
drop policy if exists "public update trades" on public.trades;
drop policy if exists "own trades read" on public.trades;
drop policy if exists "own trades insert" on public.trades;
drop policy if exists "own trades update" on public.trades;

drop policy if exists "public insert" on public.notes;
drop policy if exists "public read" on public.notes;
drop policy if exists "public update notes" on public.notes;
drop policy if exists "own notes read" on public.notes;
drop policy if exists "own notes insert" on public.notes;
drop policy if exists "own notes update" on public.notes;

drop policy if exists "public insert" on public.summaries;
drop policy if exists "public read" on public.summaries;
drop policy if exists "public update" on public.summaries;
drop policy if exists "own summaries read" on public.summaries;
drop policy if exists "own summaries insert" on public.summaries;
drop policy if exists "own summaries update" on public.summaries;

drop policy if exists "public insert" on public.deposits;
drop policy if exists "public read" on public.deposits;
drop policy if exists "public update" on public.deposits;
drop policy if exists "own deposits read" on public.deposits;
drop policy if exists "own deposits insert" on public.deposits;
drop policy if exists "own deposits update" on public.deposits;

create policy "own trades read" on public.trades
for select to authenticated
using (auth.uid() = user_id);

create policy "own trades insert" on public.trades
for insert to authenticated
with check (auth.uid() = user_id);

create policy "own trades update" on public.trades
for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "own notes read" on public.notes
for select to authenticated
using (auth.uid() = user_id);

create policy "own notes insert" on public.notes
for insert to authenticated
with check (auth.uid() = user_id);

create policy "own notes update" on public.notes
for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "own summaries read" on public.summaries
for select to authenticated
using (auth.uid() = user_id);

create policy "own summaries insert" on public.summaries
for insert to authenticated
with check (auth.uid() = user_id);

create policy "own summaries update" on public.summaries
for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "own deposits read" on public.deposits
for select to authenticated
using (auth.uid() = user_id);

create policy "own deposits insert" on public.deposits
for insert to authenticated
with check (auth.uid() = user_id);

create policy "own deposits update" on public.deposits
for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create unique index if not exists summaries_user_date_unique
on public.summaries(user_id, summary_date);
