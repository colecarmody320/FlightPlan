/* ============================================================
   FLIGHTPLAN — NORMALIZED CALENDAR LAYER

   One read model for every schedule source. The Calendar tab, the Home
   THIS WEEK strip, and Cirrus's read-only context all consume these
   same functions — there is no per-source UI and no duplicated
   calendar logic.

   This is a VIEW, not a store. CalendarEvent objects are derived on
   demand from records that already exist (courses, countdowns, daily
   tasks, sessions, flights) plus any external events handed in. No
   existing record is migrated into a new schema to make rendering
   easier, and nothing here writes.

   SOURCES
     flightplan  — derived from FlightPlan's own records
     brightspace — iCal feed (not wired yet; shape reserved)
     google      — Google Calendar (not wired yet; shape reserved)
     manual      — user-created one-off events

   External events are passed in already normalized, so adding
   Brightspace or Google later means writing an adapter to this shape
   and nothing in the UI changes.
   ============================================================ */

export const CALENDAR_SOURCES = {
  FLIGHTPLAN: "flightplan",
  BRIGHTSPACE: "brightspace",
  GOOGLE: "google",
  MANUAL: "manual",
};

export const EVENT_TYPES = {
  CLASS: "class",
  ASSIGNMENT: "assignment",
  QUIZ: "quiz",
  EXAM: "exam",
  EVENT: "event",
  STUDY: "study",
  FLIGHT: "flight",
  OTHER: "other",
};

/* iCal day codes — chosen now so a Brightspace RRULE maps straight in. */
export const DAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
export const DAY_LABELS = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };

/* ---------- date helpers (local time, matching app convention) ---------- */
const pad = (n) => String(n).padStart(2, "0");

export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const todayISO = () => isoOf(new Date());

export function addDaysISO(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return isoOf(new Date(y, m - 1, d + n));
}

/** Monday-based, matching App's weekStart(). */
export function weekStartISO(iso = todayISO()) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return addDaysISO(iso, -((dt.getDay() + 6) % 7));
}

export function weekDays(anchorISO = todayISO()) {
  const start = weekStartISO(anchorISO);
  return Array.from({ length: 7 }, (_, i) => addDaysISO(start, i));
}

export function dayCodeOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return DAY_CODES[(new Date(y, m - 1, d).getDay() + 6) % 7];
}

