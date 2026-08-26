-- ============================================================
-- CIRRUS — SERVER-SIDE RATE LIMITING
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor →
-- New query → paste → Run). It is idempotent: running it again is
-- harmless.
--
-- WHY A TABLE AND NOT A COUNTER IN THE FUNCTION. Edge Functions scale
-- horizontally and are recycled freely, so an in-memory counter is per
-- instance and resets on every cold start — which means the real
-- ceiling is "the limit, times however many instances happen to exist".
-- That is not a limit. Postgres gives one shared counter and, through
-- row locking, makes the check-and-increment atomic, so two requests
-- arriving at the same instant cannot both pass a check that only one
-- of them should.
--
-- This is defence in depth beneath Google's own quotas and the account
-- spend cap, not a replacement for either.
-- ============================================================

create table if not exists public.cirrus_rate_limit (
  user_id      uuid        primary key,
  -- rolling one-minute window
  minute_start timestamptz not null default now(),
  minute_count integer     not null default 0,
  -- calendar day, UTC
  day_start    date        not null default (now() at time zone 'utc')::date,
  day_count    integer     not null default 0,
  -- concurrency lease: set while a request is in flight, cleared after.
  -- A timestamp rather than a counter so a request that dies without
  -- releasing cannot wedge the user out permanently — the lease simply
  -- expires.
  active_since timestamptz,
  updated_at   timestamptz not null default now()
);

-- RLS on with no policies: the browser gets nothing at all, even with a
-- valid session. Only the service role, which bypasses RLS, can reach
-- it — and only the Edge Function holds that key.
alter table public.cirrus_rate_limit enable row level security;

comment on table public.cirrus_rate_limit is
  'Server-side Cirrus/Gemini rate limiting. Written only by the cirrus-chat Edge Function via the service role.';

