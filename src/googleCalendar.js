import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase.js";

/* ============================================================
   GOOGLE CALENDAR — CLIENT SERVICE

   The browser never talks to Google. Every call goes to our own
   authenticated Edge Function, which holds the tokens server-side and
   returns events already normalized to FlightPlan's CalendarEvent
   shape. There is no Google SDK, endpoint, or token in this bundle.

   Failure is always non-destructive: a failed refresh keeps whatever
   was last fetched rather than blanking the calendar, and no FlightPlan
   record is ever written from here.
   ============================================================ */

const FN = "google-calendar-callback";
const FRESH_MS = 15 * 60 * 1000; // matches the calendar freshness rule

const MESSAGES = {
  unauthenticated: "Sign in again to reach Google Calendar.",
  not_connected: "Google Calendar isn't connected.",
  reauth_required: "Google access expired — reconnect.",
  provider_error: "Google Calendar is unavailable right now.",
  server_misconfigured: "Google Calendar isn't configured on the server.",
  bad_request: "That request couldn't be sent.",
  network_error: "Couldn't reach Google Calendar.",
  not_found: "That event no longer exists in Google Calendar.",
  conflict: "That event changed in Google, so it was left untouched.",
};
const friendly = (code) => MESSAGES[code] || "Something went wrong.";

async function callFn(action, body) {
  const { data: session } = await supabase.auth.getSession();
  if (!session?.session) return { ok: false, code: "unauthenticated" };

  let res;
  try {
    res = await supabase.functions.invoke(`${FN}?action=${encodeURIComponent(action)}`, {
      body: body || {},
    });
  } catch (err) {
    return { ok: false, code: "network_error", detail: err?.message };
  }

  if (res.error) {
    const ctx = res.error?.context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const b = await ctx.json();
        const code = b?.error?.code;
        if (code) return { ok: false, code, detail: b?.error?.message };
      } catch {
        /* fall through to status mapping */
      }
      if (ctx.status === 401) return { ok: false, code: "unauthenticated" };
      if (ctx.status >= 500) return { ok: false, code: "provider_error" };
      return { ok: false, code: "bad_request" };
    }
    return { ok: false, code: "network_error", detail: res.error?.message };
  }

  return { ok: true, data: res.data };
}

/* ---------- thin action wrappers ---------- */
export const googleStatus = () => callFn("status");
export const googleCalendars = () => callFn("calendars");
export const googleSelect = (calendarIds) => callFn("select", { calendarIds });
export const googleDisconnect = () => callFn("disconnect");
export const googleEvents = (from, to) =>
  callFn("events", {
    from,
    to,
    // Google returns times already offset into this zone, so the
    // calendar renders in the user's actual local time.
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  });

/* ============================================================
   WRITE CLIENT

   The mutating half of the integration. It is deliberately thin: every
   one of these takes already-validated primitives and forwards them to
   the Edge Function, which holds the tokens and does the talking. No
   Google endpoint, token, or client secret exists on this side, and
   nothing here writes to flightplan_data — a Google event lives in
   Google, and FlightPlan only ever re-reads it.

   `etag` is the concurrency token. Pass the one seen when the change
   was proposed and a stale write is refused rather than applied.
   ============================================================ */
export const googleGetEvent = ({ calendarId, eventId }) =>
  callFn("event_get", { calendarId, eventId });

export const googleCreateEvent = (payload) => callFn("event_create", payload);

export const googleUpdateEvent = ({ calendarId, eventId, etag, changes, timeZone }) =>
  callFn("event_update", { calendarId, eventId, etag, changes, timeZone });

export const googleDeleteEvent = ({ calendarId, eventId, etag }) =>
  callFn("event_delete", { calendarId, eventId, etag });

/** The zone Google should resolve wall-clock times in. Read from the
    device, never computed and never supplied by the model. */
export const localTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/* ---------- refresh bus ----------
   CalendarTab and ThisWeekPanel each hold their own instance of the
   hook, so a mutation made from Cirrus has to reach both. This is a
   one-line pub/sub rather than a shared store: it changes nothing about
   how the calendar is structured, and it means a successful write shows
   up immediately instead of waiting out the 15-minute freshness
   window. */
const refreshListeners = new Set();

export function invalidateGoogleCalendar() {
  for (const fn of refreshListeners) {
    try {
      fn();
    } catch {
      /* one stale listener must not stop the others */
    }
  }
}

/** Begins OAuth by navigating to Google's consent screen. */
export async function googleConnect() {
  const r = await callFn("start");
  if (!r.ok) return r;
  if (!r.data?.authUrl) return { ok: false, code: "provider_error" };
  window.location.href = r.data.authUrl;
  return { ok: true };
}

/* ============================================================
   HOOK
   Owns connection status and the event cache for a date range.
   ============================================================ */
