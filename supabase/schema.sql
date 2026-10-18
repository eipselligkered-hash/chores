-- Household chores: Supabase schema. Run once in the Supabase SQL editor (Project > SQL editor > New query).
-- Every row belongs to one user (owner_id = auth.uid()); row-level security lets only the owner read/write.
create extension if not exists pgcrypto;

create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  room            text not null,
  name            text not null,
  frequency       text not null check (frequency in ('Daily','Weekly','Fortnightly','Monthly','Every 2 months','Quarterly','Half-yearly','Yearly')),
  interval_days   int  not null,                 -- 1/7/14/30/60/91/182/365 (used for days and for the stagger half-interval)
  interval_months int  not null default 0,       -- >0: next due = Last done + calendar months
  last_done       date,                          -- typed Last done (completions also count: effective = latest of both)
  planned_date    date,                          -- used only while never done
  stagger_date    date,                          -- one-off move of a single occurrence
  due_weekday     text check (due_weekday in ('Sun','Mon','Tue','Wed','Thu','Fri','Sat')),  -- null = Saturday
  season          text,                          -- see src/schedule.js SEASONS
  priority        text not null default 'Nice-to-have' check (priority in ('Safety','Hygiene','Nice-to-have')),
  effort_min      int  check (effort_min between 0 and 1440),
  notes           text,                          -- how-to
  active          boolean not null default true,
  sort_key        int  not null default 0,       -- workbook row order (This Weekend tie-break)
  plan_text       text,                          -- label shown while Next due = plan_date (e.g. 'Catch-up Fri 23 Oct')
  plan_date       date,
  source          text,
  history         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (owner_id, room, name)
);

create table if not exists public.completions (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id     uuid not null references public.tasks(id) on delete cascade,
  done_on     date not null default current_date,
  note        text,
  source      text not null default 'app',      -- app | assistant | workbook | catchup
  created_at  timestamptz not null default now()
);
create index if not exists completions_task_idx on public.completions (task_id, done_on desc);

-- Catch-up plan 23-27 Oct 2026 (one row per task per day; walls are split over several days)
create table if not exists public.catchup_items (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id     uuid not null references public.tasks(id) on delete cascade,
  day_label   text not null,                     -- Fri, Sat, ...
  day_date    date not null,
  kind        text,                              -- Catch-up | Weekend routine | Catch-up (walls part) | Folded in ...
  minutes     int,
  note        text,
  position    int not null default 0,
  done_on     date                               -- ticked
);

create table if not exists public.settings (
  owner_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  cap_min     int not null default 300
);

-- Row-level security: owner only
alter table public.tasks         enable row level security;
alter table public.completions   enable row level security;
alter table public.catchup_items enable row level security;
alter table public.settings      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['tasks','completions','catchup_items','settings'] loop
    execute format('drop policy if exists "owner select" on public.%I', t);
    execute format('drop policy if exists "owner insert" on public.%I', t);
    execute format('drop policy if exists "owner update" on public.%I', t);
    execute format('drop policy if exists "owner delete" on public.%I', t);
    execute format('create policy "owner select" on public.%I for select to authenticated using (owner_id = (select auth.uid()))', t);
    execute format('create policy "owner insert" on public.%I for insert to authenticated with check (owner_id = (select auth.uid()))', t);
    execute format('create policy "owner update" on public.%I for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))', t);
    execute format('create policy "owner delete" on public.%I for delete to authenticated using (owner_id = (select auth.uid()))', t);
  end loop;
end $$;

-- a completion may only point at one of your own tasks
create or replace function public.completion_task_owner() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.tasks where id = new.task_id and owner_id = new.owner_id) then
    raise exception 'task % does not belong to this user', new.task_id;
  end if;
  return new;
end $$;
drop trigger if exists completions_owner_check on public.completions;
create trigger completions_owner_check before insert or update on public.completions
  for each row execute function public.completion_task_owner();

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks for each row execute function public.touch_updated_at();

-- live sync between phone and laptop
do $$ begin
  alter publication supabase_realtime add table public.completions, public.tasks, public.catchup_items;
exception when others then null; end $$;
