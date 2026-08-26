-- ============================================================
-- FLIGHTPLAN — row level security for the user's data table
--
-- WHY THIS FILE EXISTS. The browser writes its own `user_id` when it
-- saves:
--
--     supabase.from("flightplan_data").upsert({ user_id: userId, ... })
--
-- That value comes from the client, so the database — not the client —
-- has to be the thing that decides whose row may be touched. Without
-- RLS, any authenticated session could read or overwrite any other
-- user's FlightPlan simply by sending a different id. The email
-- allowlist in App.jsx is a UI gate, not a security boundary: it runs
-- on the attacker's own machine.
--
-- Stage 10 could not verify the live database from the build sandbox,
-- so the policy lives here as something you can run and re-run. It is
-- idempotent — safe to execute even if it is already in place.
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> paste -> Run.
-- ============================================================

-- 1. Turn RLS on. With it off, every policy below is decoration.
alter table public.flightplan_data enable row level security;

-- 2. Replace any earlier versions so this file is the whole story.
drop policy if exists "flightplan_data_select_own" on public.flightplan_data;
drop policy if exists "flightplan_data_insert_own" on public.flightplan_data;
drop policy if exists "flightplan_data_update_own" on public.flightplan_data;
drop policy if exists "flightplan_data_delete_own" on public.flightplan_data;

-- 3. A user may only ever see their own row.
create policy "flightplan_data_select_own"
  on public.flightplan_data
  for select
  to authenticated
  using (auth.uid() = user_id);

-- INSERT needs WITH CHECK: USING is not consulted for new rows, so
-- without this a client could insert a row under someone else's id.
create policy "flightplan_data_insert_own"
  on public.flightplan_data
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- UPDATE needs BOTH: USING decides which rows are visible to update,
-- WITH CHECK decides what they may be changed INTO. Omitting the
-- second lets a user hand their row to another account.
create policy "flightplan_data_update_own"
  on public.flightplan_data
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "flightplan_data_delete_own"
  on public.flightplan_data
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- 4. The upsert in App.jsx relies on this to resolve its conflict
--    target, and it also stops one account accumulating several rows.
create unique index if not exists flightplan_data_user_id_key
  on public.flightplan_data (user_id);

-- ============================================================
-- VERIFY. Run these after the above and read the results.
--
--   select relrowsecurity from pg_class
--   where oid = 'public.flightplan_data'::regclass;
--     -> must be true. false means the data is public to any session.
--
--   select policyname, cmd, qual, with_check from pg_policies
--   where tablename = 'flightplan_data';
--     -> expect four rows; both UPDATE columns must be populated.
-- ============================================================
