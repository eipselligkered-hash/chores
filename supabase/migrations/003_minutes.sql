-- 003_minutes.sql – chores app v13: optional 'took __ min' on each tick. Idempotent; nothing else needed (RLS covers the table).
alter table public.completions add column if not exists minutes int check (minutes between 0 and 600);