/** "HH:MM" -> minutes from midnight. Returns null on anything malformed. */
export function minutesOf(hhmm) {
  if (typeof hhmm !== "string") return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatTime(hhmm) {
  const mins = minutesOf(hhmm);
  if (mins === null) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${ampm}`;
}

export function formatDayLabel(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function formatRange(days) {
  if (!days.length) return "";
  return `${formatDayLabel(days[0])} — ${formatDayLabel(days[days.length - 1])}`.toUpperCase();
}

const inRange = (iso, from, to) => (!from || iso >= from) && (!to || iso <= to);

/* ---------- colors ---------- */
/* Derived deterministically from the course id so a course keeps the
   same color across the app without storing a color field. */
const COURSE_COLORS = ["#6FBF8F", "#7FB2D4", "#C4A15A", "#B08BC4", "#5FB3A8", "#D98F5A"];

export function colorForCourse(courseId) {
  if (!courseId) return null;
  let h = 0;
  for (let i = 0; i < courseId.length; i++) h = (h * 31 + courseId.charCodeAt(i)) >>> 0;
  return COURSE_COLORS[h % COURSE_COLORS.length];
}

/* ============================================================
   DERIVATION
   Each builder reads one existing record type. All are pure.
   ============================================================ */

/** Recurring class meetings from course.meetingTimes (additive field). */
function classEvents(data, days) {
  const out = [];
  (data.courses || [])
    .filter((c) => !c.archived)
    .forEach((course) => {
      (course.meetingTimes || []).forEach((mt, idx) => {
        const startMin = minutesOf(mt.start);
        if (startMin === null) return; // never fabricate a time
        const codes = Array.isArray(mt.days) ? mt.days : [];
        days.forEach((iso) => {
          if (!codes.includes(dayCodeOf(iso))) return;
          out.push({
            id: `class:${course.id}:${mt.id || idx}:${iso}`,
            source: CALENDAR_SOURCES.FLIGHTPLAN,
            eventType: EVENT_TYPES.CLASS,
            title: course.code,
            subtitle: course.name,
            courseId: course.id,
            date: iso,
            start: mt.start,
            end: minutesOf(mt.end) !== null ? mt.end : null,
            allDay: false,
            location: mt.location || course.room || null,
            color: colorForCourse(course.id),
          });
        });
      });
    });
  return out;
}

/** Countdowns are FlightPlan's only dated academic deadlines. */
function countdownEvents(data, from, to) {
  return (data.countdowns || [])
    .filter((c) => c && typeof c.date === "string" && inRange(c.date, from, to))
    .map((c) => ({
      id: `countdown:${c.id}`,
      source: CALENDAR_SOURCES.FLIGHTPLAN,
      eventType: /exam|final/i.test(c.title || "")
        ? EVENT_TYPES.EXAM
        : /quiz/i.test(c.title || "")
        ? EVENT_TYPES.QUIZ
        : EVENT_TYPES.EVENT,
      title: c.title || "Countdown",
      date: c.date,
      start: null,
      end: null,
      allDay: true,
      color: "#C4705A",
    }));
}

function taskEvents(data, from, to) {
  return (data.dailyTasks || [])
    .filter((t) => t && typeof t.date === "string" && inRange(t.date, from, to))
    .map((t) => ({
      id: `task:${t.id}`,
      source: CALENDAR_SOURCES.FLIGHTPLAN,
      eventType: EVENT_TYPES.OTHER,
      title: t.title || "Objective",
      date: t.date,
      start: null,
      end: null,
      allDay: true,
      done: Boolean(t.done),
      color: "#8FA396",
    }));
}

function sessionEvents(data, from, to) {
  const codeOf = (id) => (data.courses || []).find((c) => c.id === id)?.code || null;
  return (data.sessions || [])
    .filter((s) => s && typeof s.date === "string" && inRange(s.date, from, to))
    .map((s) => ({
      id: `session:${s.id}`,
      source: CALENDAR_SOURCES.FLIGHTPLAN,
      eventType: EVENT_TYPES.STUDY,
      title: `Studied ${codeOf(s.courseId) || ""}`.trim(),
      subtitle: s.what || null,
      courseId: s.courseId || null,
      date: s.date,
      start: null,
      end: null,
      allDay: true,
      minutes: Number(s.minutes) || 0,
      color: colorForCourse(s.courseId),
    }));
}

function flightEvents(data, from, to) {
  return (data.flights || [])
    .filter((f) => f && typeof f.date === "string" && inRange(f.date, from, to))
    .map((f) => ({
      id: `flight:${f.id}`,
      source: CALENDAR_SOURCES.FLIGHTPLAN,
      eventType: EVENT_TYPES.FLIGHT,
      title: `Flight ${f.aircraft || ""}`.trim(),
      subtitle: f.route || null,
      date: f.date,
      start: null,
      end: null,
      allDay: true,
      hours: Number(f.total) || 0,
      color: "#7FB2D4",
    }));
}

/** User-created one-off calendar events (additive: data.calendarEvents). */
function manualEvents(data, from, to) {
  return (data.calendarEvents || [])
    .filter((e) => e && typeof e.date === "string" && inRange(e.date, from, to))
    .map((e) => ({
      id: `manual:${e.id}`,
      source: CALENDAR_SOURCES.MANUAL,
      eventType: e.eventType || EVENT_TYPES.EVENT,
      title: e.title || "Event",
      date: e.date,
      start: minutesOf(e.start) !== null ? e.start : null,
      end: minutesOf(e.end) !== null ? e.end : null,
      allDay: minutesOf(e.start) === null,
      location: e.location || null,
      description: e.description || null,
      color: "#B08BC4",
    }));
}

/**
 * Build the normalized event list for a date range.
 *
 * `externalEvents` accepts already-normalized events from Brightspace or
 * Google once those are wired; they are filtered by range and merged
 * with FlightPlan-derived events. Read-only: nothing here mutates data.
 */
export function buildCalendarEvents(data, { from, to, externalEvents = [] } = {}) {
  if (!data) return [];
  const days = [];
  if (from && to) {
    for (let iso = from; iso <= to; iso = addDaysISO(iso, 1)) days.push(iso);
  }

  const external = (externalEvents || []).filter(
    (e) => e && typeof e.date === "string" && inRange(e.date, from, to)
  );

  return [
    ...classEvents(data, days),
    ...countdownEvents(data, from, to),
    ...taskEvents(data, from, to),
    ...sessionEvents(data, from, to),
    ...flightEvents(data, from, to),
    ...manualEvents(data, from, to),
    ...external,
  ];
}

/* ---------- per-day access ---------- */
export function eventsForDay(events, iso) {
  const mine = events.filter((e) => e.date === iso);
  const timed = mine
    .filter((e) => !e.allDay && minutesOf(e.start) !== null)
    .sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
  const allDay = mine.filter((e) => e.allDay || minutesOf(e.start) === null);
  return { timed, allDay, all: mine };
}

/**
 * Column layout for overlapping timed events. Every event stays
 * visible — overlaps split the width rather than hiding anything.
 */
export function layoutDay(timed, defaultDurationMin = 50) {
  const withSpan = timed.map((e) => {
    const s = minutesOf(e.start);
    const eMin = minutesOf(e.end);
    return { event: e, start: s, end: eMin !== null && eMin > s ? eMin : s + defaultDurationMin };
  });

  const laid = [];
  let cluster = [];
  let clusterEnd = -1;

  const flush = () => {
    if (!cluster.length) return;
    const columns = [];
    cluster.forEach((item) => {
      let col = columns.findIndex((c) => c <= item.start);
      if (col === -1) {
        columns.push(item.end);
        col = columns.length - 1;
      } else {
        columns[col] = item.end;
      }
      item.column = col;
    });
    cluster.forEach((item) => laid.push({ ...item, columns: columns.length }));
    cluster = [];
    clusterEnd = -1;
  };

  withSpan.forEach((item) => {
    if (cluster.length && item.start >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  });
  flush();

  return laid;
}

/** Visible time bounds for a set of days — widened to include outliers. */
export function timeBounds(events, fallback = { from: 7 * 60, to: 22 * 60 }) {
  const timed = events.filter((e) => !e.allDay && minutesOf(e.start) !== null);
  if (!timed.length) return fallback;
  const starts = timed.map((e) => minutesOf(e.start));
  const ends = timed.map((e) => {
    const end = minutesOf(e.end);
    return end !== null ? end : minutesOf(e.start) + 50;
  });
  return {
    from: Math.min(fallback.from, Math.floor(Math.min(...starts) / 60) * 60),
    to: Math.max(fallback.to, Math.ceil(Math.max(...ends) / 60) * 60),
  };
}

/** Gaps between timed commitments on one day. */
export function freeWindows(events, iso, { from = 8 * 60, to = 21 * 60, minMinutes = 30 } = {}) {
  const { timed } = eventsForDay(events, iso);
  const busy = layoutDay(timed)
    .map(({ start, end }) => ({ start, end }))
    .sort((a, b) => a.start - b.start);

  const gaps = [];
  let cursor = from;
  busy.forEach((b) => {
    if (b.start - cursor >= minMinutes) gaps.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  });
  if (to - cursor >= minMinutes) gaps.push({ start: cursor, end: to });

  const fmt = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  return gaps.map((g) => ({
    start: fmt(g.start),
    end: fmt(g.end),
    minutes: g.end - g.start,
  }));
}

/** Next upcoming event from now, across the supplied set. */
export function nextEvent(events, nowISO = todayISO(), nowMinutes = null) {
  const mins = nowMinutes ?? new Date().getHours() * 60 + new Date().getMinutes();
  const future = events
    .filter((e) => e.date > nowISO || (e.date === nowISO && (minutesOf(e.start) ?? 0) >= mins))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (minutesOf(a.start) ?? -1) - (minutesOf(b.start) ?? -1);
    });
  return future[0] || null;
}

/** Deadlines worth surfacing — countdowns, exams, quizzes, assignments. */
export function upcomingDeadlines(events, fromISO = todayISO(), limit = 5) {
  const kinds = [EVENT_TYPES.EXAM, EVENT_TYPES.QUIZ, EVENT_TYPES.ASSIGNMENT, EVENT_TYPES.EVENT];
  return events
    .filter((e) => kinds.includes(e.eventType) && e.date >= fromISO)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(0, limit);
}
