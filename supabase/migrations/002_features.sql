-- 002_features.sql – chores app v7: snooze ('Not this weekend'), supplies, away mode.
-- Idempotent: safe to run more than once. Run in Supabase: SQL Editor > New query > paste > Run.
-- Nothing is deleted; existing data is untouched except filling tasks.supplies where it is still empty.

-- 1. new task columns
alter table public.tasks add column if not exists snooze_until date;   -- 'Not this weekend': next due >= this date while today < it
alter table public.tasks add column if not exists supplies     text;   -- "You'll need" (comma-separated)

-- 2. away periods (tasks due while away move later by the length of the trip)
create table if not exists public.away_periods (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  created_at  timestamptz not null default now(),
  constraint away_periods_dates check (end_date >= start_date)
);
create index if not exists away_periods_owner_idx on public.away_periods (owner_id, start_date);

-- 3. row-level security: owner only (same policies as the other tables)
alter table public.away_periods enable row level security;
do $$
declare t text := 'away_periods';
begin
  execute format('drop policy if exists "owner select" on public.%I', t);
  execute format('drop policy if exists "owner insert" on public.%I', t);
  execute format('drop policy if exists "owner update" on public.%I', t);
  execute format('drop policy if exists "owner delete" on public.%I', t);
  execute format('create policy "owner select" on public.%I for select to authenticated using (owner_id = (select auth.uid()))', t);
  execute format('create policy "owner insert" on public.%I for insert to authenticated with check (owner_id = (select auth.uid()))', t);
  execute format('create policy "owner update" on public.%I for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))', t);
  execute format('create policy "owner delete" on public.%I for delete to authenticated using (owner_id = (select auth.uid()))', t);
end $$;

-- 4. grants (what Supabase gives tables created in the SQL editor; explicit so it doesn't depend on defaults)
grant select, insert, update, delete on public.away_periods to authenticated;
grant all on public.away_periods to service_role;
revoke all on public.away_periods from anon;

-- 5. live sync
do $$ begin
  alter publication supabase_realtime add table public.away_periods;
exception when others then null; end $$;

-- 6. supplies for the obvious existing tasks (only where still empty)
update public.tasks set supplies = 'Degreaser' where room = 'Kitchen' and name = 'Clean hood above stove' and supplies is null;
update public.tasks set supplies = 'Descaler or citric acid' where room = 'Kitchen' and name = 'Descale kettle & coffee maker' and supplies is null;
update public.tasks set supplies = 'Dishwasher salt, Rinse aid, Dishwasher cleaner' where room = 'Kitchen' and name = 'Dishwasher: clean, salt & rinse aid' and supplies is null;
update public.tasks set supplies = 'Scrub Daddy sponge' where room = 'Kitchen' and name = 'Replace Scrub Daddy sponge' and supplies is null;
update public.tasks set supplies = 'Oven cleaner' where room = 'Kitchen' and name = 'Clean oven' and supplies is null;
update public.tasks set supplies = 'Floor disinfectant' where room = 'Bathroom' and name = 'Mop & disinfect floor' and supplies is null;
update public.tasks set supplies = 'Floor disinfectant' where room = 'Ensuite' and name = 'Mop & disinfect floor' and supplies is null;
update public.tasks set supplies = 'Mould spray' where room = 'Bathroom' and name = 'Tiles - Mold prevention' and supplies is null;
update public.tasks set supplies = 'Mould spray' where room = 'Ensuite' and name = 'Tiles - Mold prevention' and supplies is null;
update public.tasks set supplies = 'Bathroom descaler' where room = 'Bathroom' and name = 'Tiles - Descale & check bath/shower sealant' and supplies is null;
update public.tasks set supplies = 'Bathroom descaler' where room = 'Ensuite' and name = 'Tiles - Descale & check bath/shower sealant' and supplies is null;
update public.tasks set supplies = 'New toothbrushes / brush heads' where room = 'Bathroom' and name = 'Change toothbrushes (bathroom & ensuite)' and supplies is null;
update public.tasks set supplies = 'Washing machine cleaner' where room = 'Laundry' and name = 'Clean washing machine (hot cycle, door seal, detergent drawer, filter)' and supplies is null;
update public.tasks set supplies = '2 x Hoover U97 H-Trifilter (part 35602347)' where room = 'General' and name = 'Air purifiers (x2): replace U97 H-Trifilter (HEPA H13 + carbon)' and supplies is null;
update public.tasks set supplies = 'Smoke alarm batteries (9V or AA - check each alarm), First-aid kit top-up' where room = 'General' and name = 'Smoke detectors: check/replace batteries & check first-aid kit (expiry dates)' and supplies is null;
update public.tasks set supplies = 'Radiator brush' where room = 'General' and name = 'Clean radiators (dust behind & between fins)' and supplies is null;
update public.tasks set supplies = 'Plant feed' where room = 'General' and name = 'Feed plants' and supplies is null;
update public.tasks set supplies = 'Radiator bleed key' where room = 'Storage room/closet' and name = 'Check boiler pressure (1–1.5 bar cold) & bleed radiators' and supplies is null;
update public.tasks set supplies = 'Shoe polish' where room = 'Entrance' and name = 'Polish shoes' and supplies is null;

-- make PostgREST see the new columns/table straight away
notify pgrst, 'reload schema';
