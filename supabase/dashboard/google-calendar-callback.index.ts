/* ============================================================
   GOOGLE CALENDAR — SINGLE-FILE EDGE FUNCTION
   Deploy as: google-calendar-callback
   IMPORTANT: this function must have JWT verification DISABLED,
   because Google's OAuth redirect arrives with no JWT. Every action
   other than the callback verifies the caller itself with
   auth.getUser(), so disabling the gateway check does not open it up.

   Routes (all on this one URL, chosen so the already-configured
   redirect URI keeps working):
     GET  ?code=..&state=..   Google's OAuth callback
     POST ?action=start       -> { authUrl }
     POST ?action=status      -> { connected, scope, connectedAt, selected }
     POST ?action=calendars   -> { calendars: [...] }
     POST ?action=select      -> { selected: [...] }        body: { calendarIds }
     POST ?action=events      -> { events: [...] }          body: { from, to, timeZone }
     POST ?action=disconnect  -> { connected: false }

   TOKENS NEVER LEAVE THE SERVER. They are written to
   public.user_integrations, which has RLS on and zero policies, so the
   browser cannot read them even with a valid session. This function
   reaches them with SERVICE_ROLE_KEY. No token or code is ever logged
   or returned.

   Events come back already normalized to FlightPlan's CalendarEvent
   shape, so the frontend does no Google-specific parsing.
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.112.4";

const PROVIDER = "google";
const APP_RETURN_URL = "https://colecarmody320.github.io/FlightPlan/";
const ALLOWED_ORIGINS = [
  "https://colecarmody320.github.io",
  "http://localhost:5173",
  "http://localhost:5183",
];

/* Scopes must match what is configured on the OAuth consent screen.
   calendar.readonly is what permits listing calendars; calendar.events
   covers reading (and later writing) events. */
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PAGES = 5;
const MAX_EVENTS = 500;
const FETCH_TIMEOUT_MS = 20000;

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

/* ---------- CORS ---------- */
function cors(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
const fail = (code: string, message: string, status: number, origin: string | null) =>
  json({ error: { code, message } }, status, origin);

/** Structural logging only. Never a token, code, or calendar content. */
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...fields }));

/* ---------- signed OAuth state (no nonce table needed) ---------- */
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmacKey() {
  // Domain-separated so this signature can never be confused with any
  // other use of the client secret.
  const raw = new TextEncoder().encode("fp-oauth-state:" + env("GOOGLE_CLIENT_SECRET"));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function signState(userId: string): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ u: userId, t: Date.now() })));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(), new TextEncoder().encode(payload))
  );
  return `${payload}.${b64url(sig)}`;
}

async function verifyState(state: string): Promise<string | null> {
  const [payload, sig] = String(state || "").split(".");
  if (!payload || !sig) return null;

  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(), new TextEncoder().encode(payload))
  );
  const got = unb64url(sig);
  if (got.length !== expected.length) return null;
  // Constant-time compare.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ got[i];
  if (diff !== 0) return null;

  try {
    const { u, t } = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    if (typeof u !== "string" || typeof t !== "number") return null;
    if (Date.now() - t > STATE_TTL_MS) return null;
    return u;
  } catch {
    return null;
  }
}

/* ---------- service-role client (RLS bypass, server only) ---------- */
const admin = () =>
  createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Verifies the caller from their Authorization header. */
async function callerId(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.getUser();
  return error || !data?.user ? null : data.user.id;
}

const redirectUri = () => `${env("SUPABASE_URL")}/functions/v1/google-calendar-callback`;

/* ---------- token handling ---------- */
async function timedFetch(url: string, init: RequestInit) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Returns a valid access token, refreshing first if it is close to expiry. */
async function accessTokenFor(userId: string): Promise<{ token: string } | { error: string }> {
  const db = admin();
  const { data: row } = await db
    .from("user_integrations")
    .select("access_token, refresh_token, token_expires_at")
    .eq("user_id", userId)
    .eq("provider", PROVIDER)
    .maybeSingle();

  if (!row || !row.refresh_token) return { error: "not_connected" };

  const expiresAt = row.token_expires_at ? Date.parse(row.token_expires_at) : 0;
  if (row.access_token && expiresAt > Date.now() + 60_000) return { token: row.access_token };

  const res = await timedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    log("refresh_failed", { status: res.status });
    return { error: res.status === 400 || res.status === 401 ? "reauth_required" : "provider_error" };
  }

  const t = await res.json();
  if (!t.access_token) return { error: "provider_error" };

  await db
    .from("user_integrations")
    .update({
      access_token: t.access_token,
      token_expires_at: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("provider", PROVIDER);

  return { token: t.access_token };
}

/* ---------- normalization to FlightPlan's CalendarEvent ---------- */
const addDaysISO = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};

