/* ============================================================
   GOOGLE CALENDAR — ACTION SUPPORT

   Two jobs, both deliberately kept out of the model's hands:

   1. RESOLVING WHEN. The model may say "tomorrow", but it never
      computes a date and never computes a timezone offset. It hands
      over a token from a fixed vocabulary; this module turns that into
      a calendar date using the device's clock, and the Edge Function
      sends Google a wall-clock time plus an IANA zone name so Google
      does the conversion. There is no arithmetic anywhere a model
      could get wrong.

   2. IDENTIFYING WHICH. A title is not an identifier. Nothing here
      returns an event to act on unless exactly one candidate matches;
      several candidates or none are reported as such so Cirrus asks
      instead of guessing. The identifiers that actually reach Google
      are the calendarId and eventId of that single candidate.

   Pure functions only: no network, no state, no writes.
   ============================================================ */

export const RELATIVE_DAYS = {
  today: 0,
  tomorrow: 1,
  "the day after tomorrow": 2,
  yesterday: -1,
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isISODate = (v) => typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00`));
export const isHHMM = (v) => typeof v === "string" && HHMM.test(v);

export function addDaysISO(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(y, m - 1, d + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

/**
 * Turns a date token into a calendar date, or explains why it can't.
 *
 * Accepts an absolute YYYY-MM-DD or one of a small closed vocabulary of
 * relative words. Anything else — "next week", "soon", "the 3rd" — is
 * refused rather than guessed at, because a wrong date silently creates
 * the right event on the wrong day.
 */
export function resolveDate(token, todayISO) {
  if (isISODate(token)) return { ok: true, date: token };
  const key = String(token || "").trim().toLowerCase();
  if (key in RELATIVE_DAYS) {
    return { ok: true, date: addDaysISO(todayISO, RELATIVE_DAYS[key]) };
  }
  return {
    ok: false,
    reason: `I can't pin "${String(token || "").slice(0, 40)}" to a date. Give me the day as YYYY-MM-DD, or say today or tomorrow.`,
  };
}

/** Minutes since midnight, or null. Used only for ordering and overlap. */
export const minutesOf = (hhmm) =>
  isHHMM(hhmm) ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) : null;

/** 13:00 → 1:00 PM. Display only. */
export function formatTime(hhmm) {
  if (!isHHMM(hhmm)) return null;
  const h = Number(hhmm.slice(0, 2));
  const m = hhmm.slice(3, 5);
  const suffix = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${m} ${suffix}`;
}

/** "1:00 PM–2:00 PM", "All day", or "—". */
export function formatWhen(ev) {
  if (!ev) return "—";
  if (ev.allDay || !ev.start) return "All day";
  const s = formatTime(ev.start);
  const e = ev.end ? formatTime(ev.end) : null;
  return e ? `${s}–${e}` : s;
}

/* ---------- identification ---------- */

const normalizeText = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const STOPWORDS = new Set([
  "my", "the", "a", "an", "on", "at", "for", "to", "of", "session",
  "event", "appointment", "meeting", "please", "cirrus",
]);

const keywords = (s) =>
  normalizeText(s)
    .split(" ")
    .filter((w) => w && w.length > 1 && !STOPWORDS.has(w));

/**
 * Scores how well an event title matches a query. Returns null for no
 * match at all — a weak partial is not a match, because acting on a
 * near-miss is exactly the failure mode this guards against.
 */
export function matchScore(query, title) {
  const q = normalizeText(query);
  const t = normalizeText(title);
  if (!q || !t) return null;
  if (q === t) return 100;
  if (t.includes(q)) return 80;

  const qk = keywords(query);
  const tk = new Set(keywords(title));
  if (!qk.length) return null;
  const hits = qk.filter((w) => tk.has(w)).length;
  if (!hits) return null;
  // Every meaningful word must land, or it isn't confidently this event.
  if (hits < qk.length) return null;
  return 60;
}

export const CANDIDATE_RESULTS = { ONE: "one", MANY: "many", NONE: "none" };

/**
 * Finds the Google event a request refers to.
 *
 * `events` is the normalized calendar list already in memory. Only
 * Google-sourced events are eligible: FlightPlan's own classes and
 * deadlines are not Google events and must never be sent to Google.
 */
export function findEventCandidates(events, { query, date, eventId, calendarId } = {}) {
  const google = (events || []).filter(
    (e) => e && e.source === "google" && e.externalId && e.sourceCalendarId
  );

  // An explicit id short-circuits everything: it is already unambiguous.
  if (eventId) {
    const exact = google.filter(
      (e) => e.externalId === eventId && (!calendarId || e.sourceCalendarId === calendarId)
    );
    if (exact.length === 1) return { result: CANDIDATE_RESULTS.ONE, event: exact[0], candidates: exact };
    if (exact.length > 1) return { result: CANDIDATE_RESULTS.MANY, candidates: exact };
    return { result: CANDIDATE_RESULTS.NONE, candidates: [] };
  }

  let pool = google;
  if (date) pool = pool.filter((e) => e.date === date);

  let scored = pool
    .map((e) => ({ event: e, score: query ? matchScore(query, e.title) : 0 }))
    .filter((x) => x.score !== null);

  if (query && scored.length > 1) {
    // Prefer the strongest match, but only if it is genuinely stronger.
    const best = Math.max(...scored.map((x) => x.score));
    const top = scored.filter((x) => x.score === best);
    if (top.length === 1) scored = top;
  }

  // A recurring event expands into one entry per instance; entries that
  // are the same instance of the same event are not real ambiguity.
  const unique = [];
  const seen = new Set();
  for (const x of scored) {
    const key = `${x.event.sourceCalendarId}::${x.event.externalId}::${x.event.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(x.event);
  }

  if (unique.length === 1) return { result: CANDIDATE_RESULTS.ONE, event: unique[0], candidates: unique };
  if (unique.length > 1) {
    return {
      result: CANDIDATE_RESULTS.MANY,
      candidates: unique
        .slice(0, 8)
        .sort((a, b) => (a.date === b.date ? (minutesOf(a.start) ?? 0) - (minutesOf(b.start) ?? 0) : a.date < b.date ? -1 : 1)),
    };
  }
  return { result: CANDIDATE_RESULTS.NONE, candidates: [] };
}

/** One-line description used in previews and clarifying questions. */
export const describeEvent = (e) =>
  e ? `"${e.title}" on ${e.date}${e.allDay ? " (all day)" : e.start ? ` at ${formatTime(e.start)}` : ""}` : "";

/**
 * The material fields of a Google event. Compared between proposal and
 * approval to detect that it changed underneath us — the same idea as
 * Stage 6's local fingerprint, applied to a remote record.
 */
export function fingerprintGoogleEvent(ev) {
  if (!ev) return null;
  return JSON.stringify([
    ev.title || "",
    ev.date || "",
    ev.start || "",
    ev.end || "",
    ev.allDay ? 1 : 0,
    ev.location || "",
  ]);
}
