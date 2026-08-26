import {
  buildCalendarEvents,
  eventsForDay,
  freeWindows,
  nextEvent as calNextEvent,
  upcomingDeadlines,
  weekDays,
  todayISO as calToday,
} from "./calendar.js";
import {
  totals as flightTotals,
  currency as currencyRows,
  readinessScores,
  parseMetar,
  flightCategory,
  weekPosition,
  todaysShare,
  STATION,
} from "./aviation.jsx";

/* ============================================================
   CIRRUS — FLIGHTPLAN CONTEXT ENGINE (Stage 4)

   STRICTLY READ-ONLY. Every function here derives a compact summary
   from state it is handed. Nothing in this file writes, normalizes,
   migrates, seeds, repairs, or persists anything — there is no
   setData, no update(), no supabase call, no localStorage access, and
   no return value is ever written back. Context is a temporary
   snapshot for one request, never an authoritative source for a
   later write.

   Authoritative numbers (GPA, flight hours, due-card counts,
   readiness, goal progress) are computed HERE, by the same helpers
   the UI uses, so the model interprets values rather than recomputing
   totals from raw records.

   Helpers are injected rather than imported from App.jsx. That is the
   pattern this codebase already uses (MissionPanel and ReadinessView
   both take a `helpers` object), and it avoids an import cycle:
   App.jsx -> cirrus.jsx -> cirrusContext.js -> App.jsx.

   ------------------------------------------------------------
   CONTEXT SOURCE MAP — verified by inspection, not assumed
   ------------------------------------------------------------
   Nearly everything persists inside ONE JSON blob: the `data` object,
   stored as a single row in Supabase `flightplan_data` (user_id, data,
   updated_at). Weather is the exception: it is never persisted.

   academics.courses      -> data.courses[]
   academics.grades       -> data.courses[].categories[].items[]
                             via injected courseGrade()
   academics.GPA          -> derived: courseGrade + letterFor + GPA_PTS
   academics.assignments  -> grade items are {id,label,earned,possible}
                             with NO due date -> dueDates: notImplemented
   academics.deadlines    -> data.countdowns[] {id,title,date}
                             (the only dated academic objects)
   academics.studyHistory -> data.sessions[]
   cards                  -> data.cards[]
   reviewHistory          -> NOT a separate log. Review outcomes are
                             folded into each card: box, ivl, due,
                             lastReviewed, seen, missed -> aggregates
                             only, no per-review timeline
   goals                  -> data.goals[] via goalProgress/goalPace
   mission                -> data.dailyTasks[] (manual) + derived from
                             cards/sessions/personal
   aviation               -> data.flights[], data.pilot
                             via totals()/currency() from aviation.jsx
   readiness              -> derived from data.cards + data.courses via
                             readinessScores() from aviation.jsx
   mistakeJournal         -> DOES NOT EXIST -> notImplemented
   weather                -> LIVE FETCH from a Cloudflare Worker
                             (METAR_URL). Never persisted, so it must be
                             injected; minimums live in data.minimums
   fitness                -> data.personal.{workouts,gymTarget,milesTarget}
   ============================================================ */

/** Helper functions the caller must inject. All live in App.jsx. */
export const REQUIRED_HELPERS = [
  "live",
  "courseGrade",
  "letterFor",
  "GPA_PTS",
  "studyPriority",
  "goalProgress",
  "goalPace",
  "gymDays",
  "sumMiles",
  "weekStart",
  "todayISO",
  "daysBetween",
];

/* ---------- small local utilities (no mutation) ---------- */
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const round1 = (x) => Math.round(num(x) * 10) / 10;

/** Explicit absence. Never fabricate a value to fill a gap. */
export const UNAVAILABLE = (reason) => ({ state: "unavailable", reason });
export const NOT_IMPLEMENTED = (reason) => ({ state: "notImplemented", reason });
export const EMPTY = (reason) => ({ state: "empty", reason });

const isPresent = (d) => d && !d.state;

/* ============================================================
   ACADEMICS
   ============================================================ */