/**
 * Google returns dateTime already offset into the requested timeZone,
 * so the local date and clock time can be read straight off the string
 * without any timezone math here.
 */
function normalize(ev: any, calId: string, calName: string) {
  const out: any[] = [];
  const isAllDay = Boolean(ev.start?.date);
  const base = {
    source: "google",
    eventType: "event",
    externalId: ev.id,
    sourceCalendarId: calId,
    sourceCalendarName: calName,
    title: ev.summary || "(no title)",
    location: ev.location || null,
    sourceUrl: ev.htmlLink || null,
    color: "#7FB2D4",
  };

  if (isAllDay) {
    // Google's all-day end date is exclusive; expand across the span.
    const start = ev.start.date;
    const endExcl = ev.end?.date || addDaysISO(start, 1);
    let i = 0;
    for (let day = start; day < endExcl && i < 14; day = addDaysISO(day, 1), i++) {
      out.push({ ...base, id: `google:${ev.id}:${day}`, date: day, start: null, end: null, allDay: true });
    }
    return out;
  }

  const s = String(ev.start?.dateTime || "");
  const e = String(ev.end?.dateTime || "");
  if (s.length < 16) return out;
  out.push({
    ...base,
    id: `google:${ev.id}`,
    date: s.slice(0, 10),
    start: s.slice(11, 16),
    end: e.length >= 16 && e.slice(0, 10) === s.slice(0, 10) ? e.slice(11, 16) : null,
    allDay: false,
  });
  return out;
}

