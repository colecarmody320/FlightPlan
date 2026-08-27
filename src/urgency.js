/* ============================================================
   FLIGHTPLAN — URGENCY

   One place decides how close something is, so every page says the
   same thing about the same deadline. A component asks for a state; it
   never picks a colour.

   THE POINT OF THIS IS RESTRAINT. Most things, most of the time, are
   NORMAL — and normal is grey. A dashboard where nothing is due should
   be almost monochrome, because that is what makes one amber row
   impossible to miss. Every colour spent on something ordinary makes
   every real warning quieter, so the thresholds below are deliberately
   late rather than eager.

   THRESHOLDS DIFFER BY TYPE, on purpose. An assignment due in two days
   is not yet interesting; a flight leaving in two hours very much is.
   A single global threshold would be wrong for nearly everything, so
   each kind of item gets its own scale.

   All dates are local ISO (YYYY-MM-DD) — the same representation the
   rest of the app uses. Nothing here parses a UTC instant, so nothing
   here can shift a day.
   ============================================================ */

export const URGENCY = {
  DONE: "done",             // finished; recedes
  NORMAL: "normal",         // plenty of time — grey
  UPCOMING: "upcoming",     // on the horizon — informational
  SOON: "soon",             // approaching — caution
  URGENT: "urgent",         // very close — stronger caution
  OVERDUE: "overdue",       // past due — critical
  ACTIVE: "active",         // happening right now
};

/** Rank, for "what is the worst thing on this page?" */
const RANK = {
  [URGENCY.DONE]: 0,
  [URGENCY.NORMAL]: 1,
  [URGENCY.UPCOMING]: 2,
  [URGENCY.ACTIVE]: 3,
  [URGENCY.SOON]: 4,
  [URGENCY.URGENT]: 5,
  [URGENCY.OVERDUE]: 6,
};

/** The CSS custom property each state paints with. */
export const URGENCY_COLOR = {
  [URGENCY.DONE]: "var(--inactive)",
  [URGENCY.NORMAL]: "var(--text-primary)",
  [URGENCY.UPCOMING]: "var(--informational)",
  [URGENCY.ACTIVE]: "var(--informational)",
  [URGENCY.SOON]: "var(--caution)",
  [URGENCY.URGENT]: "var(--caution-high)",
  [URGENCY.OVERDUE]: "var(--critical)",
};

/** Class hook, for anything styled in a stylesheet rather than inline. */
export const urgencyClass = (u) => `u-${u || URGENCY.NORMAL}`;
export const urgencyColor = (u) => URGENCY_COLOR[u] || URGENCY_COLOR[URGENCY.NORMAL];

/** Short label for a status chip. Null when there is nothing to say —
    "normal" deserves no badge at all. */
export function urgencyLabel(u) {
  switch (u) {
    case URGENCY.OVERDUE: return "OVERDUE";
    case URGENCY.URGENT: return "DUE NOW";
    case URGENCY.SOON: return "DUE SOON";
    case URGENCY.ACTIVE: return "NOW";
    case URGENCY.DONE: return "DONE";
    default: return null;   // normal and upcoming stay quiet
  }
}

/** Whole days from `fromISO` to `toISO`; negative means already past. */
export function daysUntil(toISO, fromISO) {
  if (!toISO || !fromISO) return null;
  const [ay, am, ad] = String(fromISO).split("-").map(Number);
  const [by, bm, bd] = String(toISO).split("-").map(Number);
  if (!ay || !by) return null;
  // Local midnights, so the answer is a count of calendar days and
  // never drifts with the clock or the timezone.
  const a = new Date(ay, am - 1, ad);
  const b = new Date(by, bm - 1, bd);
  return Math.round((b - a) / 86400000);
}

/**
 * How urgent a dated piece of work is.
 *
 * `scale` picks the threshold set. Academic work gets a slow ramp —
 * an assignment due in three days is not an emergency — while
 * something explicitly short-fuse can use "tight".
 */
export function itemUrgency({ dueISO, done = false, todayISO, scale = "coursework" } = {}) {
  if (done) return URGENCY.DONE;
  if (!dueISO || !todayISO) return URGENCY.NORMAL;

  const d = daysUntil(dueISO, todayISO);
  if (d === null) return URGENCY.NORMAL;
  if (d < 0) return URGENCY.OVERDUE;

  const T = {
    // Assignments, readings, problem sets.
    coursework: { urgent: 0, soon: 2, upcoming: 5 },
    // Goals and habits move slowly; they earn attention later.
    goal: { urgent: 1, soon: 4, upcoming: 10 },
    // Checkrides, medicals, currency: months of lead time matter.
    currency: { urgent: 7, soon: 21, upcoming: 45 },
  }[scale] || { urgent: 0, soon: 2, upcoming: 5 };

  if (d <= T.urgent) return URGENCY.URGENT;
  if (d <= T.soon) return URGENCY.SOON;
  if (d <= T.upcoming) return URGENCY.UPCOMING;
  return URGENCY.NORMAL;
}

/**
 * How urgent a calendar event is.
 *
 * Events are judged in minutes once they are today's problem, because
 * "in six hours" and "in ten minutes" are not the same thing at all.
 * `startMin`/`endMin` are minutes past local midnight; an all-day
 * event passes neither and is treated as a whole-day item.
 */
export function eventUrgency({ dateISO, startMin = null, endMin = null, todayISO, nowMin = null } = {}) {
  if (!dateISO || !todayISO) return URGENCY.NORMAL;

  const d = daysUntil(dateISO, todayISO);
  if (d === null) return URGENCY.NORMAL;
  if (d < 0) return URGENCY.NORMAL;      // the past is not urgent, it is gone
  if (d > 2) return URGENCY.NORMAL;
  if (d > 0) return d === 1 ? URGENCY.UPCOMING : URGENCY.NORMAL;

  /* Today. */
  if (startMin === null || nowMin === null) return URGENCY.UPCOMING;

  const finish = endMin === null ? startMin + 60 : endMin;
  if (nowMin >= startMin && nowMin < finish) return URGENCY.ACTIVE;
  if (nowMin >= finish) return URGENCY.NORMAL;    // done for the day

  const away = startMin - nowMin;
  if (away <= 15) return URGENCY.URGENT;
  if (away <= 60) return URGENCY.SOON;
  return URGENCY.UPCOMING;
}

/**
 * The worst state in a set — what a summary tile should report.
 *
 * "Worst" deliberately ignores DONE and NORMAL: a list of finished
 * work is not a state worth colouring.
 */
export function worstUrgency(list = []) {
  let worst = URGENCY.NORMAL;
  for (const u of list) {
    if (!u) continue;
    if ((RANK[u] ?? 0) > (RANK[worst] ?? 0)) worst = u;
  }
  return worst;
}

/** True when a state is worth drawing the eye to at all. */
export const needsAttention = (u) =>
  u === URGENCY.SOON || u === URGENCY.URGENT || u === URGENCY.OVERDUE;

export default itemUrgency;
