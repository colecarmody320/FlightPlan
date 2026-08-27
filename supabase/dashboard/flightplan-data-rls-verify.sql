-- ============================================================
-- FLIGHTPLAN — verify the RLS policy is actually in force
--
-- Run this AFTER flightplan-data-rls.sql.
--
-- Why it is a separate file: that one is all DDL, and DDL reports
-- "Success. No rows returned." even when it worked perfectly. These are
-- queries, so they return something you can actually read.
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> paste -> Run.
-- ============================================================

-- 1. THE HEADLINE. One row, two numbers.
--
--    rls_enabled  must be TRUE.  If false, every policy below is
--                 decoration and any authenticated session can read or
--                 overwrite any other account's FlightPlan.
--    policy_count must be 4.
select
  (select relrowsecurity
     from pg_class
    where oid = 'public.flightplan_data'::regclass) as rls_enabled,
  (select count(*)
     from pg_policies
    where schemaname = 'public'
      and tablename  = 'flightplan_data')           as policy_count;

-- 2. THE DETAIL. Four rows: select, insert, update, delete.
--
--    The UPDATE row must have BOTH `qual` and `with_check` populated.
--    `qual` decides which rows may be updated; `with_check` decides
--    what they may be changed INTO. With only the first, a user can
--    reassign their own row to somebody else's user_id.
--
--    The INSERT row has `with_check` only — that is correct. USING is
--    not consulted for rows that do not exist yet.
select policyname, cmd, qual, with_check
  from pg_policies
 where schemaname = 'public'
   and tablename  = 'flightplan_data'
 order by policyname;

-- 3. The upsert in App.jsx names user_id as its conflict target, so a
--    unique index on that column has to exist. Expect one row.
select indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename  = 'flightplan_data'
   and indexdef ilike '%unique%';