/* ---------- handler ---------- */
Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });

  if (!env("GOOGLE_CLIENT_ID") || !env("GOOGLE_CLIENT_SECRET")) {
    log("misconfigured", { reason: "missing_google_credentials" });
    return fail("server_misconfigured", "Google is not configured.", 500, origin);
  }

  /* ---- 1. OAuth callback from Google (no JWT) ---- */
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code && state) {
    const userId = await verifyState(state);
    if (!userId) {
      log("callback_bad_state");
      return Response.redirect(`${APP_RETURN_URL}?calendar=error&reason=state`, 302);
    }

    const res = await timedFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env("GOOGLE_CLIENT_ID"),
        client_secret: env("GOOGLE_CLIENT_SECRET"),
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }),
    });

    if (!res.ok) {
      log("token_exchange_failed", { status: res.status });
      return Response.redirect(`${APP_RETURN_URL}?calendar=error&reason=exchange`, 302);
    }

    const t = await res.json();
    const db = admin();

    // Google only returns a refresh_token on first consent; keep the
    // stored one if this response omits it.
    const { data: existing } = await db
      .from("user_integrations")
      .select("id, refresh_token")
      .eq("user_id", userId)
      .eq("provider", PROVIDER)
      .maybeSingle();

    const row = {
      user_id: userId,
      provider: PROVIDER,
      access_token: t.access_token ?? null,
      refresh_token: t.refresh_token ?? existing?.refresh_token ?? null,
      token_expires_at: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString(),
      scope: t.scope ?? null,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      await db.from("user_integrations").update(row).eq("id", existing.id);
    } else {
      await db.from("user_integrations").insert(row);
    }

    log("connected", { hasRefresh: Boolean(row.refresh_token) });
    return Response.redirect(`${APP_RETURN_URL}?calendar=connected`, 302);
  }

  /* ---- 2. everything else requires an authenticated caller ---- */
  const action = url.searchParams.get("action") || "";
  const userId = await callerId(req);
  if (!userId) return fail("unauthenticated", "Sign in first.", 401, origin);

  const db = admin();

  if (action === "start") {
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.searchParams.set("client_id", env("GOOGLE_CLIENT_ID"));
    auth.searchParams.set("redirect_uri", redirectUri());
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", SCOPES);
    auth.searchParams.set("access_type", "offline");
    auth.searchParams.set("prompt", "consent");
    auth.searchParams.set("include_granted_scopes", "true");
    auth.searchParams.set("state", await signState(userId));
    return json({ authUrl: auth.toString() }, 200, origin);
  }

  if (action === "status") {
    const { data: row } = await db
      .from("user_integrations")
      .select("scope, connected_at, selected_calendar_ids, refresh_token")
      .eq("user_id", userId)
      .eq("provider", PROVIDER)
      .maybeSingle();
    return json(
      {
        connected: Boolean(row?.refresh_token),
        scope: row?.scope ?? null,
        connectedAt: row?.connected_at ?? null,
        selected: row?.selected_calendar_ids ?? [],
      },
      200,
      origin
    );
  }

  if (action === "disconnect") {
    await db.from("user_integrations").delete().eq("user_id", userId).eq("provider", PROVIDER);
    log("disconnected");
    return json({ connected: false }, 200, origin);
  }

  if (action === "calendars") {
    const tok = await accessTokenFor(userId);
    if ("error" in tok) return fail(tok.error, "Reconnect Google Calendar.", 400, origin);
    const res = await timedFetch(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=100",
      { headers: { Authorization: `Bearer ${tok.token}` } }
    );
    if (!res.ok) {
      log("calendarlist_failed", { status: res.status });
      return fail("provider_error", "Could not list calendars.", 502, origin);
    }
    const body = await res.json();
    return json(
      {
        calendars: (body.items || []).map((c: any) => ({
          id: c.id,
          name: c.summaryOverride || c.summary || c.id,
          primary: Boolean(c.primary),
        })),
      },
      200,
      origin
    );
  }

  if (action === "select") {
    let ids: unknown = [];
    try {
      ids = (await req.json())?.calendarIds;
    } catch {
      return fail("bad_request", "Body must be JSON.", 400, origin);
    }
    if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string") || ids.length > 50) {
      return fail("bad_request", "`calendarIds` must be an array of up to 50 strings.", 400, origin);
    }
    await db
      .from("user_integrations")
      .update({ selected_calendar_ids: ids, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("provider", PROVIDER);
    return json({ selected: ids }, 200, origin);
  }

  if (action === "events") {
    let from = "";
    let to = "";
    let timeZone = "UTC";
    try {
      const b = await req.json();
      from = String(b?.from || "");
      to = String(b?.to || "");
      timeZone = String(b?.timeZone || "UTC").slice(0, 64);
    } catch {
      return fail("bad_request", "Body must be JSON.", 400, origin);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return fail("bad_request", "`from` and `to` must be YYYY-MM-DD.", 400, origin);
    }

    const tok = await accessTokenFor(userId);
    if ("error" in tok) return fail(tok.error, "Reconnect Google Calendar.", 400, origin);

    const { data: row } = await db
      .from("user_integrations")
      .select("selected_calendar_ids")
      .eq("user_id", userId)
      .eq("provider", PROVIDER)
      .maybeSingle();

    // No explicit selection yet: fall back to the primary calendar only,
    // rather than pulling in every calendar the account can see.
    let calendars: Array<{ id: string; name: string }> = [];
    const selected: string[] = row?.selected_calendar_ids ?? [];
    const listRes = await timedFetch(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=100",
      { headers: { Authorization: `Bearer ${tok.token}` } }
    );
    if (listRes.ok) {
      const all = (await listRes.json()).items || [];
      calendars = all
        .filter((c: any) => (selected.length ? selected.includes(c.id) : c.primary))
        .map((c: any) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id }));
    }

    const events: any[] = [];
    for (const cal of calendars) {
      let pageToken = "";
      for (let page = 0; page < MAX_PAGES; page++) {
        const q = new URLSearchParams({
          timeMin: `${from}T00:00:00Z`,
          timeMax: `${addDaysISO(to, 1)}T00:00:00Z`,
          singleEvents: "true", // expands recurring events into instances
          orderBy: "startTime",
          maxResults: "250",
          timeZone,
        });
        if (pageToken) q.set("pageToken", pageToken);

        const r = await timedFetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${q}`,
          { headers: { Authorization: `Bearer ${tok.token}` } }
        );
        if (!r.ok) {
          log("events_failed", { status: r.status });
          break; // one bad calendar must not sink the rest
        }
        const body = await r.json();
        for (const ev of body.items || []) {
          if (ev.status === "cancelled") continue;
          events.push(...normalize(ev, cal.id, cal.name));
          if (events.length >= MAX_EVENTS) break;
        }
        pageToken = body.nextPageToken || "";
        if (!pageToken || events.length >= MAX_EVENTS) break;
      }
      if (events.length >= MAX_EVENTS) break;
    }

    log("events_ok", { calendars: calendars.length, events: events.length });
    return json({ events, calendars, fetchedAt: new Date().toISOString() }, 200, origin);
  }

  return fail("bad_request", "Unknown action.", 400, origin);
});