export function useGoogleCalendar({ user, from, to } = {}) {
  const [status, setStatus] = useState({ connected: false, selected: [], connectedAt: null });
  const [calendars, setCalendars] = useState([]);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(null);

  // Guards against overlapping fetches and stale-range writes.
  const inFlight = useRef(false);
  const rangeKey = `${from || ""}..${to || ""}`;
  const lastRange = useRef("");
  const lastFetch = useRef(0);

  const refreshStatus = useCallback(async () => {
    if (!user) return;
    const r = await googleStatus();
    if (r.ok) {
      setStatus({
        connected: Boolean(r.data?.connected),
        selected: r.data?.selected || [],
        connectedAt: r.data?.connectedAt || null,
      });
      setError(null);
    } else if (r.code !== "unauthenticated") {
      setError({ code: r.code, message: friendly(r.code) });
    }
  }, [user]);

  const loadCalendars = useCallback(async () => {
    const r = await googleCalendars();
    if (r.ok) {
      setCalendars(r.data?.calendars || []);
      setError(null);
    } else {
      setError({ code: r.code, message: friendly(r.code) });
    }
    return r;
  }, []);

  const fetchEvents = useCallback(
    async (force = false) => {
      if (!user || !status.connected || !from || !to) return;
      if (inFlight.current) return; // never overlap
      const fresh = Date.now() - lastFetch.current < FRESH_MS;
      if (!force && fresh && lastRange.current === rangeKey) return;

      inFlight.current = true;
      setBusy(true);
      const r = await googleEvents(from, to);
      inFlight.current = false;
      setBusy(false);

      if (r.ok) {
        setEvents(r.data?.events || []);
        setFetchedAt(r.data?.fetchedAt || new Date().toISOString());
        lastFetch.current = Date.now();
        lastRange.current = rangeKey;
        setError(null);
      } else {
        // Keep whatever we already have. A failed refresh must never
        // blank the calendar.
        setError({ code: r.code, message: friendly(r.code) });
        if (r.code === "reauth_required" || r.code === "not_connected") {
          setStatus((s) => ({ ...s, connected: false }));
        }
      }
    },
    [user, status.connected, from, to, rangeKey]
  );

  const selectCalendars = useCallback(
    async (ids) => {
      const r = await googleSelect(ids);
      if (r.ok) {
        setStatus((s) => ({ ...s, selected: r.data?.selected || [] }));
        lastFetch.current = 0; // selection changed: refetch now
        await fetchEvents(true);
      } else {
        setError({ code: r.code, message: friendly(r.code) });
      }
      return r;
    },
    [fetchEvents]
  );

  const disconnect = useCallback(async () => {
    const r = await googleDisconnect();
    if (r.ok) {
      setStatus({ connected: false, selected: [], connectedAt: null });
      setCalendars([]);
      setEvents([]); // only Google's own events; FlightPlan data untouched
      setFetchedAt(null);
      lastFetch.current = 0;
    }
    return r;
  }, []);

  // Initial status, plus the ?calendar=connected hand-off from OAuth.
  useEffect(() => {
    if (!user) return;
    refreshStatus();
    const params = new URLSearchParams(window.location.search);
    if (params.get("calendar")) {
      // Clean the URL so a refresh doesn't look like a fresh callback.
      const url = new URL(window.location.href);
      url.searchParams.delete("calendar");
      url.searchParams.delete("reason");
      window.history.replaceState({}, "", url.toString());
    }
  }, [user, refreshStatus]);

  // Fetch when connected or when the visible range moves.
  useEffect(() => {
    fetchEvents(false);
  }, [fetchEvents]);

  // An immediate, un-gated refresh after any successful mutation, from
  // this instance of the hook or any other.
  useEffect(() => {
    if (!user || !status.connected) return;
    const onInvalidate = () => {
      lastFetch.current = 0; // bypass the freshness window deliberately
      fetchEvents(true);
    };
    refreshListeners.add(onInvalidate);
    return () => refreshListeners.delete(onInvalidate);
  }, [user, status.connected, fetchEvents]);

  // Periodic refresh and return-from-background, both freshness-gated.
  useEffect(() => {
    if (!user || !status.connected) return;
    const timer = setInterval(() => fetchEvents(false), FRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchEvents(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user, status.connected, fetchEvents]);

  return useMemo(
    () => ({
      ...status,
      calendars,
      events,
      error,
      busy,
      fetchedAt,
      connect: googleConnect,
      disconnect,
      loadCalendars,
      selectCalendars,
      refresh: () => fetchEvents(true),
      refreshStatus,
    }),
    [status, calendars, events, error, busy, fetchedAt, disconnect, loadCalendars, selectCalendars, fetchEvents, refreshStatus]
  );
}