export function academicsContext(data, helpers) {
  const { live, courseGrade, letterFor, GPA_PTS, todayISO } = helpers;
  const courses = live(data || {});
  if (!courses.length) return EMPTY("no active courses");

  const today = todayISO();

  const rows = courses.map((c) => {
    const g = courseGrade(c);
    return {
      code: c.code,
      name: c.name,
      tier: c.tier === "core" ? "aviation" : "non-aviation",
      current: g.current === null ? null : round1(g.current),
      letter: g.current === null ? null : letterFor(g.current),
      target: num(c.target),
      gap: g.current === null ? null : round1(g.current - num(c.target)),
      gradedWeight: g.weightDone,
      remainingWeight: g.remaining,
    };
  });

  const gpaOf = (list) => {
    const pts = list
      .map((r) => r.letter)
      .filter(Boolean)
      .map((l) => GPA_PTS[l]);
    return pts.length ? round1(pts.reduce((s, p) => s + p, 0) / pts.length * 100) / 100 : null;
  };

  const aviation = rows.filter((r) => r.tier === "aviation");
  const nonAviation = rows.filter((r) => r.tier === "non-aviation");

  // Study history: summarized, not dumped. Raw sessions can run to
  // hundreds of rows and the model only needs the shape.
  const sessions = data.sessions || [];
  const ws = helpers.weekStart();
  const weekSessions = sessions.filter((s) => s.date >= ws);
  const minutes = (list) => list.reduce((s, x) => s + num(x.minutes), 0);

  return {
    courses: rows,
    gpa: {
      aviation: gpaOf(aviation),
      nonAviation: gpaOf(nonAviation),
      overall: gpaOf(rows),
      note: "computed by FlightPlan from graded weight only",
    },
    studyHistory: sessions.length
      ? {
          minutesThisWeek: minutes(weekSessions),
          weeklyTargetMinutes: courses.reduce((s, c) => s + num(c.weeklyMinutes), 0),
          sessionsLogged: sessions.length,
          lastSession: sessions.map((s) => s.date).sort().pop() || null,
        }
      : EMPTY("no study sessions logged"),
    deadlines: (data.countdowns || []).length
      ? (data.countdowns || [])
          .map((c) => ({ title: c.title, date: c.date, daysAway: helpers.daysBetween(today, c.date) }))
          .filter((c) => c.daysAway >= 0)
          .sort((a, b) => a.daysAway - b.daysAway)
          .slice(0, 8)
      : EMPTY("no countdowns set"),
    assignments: NOT_IMPLEMENTED(
      "grade items carry a label and score but no due date; FlightPlan has no assignment deadlines"
    ),
  };
}

/* ============================================================
   CARDS
   ============================================================ */