-- ============================================================
-- ACQUIRE — the gate every Gemini request passes through.
--
-- Returns jsonb:
--   { allowed: true,  minute_count, day_count }
--   { allowed: false, reason: 'minute'|'daily'|'concurrent',
--     retry_after: <seconds>, minute_count, day_count }
--
-- SELECT ... FOR UPDATE is what makes this race-free: concurrent calls
-- for the same user queue on the row lock, so each one sees the
-- previous one's increment before making its own decision.
-- ============================================================
create or replace function public.cirrus_rate_acquire(
  p_user          uuid,
  p_rpm           integer,
  p_rpd           integer,
  p_lease_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r         public.cirrus_rate_limit%rowtype;
  now_ts    timestamptz := now();
  today     date        := (now() at time zone 'utc')::date;
  minute_st timestamptz;
  minute_ct integer;
  day_st    date;
  day_ct    integer;
begin
  insert into public.cirrus_rate_limit (user_id, minute_start, day_start)
  values (p_user, now_ts, today)
  on conflict (user_id) do nothing;

  select * into r from public.cirrus_rate_limit where user_id = p_user for update;
  if not found then
    -- Cannot account for it, so do not allow it.
    return jsonb_build_object('allowed', false, 'reason', 'unavailable', 'retry_after', 5);
  end if;

  minute_st := r.minute_start;
  minute_ct := r.minute_count;
  day_st    := r.day_start;
  day_ct    := r.day_count;

  -- Roll the windows before deciding anything.
  if now_ts - minute_st >= interval '1 minute' then
    minute_st := now_ts;
    minute_ct := 0;
  end if;
  if day_st is distinct from today then
    day_st := today;
    day_ct := 0;
  end if;

  -- One Gemini request per user at a time. An expired lease belonged to
  -- a request that never released; it is reclaimed rather than honoured.
  if r.active_since is not null
     and now_ts - r.active_since < make_interval(secs => greatest(p_lease_seconds, 1)) then
    update public.cirrus_rate_limit
       set minute_start = minute_st, minute_count = minute_ct,
           day_start = day_st, day_count = day_ct, updated_at = now_ts
     where user_id = p_user;
    return jsonb_build_object(
      'allowed', false, 'reason', 'concurrent', 'retry_after', 2,
      'minute_count', minute_ct, 'day_count', day_ct);
  end if;

  if day_ct >= p_rpd then
    update public.cirrus_rate_limit
       set minute_start = minute_st, minute_count = minute_ct,
           day_start = day_st, day_count = day_ct, updated_at = now_ts
     where user_id = p_user;
    return jsonb_build_object(
      'allowed', false, 'reason', 'daily',
      'retry_after', greatest(1, ceil(extract(epoch from
        (((today + 1)::timestamp at time zone 'utc') - now_ts)))::integer),
      'minute_count', minute_ct, 'day_count', day_ct);
  end if;

  if minute_ct >= p_rpm then
    update public.cirrus_rate_limit
       set minute_start = minute_st, minute_count = minute_ct,
           day_start = day_st, day_count = day_ct, updated_at = now_ts
     where user_id = p_user;
    return jsonb_build_object(
      'allowed', false, 'reason', 'minute',
      'retry_after', greatest(1, ceil(extract(epoch from
        (minute_st + interval '1 minute' - now_ts)))::integer),
      'minute_count', minute_ct, 'day_count', day_ct);
  end if;

  update public.cirrus_rate_limit
     set minute_start = minute_st,
         minute_count = minute_ct + 1,
         day_start    = day_st,
         day_count    = day_ct + 1,
         active_since = now_ts,
         updated_at   = now_ts
   where user_id = p_user;

  return jsonb_build_object(
    'allowed', true, 'minute_count', minute_ct + 1, 'day_count', day_ct + 1);
end;
$$;

-- ============================================================
-- CHARGE — a retry costs quota like any other Gemini call.
--
-- Deliberately does not touch the lease: the caller already holds it.
-- Without this a retry would be a free request, and "retries bypass the
-- limiter" is precisely the hole worth closing.
-- ============================================================
create or replace function public.cirrus_rate_charge(
  p_user uuid,
  p_rpm  integer,
  p_rpd  integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r         public.cirrus_rate_limit%rowtype;
  now_ts    timestamptz := now();
  today     date        := (now() at time zone 'utc')::date;
  minute_st timestamptz;
  minute_ct integer;
  day_st    date;
  day_ct    integer;
begin
  select * into r from public.cirrus_rate_limit where user_id = p_user for update;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'unavailable');
  end if;

  minute_st := r.minute_start; minute_ct := r.minute_count;
  day_st    := r.day_start;    day_ct    := r.day_count;

  if now_ts - minute_st >= interval '1 minute' then
    minute_st := now_ts; minute_ct := 0;
  end if;
  if day_st is distinct from today then
    day_st := today; day_ct := 0;
  end if;

  if day_ct >= p_rpd or minute_ct >= p_rpm then
    update public.cirrus_rate_limit
       set minute_start = minute_st, minute_count = minute_ct,
           day_start = day_st, day_count = day_ct, updated_at = now_ts
     where user_id = p_user;
    return jsonb_build_object('allowed', false,
      'reason', case when day_ct >= p_rpd then 'daily' else 'minute' end);
  end if;

  update public.cirrus_rate_limit
     set minute_start = minute_st, minute_count = minute_ct + 1,
         day_start = day_st, day_count = day_ct + 1, updated_at = now_ts
   where user_id = p_user;

  return jsonb_build_object('allowed', true,
    'minute_count', minute_ct + 1, 'day_count', day_ct + 1);
end;
$$;

-- ============================================================
-- RELEASE — clears the concurrency lease. Counters are untouched: a
-- request that has been made has been made, whatever its outcome.
-- ============================================================
create or replace function public.cirrus_rate_release(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.cirrus_rate_limit
     set active_since = null, updated_at = now()
   where user_id = p_user;
end;
$$;

-- ============================================================
-- Read-only view of the caller's own usage, for showing "you have N
-- left today" without exposing anyone else's row.
-- ============================================================
create or replace function public.cirrus_rate_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r      public.cirrus_rate_limit%rowtype;
  today  date := (now() at time zone 'utc')::date;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'unauthenticated');
  end if;
  select * into r from public.cirrus_rate_limit where user_id = auth.uid();
  if not found then
    return jsonb_build_object('minute_count', 0, 'day_count', 0);
  end if;
  return jsonb_build_object(
    'minute_count', case when now() - r.minute_start >= interval '1 minute' then 0 else r.minute_count end,
    'day_count',    case when r.day_start is distinct from today then 0 else r.day_count end);
end;
$$;

-- Only the service role may spend quota. `authenticated` may read its
-- own counters and nothing else.
revoke all on function public.cirrus_rate_acquire(uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.cirrus_rate_charge(uuid, integer, integer)          from public, anon, authenticated;
revoke all on function public.cirrus_rate_release(uuid)                            from public, anon, authenticated;
grant execute on function public.cirrus_rate_acquire(uuid, integer, integer, integer) to service_role;
grant execute on function public.cirrus_rate_charge(uuid, integer, integer)          to service_role;
grant execute on function public.cirrus_rate_release(uuid)                            to service_role;

revoke all on function public.cirrus_rate_status() from public, anon;
grant execute on function public.cirrus_rate_status() to authenticated, service_role;