export function cardsContext(data, helpers) {
  const { todayISO } = helpers;
  const cards = data.cards || [];
  if (!cards.length) return EMPTY("no cards created");

  const today = todayISO();
  const courseCode = (id) => (data.courses || []).find((c) => c.id === id)?.code || "untagged";

  const due = cards.filter((c) => !c.due || c.due <= today);
  const fresh = cards.filter((c) => !num(c.seen));
  const seenTotal = cards.reduce((s, c) => s + num(c.seen), 0);
  const missedTotal = cards.reduce((s, c) => s + num(c.missed), 0);

  // Per-topic accuracy. Only topics with enough reps to mean anything.
  const byTopic = {};
  cards.forEach((c) => {
    if (!num(c.seen)) return;
    const key = `${courseCode(c.courseId)} · ${c.topic || "untagged"}`;
    byTopic[key] = byTopic[key] || { seen: 0, missed: 0, cards: 0 };
    byTopic[key].seen += num(c.seen);
    byTopic[key].missed += num(c.missed);
    byTopic[key].cards += 1;
  });

  const topics = Object.entries(byTopic).map(([topic, v]) => ({
    topic,
    cards: v.cards,
    accuracy: v.seen ? Math.round((1 - v.missed / v.seen) * 100) : null,
    reps: v.seen,
  }));

  const weakest = topics
    .filter((t) => t.reps >= 3 && t.accuracy !== null && t.accuracy < 100)
    .sort((a, b) => a.accuracy - b.accuracy)
    .slice(0, 5);

  // "Recent misses" is best-effort: cards store a lastReviewed date and
  // a cumulative miss count, not a per-review log, so this is cards
  // with misses ordered by when they were last seen.
  const recentMisses = cards
    .filter((c) => num(c.missed) > 0 && c.lastReviewed)
    .sort((a, b) => String(b.lastReviewed).localeCompare(String(a.lastReviewed)))
    .slice(0, 8)
    .map((c) => ({
      front: String(c.front || "").slice(0, 80),
      topic: c.topic || "untagged",
      course: courseCode(c.courseId),
      missed: num(c.missed),
      seen: num(c.seen),
      lastReviewed: c.lastReviewed,
    }));

  const avgBox = cards.reduce((s, c) => s + num(c.box), 0) / cards.length;

  return {
    total: cards.length,
    dueNow: due.length,
    newCards: fresh.length,
    accuracy: seenTotal ? Math.round((1 - missedTotal / seenTotal) * 100) : null,
    mastery: {
      averageBox: round1(avgBox),
      scale: "1-5, higher is better retained",
    },
    decks: (data.courses || [])
      .map((c) => ({
        course: c.code,
        cards: cards.filter((x) => x.courseId === c.id).length,
        due: due.filter((x) => x.courseId === c.id).length,
      }))
      .filter((d) => d.cards > 0),
    weakestTopics: weakest.length ? weakest : EMPTY("not enough reviews to rank topics"),
    recentMisses: recentMisses.length ? recentMisses : EMPTY("no missed cards recorded"),
    reviewHistoryNote:
      "FlightPlan stores review outcomes on each card (box, seen, missed, lastReviewed), not as a per-review log, so only aggregates are available",
  };
}

/* ============================================================
   GOALS
   ============================================================ */
export function goalsContext(data, helpers) {
  const { goalProgress, goalPace } = helpers;
  const all = data.goals || [];
  const open = all.filter((g) => !g.done);
  if (!open.length) {
    return all.length ? EMPTY("all goals complete") : EMPTY("no goals set");
  }

  return {
    active: open.map((g) => {
      const p = goalProgress(g, data);
      const pace = goalPace(g, p);
      return {
        title: g.title,
        domain: g.domain || "academic",
        current: round1(p.current),
        target: round1(p.target),
        unit: p.unit,
        percent: p.target ? Math.round((p.current / p.target) * 100) : null,
        deadline: g.deadline || null,
        pace: pace
          ? {
              onPace: pace.onPace,
              overdue: pace.overdue,
              daysLeft: pace.daysLeft,
              perWeekNeeded: round1(pace.perWeek),
            }
          : UNAVAILABLE("no deadline set, so pace cannot be computed"),
      };
    }),
    completed: all.length - open.length,
  };
}

/* ============================================================
   TODAY'S MISSION
   Derived from the same inputs MissionPanel uses. The panel builds
   clickable UI items; this builds the data-only equivalent.
   ============================================================ */
export function missionContext(data, helpers) {
  const { live, gymDays, sumMiles, weekStart, todayISO, studyPriority } = helpers;
  const today = todayISO();
  const ws = weekStart();
  const { daysLeft } = weekPosition();

  const items = [];

  const manual = (data.dailyTasks || []).filter((t) => t.date === today);
  manual.forEach((t) =>
    items.push({ task: t.title, done: Boolean(t.done), source: "your objective" })
  );

  const cards = data.cards || [];
  const cardsDue = cards.filter((c) => !c.due || c.due <= today).length;
  if (cardsDue > 0) {
    items.push({
      task: `Review ${cardsDue} card${cardsDue === 1 ? "" : "s"}`,
      done: false,
      source: "due today by the box schedule",
    });
  } else if (cards.length) {
    items.push({ task: "Review queue is clear", done: true, source: "nothing due" });
  }

  const weeklyMin = live(data).reduce((s, c) => s + num(c.weeklyMinutes), 0);
  const sessions = data.sessions || [];
  const doneMin = sessions.filter((s) => s.date >= ws).reduce((s, x) => s + num(x.minutes), 0);
  const todayMin = sessions.filter((s) => s.date === today).reduce((s, x) => s + num(x.minutes), 0);
  const study = todaysShare(weeklyMin, doneMin, { step: 5, min: 5 });

  if (study) {
    if (study.state === "complete" || study.state === "ahead") {
      items.push({
        task: study.state === "complete" ? "Weekly study target met" : "Ahead on study time",
        done: true,
        source: `${doneMin} of ${weeklyMin} min this week`,
      });
    } else {
      const remainingToday = Math.max(0, study.need - todayMin);
      const top = live(data)
        .map((c) => ({ course: c, ...studyPriority(c, data) }))
        .sort((x, y) => y.score - x.score)[0];
      items.push({
        task:
          remainingToday <= 0
            ? `Study done for today (${todayMin} min)`
            : `Study ${Math.round(remainingToday)} minutes`,
        done: remainingToday <= 0,
        source: `${study.remaining} min left this week over ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
        suggestedCourse: top ? top.course.code : null,
      });
    }
  }

  const workouts = data.personal?.workouts || [];
  const week = workouts.filter((w) => w.date >= ws);
  const gymTarget = num(data.personal?.gymTarget);
  if (gymTarget > 0) {
    const gymDone = gymDays(week);
    const trainedToday = workouts.some((w) => w.date === today);
    const gymLeft = Math.max(0, gymTarget - gymDone);
    items.push({
      task: gymLeft === 0 ? "Gym target met" : trainedToday ? "Trained today" : "Gym today",
      done: gymLeft === 0 || trainedToday,
      source: `${gymDone} of ${gymTarget} days this week`,
      urgent: gymLeft > 0 && !trainedToday && gymLeft >= daysLeft,
    });
  }

  const milesTarget = num(data.personal?.milesTarget);
  const run = todaysShare(milesTarget, sumMiles(week), { step: 0.5, min: 0.5 });
  if (run) {
    const milesToday = sumMiles(workouts.filter((w) => w.date === today));
    const leftToday = Math.max(0, run.need - milesToday);
    const met = run.state === "complete" || run.state === "ahead" || leftToday <= 0;
    items.push({
      task: met ? "Mileage on track" : `Run ${round1(leftToday)} mi`,
      done: met,
      source: `${round1(sumMiles(week))} of ${round1(milesTarget)} mi this week`,
    });
  }

  if (!items.length) return EMPTY("no targets configured");

  return {
    date: today,
    items,
    completed: items.filter((i) => i.done).length,
    total: items.length,
  };
}

/* ============================================================
   AVIATION / LOGBOOK
   ============================================================ */
export function aviationContext(data, helpers) {
  const { todayISO } = helpers;
  const flights = data.flights || [];
  const pilot = data.pilot || {};

  if (!flights.length) {
    return {
      pilot: { goal: pilot.goal || null, medicalClass: pilot.medicalClass || null },
      logbook: EMPTY("no flights logged"),
      recentFlights: EMPTY("no flights logged"),
      aircraft: EMPTY("no flights logged"),
      currency: EMPTY("currency needs logged flights"),
    };
  }

  const t = flightTotals(flights);
  const byIdent = {};
  flights.forEach((f) => {
    const k = (f.aircraft || f.ident || "").trim();
    if (!k) return;
    byIdent[k] = byIdent[k] || { hours: 0, flights: 0 };
    byIdent[k].hours += num(f.total);
    byIdent[k].flights += 1;
  });

  return {
    pilot: {
      goal: pilot.goal || null,
      medicalClass: pilot.medicalClass || null,
      flightReview: pilot.flightReview || null,
      medical: pilot.medical || null,
      homeRunways: pilot.runways || null,
    },
    logbook: {
      totalHours: round1(t.total),
      dual: round1(t.dual),
      pic: round1(t.pic),
      solo: round1(t.solo),
      crossCountry: round1(t.xc),
      night: round1(t.night),
      instrumentTraining: round1(t.instrTrain),
      simulator: round1(t.sim),
      dayLandings: t.dayLdg,
      nightLandings: t.nightLdg,
      approaches: t.approaches,
      flightCount: flights.length,
      note: "totals computed by FlightPlan from the logbook",
    },
    recentFlights: flights
      .slice()
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 5)
      .map((f) => ({
        date: f.date,
        aircraft: f.aircraft || null,
        route: f.route || null,
        hours: round1(f.total),
        landings: num(f.dayLdg) + num(f.nightLdg),
      })),
    aircraft: Object.entries(byIdent).map(([name, v]) => ({
      aircraft: name,
      hours: round1(v.hours),
      flights: v.flights,
    })),
    currency: currencyRows(flights, pilot).map((r) => ({
      item: r.label,
      requirement: r.detail,
      have: r.have,
      need: r.need,
      met: typeof r.have === "number" && typeof r.need === "number" ? r.have >= r.need : null,
    })),
    hoursForecast: NOT_IMPLEMENTED("FlightPlan does not project future hours"),
  };
}

/* ============================================================
   READINESS
   ============================================================ */
export function readinessContext(data, helpers) {
  const { live } = helpers;
  const cards = data.cards || [];
  if (!cards.length) return EMPTY("readiness needs cards");

  const { courses, weak } = readinessScores(data, { live });
  const scored = courses.filter((c) => c.cards.length);
  if (!scored.length) return EMPTY("no course has cards yet");

  const ranked = scored.slice().sort((a, b) => b.score - a.score);

  return {
    academic: ranked.map((c) => ({
      course: c.course.code,
      score: c.score,
      label: c.label,
      accuracy: c.seen ? Math.round(c.accuracy * 100) : null,
      dueNow: c.dueNow,
      cards: c.cards.length,
    })),
    strongest: ranked.slice(0, 2).map((c) => c.course.code),
    weakest: ranked.slice(-2).reverse().map((c) => c.course.code),
    weakestTopics: weak.length
      ? weak.slice(0, 5).map((w) => ({
          course: w.code,
          topic: w.topic,
          missRate: Math.round(w.rate * 100),
          reps: w.seen,
        }))
      : EMPTY("not enough reviews to rank topics"),
    // Trends need a historical series. Card records keep only cumulative
    // counters and a single lastReviewed date, so there is nothing to
    // trend against without inventing one.
    trends: NOT_IMPLEMENTED(
      "no historical readiness series is stored; cards keep cumulative counters only"
    ),
    aviationReadiness: NOT_IMPLEMENTED(
      "readiness scoring covers coursework only; aviation currency is reported under aviation.currency"
    ),
  };
}

/* ============================================================
   MISTAKE JOURNAL — does not exist in FlightPlan
   ============================================================ */
export function mistakeJournalContext() {
  return NOT_IMPLEMENTED("FlightPlan has no mistake journal feature");
}

/* ============================================================
   WEATHER
   Never persisted — fetched live from a Cloudflare Worker by
   useWeather() in aviation.jsx. The caller must inject the current
   observation; without one this reports unavailable rather than
   guessing.
   ============================================================ */
export function weatherContext(data, weather) {
  if (!weather || (!weather.metar && !weather.taf)) {
    return UNAVAILABLE("no current observation supplied to the context builder");
  }

  const parsed = weather.metar ? parseMetar(weather.metar) : null;
  const cat = parsed ? flightCategory(parsed) : null;
  const mins = data.minimums || {};

  // Personal-minimums check, computed here rather than by the model.
  let personalMinimums = UNAVAILABLE("no personal minimums configured");
  if (parsed && Object.keys(mins).length) {
    const checks = [];
    if (mins.vis != null && parsed.visSM != null) {
      checks.push({ item: "visibility", value: parsed.visSM, minimum: num(mins.vis), ok: parsed.visSM >= num(mins.vis) });
    }
    if (mins.ceiling != null && parsed.ceiling != null) {
      checks.push({ item: "ceiling", value: parsed.ceiling, minimum: num(mins.ceiling), ok: parsed.ceiling >= num(mins.ceiling) });
    }
    if (mins.wind != null && parsed.wind?.speed != null) {
      checks.push({ item: "wind", value: parsed.wind.speed, minimum: num(mins.wind), ok: parsed.wind.speed <= num(mins.wind) });
    }
    personalMinimums = checks.length
      ? { checks, allMet: checks.every((c) => c.ok) }
      : UNAVAILABLE("configured minimums do not match the reported fields");
  }

  return {
    station: STATION,
    observedAt: weather.at || null,
    metar: weather.metar || null,
    taf: weather.taf || UNAVAILABLE("no TAF returned"),
    parsed: parsed
      ? {
          windDir: parsed.wind?.dir ?? null,
          windSpeed: parsed.wind?.speed ?? null,
          gust: parsed.wind?.gust ?? null,
          visibilitySM: parsed.visSM,
          ceilingFt: parsed.ceiling,
          tempC: parsed.temp,
          dewpointC: parsed.dew,
          altimeter: parsed.altim,
        }
      : UNAVAILABLE("observation could not be parsed"),
    flightCategory: cat || UNAVAILABLE("category needs ceiling and visibility"),
    personalMinimums,
    trend: NOT_IMPLEMENTED("only the current observation is fetched; no history is stored"),
  };
}

/* ============================================================
   FITNESS
   ============================================================ */
export function fitnessContext(data, helpers) {
  const { gymDays, sumMiles, weekStart } = helpers;
  const p = data.personal || {};
  const workouts = p.workouts || [];
  if (!workouts.length && !num(p.gymTarget) && !num(p.milesTarget)) {
    return EMPTY("no fitness data or targets");
  }

  const ws = weekStart();
  const week = workouts.filter((w) => w.date >= ws);

  return {
    thisWeek: {
      gymDays: gymDays(week),
      gymTarget: num(p.gymTarget),
      miles: round1(sumMiles(week)),
      milesTarget: round1(num(p.milesTarget)),
    },
    totalWorkoutsLogged: workouts.length,
    lastWorkout: workouts.map((w) => w.date).sort().pop() || null,
    lifts: (p.lifts || []).length
      ? { tracked: (p.lifts || []).length }
      : EMPTY("no lifts tracked"),
  };
}

/* ============================================================
   CALENDAR (read-only)
   Compact by design: counts, titles and times — never a dump of every
   event description. Detailed descriptions are omitted entirely at this
   stage, so nothing sensitive from an external calendar can leak into a
   prompt by default.
   ============================================================ */
export function calendarContext(data, externalEvents = []) {
  const today = calToday();
  const days = weekDays(today);
  const events = buildCalendarEvents(data, { from: days[0], to: days[6], externalEvents });

  if (!events.length) {
    return {
      state: "empty",
      reason: "nothing scheduled this week",
      freshness: { flightplan: "live", brightspace: "not_configured", google: "not_configured" },
    };
  }

  const compact = (e) => ({
    title: e.title,
    type: e.eventType,
    date: e.date,
    ...(e.allDay ? { allDay: true } : { start: e.start, end: e.end || null }),
    ...(e.location ? { location: e.location } : {}),
    source: e.source,
  });

  const todays = eventsForDay(events, today);
  const next = calNextEvent(events, today);

  return {
    today: {
      date: today,
      timed: todays.timed.map(compact),
      allDay: todays.allDay.map(compact),
    },
    week: days.map((iso) => {
      const d = eventsForDay(events, iso);
      return { date: iso, timed: d.timed.length, allDay: d.allDay.length };
    }),
    nextEvent: next ? compact(next) : null,
    upcomingDeadlines: upcomingDeadlines(events, today, 5).map(compact),
    freeWindowsToday: freeWindows(events, today),
    freshness: {
      flightplan: "live",
      brightspace: "not_configured",
      google: "not_configured",
    },
  };
}

/* ============================================================
   RELEVANCE
   Which domains a request actually needs. Sending everything wastes
   tokens and buries the useful part.
   ============================================================ */
const DOMAIN_KEYWORDS = {
  academics: ["grade", "gpa", "class", "course", "exam", "test", "semester", "assignment", "due", "deadline"],
  cards: ["card", "flashcard", "deck", "review", "study", "memoriz", "quiz", "topic"],
  goals: ["goal", "target", "progress", "pace", "streak"],
  mission: ["today", "tonight", "mission", "plan", "do now", "priorit", "schedule"],
  aviation: ["flight", "fly", "flying", "logbook", "hours", "aircraft", "pilot", "currency", "checkride", "solo", "landing"],
  readiness: ["ready", "readiness", "prepared", "weak", "strong", "struggl"],
  weather: ["weather", "metar", "taf", "wind", "ceiling", "visibility", "vfr", "ifr", "minimum"],
  calendar: ["calendar", "schedule", "class", "when", "today", "tomorrow", "week", "free", "busy", "due", "deadline", "meeting"],
  fitness: ["gym", "run", "running", "lift", "workout", "mile", "fitness", "train"],
};

/** Which domains the current page implies, for "explain this" style asks. */
const PAGE_DOMAINS = {
  home: ["mission", "academics", "goals", "calendar"],
  cards: ["cards", "readiness"],
  study: ["cards", "academics"],
  grades: ["academics"],
  goals: ["goals"],
  personal: ["fitness", "goals"],
  flying: ["aviation", "weather"],
  calendar: ["calendar"],
  courses: ["academics"],
};

export function selectDomains({ request = "", page = "", selectedObject = null } = {}) {
  const q = String(request).toLowerCase();
  const hits = new Set();

  for (const [domain, words] of Object.entries(DOMAIN_KEYWORDS)) {
    if (words.some((w) => q.includes(w))) hits.add(domain);
  }

  // A deictic request ("explain this", "quiz me on these") carries no
  // keywords, so lean on where the user actually is.
  const deictic = /\b(this|these|that|those|it|here)\b/.test(q);
  if (!hits.size || deictic || selectedObject) {
    (PAGE_DOMAINS[page] || []).forEach((d) => hits.add(d));
  }

  // Studying is the common ask, and it genuinely spans several domains.
  if (/\b(study|studying|tonight|revise)\b/.test(q)) {
    ["cards", "readiness", "academics", "goals", "mission"].forEach((d) => hits.add(d));
  }

  if (!hits.size) ["mission", "academics", "cards"].forEach((d) => hits.add(d));
  return [...hits];
}

/* ============================================================
   BUILD
   ============================================================ */
const BUILDERS = {
  academics: (data, h) => academicsContext(data, h),
  cards: (data, h) => cardsContext(data, h),
  goals: (data, h) => goalsContext(data, h),
  mission: (data, h) => missionContext(data, h),
  aviation: (data, h) => aviationContext(data, h),
  readiness: (data, h) => readinessContext(data, h),
  fitness: (data, h) => fitnessContext(data, h),
  mistakeJournal: () => mistakeJournalContext(),
};

/**
 * Build a compact, read-only context snapshot for one request.
 *
 * Never mutates `data`, never persists, never returns anything meant to
 * be written back. Callers must treat the result as disposable: by the
 * time a reply arrives, production data may already have moved on.
 */
export function buildCirrusContext({
  data,
  helpers,
  request = "",
  page = "",
  selectedObject = null,
  activeTopic = null,
  weather = null,
  externalEvents = [],
  domains = null,
} = {}) {
  if (!data) return { error: "no data", domains: [], context: {} };

  const chosen = domains || selectDomains({ request, page, selectedObject });
  const context = {};

  for (const domain of chosen) {
    const build = BUILDERS[domain];
    if (!build) continue;
    try {
      context[domain] = build(data, helpers);
    } catch (err) {
      // A malformed legacy record must never take down the assistant.
      // Degrade that one domain and keep the rest.
      context[domain] = UNAVAILABLE(`could not be summarized: ${err?.message || "error"}`);
    }
  }

  if (chosen.includes("calendar")) {
    try {
      context.calendar = calendarContext(data, externalEvents);
    } catch (err) {
      context.calendar = UNAVAILABLE(`could not be summarized: ${err?.message || "error"}`);
    }
  }

  if (chosen.includes("weather")) {
    try {
      context.weather = weatherContext(data, weather);
    } catch (err) {
      context.weather = UNAVAILABLE(`could not be summarized: ${err?.message || "error"}`);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    page: page || null,
    selectedObject: selectedObject || null,
    activeTopic: activeTopic || null,
    domains: chosen,
    context,
  };
}
