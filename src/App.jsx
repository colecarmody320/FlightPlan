import React, { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "./supabase.js";
const ALLOWED_EMAIL = "nicholasmcarmody@gmail.com";

/* ============================================================
   FLIGHTPLAN v1.0
   Study tool + grade tracker + goals + personal accountability.
   Aviation-weighted. No design pass.

   Storage key "hub:v1" — earlier versions migrate forward.
   {
     courses:  [...], notes: [...], cards: [...], sessions: [...],
     goals:    [{ id, title, domain:"academic"|"personal", courseId,
                  type:"count"|"checklist"|"hours"|"miles"|"gymdays",
                  target, unit, deadline, start, steps:[...], log:[...], done }],
     personal: {
       gymTarget: 4,     // gym days per week
       milesTarget: 10,  // miles per week
       workouts: [{ id, date, type, minutes, miles, notes }],
       lifts:    [{ id, name, entries:[{id,date,weight,reps}] }]
     }
   }
   ============================================================ */

const KEY = "hub:v1";
const uid = () => Math.random().toString(36).slice(2, 10);

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
};

const addDays = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
    dt.getDate()
  ).padStart(2, "0")}`;
};

const daysBetween = (a, b) => {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000);
};

const weekStart = () => {
  const d = new Date();
  return addDays(todayISO(), -((d.getDay() + 6) % 7));
};

/* ---------- tiers ---------- */
const TIER_WEIGHT = { core: 1.7, support: 1 };
const TIER_LABEL = { core: "Aviation", support: "Non-aviation" };

const looksAviation = (c) =>
  /avia|aero|flight|powerplant|pilot|aircraft|avs|met/i.test(`${c.code} ${c.name}`);

/* ---------- seed + migration ---------- */
function newCourse(code, name, tier = "support", term = "") {
  return {
    id: uid(),
    code,
    name,
    tier,
    term,
    archived: false,
    instructor: "",
    email: "",
    office: "",
    hours: "",
    room: "",
    textbook: "",
    syllabusUrl: "",
    target: 90,
    weeklyMinutes: 120,
    categories: [],
  };
}

const seedCourses = () => [
  newCourse("AVS", "Intro to Aviation Sciences", "core"),
  newCourse("PWR", "Aircraft Powerplants", "core"),
  newCourse("AERO", "Aerodynamics and Performance", "core"),
  newCourse("COMM", "Interpersonal Communication", "support"),
  newCourse("CRE", "Nature of Creativity", "support"),
];

const blankPersonal = () => ({ gymTarget: 4, milesTarget: 10, workouts: [], lifts: [] });
const blankSettings = () => ({ cardsPerDay: 20 });

const blank = () => ({
  courses: seedCourses(),
  notes: [],
  cards: [],
  sessions: [],
  goals: [],
  personal: blankPersonal(),
  settings: blankSettings(),
  reviewLog: {},
});

function migrate(d) {
  if (!d) return blank();
  return {
    courses: (d.courses || []).map((c) => ({
      target: 90,
      weeklyMinutes: 180,
      categories: [],
      term: "",
      archived: false,
      ...c,
      tier: c.tier || (looksAviation(c) ? "core" : "support"),
    })),
    notes: d.notes || [],
    cards: (d.cards || []).map((c) => ({
      topic: "",
      lastReviewed: null,
      seen: 0,
      missed: 0,
      frontImg: "",
      backImg: "",
      ...c,
    })),
    sessions: d.sessions || [],
    goals: (d.goals || []).map((g) => ({
      type: "count",
      deadline: "",
      start: todayISO(),
      steps: [],
      log: [],
      domain: "academic",
      ...g,
    })),
    settings: { ...blankSettings(), ...(d.settings || {}) },
    reviewLog: d.reviewLog || {},
    personal: {
      ...blankPersonal(),
      ...(d.personal || {}),
      workouts: (d.personal?.workouts || []).map((w) => ({ miles: 0, ...w })),
    },
    // tasks intentionally dropped — Work tab removed
  };
}

/* ---------- images on cards ---------- */
// Downscale before storing — full-size photos would blow past the storage cap fast.
function shrinkImage(file, maxDim = 900, quality = 0.65) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("Couldn't read that image"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Couldn't read that file"));
    reader.readAsDataURL(file);
  });
}

function ImageField({ label, value, onChange }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const handleFile = async (file) => {
    if (!file || !file.type.startsWith("image/")) {
      setErr("That wasn't an image.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      onChange(await shrinkImage(file));
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };

  const onPaste = (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    handleFile(item.getAsFile());
  };

  const onDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  };

  return (
    <div style={{ marginBottom: 8 }}>
      <label style={S.label}>{label}</label>
      {value ? (
        <div>
          <img src={value} alt="" style={S.thumb} />
          <br />
          <button style={S.btn} className="btn" onClick={() => onChange("")}>Remove image</button>
        </div>
      ) : (
        <div
          tabIndex={0}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          style={S.dropzone}
        >
          {busy ? "Processing…" : "Click here, then paste an image — or drop one in"}
        </div>
      )}
      <input
        type="file"
        accept="image/*"
        style={{ fontSize: 12, marginTop: 4 }}
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      {err && <p style={S.late}>{err}</p>}
    </div>
  );
}

/* ---------- current semester vs archive ---------- */
const live = (data) => data.courses.filter((c) => !c.archived);
const archived = (data) => data.courses.filter((c) => c.archived);

/* ---------- cloud storage ---------- */

async function loadCloudData(userId) {
  const { data, error } = await supabase
    .from("flightplan_data")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("cloud load failed", error);
    return null;
  }

  return data?.data || null;
}

async function saveCloudData(userId, flightData) {
  const { error } = await supabase
    .from("flightplan_data")
    .upsert(
      {
        user_id: userId,
        data: flightData,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "user_id",
      }
    );

  if (error) {
    console.error("cloud save failed", error);
  }
}

/* ---------- grade math ---------- */
function categoryPct(cat) {
  const scored = (cat.items || []).filter(
    (i) => i.earned !== "" && i.possible !== "" && Number(i.possible) > 0
  );
  if (!scored.length) return null;
  const e = scored.reduce((s, i) => s + Number(i.earned), 0);
  const p = scored.reduce((s, i) => s + Number(i.possible), 0);
  return (e / p) * 100;
}

function courseGrade(course) {
  const cats = course.categories || [];
  let weighted = 0;
  let weightDone = 0;
  cats.forEach((c) => {
    const pct = categoryPct(c);
    if (pct !== null) {
      weighted += (pct * Number(c.weight || 0)) / 100;
      weightDone += Number(c.weight || 0);
    }
  });
  const totalWeight = cats.reduce((s, c) => s + Number(c.weight || 0), 0);
  return {
    current: weightDone > 0 ? (weighted / weightDone) * 100 : null,
    weightDone,
    totalWeight,
    remaining: Math.max(0, totalWeight - weightDone),
    pointsEarned: weighted,
  };
}

const neededOnRemaining = (course, target) => {
  const g = courseGrade(course);
  if (g.remaining <= 0) return null;
  return ((target - g.pointsEarned) / g.remaining) * 100;
};

const LETTER = [
  [93, "A"], [90, "A-"], [87, "B+"], [83, "B"], [80, "B-"],
  [77, "C+"], [73, "C"], [70, "C-"], [67, "D+"], [63, "D"], [60, "D-"],
];
const letterFor = (p) => (p === null ? "—" : (LETTER.find(([n]) => p >= n) || [0, "F"])[1]);
const GPA_PTS = { A: 4, "A-": 3.7, "B+": 3.3, B: 3, "B-": 2.7, "C+": 2.3, C: 2, "C-": 1.7, "D+": 1.3, D: 1, "D-": 0.7, F: 0 };

/* ---------- study priority (tier-weighted) ---------- */
function studyPriority(course, data) {
  const g = courseGrade(course);
  const today = todayISO();
  const cardsDue = data.cards.filter(
    (c) => c.courseId === course.id && (!c.due || c.due <= today)
  ).length;
  const last = data.sessions
    .filter((s) => s.courseId === course.id)
    .map((s) => s.date)
    .sort()
    .pop();
  const cold = last ? Math.min(14, daysBetween(last, today)) : 14;
  const gap = g.current === null ? 5 : Math.max(0, Number(course.target) - g.current);

  const raw = gap * 3 + g.remaining * 0.25 + cardsDue * 1.5 + cold * 1.2;
  const score = raw * (TIER_WEIGHT[course.tier] || 1);

  const reasons = [];
  if (course.tier === "core") reasons.push("aviation");
  if (gap > 0.5) reasons.push(`${gap.toFixed(1)} pts under your ${course.target}% target`);
  if (cardsDue) reasons.push(`${cardsDue} cards ready`);
  if (cold >= 5) reasons.push(last ? `cold for ${cold} days` : "never studied here");
  if (g.remaining > 40) reasons.push(`${g.remaining}% of grade still open`);

  return { score, reasons, cardsDue, gap, g };
}

const BOX_GAP = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 };

/* ---------- goal math ---------- */
function goalProgress(goal, data) {
  if (goal.type === "checklist") {
    const done = (goal.steps || []).filter((s) => s.done).length;
    return { current: done, target: (goal.steps || []).length || 1, unit: "steps" };
  }
  if (goal.type === "miles") {
    const total = (data.personal?.workouts || [])
      .filter((w) => w.date >= goal.start)
      .reduce((s, w) => s + Number(w.miles || 0), 0);
    return { current: Math.round(total * 10) / 10, target: Number(goal.target), unit: "mi" };
  }
  if (goal.type === "gymdays") {
    const days = new Set(
      (data.personal?.workouts || []).filter((w) => w.date >= goal.start).map((w) => w.date)
    ).size;
    return { current: days, target: Number(goal.target), unit: "days" };
  }
  if (goal.type === "hours") {
    const mins =
      goal.domain === "personal"
        ? (data.personal?.workouts || [])
            .filter((w) => w.date >= goal.start)
            .reduce((sum, w) => sum + Number(w.minutes || 0), 0)
        : data.sessions
            .filter((s) => (!goal.courseId || s.courseId === goal.courseId) && s.date >= goal.start)
            .reduce((sum, s) => sum + Number(s.minutes), 0);
    return { current: Math.round((mins / 60) * 10) / 10, target: Number(goal.target), unit: "hrs" };
  }
  const sum = (goal.log || []).reduce((s, l) => s + Number(l.amount), 0);
  return { current: sum, target: Number(goal.target), unit: goal.unit || "" };
}

function goalPace(goal, prog) {
  if (!goal.deadline) return null;
  const daysLeft = daysBetween(todayISO(), goal.deadline);
  const remaining = Math.max(0, prog.target - prog.current);
  if (daysLeft < 0) return { overdue: true, daysLeft, remaining };
  const weeksLeft = Math.max(daysLeft / 7, 0.15);
  const elapsed = Math.max(1, daysBetween(goal.start, todayISO()));
  const total = Math.max(1, daysBetween(goal.start, goal.deadline));
  const expected = (elapsed / total) * prog.target;
  return {
    overdue: false,
    daysLeft,
    remaining,
    perWeek: remaining / weeksLeft,
    onPace: prog.current >= expected,
    expected,
  };
}

/* ---------- gym math ---------- */
const oneRepMax = (w, r) => Math.round(Number(w) * (1 + Number(r) / 30));
const sumMiles = (list) =>
  Math.round(list.reduce((s, w) => s + Number(w.miles || 0), 0) * 10) / 10;
const gymDays = (list) => new Set(list.map((w) => w.date)).size;

function weekBuckets(workouts, weeks = 8) {
  const start = weekStart();
  return Array.from({ length: weeks }, (_, idx) => {
    const from = addDays(start, -7 * (weeks - 1 - idx));
    const to = addDays(from, 6);
    const hits = workouts.filter((w) => w.date >= from && w.date <= to);
    return {
      from,
      to,
      count: hits.length,
      days: gymDays(hits),
      minutes: hits.reduce((s, w) => s + Number(w.minutes || 0), 0),
      miles: sumMiles(hits),
    };
  });
}

// consecutive weeks (ending with last completed week) that met the target
function weeklyStreak(workouts, target) {
  let streak = 0;
  for (let back = 0; back < 52; back++) {
    const from = addDays(weekStart(), -7 * back);
    const to = addDays(from, 6);
    const count = workouts.filter((w) => w.date >= from && w.date <= to).length;
    if (count >= target) streak++;
    else if (back === 0) continue; // current week still in progress
    else break;
  }
  return streak;
}

// consecutive weeks hitting the weekly mileage target
function milesStreak(workouts, target) {
  if (!target) return 0;
  let streak = 0;
  for (let back = 0; back < 52; back++) {
    const from = addDays(weekStart(), -7 * back);
    const to = addDays(from, 6);
    const total = sumMiles(workouts.filter((w) => w.date >= from && w.date <= to));
    if (total >= target) streak++;
    else if (back === 0) continue; // current week still in progress
    else break;
  }
  return streak;
}

// every week from the first logged workout through the current one
function allWeekBuckets(workouts) {
  if (!workouts.length) return [];
  const first = [...workouts].map((w) => w.date).sort()[0];
  const [y, m, d] = first.split("-").map(Number);
  const firstMonday = addDays(first, -((new Date(y, m - 1, d).getDay() + 6) % 7));
  const n = Math.floor(daysBetween(firstMonday, weekStart()) / 7) + 1;
  return weekBuckets(workouts, Math.max(1, n));
}

const MONTH_NAME = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (key) => {
  const [y, m] = key.split("-");
  return `${MONTH_NAME[Number(m) - 1]} ${y}`;
};

// month-by-month rollup, with how many of that month's weeks hit each target
function monthBuckets(workouts, gymTarget, milesTarget) {
  if (!workouts.length) return [];
  const weeks = allWeekBuckets(workouts);
  const rows = {};
  const touch = (key) =>
    (rows[key] = rows[key] || {
      key,
      days: 0,
      miles: 0,
      minutes: 0,
      weekCount: 0,
      weeksHitGym: 0,
      weeksHitMiles: 0,
    });

  const byMonth = {};
  workouts.forEach((w) => {
    const key = w.date.slice(0, 7);
    byMonth[key] = byMonth[key] || [];
    byMonth[key].push(w);
  });
  Object.entries(byMonth).forEach(([key, list]) => {
    const r = touch(key);
    r.days = gymDays(list);
    r.miles = sumMiles(list);
    r.minutes = list.reduce((s, w) => s + Number(w.minutes || 0), 0);
  });

  weeks.forEach((b) => {
    const r = touch(b.from.slice(0, 7));
    r.weekCount += 1;
    if (gymTarget && b.days >= gymTarget) r.weeksHitGym += 1;
    if (milesTarget && b.miles >= milesTarget) r.weeksHitMiles += 1;
  });

  return Object.values(rows).sort((a, b) => b.key.localeCompare(a.key));
}

const reviewedOn = (data, day) => Number(data.reviewLog?.[day] || 0);
const reviewedToday = (data) => reviewedOn(data, todayISO());
const dailyCardTarget = (data) => Number(data.settings?.cardsPerDay || 0);

// consecutive days the daily card quota was met
function cardStreak(data) {
  const target = dailyCardTarget(data);
  if (!target) return 0;
  let cursor = todayISO();
  if (reviewedOn(data, cursor) < target) {
    cursor = addDays(cursor, -1);
    if (reviewedOn(data, cursor) < target) return 0;
  }
  let streak = 0;
  while (reviewedOn(data, cursor) >= target) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

// today's queue: everything due first, then the closest-to-due cards to top up
function dailyQueue(data, count) {
  const today = todayISO();
  const pool = data.cards.filter((c) => !c.archivedCard);
  const due = pool
    .filter((c) => !c.due || c.due <= today)
    .sort((a, b) => (a.due || "").localeCompare(b.due || ""));
  const upcoming = pool
    .filter((c) => c.due && c.due > today)
    .sort((a, b) => a.due.localeCompare(b.due) || a.box - b.box);
  return [...due, ...upcoming].slice(0, Math.max(0, count));
}

// consecutive days ending today (or yesterday, if today's session isn't in yet)
function studyStreak(sessions) {
  if (!sessions.length) return 0;
  const days = new Set(sessions.map((s) => s.date));
  let start = todayISO();
  if (!days.has(start)) {
    start = addDays(start, -1);
    if (!days.has(start)) return 0;
  }
  let streak = 0;
  let cursor = start;
  while (days.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

// straight percentage average across the aviation courses
function aviationAverage(data) {
  const marks = live(data)
    .filter((c) => c.tier === "core")
    .map((c) => courseGrade(c).current)
    .filter((x) => x !== null);
  return marks.length ? marks.reduce((a, b) => a + b, 0) / marks.length : null;
}

function daysSinceLastWorkout(workouts) {
  const last = [...workouts].map((w) => w.date).sort().pop();
  return last ? daysBetween(last, todayISO()) : null;
}

/* ---------- the greeting ---------- */
const PILOT = "Cole";

const GREETINGS = {
  morning: [
    "Preflight's done. The day's yours.",
    "Winds are calm and the field is quiet.",
    "First light. The ramp's still cold.",
    "Coffee, then checklists.",
    "Clear skies on the forecast — take the early slot.",
    "Engine's warm. Let's get moving.",
    "Nothing's due yet. That's a rare thing.",
    "Sun's coming up over the hangar.",
    "You're first on the taxiway today.",
    "Early departures make easy afternoons.",
    "Fresh sectional, fresh start.",
    "Good morning. Nothing on the frequency yet.",
  ],
  afternoon: [
    "Straight and level.",
    "Halfway down the runway — keep it rolling.",
    "Ceiling and visibility unlimited.",
    "Cruise altitude. Hold the heading.",
    "Thermals are picking up. So should you.",
    "Trim it out and settle in.",
    "Midfield downwind. Plenty of day left.",
    "Fuel's good, time's good, keep going.",
    "The hard part of the day is behind you.",
    "Hold what you've got.",
    "Steady on the yoke.",
    "Good afternoon. Traffic's light.",
  ],
  evening: [
    "Sun's low. Good light for a landing.",
    "Downwind, gear coming down.",
    "Evening. Time for the second pass.",
    "One more circuit before you shut it down.",
    "Golden hour over the field.",
    "Runway lights are on.",
    "Last leg of the day.",
    "Wind's died down. Smoothest air you'll get.",
    "Short final. Bring it in easy.",
    "Chocks aren't in yet — one more.",
    "The evening flights are always the good ones.",
    "Log the hours before you forget them.",
  ],
  night: [
    "Night currency counts too.",
    "Beacon's on. Late one tonight.",
    "The field's dark and you're still at it.",
    "Nav lights only. Take it easy.",
    "Three takeoffs, three landings, one hour past sunset.",
    "Red light in the cockpit. Easy on the eyes.",
    "Quiet frequency this time of night.",
    "The hangar's empty except for you.",
    "Rest is part of the checklist too, Cole.",
    "Fatigue is a hazard. Know when to call it.",
    "Stars are out. Good night for navigation.",
    "Set the parking brake when you're done.",
  ],
};

function timeBand() {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 21) return "evening";
  return "night";
}

const BAND_TITLE = {
  morning: "Good morning",
  afternoon: "Good afternoon",
  evening: "Good evening",
  night: "Still up",
};

// a status line in the shape of a METAR — real numbers, familiar format
function statusStrip(data) {
  const now = new Date();
  const stamp = `${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(
    2,
    "0"
  )}${String(now.getMinutes()).padStart(2, "0")}Z`;
  const hours = (data.sessions.reduce((s, x) => s + Number(x.minutes), 0) / 60).toFixed(1);
  const streak = studyStreak(data.sessions);
  const avg = aviationAverage(data);
  const ws = weekStart();
  const gym = gymDays((data.personal?.workouts || []).filter((w) => w.date >= ws));
  const mi = sumMiles((data.personal?.workouts || []).filter((w) => w.date >= ws));
  return [
    `KAZO ${stamp}`,
    `STUDY ${hours}H`,
    `STREAK ${streak}D`,
    `AVGRADES ${avg === null ? "—" : avg.toFixed(1)}`,
    `GYM ${gym}`,
    `${mi} MI`,
  ].join("  /  ");
}

function Greeting({ data, go }) {
  const band = timeBand();
  const line = useMemo(() => {
    const pool = GREETINGS[band];
    return pool[Math.floor(Math.random() * pool.length)];
  }, [band]);

  const graded = live(data).map((c) => courseGrade(c).current).filter((x) => x !== null);
  const gpa = graded.length
    ? (graded.reduce((s, p) => s + GPA_PTS[letterFor(p)], 0) / graded.length).toFixed(2)
    : "—";
  const due = data.cards.filter((c) => !c.due || c.due <= todayISO()).length;
  const ws = weekStart();
  const week = (data.personal?.workouts || []).filter((w) => w.date >= ws);
  const studyMin = data.sessions
    .filter((s) => s.date >= ws)
    .reduce((s, x) => s + Number(x.minutes), 0);

  const studyGoal = live(data).reduce((s, c) => s + Number(c.weeklyMinutes || 0), 0);

  const tiles = [
    { label: "Overall GPA", value: gpa, note: `${graded.length} course${graded.length === 1 ? "" : "s"} graded` },
    { label: "Cards ready", value: due, note: due ? "review waiting" : "all caught up" },
    {
      label: "Gym this week",
      value: gymDays(week),
      note: `of ${data.personal?.gymTarget || 0} days`,
    },
    {
      label: "Miles this week",
      value: sumMiles(week),
      note: `of ${data.personal?.milesTarget || 0} mi`,
    },
    {
      label: "Study this week",
      value: `${(studyMin / 60).toFixed(1)}h`,
      note: studyGoal ? `of ${(studyGoal / 60).toFixed(1)}h goal` : "no goal set",
    },
  ];

  return (
    <div style={S.heroWrap}>
      <p style={S.eyebrow} className="hero">
        {new Date()
          .toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
          .toUpperCase()}
      </p>

      <h1 className="hero-h hero" style={{ marginTop: 14 }}>
        {BAND_TITLE[band]}, <em>{PILOT}</em>.
      </h1>

      <p style={S.heroSub} className="hero-2">
        {line}
      </p>

      <div style={{ marginTop: 22 }} className="hero-2">
        <button style={S.btn} className="btn cta" onClick={() => go("cards")}>
          Review {due} card{due === 1 ? "" : "s"}
        </button>
        <button style={S.btn} className="btn" onClick={() => go("study")}>
          Log a session
        </button>
      </div>

      <div className="tiles hero-3">
        {tiles.map((t) => (
          <div className="tile" key={t.label}>
            <p style={S.tileLabel}>{t.label}</p>
            <p style={S.tileValue}>{t.value}</p>
            <p style={S.tileNote}>{t.note}</p>
          </div>
        ))}
      </div>

      <p style={S.strip} className="hero-3">
        {statusStrip(data)}
      </p>
    </div>
  );
}

/* ============================================================
   APP
   ============================================================ */
export default function CollegeHub() {
  const [data, setData] = useState(null);
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [tab, setTab] = useState("home");
  const [openCourse, setOpenCourse] = useState(null);
  const first = useRef(true);

 useEffect(() => {
  supabase.auth.getSession().then(async ({ data: { session } }) => {
    const signedInUser = session?.user || null;

    if (
      signedInUser &&
      signedInUser.email?.toLowerCase() !== ALLOWED_EMAIL.toLowerCase()
    ) {
      await supabase.auth.signOut();
      setUser(null);
      setAuthLoading(false);
      return;
    }

    setUser(signedInUser);
    setAuthLoading(false);
  });

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange(async (_event, session) => {
    const signedInUser = session?.user || null;

    if (
      signedInUser &&
      signedInUser.email?.toLowerCase() !== ALLOWED_EMAIL.toLowerCase()
    ) {
      await supabase.auth.signOut();
      setUser(null);
      setAuthLoading(false);
      return;
    }

    setUser(signedInUser);
    setAuthLoading(false);
  });

  return () => subscription.unsubscribe();
}, []);

  useEffect(() => {
    if (!user) {
      setData(null);
      return;
    }

    let cancelled = false;

    (async () => {
      const cloud = await loadCloudData(user.id);

      if (!cancelled) {
        setData(migrate(cloud));
        first.current = true;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user || !data) return;

    if (first.current) {
      first.current = false;
      return;
    }

    const t = setTimeout(() => {
      saveCloudData(user.id, data);
    }, 500);

    return () => clearTimeout(t);
  }, [data, user]);

  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel(`flightplan-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "flightplan_data",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const incoming = payload.new?.data;

          if (incoming) {
            first.current = true;
            setData(migrate(incoming));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]);

  const signIn = async () => {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: "https://colecarmody320.github.io/FlightPlan/",
      },
    });
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const update = (fn) => setData((d) => fn({ ...d }));

  if (authLoading) {
    return <div style={S.page}>Loading…</div>;
  }

  if (!user) {
    return (
      <div style={S.page}>
        <style>{CSS}</style>
        <div style={{ paddingTop: 80, maxWidth: 480 }}>
          <p style={S.eyebrow}>FLIGHTPLAN</p>
          <h1 style={{ fontSize: 42 }}>Your data, everywhere.</h1>
          <p style={S.dim}>
            Sign in with Google to sync FlightPlan across your devices.
          </p>

          <button style={S.btn} className="btn cta" onClick={signIn}>
            Continue with Google
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div style={S.page}>Loading FlightPlan…</div>;
  }

  return (
    <div style={S.page} className="hub">
      <style>{CSS}</style>

      <header className="bar">
        <span className="mark">✈</span>
        <span style={S.wordmark}>FlightPlan</span>

        <div className="nav">
          {[
            ["home", "Home"],
            ["cards", "Cards"],
            ["study", "Study"],
            ["grades", "Grades"],
            ["goals", "Goals"],
            ["personal", "Personal"],
            ["courses", "Courses"],
          ].map(([k, label]) => (
            <button
              key={k}
              className={tab === k ? "tab on" : "tab"}
              onClick={() => {
                setTab(k);
                setOpenCourse(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          style={S.btn}
       className="btn cta cta-desktop"
          onClick={() => {
            setTab("cards");
            setOpenCourse(null);
          }}
        >
          Start studying
        </button>
         <button
  style={S.btn}
  className="btn"
  onClick={signOut}
>
  Sign out
</button>
      </header>

      <main key={tab} className="view">
        {tab === "home" && <Home data={data} go={setTab} />}
        {tab === "cards" && <CardsTab data={data} update={update} />}
        {tab === "study" && <StudyTab data={data} update={update} />}
        {tab === "grades" && <GradesTab data={data} update={update} />}
        {tab === "goals" && <GoalsTab data={data} update={update} />}
        {tab === "personal" && <PersonalTab data={data} update={update} />}
        {tab === "courses" &&
          (openCourse ? (
            <CourseDetail
              data={data}
              update={update}
              courseId={openCourse}
              back={() => setOpenCourse(null)}
            />
          ) : (
            <CourseList data={data} update={update} open={setOpenCourse} />
          ))}
        {tab === "data" && <DataTab data={data} setData={setData} />}
      </main>

      <footer style={S.footer}>
        <button style={S.footLink} className="btn" onClick={() => setTab(tab === "data" ? "home" : "data")}>
          {tab === "data" ? "← back" : "Backup & export"}
        </button>
      </footer>
    </div>
  );
}

/* ============================================================
   HOME
   ============================================================ */
function Home({ data, go }) {
  const ranked = live(data)
    .map((c) => ({ course: c, ...studyPriority(c, data) }))
    .sort((a, b) => b.score - a.score);

  const ws = weekStart();
  const weekSessions = data.sessions.filter((s) => s.date >= ws);
  const mins = (list) => list.reduce((s, x) => s + Number(x.minutes), 0);

  const core = live(data).filter((c) => c.tier === "core");
  const support = live(data).filter((c) => c.tier !== "core");
  const coreIds = core.map((c) => c.id);

  const coreMin = mins(weekSessions.filter((s) => coreIds.includes(s.courseId)));
  const otherMin = mins(weekSessions) - coreMin;
  const coreGoal = core.reduce((s, c) => s + Number(c.weeklyMinutes || 0), 0);
  const otherGoal = support.reduce((s, c) => s + Number(c.weeklyMinutes || 0), 0);

  const graded = live(data).map((c) => courseGrade(c).current).filter((x) => x !== null);
  const gpa = graded.length
    ? graded.reduce((s, p) => s + GPA_PTS[letterFor(p)], 0) / graded.length
    : null;
  const coreGraded = core.map((c) => courseGrade(c).current).filter((x) => x !== null);
  const coreGpa = coreGraded.length
    ? coreGraded.reduce((s, p) => s + GPA_PTS[letterFor(p)], 0) / coreGraded.length
    : null;

  const GradeTable = ({ list }) => (
    <table style={S.table}>
      <thead>
        <tr>
          <th style={S.th}>Course</th>
          <th style={S.th}>Now</th>
          <th style={S.th}>Target</th>
          <th style={S.th}>Gap</th>
          <th style={S.th}>Open</th>
          <th style={S.th}>Cards</th>
        </tr>
      </thead>
      <tbody>
        {list.map((c) => {
          const g = courseGrade(c);
          const gap = g.current === null ? null : g.current - Number(c.target);
          const due = data.cards.filter(
            (x) => x.courseId === c.id && (!x.due || x.due <= todayISO())
          ).length;
          return (
            <tr key={c.id}>
              <td style={S.td}>{c.code}</td>
              <td style={S.td}>
                {g.current === null ? "—" : `${g.current.toFixed(1)}% (${letterFor(g.current)})`}
              </td>
              <td style={S.td}>{c.target}%</td>
              <td style={{ ...S.td, color: gap === null ? "#8C837A" : gap < 0 ? "#B4674A" : "#7C8471" }}>
                {gap === null ? "—" : `${gap > 0 ? "+" : ""}${gap.toFixed(1)}`}
              </td>
              <td style={S.td}>{g.totalWeight ? `${g.remaining}%` : "—"}</td>
              <td style={S.td}>{due || "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div>
      <Greeting data={data} go={go} />
      <div style={{ height: 30 }} />
      <Section title="Aviation">
        <p>
          Aviation GPA: <b>{coreGpa === null ? "—" : coreGpa.toFixed(2)}</b>{" "}
          <span style={S.dim}>· all courses {gpa === null ? "—" : gpa.toFixed(2)}</span>
        </p>
        <GradeTable list={core} />
        <p style={{ marginTop: 8 }}>
          Studied <b>{coreMin}</b> of {coreGoal} min this week
        </p>
        <Bar value={coreMin} max={coreGoal} />
      </Section>

      <Section title="Non-aviation">
        <GradeTable list={support} />
        <p style={{ marginTop: 8 }}>
          Studied <b>{otherMin}</b> of {otherGoal} min this week
        </p>
        <Bar value={otherMin} max={otherGoal} />
      </Section>

      <Section title="Study this next">
        <ol style={S.list}>
          {ranked.slice(0, 4).map((r) => (
            <li key={r.course.id} style={{ marginBottom: 6 }}>
              <b>{r.course.code}</b> — {r.course.name}
              <br />
              <span style={S.dim}>
                {r.reasons.length ? r.reasons.join(" · ") : "on track"}
              </span>
            </li>
          ))}
        </ol>
        <button style={S.btn} className="btn" onClick={() => go("cards")}>Cards</button>
        <button style={S.btn} className="btn" onClick={() => go("study")}>Log a session</button>
      </Section>

      <Section title="Gym">
        {(() => {
          const p = data.personal;
          const target = Number(p.gymTarget) || 0;
          const milesTarget = Number(p.milesTarget) || 0;
          const thisWeek = p.workouts.filter((w) => w.date >= ws);
          const streak = weeklyStreak(p.workouts, target);
          const mStreak = milesStreak(p.workouts, milesTarget);
          const gap = daysSinceLastWorkout(p.workouts);
          return (
            <>
              <p>
                <b>{gymDays(thisWeek)}</b> of {target} gym days this week
              </p>
              <Bar value={gymDays(thisWeek)} max={target} />
              <p>
                <b>{sumMiles(thisWeek)}</b> of {milesTarget} miles this week
              </p>
              <Bar value={sumMiles(thisWeek)} max={milesTarget} />
              <p style={S.dim}>
                {streak} week gym streak · {mStreak} week mileage streak ·{" "}
                {gap === null
                  ? "nothing logged yet"
                  : gap === 0
                  ? "trained today"
                  : `${gap} day${gap === 1 ? "" : "s"} since last session`}
              </p>
              <button style={S.btn} className="btn" onClick={() => go("personal")}>Log a workout</button>
            </>
          );
        })()}
      </Section>

      <Section title="Goals">
        {data.goals.filter((g) => !g.done).length === 0 ? (
          <p style={S.dim}>No active goals.</p>
        ) : (
          data.goals
            .filter((g) => !g.done)
            .map((g) => {
              const p = goalProgress(g, data);
              const pace = goalPace(g, p);
              return (
                <div key={g.id} style={{ marginBottom: 8 }}>
                  {g.title}{" "}
                  <span style={S.dim}>
                    {(g.domain || "academic") === "personal" ? "personal · " : ""}
                    {p.current}/{p.target} {p.unit}
                    {pace && !pace.overdue && ` · ${pace.daysLeft}d left`}
                    {pace && pace.overdue && " · past deadline"}
                  </span>
                  <Bar value={p.current} max={p.target} />
                  {pace && !pace.overdue && p.current < p.target && (
                    <span style={pace.onPace ? S.ok : S.late}>
                      {pace.onPace ? "on pace" : "behind pace"} · {pace.perWeek.toFixed(1)}{" "}
                      {p.unit}/week to finish
                    </span>
                  )}
                </div>
              );
            })
        )}
      </Section>
    </div>
  );
}

function Bar({ value, max }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={pct >= 100 ? "gauge met" : "gauge"} style={{ marginBottom: 8 }}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ============================================================
   CARDS — browse, filter, review by scope
   ============================================================ */
function CardsTab({ data, update }) {
  const [review, setReview] = useState(null); // {ids:[], label}
  const [view, setView] = useState("decks");

  if (review)
    return <Review data={data} update={update} scope={review} done={() => setReview(null)} />;

  return (
    <div>
      <nav style={S.subnav}>
        {[["decks", "Decks"], ["browse", "Browse & edit"], ["add", "Add cards"]].map(([k, l]) => (
          <button key={k} onClick={() => setView(k)} className={view === k ? "tab on" : "tab"}>
            {l}
          </button>
        ))}
      </nav>
      {view === "decks" && <Decks data={data} start={setReview} />}
      {view === "browse" && <Browse data={data} update={update} start={setReview} />}
      {view === "add" && <AddCards data={data} update={update} />}
    </div>
  );
}

function Decks({ data, start }) {
  const today = todayISO();
  const dueIn = (list) => list.filter((c) => !c.due || c.due <= today);

  const byCourse = (id) => data.cards.filter((c) => c.courseId === id);
  const coreIds = live(data).filter((c) => c.tier === "core").map((c) => c.id);
  const coreDue = dueIn(data.cards.filter((c) => coreIds.includes(c.courseId)));
  const allDue = dueIn(data.cards);

  return (
    <div>
      <Section title="Quick review">
        <button
          style={S.btn} className="btn"
          disabled={!coreDue.length}
          onClick={() => start({ ids: coreDue.map((c) => c.id), label: "Aviation core" })}
        >
          All aviation ({coreDue.length})
        </button>
        <button
          style={S.btn} className="btn"
          disabled={!allDue.length}
          onClick={() => start({ ids: allDue.map((c) => c.id), label: "Everything due" })}
        >
          Everything due ({allDue.length})
        </button>
      </Section>

      {["core", "support"].map((tier) => (
        <Section key={tier} title={TIER_LABEL[tier]}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Course</th>
                <th style={S.th}>Cards</th>
                <th style={S.th}>Ready</th>
                <th style={S.th}>Box spread</th>
                <th style={S.th}></th>
              </tr>
            </thead>
            <tbody>
              {live(data)
                .filter((c) => (c.tier || "support") === tier)
                .map((c) => {
                  const all = byCourse(c.id);
                  const due = dueIn(all);
                  const spread = [1, 2, 3, 4, 5]
                    .map((b) => all.filter((x) => x.box === b).length)
                    .join("/");
                  return (
                    <tr key={c.id}>
                      <td style={S.td}>{c.code}</td>
                      <td style={S.td}>{all.length}</td>
                      <td style={S.td}>{due.length}</td>
                      <td style={S.td}>
                        <span style={S.dim}>{spread}</span>
                      </td>
                      <td style={S.td}>
                        <button
                          style={S.btn} className="btn"
                          disabled={!due.length}
                          onClick={() => start({ ids: due.map((x) => x.id), label: c.code })}
                        >
                          Review
                        </button>
                        {all.length > due.length && (
                          <button
                            style={S.btn} className="btn"
                            onClick={() => start({ ids: all.map((x) => x.id), label: `${c.code} (all)` })}
                          >
                            Cram all
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          <p style={S.dim}>Box spread = cards in box 1/2/3/4/5. Box 5 comes back every 16 days.</p>
        </Section>
      ))}

      <Section title="By topic">
        <TopicTable data={data} start={start} />
      </Section>
    </div>
  );
}

function TopicTable({ data, start }) {
  const today = todayISO();
  const topics = {};
  data.cards.forEach((c) => {
    const key = `${c.courseId}||${c.topic || "untagged"}`;
    topics[key] = topics[key] || [];
    topics[key].push(c);
  });
  const rows = Object.entries(topics);
  if (!rows.length) return <p style={S.dim}>No cards yet.</p>;

  return (
    <table style={S.table}>
      <thead>
        <tr>
          <th style={S.th}>Course</th>
          <th style={S.th}>Topic</th>
          <th style={S.th}>Cards</th>
          <th style={S.th}>Ready</th>
          <th style={S.th}></th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, list]) => {
          const [courseId, topic] = key.split("||");
          const code = data.courses.find((c) => c.id === courseId)?.code || "—";
          const due = list.filter((c) => !c.due || c.due <= today);
          return (
            <tr key={key}>
              <td style={S.td}>{code}</td>
              <td style={S.td}>{topic}</td>
              <td style={S.td}>{list.length}</td>
              <td style={S.td}>{due.length}</td>
              <td style={S.td}>
                <button
                  style={S.btn} className="btn"
                  onClick={() => start({ ids: list.map((c) => c.id), label: `${code} — ${topic}` })}
                >
                  Study
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Browse({ data, update, start }) {
  const [course, setCourse] = useState("all");
  const [topic, setTopic] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("due");
  const [editing, setEditing] = useState(null);

  const coreIds = live(data).filter((c) => c.tier === "core").map((c) => c.id);

  let list = data.cards.filter((c) => {
    if (course === "aviation" && !coreIds.includes(c.courseId)) return false;
    if (course !== "all" && course !== "aviation" && c.courseId !== course) return false;
    if (topic !== "all" && (c.topic || "untagged") !== topic) return false;
    if (q && !`${c.front} ${c.back} ${c.topic}`.toLowerCase().includes(q.toLowerCase()))
      return false;
    return true;
  });

  const codeOf = (id) => data.courses.find((c) => c.id === id)?.code || "—";
  list = [...list].sort((a, b) => {
    if (sort === "due") return (a.due || "").localeCompare(b.due || "");
    if (sort === "box") return a.box - b.box;
    if (sort === "course") return codeOf(a.courseId).localeCompare(codeOf(b.courseId));
    if (sort === "topic") return (a.topic || "zzz").localeCompare(b.topic || "zzz");
    if (sort === "hardest") return (b.missed || 0) - (a.missed || 0);
    return a.front.localeCompare(b.front);
  });

  const topics = [
    ...new Set(
      data.cards
        .filter((c) => course === "all" || course === "aviation" || c.courseId === course)
        .map((c) => c.topic || "untagged")
    ),
  ];

  const edit = (id, field, value) =>
    update((d) => {
      d.cards = d.cards.map((c) => (c.id === id ? { ...c, [field]: value } : c));
      return d;
    });

  const remove = (id) =>
    update((d) => {
      d.cards = d.cards.filter((c) => c.id !== id);
      return d;
    });

  const resetBox = (id) =>
    update((d) => {
      d.cards = d.cards.map((c) => (c.id === id ? { ...c, box: 1, due: todayISO() } : c));
      return d;
    });

  return (
    <div>
      <Section title="Filter">
        <select style={S.input} value={course} onChange={(e) => { setCourse(e.target.value); setTopic("all"); }}>
          <option value="all">All courses</option>
          <option value="aviation">Aviation only</option>
          {data.courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.name}{c.archived ? " (archived)" : ""}
            </option>
          ))}
        </select>
        <select style={S.input} value={topic} onChange={(e) => setTopic(e.target.value)}>
          <option value="all">All topics</option>
          {topics.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select style={S.input} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="due">Sort: next due</option>
          <option value="course">Sort: course</option>
          <option value="topic">Sort: topic</option>
          <option value="box">Sort: weakest box</option>
          <option value="hardest">Sort: most missed</option>
          <option value="front">Sort: A–Z</option>
        </select>
        <input style={S.input} placeholder="Search text" value={q} onChange={(e) => setQ(e.target.value)} />
        <br />
        <button
          style={S.btn} className="btn"
          disabled={!list.length}
          onClick={() => start({ ids: list.map((c) => c.id), label: `${list.length} filtered cards` })}
        >
          Study these {list.length}
        </button>
        <span style={S.dim}>{list.length} of {data.cards.length} cards</span>
      </Section>

      <Section title="Cards">
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Course</th>
              <th style={S.th}>Topic</th>
              <th style={S.th}>Front</th>
              <th style={S.th}>Box</th>
              <th style={S.th}>Next</th>
              <th style={S.th}>Missed</th>
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <React.Fragment key={c.id}>
                <tr>
                  <td style={S.td}>{codeOf(c.courseId)}</td>
                  <td style={S.td}>{c.topic || <span style={S.dim}>untagged</span>}</td>
                  <td style={S.td}>
                    {c.front || <span style={S.dim}>(image only)</span>}
                    {(c.frontImg || c.backImg) && <span title="has image"> ▣</span>}
                  </td>
                  <td style={S.td}>{c.box}</td>
                  <td style={S.td}>{c.due}</td>
                  <td style={S.td}>{c.missed || 0}/{c.seen || 0}</td>
                  <td style={S.td}>
                    <button style={S.btn} className="btn" onClick={() => setEditing(editing === c.id ? null : c.id)}>
                      Edit
                    </button>
                  </td>
                </tr>
                {editing === c.id && (
                  <tr>
                    <td style={S.td} colSpan={7}>
                      <div style={S.card}>
                        <label style={S.label}>Course</label>
                        <select
                          style={S.input}
                          value={c.courseId}
                          onChange={(e) => edit(c.id, "courseId", e.target.value)}
                        >
                          {data.courses.map((x) => (
                            <option key={x.id} value={x.id}>{x.code}</option>
                          ))}
                        </select>
                        <label style={S.label}>Topic</label>
                        <input
                          style={S.input}
                          value={c.topic || ""}
                          placeholder="e.g. Fuel systems"
                          onChange={(e) => edit(c.id, "topic", e.target.value)}
                        />
                        <label style={S.label}>Front</label>
                        <textarea
                          style={S.textarea}
                          rows={2}
                          value={c.front}
                          onChange={(e) => edit(c.id, "front", e.target.value)}
                        />
                        <ImageField
                          label="Front image"
                          value={c.frontImg || ""}
                          onChange={(v) => edit(c.id, "frontImg", v)}
                        />
                        <label style={S.label}>Back</label>
                        <textarea
                          style={S.textarea}
                          rows={4}
                          value={c.back}
                          onChange={(e) => edit(c.id, "back", e.target.value)}
                        />
                        <ImageField
                          label="Back image"
                          value={c.backImg || ""}
                          onChange={(v) => edit(c.id, "backImg", v)}
                        />
                        <button style={S.btn} className="btn" onClick={() => resetBox(c.id)}>Reset to box 1</button>
                        <button style={S.btn} className="btn" onClick={() => remove(c.id)}>Delete card</button>
                        <button style={S.btn} className="btn" onClick={() => setEditing(null)}>Close</button>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
        {!list.length && <p style={S.dim}>Nothing matches.</p>}
      </Section>
    </div>
  );
}

function AddCards({ data, update }) {
  const core = live(data).filter((c) => c.tier === "core");
  const [courseId, setCourseId] = useState((core[0] || live(data)[0])?.id || "");
  const [topic, setTopic] = useState("");
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [frontImg, setFrontImg] = useState("");
  const [backImg, setBackImg] = useState("");
  const [bulk, setBulk] = useState("");
  const [msg, setMsg] = useState("");

  const push = (cards) =>
    update((d) => {
      d.cards = [...d.cards, ...cards];
      return d;
    });

  const addOne = () => {
    if (!front.trim() && !frontImg) return;
    push([
      {
        id: uid(),
        courseId,
        topic: topic.trim(),
        front: front.trim(),
        back: back.trim(),
        frontImg,
        backImg,
        box: 1,
        due: todayISO(),
        lastReviewed: null,
        seen: 0,
        missed: 0,
      },
    ]);
    setFront("");
    setBack("");
    setFrontImg("");
    setBackImg("");
  };

  const addBulk = () => {
    const rows = bulk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [f, ...rest] = l.split("|");
        return {
          id: uid(),
          courseId,
          topic: topic.trim(),
          front: (f || "").trim(),
          back: rest.join("|").trim(),
          frontImg: "",
          backImg: "",
          box: 1,
          due: todayISO(),
          lastReviewed: null,
          seen: 0,
          missed: 0,
        };
      })
      .filter((c) => c.front);
    if (!rows.length) return;
    push(rows);
    setBulk("");
    setMsg(`Added ${rows.length} cards.`);
  };

  return (
    <div>
      <Section title="Where">
        <label style={S.label}>Course</label>
        <select style={S.input} value={courseId} onChange={(e) => setCourseId(e.target.value)}>
          <optgroup label="Aviation">
            {live(data).filter((c) => c.tier === "core").map((c) => (
              <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
            ))}
          </optgroup>
          <optgroup label="Non-aviation">
            {live(data).filter((c) => c.tier !== "core").map((c) => (
              <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
            ))}
          </optgroup>
        </select>
        <label style={S.label}>Topic (groups cards inside a course)</label>
        <input
          style={S.input}
          placeholder="Fuel systems / V-speeds / Airspace"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
      </Section>

      <Section title="One at a time">
        <input
          style={S.input}
          placeholder="Front"
          value={front}
          onChange={(e) => setFront(e.target.value)}
        />
        <ImageField label="Front image (optional)" value={frontImg} onChange={setFrontImg} />
        <textarea
          style={S.textarea}
          rows={3}
          placeholder="Back"
          value={back}
          onChange={(e) => setBack(e.target.value)}
        />
        <ImageField label="Back image (optional)" value={backImg} onChange={setBackImg} />
        <button style={S.btn} className="btn" onClick={addOne}>Add card</button>
        <p style={S.dim}>
          An image on the front with a blank text field works fine — good for "identify this
          instrument reading" or a systems diagram you have to name parts of.
        </p>
      </Section>

      <Section title="Paste a batch">
        <p style={S.dim}>One card per line, front and back separated by a pipe: Vso | stall speed, landing config</p>
        <textarea
          style={S.textarea}
          rows={8}
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
        />
        <button style={S.btn} className="btn" onClick={addBulk}>Add batch</button>
        {msg && <span style={S.dim}>{msg}</span>}
      </Section>
    </div>
  );
}

function Review({ data, update, scope, done }) {
  const today = todayISO();
  const queue = useMemo(() => {
    const byId = Object.fromEntries(data.cards.map((c) => [c.id, c]));
    const arr = scope.ids.map((id) => byId[id]).filter(Boolean);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }, []);

  const [round, setRound] = useState(queue);
  const [i, setI] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [right, setRight] = useState(0);
  const [missedIds, setMissedIds] = useState([]);
  const card = round[i];

  const grade = (correct) => {
    update((d) => {
      d.cards = d.cards.map((c) => {
        if (c.id !== card.id) return c;
        const box = correct ? Math.min(5, c.box + 1) : 1;
        return {
          ...c,
          box,
          due: addDays(today, BOX_GAP[box]),
          lastReviewed: today,
          seen: (c.seen || 0) + 1,
          missed: (c.missed || 0) + (correct ? 0 : 1),
        };
      });
      return d;
    });
    if (correct) setRight(right + 1);
    else setMissedIds([...missedIds, card.id]);
    setRevealed(false);
    setI(i + 1);
  };

  const retryMissed = () => {
    const byId = Object.fromEntries(data.cards.map((c) => [c.id, c]));
    setRound(missedIds.map((id) => byId[id]).filter(Boolean));
    setMissedIds([]);
    setRight(0);
    setI(0);
    setRevealed(false);
  };

  if (!card)
    return (
      <Section title="Round complete">
        <p>
          {right} of {round.length} correct.
        </p>
        {missedIds.length > 0 && (
          <button style={S.btn} className="btn" onClick={retryMissed}>
            Retry the {missedIds.length} you missed
          </button>
        )}
        <button style={S.btn} className="btn" onClick={done}>Back to decks</button>
      </Section>
    );

  const code = data.courses.find((c) => c.id === card.courseId)?.code || "";

  return (
    <Section title={`${scope.label} — ${i + 1} of ${round.length}`}>
      <p style={S.dim}>
        {code}
        {card.topic ? ` · ${card.topic}` : ""} · box {card.box}
      </p>
      <div style={S.card}>
        {card.front && <p style={{ fontSize: 18 }}>{card.front}</p>}
        {card.frontImg && <img src={card.frontImg} alt="" style={S.cardImg} />}
        {revealed ? (            
          <div className="flip">
            <hr />
            {card.back && <pre style={S.pre}>{card.back}</pre>}
            {card.backImg && <img src={card.backImg} alt="" style={S.cardImg} />}
            <button style={S.btn} className="btn" onClick={() => grade(false)}>Missed it</button>
            <button style={S.btn} className="btn" onClick={() => grade(true)}>Got it</button>
          </div>
          <button style={S.btn} className="btn" onClick={() => setRevealed(true)}>Show answer</button>
        )}
      </div>
      <button style={S.btn} className="btn" onClick={done}>Stop</button>
    </Section>
  );
}

/* ============================================================
   STUDY — timer + sessions
   ============================================================ */
function StudyTab({ data, update }) {
  const [sub, setSub] = useState("log");
  return (
    <div>
      <nav style={S.subnav}>
        {[["log", "Log a session"], ["history", "History"]].map(([k, l]) => (
          <button key={k} onClick={() => setSub(k)} className={sub === k ? "tab on" : "tab"}>
            {l}
          </button>
        ))}
      </nav>
      {sub === "log" && <SessionLogger data={data} update={update} />}
      {sub === "history" && <History data={data} update={update} />}
    </div>
  );
}

function SessionLogger({ data, update }) {
  const core = live(data).filter((c) => c.tier === "core");
  const [courseId, setCourseId] = useState((core[0] || live(data)[0])?.id || "");
  const [what, setWhat] = useState("");
  const [minutes, setMinutes] = useState(25);
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const log = (mins) => {
    if (!mins || mins <= 0) return;
    update((d) => {
      d.sessions = [
        ...d.sessions,
        { id: uid(), courseId, date: todayISO(), minutes: Math.round(mins), what: what.trim() },
      ];
      return d;
    });
    setWhat("");
    setSeconds(0);
    setRunning(false);
  };

  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <div>
      <Section title="Timer">
        <p style={{ fontSize: 28, fontVariantNumeric: "tabular-nums", margin: "4px 0" }}>
          {mm}:{ss}
        </p>
        <button style={S.btn} className="btn" onClick={() => setRunning(!running)}>
          {running ? "Pause" : "Start"}
        </button>
        <button style={S.btn} className="btn" disabled={seconds < 60} onClick={() => log(seconds / 60)}>
          Log {Math.round(seconds / 60)} min
        </button>
        <button style={S.btn} className="btn" onClick={() => { setRunning(false); setSeconds(0); }}>Reset</button>
      </Section>

      <Section title="Session">
        <label style={S.label}>Course</label>
        <select style={S.input} value={courseId} onChange={(e) => setCourseId(e.target.value)}>
          <optgroup label="Aviation">
            {live(data).filter((c) => c.tier === "core").map((c) => (
              <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
            ))}
          </optgroup>
          <optgroup label="Non-aviation">
            {live(data).filter((c) => c.tier !== "core").map((c) => (
              <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
            ))}
          </optgroup>
        </select>
        <label style={S.label}>What you worked on</label>
        <input
          style={S.input}
          placeholder="Chair fly ILS / powerplant fuel systems"
          value={what}
          onChange={(e) => setWhat(e.target.value)}
        />
        <label style={S.label}>Minutes</label>
        <input style={S.inputSm} type="number" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        <button style={S.btn} className="btn" onClick={() => log(Number(minutes))}>Add session</button>
      </Section>
    </div>
  );
}

function History({ data, update }) {
  const codeOf = (id) => data.courses.find((c) => c.id === id)?.code || "—";
  const list = [...data.sessions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 80);
  const remove = (id) =>
    update((d) => {
      d.sessions = d.sessions.filter((s) => s.id !== id);
      return d;
    });

  const coreIds = live(data).filter((c) => c.tier === "core").map((c) => c.id);
  const total = data.sessions.reduce((s, x) => s + Number(x.minutes), 0);
  const coreTotal = data.sessions
    .filter((s) => coreIds.includes(s.courseId))
    .reduce((s, x) => s + Number(x.minutes), 0);

  return (
    <Section title="Sessions">
      <p>
        {(total / 60).toFixed(1)} hrs total ·{" "}
        <b>{(coreTotal / 60).toFixed(1)} hrs on aviation</b>{" "}
        <span style={S.dim}>({total ? Math.round((coreTotal / total) * 100) : 0}%)</span>
      </p>
      {list.length === 0 ? (
        <p style={S.dim}>Nothing logged yet.</p>
      ) : (
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Date</th>
              <th style={S.th}>Course</th>
              <th style={S.th}>Min</th>
              <th style={S.th}>What</th>
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td style={S.td}>{s.date}</td>
                <td style={S.td}>{codeOf(s.courseId)}</td>
                <td style={S.td}>{s.minutes}</td>
                <td style={S.td}>{s.what}</td>
                <td style={S.td}>
                  <button style={S.btn} className="btn" onClick={() => remove(s.id)}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

/* ============================================================
   GRADES
   ============================================================ */
function GradesTab({ data, update }) {
  const core = live(data).filter((c) => c.tier === "core");
  const [courseId, setCourseId] = useState((core[0] || live(data)[0])?.id || "");
  const course = data.courses.find((c) => c.id === courseId) || data.courses[0];
  if (!course) return <p>Add a course first.</p>;

  return (
    <div>
      <Section title="Course">
        <select style={S.input} value={course.id} onChange={(e) => setCourseId(e.target.value)}>
          <optgroup label="Aviation">
            {live(data).filter((c) => c.tier === "core").map((c) => (
              <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
            ))}
          </optgroup>
          <optgroup label="Non-aviation">
            {live(data).filter((c) => c.tier !== "core").map((c) => (
              <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
            ))}
          </optgroup>
        </select>
      </Section>
      <GradeEditor data={data} update={update} courseId={course.id} />
    </div>
  );
}

function GradeEditor({ data, update, courseId }) {
  const course = data.courses.find((c) => c.id === courseId);
  const [catName, setCatName] = useState("");
  const [catWeight, setCatWeight] = useState("");

  const mutate = (fn) =>
    update((d) => {
      d.courses = d.courses.map((c) => (c.id === courseId ? fn({ ...c }) : c));
      return d;
    });

  const addCat = () => {
    if (!catName.trim()) return;
    mutate((c) => ({
      ...c,
      categories: [
        ...(c.categories || []),
        { id: uid(), name: catName.trim(), weight: Number(catWeight) || 0, items: [] },
      ],
    }));
    setCatName("");
    setCatWeight("");
  };

  const addItem = (catId) =>
    mutate((c) => ({
      ...c,
      categories: c.categories.map((k) =>
        k.id === catId
          ? { ...k, items: [...k.items, { id: uid(), label: "", earned: "", possible: "" }] }
          : k
      ),
    }));

  const editItem = (catId, itemId, field, value) =>
    mutate((c) => ({
      ...c,
      categories: c.categories.map((k) =>
        k.id === catId
          ? { ...k, items: k.items.map((i) => (i.id === itemId ? { ...i, [field]: value } : i)) }
          : k
      ),
    }));

  const removeItem = (catId, itemId) =>
    mutate((c) => ({
      ...c,
      categories: c.categories.map((k) =>
        k.id === catId ? { ...k, items: k.items.filter((i) => i.id !== itemId) } : k
      ),
    }));

  const removeCat = (catId) =>
    mutate((c) => ({ ...c, categories: c.categories.filter((k) => k.id !== catId) }));

  const g = courseGrade(course);
  const need = neededOnRemaining(course, Number(course.target));

  return (
    <div>
      <Section title="Standing">
        <p style={{ fontSize: 20 }}>
          {g.current === null ? "No scores yet" : `${g.current.toFixed(2)}% — ${letterFor(g.current)}`}
        </p>
        <p style={S.dim}>
          Weights total {g.totalWeight}% · {g.weightDone}% graded · {g.remaining}% still open
          {g.totalWeight > 0 && g.totalWeight !== 100 ? " · weights don't sum to 100 yet" : ""}
        </p>
        <label style={S.label}>Target grade (%)</label>
        <input
          style={S.inputSm}
          type="number"
          value={course.target}
          onChange={(e) => mutate((c) => ({ ...c, target: e.target.value }))}
        />
        {need === null ? (
          <p style={S.dim}>Add categories and weights to forecast.</p>
        ) : (
          <p>
            You need <b>{need.toFixed(1)}%</b> across the remaining {g.remaining}% to finish at{" "}
            {course.target}%.
            {need > 100 && <span style={S.late}> Out of reach — adjust the target.</span>}
            {need <= 0 && <span> Already secured.</span>}
          </p>
        )}
      </Section>

      <Section title="Categories">
        {(course.categories || []).map((cat) => {
          const pct = categoryPct(cat);
          return (
            <div key={cat.id} style={S.card}>
              <div style={S.row}>
                <b>{cat.name} ({cat.weight}%)</b>
                <span style={S.dim}>{pct === null ? "ungraded" : `${pct.toFixed(1)}%`}</span>
                <button style={S.btn} className="btn" onClick={() => addItem(cat.id)}>Add score</button>
                <button style={S.btn} className="btn" onClick={() => removeCat(cat.id)}>Delete</button>
              </div>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Item</th>
                    <th style={S.th}>Earned</th>
                    <th style={S.th}>Out of</th>
                    <th style={S.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {cat.items.map((i) => (
                    <tr key={i.id}>
                      <td style={S.td}>
                        <input
                          style={S.input}
                          placeholder="Exam 1"
                          value={i.label}
                          onChange={(e) => editItem(cat.id, i.id, "label", e.target.value)}
                        />
                      </td>
                      <td style={S.td}>
                        <input
                          style={S.inputSm}
                          type="number"
                          value={i.earned}
                          onChange={(e) => editItem(cat.id, i.id, "earned", e.target.value)}
                        />
                      </td>
                      <td style={S.td}>
                        <input
                          style={S.inputSm}
                          type="number"
                          value={i.possible}
                          onChange={(e) => editItem(cat.id, i.id, "possible", e.target.value)}
                        />
                      </td>
                      <td style={S.td}>
                        <button style={S.btn} className="btn" onClick={() => removeItem(cat.id, i.id)}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
        {(course.categories || []).length === 0 && (
          <p style={S.dim}>
            Copy the weight breakdown off the syllabus — e.g. Exams 40, Labs 25, Homework 20, Final 15.
          </p>
        )}
      </Section>

      <Section title="Add category">
        <input style={S.input} placeholder="Category" value={catName} onChange={(e) => setCatName(e.target.value)} />
        <input style={S.inputSm} type="number" placeholder="Weight %" value={catWeight} onChange={(e) => setCatWeight(e.target.value)} />
        <button style={S.btn} className="btn" onClick={addCat}>Add</button>
      </Section>
    </div>
  );
}

/* ============================================================
   GOALS
   ============================================================ */
function GoalsTab({ data, update }) {
  const [sub, setSub] = useState("active");
  return (
    <div>
      <nav style={S.subnav}>
        {[["active", "Active"], ["new", "New goal"], ["targets", "Course targets"], ["done", "Finished"]].map(
          ([k, l]) => (
            <button key={k} onClick={() => setSub(k)} className={sub === k ? "tab on" : "tab"}>
              {l}
            </button>
          )
        )}
      </nav>
      {sub === "active" && <GoalList data={data} update={update} done={false} />}
      {sub === "done" && <GoalList data={data} update={update} done={true} />}
      {sub === "new" && <NewGoal data={data} update={update} />}
      {sub === "targets" && <CourseTargets data={data} update={update} />}
    </div>
  );
}

function GoalList({ data, update, done, domain = "academic" }) {
  const list = data.goals.filter(
    (g) => !!g.done === done && (g.domain || "academic") === domain
  );
  if (!list.length)
    return (
      <Section title={done ? "Finished" : "Active goals"}>
        <p style={S.dim}>
          {done ? "Nothing finished yet." : "No active goals. Create one under New goal."}
        </p>
      </Section>
    );
  return (
    <div>
      {list.map((g) => (
        <GoalCard key={g.id} goal={g} data={data} update={update} />
      ))}
    </div>
  );
}

function GoalCard({ goal, data, update }) {
  const [amount, setAmount] = useState(1);
  const [note, setNote] = useState("");
  const [stepText, setStepText] = useState("");
  const [showLog, setShowLog] = useState(false);

  const p = goalProgress(goal, data);
  const pace = goalPace(goal, p);
  const code = data.courses.find((c) => c.id === goal.courseId)?.code;

  const mutate = (fn) =>
    update((d) => {
      d.goals = d.goals.map((g) => (g.id === goal.id ? fn({ ...g }) : g));
      return d;
    });

  const addLog = (n) => {
    if (!n) return;
    mutate((g) => ({
      ...g,
      log: [...(g.log || []), { id: uid(), date: todayISO(), amount: Number(n), note: note.trim() }],
    }));
    setNote("");
  };

  const removeLog = (id) =>
    mutate((g) => ({ ...g, log: g.log.filter((l) => l.id !== id) }));

  const toggleStep = (id) =>
    mutate((g) => ({
      ...g,
      steps: g.steps.map((s) => (s.id === id ? { ...s, done: !s.done } : s)),
    }));

  const addStep = () => {
    if (!stepText.trim()) return;
    mutate((g) => ({ ...g, steps: [...(g.steps || []), { id: uid(), text: stepText.trim(), done: false }] }));
    setStepText("");
  };

  const removeStep = (id) => mutate((g) => ({ ...g, steps: g.steps.filter((s) => s.id !== id) }));

  const remove = () =>
    update((d) => {
      d.goals = d.goals.filter((g) => g.id !== goal.id);
      return d;
    });

  const pct = p.target ? Math.min(100, (p.current / p.target) * 100) : 0;

  return (
    <Section title={goal.title}>
      <p style={S.dim}>
        {goal.type}
        {code ? ` · ${code}` : ""} · started {goal.start}
        {goal.deadline ? ` · due ${goal.deadline}` : ""}
      </p>

      <p style={{ fontSize: 18, margin: "4px 0" }}>
        {p.current} / {p.target} {p.unit}{" "}
        <span style={S.dim}>({Math.round(pct)}%)</span>
      </p>
      <Bar value={p.current} max={p.target} />

      {pace && (
        <p style={pace.overdue ? S.late : pace.onPace ? S.ok : S.late}>
          {pace.overdue
            ? `${Math.abs(pace.daysLeft)} days past deadline · ${pace.remaining} ${p.unit} short`
            : p.current >= p.target
            ? "Complete — mark it done"
            : `${pace.daysLeft} days left · ${pace.perWeek.toFixed(1)} ${p.unit}/week needed · ${
                pace.onPace ? "on pace" : "behind pace"
              }`}
        </p>
      )}

      {goal.type === "checklist" && (
        <div>
          <ul style={{ listStyle: "none", paddingLeft: 0 }}>
            {(goal.steps || []).map((s) => (
              <li key={s.id} style={S.row}>
                <input type="checkbox" checked={s.done} onChange={() => toggleStep(s.id)} />
                <span style={{ textDecoration: s.done ? "line-through" : "none" }}>{s.text}</span>
                <button style={S.btn} className="btn" onClick={() => removeStep(s.id)}>×</button>
              </li>
            ))}
          </ul>
          <input
            style={S.input}
            placeholder="Add a step"
            value={stepText}
            onChange={(e) => setStepText(e.target.value)}
          />
          <button style={S.btn} className="btn" onClick={addStep}>Add step</button>
        </div>
      )}

      {goal.type === "count" && (
        <div>
          <input style={S.inputSm} type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input
            style={S.input}
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button style={S.btn} className="btn" onClick={() => addLog(amount)}>Log progress</button>
          <button style={S.btn} className="btn" onClick={() => addLog(1)}>+1</button>
          <button style={S.btn} className="btn" onClick={() => setShowLog(!showLog)}>
            {showLog ? "Hide" : "Show"} log ({(goal.log || []).length})
          </button>
          {showLog && (
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Date</th>
                  <th style={S.th}>Amount</th>
                  <th style={S.th}>Note</th>
                  <th style={S.th}></th>
                </tr>
              </thead>
              <tbody>
                {[...(goal.log || [])].reverse().map((l) => (
                  <tr key={l.id}>
                    <td style={S.td}>{l.date}</td>
                    <td style={S.td}>{l.amount}</td>
                    <td style={S.td}>{l.note}</td>
                    <td style={S.td}>
                      <button style={S.btn} className="btn" onClick={() => removeLog(l.id)}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {goal.type === "hours" && (
        <p style={S.dim}>
          Counts automatically from study sessions{code ? ` logged to ${code}` : " across all courses"}{" "}
          since {goal.start}.
        </p>
      )}

      <div style={{ marginTop: 8 }}>
        <button style={S.btn} className="btn" onClick={() => mutate((g) => ({ ...g, done: !g.done }))}>
          {goal.done ? "Reopen" : "Mark done"}
        </button>
        <button style={S.btn} className="btn" onClick={remove}>Delete goal</button>
      </div>
    </Section>
  );
}

function NewGoal({ data, update, domain = "academic" }) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState(domain === "personal" ? "miles" : "count");
  const [target, setTarget] = useState(domain === "personal" ? 100 : 10);
  const [unit, setUnit] = useState("");
  const [courseId, setCourseId] = useState("");
  const [deadline, setDeadline] = useState("");
  const [msg, setMsg] = useState("");

  const add = () => {
    if (!title.trim()) return;
    update((d) => {
      d.goals = [
        ...d.goals,
        {
          id: uid(),
          title: title.trim(),
          type,
          domain,
          courseId: domain === "personal" ? "" : courseId,
          target: type === "checklist" ? 0 : Number(target),
          unit:
            type === "hours"
              ? "hrs"
              : type === "miles"
              ? "mi"
              : type === "gymdays"
              ? "days"
              : unit.trim(),
          deadline,
          start: todayISO(),
          steps: [],
          log: [],
          done: false,
        },
      ];
      return d;
    });
    setTitle("");
    setMsg("Goal created — find it under Active.");
  };

  return (
    <Section title="New goal">
      <label style={S.label}>What are you going for</label>
      <input
        style={S.input}
        placeholder={
          domain === "personal"
            ? "Run 150 miles this semester"
            : "Pass the private pilot written"
        }
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />

      <label style={S.label}>How it's measured</label>
      <select style={S.input} value={type} onChange={(e) => setType(e.target.value)}>
        {domain === "personal" && (
          <>
            <option value="miles">Miles ran — adds up the miles in your gym log</option>
            <option value="gymdays">Gym days — counts the days you showed up</option>
          </>
        )}
        <option value="count">Count — you log progress as you go</option>
        <option value="checklist">Checklist — a list of steps to tick off</option>
        {domain === "academic" && (
          <option value="hours">Hours — counts your logged study sessions automatically</option>
        )}
      </select>

      {type !== "checklist" && (
        <>
          <label style={S.label}>Target</label>
          <input style={S.inputSm} type="number" value={target} onChange={(e) => setTarget(e.target.value)} />
          {type === "count" && (
            <input
              style={S.inputSm}
              placeholder="unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            />
          )}
        </>
      )}

      {domain === "academic" && (
        <>
          <label style={S.label}>Course (optional)</label>
          <select style={S.input} value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            <option value="">no course</option>
            {live(data).map((c) => (
              <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
            ))}
          </select>
        </>
      )}

      <label style={S.label}>Deadline (optional — turns on pace tracking)</label>
      <input style={S.input} type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />

      <br />
      <button style={S.btn} className="btn" onClick={add}>Create goal</button>
      {msg && <span style={S.dim}>{msg}</span>}

      <p style={{ ...S.dim, marginTop: 10 }}>
        {domain === "personal"
          ? "Miles and gym days both fill in from the gym log — log a workout and the goal moves on its own. Count and checklist are there for anything else."
          : "Checklist fits a written-test syllabus or a checkride prep list. Count fits practice problems, chapters, or mock exams. Hours needs nothing from you beyond logging sessions."}
      </p>
    </Section>
  );
}

function CourseTargets({ data, update }) {
  const setField = (id, field, value) =>
    update((d) => {
      d.courses = d.courses.map((c) => (c.id === id ? { ...c, [field]: value } : c));
      return d;
    });

  return (
    <Section title="Course targets">
      <p style={S.dim}>Drives the grade forecast, the weekly bars, and study ranking.</p>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Course</th>
            <th style={S.th}>Tier</th>
            <th style={S.th}>Target %</th>
            <th style={S.th}>Weekly min</th>
          </tr>
        </thead>
        <tbody>
          {live(data).map((c) => (
            <tr key={c.id}>
              <td style={S.td}>{c.code} — {c.name}</td>
              <td style={S.td}>
                <select
                  style={S.inputSm}
                  value={c.tier}
                  onChange={(e) => setField(c.id, "tier", e.target.value)}
                >
                  <option value="core">aviation</option>
                  <option value="support">non-aviation</option>
                </select>
              </td>
              <td style={S.td}>
                <input
                  style={S.inputSm}
                  type="number"
                  value={c.target}
                  onChange={(e) => setField(c.id, "target", e.target.value)}
                />
              </td>
              <td style={S.td}>
                <input
                  style={S.inputSm}
                  type="number"
                  value={c.weeklyMinutes}
                  onChange={(e) => setField(c.id, "weeklyMinutes", e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={S.dim}>
        Aviation courses count {TIER_WEIGHT.core}× toward what the Home page tells you to study next.
      </p>
    </Section>
  );
}

/* ============================================================
   PERSONAL — gym log, records, life goals
   ============================================================ */
function PersonalTab({ data, update }) {
  const [sub, setSub] = useState("gym");
  return (
    <div>
      <nav style={S.subnav}>
        {[
          ["gym", "Gym"],
          ["lifts", "Records"],
          ["goals", "Personal goals"],
          ["newgoal", "New goal"],
        ].map(([k, l]) => (
          <button key={k} onClick={() => setSub(k)} className={sub === k ? "tab on" : "tab"}>
            {l}
          </button>
        ))}
      </nav>
      {sub === "gym" && <Gym data={data} update={update} />}
      {sub === "lifts" && <Lifts data={data} update={update} />}
      {sub === "goals" && (
        <div>
          <GoalList data={data} update={update} done={false} domain="personal" />
          <GoalList data={data} update={update} done={true} domain="personal" />
        </div>
      )}
      {sub === "newgoal" && <NewGoal data={data} update={update} domain="personal" />}
    </div>
  );
}

const WORKOUT_TYPES = ["push", "pull", "legs", "upper", "lower", "full body", "run", "cardio", "other"];

function Gym({ data, update }) {
  const p = data.personal;
  const [date, setDate] = useState(todayISO());
  const [type, setType] = useState("push");
  const [minutes, setMinutes] = useState(60);
  const [miles, setMiles] = useState("");
  const [notes, setNotes] = useState("");
  const [range, setRange] = useState("8");

  const setPersonal = (fn) =>
    update((d) => {
      d.personal = fn({ ...d.personal });
      return d;
    });

  const add = () => {
    setPersonal((pp) => ({
      ...pp,
      workouts: [
        ...pp.workouts,
        {
          id: uid(),
          date,
          type,
          minutes: Number(minutes) || 0,
          miles: Number(miles) || 0,
          notes: notes.trim(),
        },
      ],
    }));
    setNotes("");
    setMiles("");
    setDate(todayISO());
  };

  const remove = (id) =>
    setPersonal((pp) => ({ ...pp, workouts: pp.workouts.filter((w) => w.id !== id) }));

  const target = Number(p.gymTarget) || 0;
  const milesTarget = Number(p.milesTarget) || 0;
  const ws = weekStart();
  const thisWeek = p.workouts.filter((w) => w.date >= ws);
  const streak = weeklyStreak(p.workouts, target);
  const mStreak = milesStreak(p.workouts, milesTarget);

  const everyWeek = allWeekBuckets(p.workouts);
  const shown =
    range === "all" || range === "month"
      ? everyWeek
      : everyWeek.slice(Math.max(0, everyWeek.length - Number(range)));
  const months = monthBuckets(p.workouts, target, milesTarget);
  const rangeDays = shown.reduce((s, b) => s + b.days, 0);
  const rangeMiles = Math.round(shown.reduce((s, b) => s + b.miles, 0) * 10) / 10;
  const rangeMinutes = shown.reduce((s, b) => s + b.minutes, 0);
  const gap = daysSinceLastWorkout(p.workouts);
  const month = p.workouts.filter((w) => w.date >= addDays(todayISO(), -30));

  return (
    <div>
      <Section title="This week">
        <p style={{ fontSize: 20, margin: "4px 0" }}>
          {gymDays(thisWeek)} / {target} gym days
        </p>
        <Bar value={gymDays(thisWeek)} max={target} />
        <p style={gymDays(thisWeek) >= target ? S.ok : S.dim}>
          {gymDays(thisWeek) >= target
            ? "Gym target met."
            : `${target - gymDays(thisWeek)} more day${target - gymDays(thisWeek) === 1 ? "" : "s"} to hit the week.`}
        </p>

        <p style={{ fontSize: 20, margin: "10px 0 4px" }}>
          {sumMiles(thisWeek)} / {milesTarget} miles
        </p>
        <Bar value={sumMiles(thisWeek)} max={milesTarget} />
        <p style={sumMiles(thisWeek) >= milesTarget ? S.ok : S.dim}>
          {sumMiles(thisWeek) >= milesTarget
            ? "Mileage target met."
            : `${Math.round((milesTarget - sumMiles(thisWeek)) * 10) / 10} mi to go.`}
        </p>

        <p>
          Streaks: <b>{streak}</b> week{streak === 1 ? "" : "s"} at the gym target ·{" "}
          <b>{mStreak}</b> week{mStreak === 1 ? "" : "s"} at the mileage target
        </p>
        <p style={S.dim}>
          {gap === null
            ? "no workouts logged"
            : gap === 0
            ? "trained today"
            : `${gap} day${gap === 1 ? "" : "s"} since last session`}
        </p>
        <p style={S.dim}>
          Last 30 days: {gymDays(month)} gym days · {sumMiles(month)} mi ·{" "}
          {(month.reduce((s, w) => s + Number(w.minutes || 0), 0) / 60).toFixed(1)} hrs
        </p>
        <p style={S.dim}>
          All time: {gymDays(p.workouts)} gym days · {sumMiles(p.workouts)} mi
        </p>

        <label style={S.label}>Gym days per week target</label>
        <input
          style={S.inputSm}
          type="number"
          value={p.gymTarget}
          onChange={(e) => setPersonal((pp) => ({ ...pp, gymTarget: e.target.value }))}
        />
        <label style={S.label}>Miles per week target</label>
        <input
          style={S.inputSm}
          type="number"
          step="0.1"
          value={p.milesTarget}
          onChange={(e) => setPersonal((pp) => ({ ...pp, milesTarget: e.target.value }))}
        />
      </Section>

      <Section title="History">
        <div style={S.row}>
          <select style={S.input} value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="8">Last 8 weeks</option>
            <option value="26">Last 26 weeks</option>
            <option value="all">All time — every week</option>
            <option value="month">All time — by month</option>
          </select>
        </div>

        {p.workouts.length === 0 ? (
          <p style={S.dim}>Nothing logged yet.</p>
        ) : range === "month" ? (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Month</th>
                <th style={S.th}>Gym days</th>
                <th style={S.th}>Miles</th>
                <th style={S.th}>Hours</th>
                <th style={S.th}>Weeks at gym target</th>
                <th style={S.th}>Weeks at miles target</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.key}>
                  <td style={S.td}>{monthLabel(m.key)}</td>
                  <td style={S.td}>{m.days}</td>
                  <td style={S.td}>{m.miles || "—"}</td>
                  <td style={S.td}>{(m.minutes / 60).toFixed(1)}</td>
                  <td style={S.td}>
                    {m.weeksHitGym}/{m.weekCount}
                  </td>
                  <td style={S.td}>
                    {m.weeksHitMiles}/{m.weekCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <>
            <p style={S.dim}>
              {shown.length} week{shown.length === 1 ? "" : "s"} · {rangeDays} gym days ·{" "}
              {rangeMiles} mi · {(rangeMinutes / 60).toFixed(1)} hrs · hit the gym target{" "}
              {shown.filter((b) => b.days >= target).length} time
              {shown.filter((b) => b.days >= target).length === 1 ? "" : "s"}, the mileage target{" "}
              {shown.filter((b) => b.miles >= milesTarget).length}
            </p>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Week of</th>
                  <th style={S.th}>Gym days</th>
                  <th style={S.th}>Miles</th>
                  <th style={S.th}>Minutes</th>
                  <th style={S.th}>Gym target</th>
                  <th style={S.th}>Miles target</th>
                </tr>
              </thead>
              <tbody>
                {[...shown].reverse().map((b) => (
                  <tr key={b.from}>
                    <td style={S.td}>{b.from}</td>
                    <td style={S.td}>
                      {"■".repeat(b.days) || "—"} {b.days}
                    </td>
                    <td style={S.td}>{b.miles || "—"}</td>
                    <td style={S.td}>{b.minutes}</td>
                    <td style={{ ...S.td, color: b.days >= target ? "#7C8471" : "#B4674A" }}>
                      {b.days >= target ? "yes" : "no"}
                    </td>
                    <td style={{ ...S.td, color: b.miles >= milesTarget ? "#7C8471" : "#B4674A" }}>
                      {b.miles >= milesTarget ? "yes" : "no"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Section>

      <Section title="Log a workout">
        <label style={S.label}>Date</label>
        <input style={S.input} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <label style={S.label}>Type</label>
        <select style={S.input} value={type} onChange={(e) => setType(e.target.value)}>
          {WORKOUT_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <label style={S.label}>Minutes</label>
        <input style={S.inputSm} type="number" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        <label style={S.label}>Miles (leave blank if you didn't run)</label>
        <input
          style={S.inputSm}
          type="number"
          step="0.1"
          placeholder="0"
          value={miles}
          onChange={(e) => setMiles(e.target.value)}
        />
        <label style={S.label}>Notes</label>
        <input
          style={S.input}
          placeholder="What you hit, how it felt"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <br />
        <button style={S.btn} className="btn" onClick={add}>Log workout</button>
      </Section>

      <Section title={`Every session (${p.workouts.length})`}>
        {p.workouts.length === 0 ? (
          <p style={S.dim}>Nothing logged yet.</p>
        ) : (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Date</th>
                <th style={S.th}>Type</th>
                <th style={S.th}>Min</th>
                <th style={S.th}>Miles</th>
                <th style={S.th}>Notes</th>
                <th style={S.th}></th>
              </tr>
            </thead>
            <tbody>
              {[...p.workouts]
                .sort((a, b) => b.date.localeCompare(a.date))
                .slice(0, 60)
                .map((w) => (
                  <tr key={w.id}>
                    <td style={S.td}>{w.date}</td>
                    <td style={S.td}>{w.type}</td>
                    <td style={S.td}>{w.minutes}</td>
                    <td style={S.td}>{w.miles || "—"}</td>
                    <td style={S.td}>{w.notes}</td>
                    <td style={S.td}>
                      <button style={S.btn} className="btn" onClick={() => remove(w.id)}>×</button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function Lifts({ data, update }) {
  const p = data.personal;
  const [name, setName] = useState("");
  const [liftId, setLiftId] = useState("");
  const [weight, setWeight] = useState("");
  const [reps, setReps] = useState(5);
  const [date, setDate] = useState(todayISO());

  const setPersonal = (fn) =>
    update((d) => {
      d.personal = fn({ ...d.personal });
      return d;
    });

  const addLift = () => {
    if (!name.trim()) return;
    setPersonal((pp) => ({
      ...pp,
      lifts: [...pp.lifts, { id: uid(), name: name.trim(), entries: [] }],
    }));
    setName("");
  };

  const addEntry = () => {
    if (!liftId || !weight) return;
    setPersonal((pp) => ({
      ...pp,
      lifts: pp.lifts.map((l) =>
        l.id === liftId
          ? {
              ...l,
              entries: [
                ...l.entries,
                { id: uid(), date, weight: Number(weight), reps: Number(reps) || 1 },
              ],
            }
          : l
      ),
    }));
    setWeight("");
  };

  const removeEntry = (liftIdX, entryId) =>
    setPersonal((pp) => ({
      ...pp,
      lifts: pp.lifts.map((l) =>
        l.id === liftIdX ? { ...l, entries: l.entries.filter((e) => e.id !== entryId) } : l
      ),
    }));

  const removeLift = (id) =>
    setPersonal((pp) => ({ ...pp, lifts: pp.lifts.filter((l) => l.id !== id) }));

  return (
    <div>
      <Section title="Records">
        {p.lifts.length === 0 ? (
          <p style={S.dim}>No lifts tracked yet. Add one below.</p>
        ) : (
          p.lifts.map((l) => {
            const sorted = [...l.entries].sort((a, b) => b.date.localeCompare(a.date));
            const best = l.entries.reduce(
              (b, e) => (oneRepMax(e.weight, e.reps) > (b ? oneRepMax(b.weight, b.reps) : 0) ? e : b),
              null
            );
            const heaviest = l.entries.reduce(
              (b, e) => (Number(e.weight) > (b ? Number(b.weight) : 0) ? e : b),
              null
            );
            const first = [...l.entries].sort((a, b) => a.date.localeCompare(b.date))[0];
            const gained =
              best && first ? oneRepMax(best.weight, best.reps) - oneRepMax(first.weight, first.reps) : 0;

            return (
              <div key={l.id} style={S.card}>
                <div style={S.row}>
                  <b>{l.name}</b>
                  <span style={S.dim}>
                    {heaviest ? `heaviest ${heaviest.weight} × ${heaviest.reps}` : "no entries"}
                    {best ? ` · est. 1RM ${oneRepMax(best.weight, best.reps)}` : ""}
                    {gained > 0 ? ` · +${gained} since ${first.date}` : ""}
                  </span>
                  <button style={S.btn} className="btn" onClick={() => removeLift(l.id)}>Delete lift</button>
                </div>
                {sorted.length > 0 && (
                  <table style={S.table}>
                    <thead>
                      <tr>
                        <th style={S.th}>Date</th>
                        <th style={S.th}>Weight</th>
                        <th style={S.th}>Reps</th>
                        <th style={S.th}>Est. 1RM</th>
                        <th style={S.th}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.slice(0, 12).map((e) => (
                        <tr key={e.id}>
                          <td style={S.td}>{e.date}</td>
                          <td style={S.td}>{e.weight}</td>
                          <td style={S.td}>{e.reps}</td>
                          <td style={S.td}>{oneRepMax(e.weight, e.reps)}</td>
                          <td style={S.td}>
                            <button style={S.btn} className="btn" onClick={() => removeEntry(l.id, e.id)}>×</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })
        )}
      </Section>

      <Section title="Log a set">
        <select style={S.input} value={liftId} onChange={(e) => setLiftId(e.target.value)}>
          <option value="">pick a lift</option>
          {p.lifts.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <input style={S.inputSm} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input
          style={S.inputSm}
          type="number"
          placeholder="weight"
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
        />
        <input
          style={S.inputSm}
          type="number"
          placeholder="reps"
          value={reps}
          onChange={(e) => setReps(e.target.value)}
        />
        <button style={S.btn} className="btn" onClick={addEntry}>Log</button>
        <p style={S.dim}>Estimated 1RM uses the Epley formula — a rough number for comparison, not a target to attempt.</p>
      </Section>

      <Section title="Add a lift">
        <input
          style={S.input}
          placeholder="Bench press"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button style={S.btn} className="btn" onClick={addLift}>Add lift</button>
      </Section>
    </div>
  );
}

/* ============================================================
   COURSES
   ============================================================ */
function CourseList({ data, update, open }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [tier, setTier] = useState("core");
  const [term, setTerm] = useState("");
  const [newTerm, setNewTerm] = useState("");
  const [bulk, setBulk] = useState("");
  const [msg, setMsg] = useState("");

  const add = () => {
    if (!name.trim()) return;
    update((d) => {
      d.courses = [
        ...d.courses,
        newCourse(code.trim() || name.trim().slice(0, 4).toUpperCase(), name.trim(), tier, term.trim()),
      ];
      return d;
    });
    setName("");
    setCode("");
  };

  const addBulk = () => {
    const rows = bulk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [c, n, t] = l.split("|").map((x) => (x || "").trim());
        if (!c) return null;
        return newCourse(c, n || c, /core/i.test(t || "") ? "core" : t ? "support" : "core", term.trim());
      })
      .filter(Boolean);
    if (!rows.length) return;
    update((d) => {
      d.courses = [...d.courses, ...rows];
      return d;
    });
    setBulk("");
    setMsg(`Added ${rows.length} courses.`);
  };

  const setArchived = (id, value) =>
    update((d) => {
      d.courses = d.courses.map((c) => (c.id === id ? { ...c, archived: value } : c));
      return d;
    });

  const archiveAll = () => {
    const liveCount = live(data).length;
    if (!liveCount) return;
    if (
      !confirm(
        `Archive all ${liveCount} current courses${
          newTerm.trim() ? ` as "${newTerm.trim()}"` : ""
        }? Their grades, notes and cards are kept — they just move out of the active view.`
      )
    )
      return;
    update((d) => {
      d.courses = d.courses.map((c) =>
        c.archived ? c : { ...c, archived: true, term: c.term || newTerm.trim() }
      );
      return d;
    });
    setMsg("Semester archived. Add this term's courses below.");
  };

  const past = archived(data);
  const pastGraded = past.map((c) => courseGrade(c).current).filter((x) => x !== null);
  const allGraded = data.courses.map((c) => courseGrade(c).current).filter((x) => x !== null);
  const gpaOf = (list) =>
    list.length ? (list.reduce((s, p) => s + GPA_PTS[letterFor(p)], 0) / list.length).toFixed(2) : "—";

  return (
    <div>
      {["core", "support"].map((t) => (
        <Section key={t} title={`${TIER_LABEL[t]} — this semester`}>
          <ul style={S.list}>
            {live(data)
              .filter((c) => (c.tier || "support") === t)
              .map((c) => {
                const notes = data.notes.filter((n) => n.courseId === c.id).length;
                const cards = data.cards.filter((n) => n.courseId === c.id).length;
                const g = courseGrade(c);
                return (
                  <li key={c.id} style={S.row}>
                    <button style={S.link} className="link" onClick={() => open(c.id)}>
                      {c.code} — {c.name}
                    </button>
                    <span style={S.dim}>
                      {g.current === null ? "no grades" : `${g.current.toFixed(1)}%`} · {notes} note
                      {notes === 1 ? "" : "s"} · {cards} card{cards === 1 ? "" : "s"}
                    </span>
                    <button style={S.btn} className="btn" onClick={() => setArchived(c.id, true)}>
                      Archive
                    </button>
                  </li>
                );
              })}
          </ul>
          {live(data).filter((c) => (c.tier || "support") === t).length === 0 && (
            <p style={S.dim}>Nothing here this semester.</p>
          )}
        </Section>
      ))}

      <Section title="Add a course">
        <input style={S.input} placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} />
        <input style={S.input} placeholder="Course name" value={name} onChange={(e) => setName(e.target.value)} />
        <select style={S.inputSm} value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="core">aviation</option>
          <option value="support">non-aviation</option>
        </select>
        <input
          style={S.inputSm}
          placeholder="term"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <button style={S.btn} className="btn" onClick={add}>Add course</button>

        <p style={{ ...S.dim, marginTop: 10 }}>
          Adding a full schedule at once — one per line, <code>CODE | Name | core</code>:
        </p>
        <textarea
          style={S.textarea}
          rows={5}
          placeholder={"AVS 2100 | Aviation Weather | core\nMATH 1710 | Calculus I | support"}
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
        />
        <button style={S.btn} className="btn" onClick={addBulk}>Add batch</button>
        {msg && <span style={S.dim}>{msg}</span>}
      </Section>

      <Section title="Start a new semester">
        <p style={S.dim}>
          Archives everything currently active in one move. Grades, notes and flashcards stay
          attached to the archived course — you can still study old cards and look up what you
          wrote. Then add the new term's courses above.
        </p>
        <input
          style={S.input}
          placeholder="Label the semester you're closing out (Fall 2026)"
          value={newTerm}
          onChange={(e) => setNewTerm(e.target.value)}
        />
        <button style={S.btn} className="btn" onClick={archiveAll} disabled={!live(data).length}>
          Archive all {live(data).length} active courses
        </button>
      </Section>

      <Section title={`Past semesters (${past.length})`}>
        {past.length === 0 ? (
          <p style={S.dim}>Nothing archived yet.</p>
        ) : (
          <>
            <p>
              Cumulative GPA: <b>{gpaOf(allGraded)}</b>{" "}
              <span style={S.dim}>· archived only {gpaOf(pastGraded)}</span>
            </p>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Term</th>
                  <th style={S.th}>Course</th>
                  <th style={S.th}>Final</th>
                  <th style={S.th}>Letter</th>
                  <th style={S.th}></th>
                </tr>
              </thead>
              <tbody>
                {[...past]
                  .sort((a, b) => (b.term || "").localeCompare(a.term || ""))
                  .map((c) => {
                    const g = courseGrade(c);
                    return (
                      <tr key={c.id}>
                        <td style={S.td}>{c.term || <span style={S.dim}>untagged</span>}</td>
                        <td style={S.td}>
                          <button style={S.link} className="link" onClick={() => open(c.id)}>
                            {c.code} — {c.name}
                          </button>
                        </td>
                        <td style={S.td}>
                          {g.current === null ? "—" : `${g.current.toFixed(1)}%`}
                        </td>
                        <td style={S.td}>{letterFor(g.current)}</td>
                        <td style={S.td}>
                          <button style={S.btn} className="btn" onClick={() => setArchived(c.id, false)}>
                            Restore
                          </button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </>
        )}
      </Section>
    </div>
  );
}

function CourseDetail({ data, update, courseId, back }) {
  const course = data.courses.find((c) => c.id === courseId);
  const [sub, setSub] = useState("notes");
  if (!course) return <p>Course not found.</p>;

  const setField = (field, value) =>
    update((d) => {
      d.courses = d.courses.map((c) => (c.id === courseId ? { ...c, [field]: value } : c));
      return d;
    });

  return (
    <div>
      <button style={S.btn} className="btn" onClick={back}>← All courses</button>
      <h2 style={S.h2}>
        {course.code} — {course.name}{" "}
        <span style={S.dim}>
          {course.tier === "core" ? "aviation" : "non-aviation"}
          {course.archived ? ` · archived${course.term ? ` (${course.term})` : ""}` : ""}
        </span>
      </h2>
      <button
        style={S.btn} className="btn"
        onClick={() => setField("archived", !course.archived)}
      >
        {course.archived ? "Restore to current semester" : "Archive this course"}
      </button>
      <nav style={S.subnav}>
        {[["notes", "Notes"], ["reference", "Reference"], ["search", "Search all notes"]].map(([k, l]) => (
          <button key={k} onClick={() => setSub(k)} className={sub === k ? "tab on" : "tab"}>
            {l}
          </button>
        ))}
      </nav>

      {sub === "reference" && (
        <Section title="Course reference">
          {[
            ["term", "Term"],
            ["instructor", "Instructor"],
            ["email", "Email"],
            ["office", "Office"],
            ["hours", "Office hours"],
            ["room", "Room"],
            ["textbook", "Textbook"],
            ["syllabusUrl", "Syllabus link"],
          ].map(([f, label]) => (
            <div key={f} style={S.field}>
              <label style={S.label}>{label}</label>
              <input style={S.input} value={course[f] || ""} onChange={(e) => setField(f, e.target.value)} />
            </div>
          ))}
          {course.syllabusUrl && (
            <p>
              <a href={course.syllabusUrl} target="_blank" rel="noreferrer">Open syllabus</a>
            </p>
          )}
        </Section>
      )}

      {sub === "notes" && <CourseNotes data={data} update={update} courseId={courseId} />}
      {sub === "search" && <AllNotes data={data} />}
    </div>
  );
}

function CourseNotes({ data, update, courseId }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const notes = data.notes
    .filter((n) => n.courseId === courseId)
    .sort((a, b) => (a.pinned === b.pinned ? b.date.localeCompare(a.date) : a.pinned ? -1 : 1));

  const add = () => {
    if (!title.trim() && !body.trim()) return;
    update((d) => {
      d.notes = [
        { id: uid(), courseId, title: title.trim() || "Untitled", body, date: todayISO(), pinned: false },
        ...d.notes,
      ];
      return d;
    });
    setTitle("");
    setBody("");
  };

  const edit = (id, field, value) =>
    update((d) => {
      d.notes = d.notes.map((n) => (n.id === id ? { ...n, [field]: value } : n));
      return d;
    });

  const remove = (id) =>
    update((d) => {
      d.notes = d.notes.filter((n) => n.id !== id);
      return d;
    });

  const toCard = (n) =>
    update((d) => {
      d.cards = [
        ...d.cards,
        {
          id: uid(),
          courseId,
          topic: "",
          front: n.title,
          back: n.body,
          frontImg: "",
          backImg: "",
          box: 1,
          due: todayISO(),
          lastReviewed: null,
          seen: 0,
          missed: 0,
        },
      ];
      return d;
    });

  return (
    <div>
      <Section title="New note">
        <input style={S.input} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea style={S.textarea} rows={5} placeholder="Body" value={body} onChange={(e) => setBody(e.target.value)} />
        <button style={S.btn} className="btn" onClick={add}>Save note</button>
      </Section>

      <Section title={`Notes (${notes.length})`}>
        {notes.length === 0 ? (
          <p style={S.dim}>No notes for this course yet.</p>
        ) : (
          notes.map((n) => (
            <div key={n.id} style={S.card}>
              <div style={S.row}>
                <input
                  style={{ ...S.input, fontWeight: 600 }}
                  value={n.title}
                  onChange={(e) => edit(n.id, "title", e.target.value)}
                />
                <span style={S.dim}>{n.date}</span>
                <button style={S.btn} className="btn" onClick={() => edit(n.id, "pinned", !n.pinned)}>
                  {n.pinned ? "Unpin" : "Pin"}
                </button>
                <button style={S.btn} className="btn" onClick={() => toCard(n)}>Make flashcard</button>
                <button style={S.btn} className="btn" onClick={() => remove(n.id)}>Delete</button>
              </div>
              <textarea
                style={S.textarea}
                rows={6}
                value={n.body}
                onChange={(e) => edit(n.id, "body", e.target.value)}
              />
            </div>
          ))
        )}
      </Section>
    </div>
  );
}

function AllNotes({ data }) {
  const [q, setQ] = useState("");
  const hits = data.notes.filter(
    (n) => !q || `${n.title} ${n.body}`.toLowerCase().includes(q.toLowerCase())
  );
  const codeOf = (id) => data.courses.find((c) => c.id === id)?.code || "—";

  return (
    <Section title="Search every course">
      <input style={S.input} placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} />
      <p style={S.dim}>{hits.length} of {data.notes.length} notes</p>
      {hits.map((n) => (
        <div key={n.id} style={S.card}>
          <div>
            <b>{codeOf(n.courseId)}</b> — {n.title} <span style={S.dim}>{n.date}</span>
          </div>
          <pre style={S.pre}>{n.body}</pre>
        </div>
      ))}
    </Section>
  );
}

/* ============================================================
   DATA
   ============================================================ */
function DataTab({ data, setData }) {
  const [paste, setPaste] = useState("");
  const [msg, setMsg] = useState("");

  return (
    <div>
      <Section title="Export">
        {(() => {
          const json = JSON.stringify(data);
          const kb = Math.round(json.length / 1024);
          const imgs = data.cards.filter((c) => c.frontImg || c.backImg).length;
          return (
            <p style={kb > 3500 ? S.late : S.dim}>
              Stored size: {kb} KB of roughly 5,000 KB · {imgs} card
              {imgs === 1 ? "" : "s"} with images.
              {kb > 3500 && " Getting close to the cap — delete some image cards."}
            </p>
          );
        })()}
        <textarea style={S.textarea} rows={10} readOnly value={JSON.stringify(data, null, 2)} />
      </Section>
      <Section title="Import">
        <p style={S.dim}>Replaces everything currently stored.</p>
        <textarea style={S.textarea} rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} />
        <button
          style={S.btn} className="btn"
          onClick={() => {
            try {
              const parsed = JSON.parse(paste);
              if (!parsed.courses) throw new Error("no courses key");
              setData(migrate(parsed));
              setMsg("Imported.");
            } catch (e) {
              setMsg(`Import failed: ${e.message}`);
            }
          }}
        >
          Import
        </button>
        {msg && <p>{msg}</p>}
      </Section>
      <Section title="Reset">
        <button
          style={S.btn} className="btn"
          onClick={() => {
            if (confirm("Erase everything in FlightPlan and start over?")) setData(blank());
          }}
        >
          Erase all data
        </button>
      </Section>
    </div>
  );
}

/* ---------- shared ---------- */
function Section({ title, children }) {
  return (
    <section style={S.section} className="panel">
      <h3 style={S.h3}>{title}</h3>
      {children}
    </section>
  );
}

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

  * { box-sizing: border-box; }

  .hub {
    --ground: #0D1411;
    --surface: #141E19;
    --raised: #1B2822;
    --line: #26362E;
    --edge: #33473C;
    --green: #3E8E63;
    --green-deep: #1F5138;
    --green-bright: #6FBF8F;
    --bone: #E8EFE9;
    --muted: #8FA396;
    --faint: #6B7F73;
    --alert: #C4705A;
  }

  .hub ::selection { background: var(--green); color: #0D1411; }

  /* green light pooling behind the hero, the way the reference glows */
  .hub::before {
    content: "";
    position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background:
      radial-gradient(900px 520px at 78% -6%, rgba(62,142,99,.20), transparent 62%),
      radial-gradient(620px 420px at 6% 4%, rgba(31,81,56,.22), transparent 60%);
  }
  .hub > * { position: relative; z-index: 1; }

  .hub button:focus-visible, .hub input:focus-visible,
  .hub textarea:focus-visible, .hub select:focus-visible {
    outline: 2px solid var(--green-bright); outline-offset: 2px;
  }
  .hub button[disabled] { opacity: .35; cursor: default; }

  .hub input, .hub textarea, .hub select {
    background: var(--raised);
    color: var(--bone);
    border: 1px solid var(--line);
    border-radius: 10px;
    font-family: 'Inter', system-ui, sans-serif;
  }
  .hub input::placeholder, .hub textarea::placeholder { color: var(--faint); }
  .hub input[type="date"] { color-scheme: dark; }
  .hub input[type="checkbox"] { accent-color: var(--green); }

  /* sticky product bar */
  .hub .bar {
    display: flex; align-items: center; gap: 18px;
    padding: 14px 0;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--line);
  }

  .hub .mark {
    display: inline-flex; align-items: center; justify-content: center;
    width: 34px; height: 34px; flex: none;
    border-radius: 10px;
    border: 1px solid var(--edge);
    background: linear-gradient(150deg, var(--green-deep), transparent);
    color: var(--green-bright);
    font-family: 'JetBrains Mono', monospace; font-size: 14px;
  }

  .hub .tab {
    background: none; border: none;
    color: var(--muted);
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 14px; font-weight: 500;
    padding: 7px 11px; border-radius: 8px;
    cursor: pointer;
    transition: color .15s ease, background .15s ease;
  }
  .hub .tab:hover { color: var(--bone); background: rgba(62,142,99,.10); }
  .hub .tab.on { color: var(--green-bright); background: rgba(62,142,99,.14); }

  /* buttons: filled primary pill + outlined secondary, per the reference */
  .hub .btn {
    border-radius: 999px;
    transition: border-color .15s ease, color .15s ease, background .15s ease, transform .1s ease;
  }
  .hub .btn:hover:not([disabled]) { border-color: var(--green); color: var(--green-bright); }
  .hub .btn:active:not([disabled]) { transform: translateY(1px); }

  .hub .cta {
    border: none;
    background: linear-gradient(135deg, var(--green), var(--green-deep));
    color: #0D1411;
    font-weight: 600;
    box-shadow: 0 6px 20px rgba(62,142,99,.28);
  }
  .hub .cta:hover:not([disabled]) { color: #0D1411; filter: brightness(1.1); }

  .hub .link { transition: color .15s ease; }
  .hub .link:hover { color: var(--green-bright); }

  /* hero */
  .hub .hero-h {
    font-weight: 800;
    font-size: clamp(38px, 7.4vw, 66px);
    line-height: 1.02;
    letter-spacing: -.03em;
    margin: 0;
  }
  .hub .hero-h em {
    font-style: normal;
    background: linear-gradient(100deg, var(--green-bright), var(--green));
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent; color: transparent;
  }
  .hub .hero { animation: rise .6s cubic-bezier(.22,.61,.36,1) both; }
  .hub .hero-2 { animation: rise .6s .1s cubic-bezier(.22,.61,.36,1) both; }
  .hub .hero-3 { animation: rise .6s .2s cubic-bezier(.22,.61,.36,1) both; }
  @keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }

  /* stat tiles */
  .hub .tiles {
    display: grid; gap: 10px; margin-top: 26px;
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
  .hub .tile {
    border: 1px solid var(--line);
    border-radius: 14px;
    background: linear-gradient(160deg, rgba(62,142,99,.07), transparent 60%), var(--surface);
    padding: 13px 13px 14px;
    min-width: 0;
    transition: border-color .18s ease, transform .18s ease;
  }
  .hub .tile p { overflow-wrap: anywhere; }
  .hub .tile:hover { border-color: var(--edge); transform: translateY(-2px); }

  .hub .panel {
    border-radius: 16px;
    box-shadow: 0 10px 30px rgba(0,0,0,.30);
  }

  .hub .gauge {
    position: relative; height: 7px;
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: 999px;
    overflow: hidden;
  }
  .hub .gauge span {
    display: block; height: 100%;
    background: linear-gradient(90deg, var(--green-deep), var(--green));
    transition: width .45s ease;
  }
  .hub .gauge.met span { background: linear-gradient(90deg, var(--green), var(--green-bright)); }

  .hub table { font-variant-numeric: tabular-nums; }
  .hub hr { border: none; border-top: 1px solid var(--line); margin: 14px 0; }
  .hub optgroup { color: var(--muted); background: var(--raised); }
  .hub option { color: var(--bone); background: var(--raised); }
  .hub a { color: var(--green-bright); }
  .hub code { font-family: 'JetBrains Mono', monospace; color: var(--green-bright); font-size: 12px; }
  .hub ol li::marker, .hub ul li::marker { color: var(--green); }

  @media (prefers-reduced-motion: reduce) {
    .hub .hero, .hub .hero-2, .hub .hero-3 { animation: none; }
    .hub .gauge span, .hub .tile { transition: none; }
  }

  @media (max-width: 940px) {
    .hub .tiles { grid-template-columns: repeat(3, 1fr); }
  }

  /* nav scrolls sideways instead of wrapping into a pile */
  .hub .nav {
    display: flex; align-items: center; gap: 2px;
    flex: 1; min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .hub .nav::-webkit-scrollbar { display: none; }
  .hub .nav .tab { flex: none; white-space: nowrap; }

  /* view swaps in when you change tabs */
  .hub .view { animation: viewIn .34s cubic-bezier(.22,.61,.36,1) both; }
  @keyframes viewIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: none; }
  }

  /* panels stagger in underneath it */
  .hub .panel { animation: panelIn .5s cubic-bezier(.22,.61,.36,1) both; }
  .hub .panel:nth-child(1) { animation-delay: .04s; }
  .hub .panel:nth-child(2) { animation-delay: .10s; }
  .hub .panel:nth-child(3) { animation-delay: .16s; }
  .hub .panel:nth-child(4) { animation-delay: .22s; }
  .hub .panel:nth-child(5) { animation-delay: .28s; }
  .hub .panel:nth-child(n+6) { animation-delay: .32s; }
  @keyframes panelIn {
    from { opacity: 0; transform: translateY(16px); }
    to { opacity: 1; transform: none; }
  }
  .hub .panel:hover { border-color: var(--edge); }

  /* answer flips up when revealed */
  .hub .flip { animation: flipIn .4s cubic-bezier(.22,.61,.36,1) both; transform-origin: top center; }
  @keyframes flipIn {
    from { opacity: 0; transform: perspective(700px) rotateX(-32deg); }
    to { opacity: 1; transform: none; }
  }

  .hub tbody tr { transition: background .15s ease; }
  .hub tbody tr:hover { background: rgba(62,142,99,.06); }

  .hub .mark { transition: transform .3s cubic-bezier(.22,.61,.36,1); }
  .hub .bar:hover .mark { transform: translateX(3px) rotate(-10deg); }

  @media (prefers-reduced-motion: reduce) {
    .hub .hero, .hub .hero-2, .hub .hero-3,
    .hub .view, .hub .panel, .hub .flip { animation: none; }
    .hub .gauge span, .hub .tile { transition: none; }
  }

  @media (max-width: 940px) {
    .hub .tiles { grid-template-columns: repeat(3, 1fr); }
  }

  @media (max-width: 720px) {
    .hub { padding-left: 14px !important; padding-right: 14px !important; }

    .hub .bar { gap: 10px; padding: 12px 0; }
    .hub .cta-desktop { display: none; }

    .hub .tiles { grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .hub .tile { padding: 12px; }
    .hub .tab { font-size: 13px; padding: 6px 9px; }

    /* wide tables scroll instead of blowing out the page */
    .hub table {
      display: block;
      overflow-x: auto;
      white-space: nowrap;
      -webkit-overflow-scrolling: touch;
    }

    /* inputs stop overflowing — checkboxes excluded */
    .hub input:not([type="checkbox"]):not([type="file"]),
    .hub select,
    .hub textarea {
      width: 100% !important;
      min-width: 0 !important;
      margin-right: 0 !important;
    }

    .hub section { padding: 14px 14px 16px !important; }
    .hub .panel { border-radius: 14px; }
  }
`;


const BODY = "'Inter', system-ui, -apple-system, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";

const S = {
  page: {
    fontFamily: BODY,
    fontSize: 14,
    color: "#E8EFE9",
    background: "#0D1411",
    padding: "0 18px 48px",
    maxWidth: 1040,
    margin: "0 auto",
    minHeight: "100vh",
    lineHeight: 1.55,
  },
  wordmark: { fontSize: 17, fontWeight: 700, letterSpacing: "-.02em", color: "#E8EFE9" },
  version: { fontFamily: MONO, fontSize: 10, letterSpacing: ".16em", color: "#6B7F73", textTransform: "uppercase" },
  navWrap: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2, flex: 1 },
  subnav: { display: "flex", flexWrap: "wrap", gap: 4, margin: "0 0 16px" },

  heroWrap: { padding: "44px 0 8px" },
  eyebrow: {
    fontFamily: MONO,
    fontSize: 11,
    letterSpacing: ".2em",
    textTransform: "uppercase",
    color: "#6FBF8F",
    margin: 0,
  },
  heroSub: { fontSize: "clamp(16px, 2.2vw, 20px)", color: "#E8EFE9", fontWeight: 500, margin: "18px 0 0" },
  heroBody: { fontSize: 15, color: "#8FA396", margin: "8px 0 0", maxWidth: 520 },
  strip: {
    fontFamily: MONO,
    fontSize: 11,
    letterSpacing: ".05em",
    color: "#6B7F73",
    marginTop: 26,
    paddingTop: 14,
    borderTop: "1px solid #26362E",
    wordSpacing: ".2em",
  },
  tileLabel: {
    fontFamily: MONO,
    fontSize: 9,
    letterSpacing: ".12em",
    textTransform: "uppercase",
    color: "#6B7F73",
    margin: 0,
  },
  tileValue: { fontSize: 23, fontWeight: 700, letterSpacing: "-.02em", margin: "6px 0 0", color: "#E8EFE9", lineHeight: 1.1 },
  tileNote: { fontSize: 11, color: "#8FA396", margin: "3px 0 0" },

  section: {
    border: "1px solid #26362E",
    background: "#141E19",
    padding: "18px 20px 20px",
    marginBottom: 16,
  },
  h2: { fontSize: 24, fontWeight: 700, letterSpacing: "-.02em", margin: "16px 0 8px" },
  h3: {
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 500,
    margin: "0 0 14px",
    textTransform: "uppercase",
    letterSpacing: ".2em",
    color: "#6FBF8F",
  },

  list: { paddingLeft: 18, margin: 0 },
  row: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 6 },
  field: { marginBottom: 10 },
  label: {
    display: "block",
    fontFamily: MONO,
    fontSize: 10,
    letterSpacing: ".14em",
    textTransform: "uppercase",
    color: "#6B7F73",
    marginBottom: 4,
  },

  input: { padding: "9px 12px", marginRight: 6, marginBottom: 8, minWidth: 170, maxWidth: "100%", fontSize: 13 },
  inputSm: { padding: "9px 12px", width: 110, marginRight: 6, marginBottom: 8, fontSize: 13, fontFamily: MONO },
  textarea: { width: "100%", padding: 12, marginBottom: 8, fontSize: 13, lineHeight: 1.55, resize: "vertical" },

  btn: {
    padding: "9px 16px",
    border: "1px solid #33473C",
    background: "transparent",
    color: "#E8EFE9",
    cursor: "pointer",
    marginRight: 8,
    marginBottom: 8,
    fontSize: 13,
    fontWeight: 500,
  },
  link: {
    border: "none",
    background: "none",
    padding: 0,
    color: "#E8EFE9",
    borderBottom: "1px solid #33473C",
    cursor: "pointer",
    fontSize: 14,
    fontFamily: BODY,
  },

  table: { borderCollapse: "collapse", width: "100%", marginTop: 10 },
  th: {
    textAlign: "left",
    borderBottom: "1px solid #33473C",
    padding: "8px 10px 8px 0",
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: ".12em",
    textTransform: "uppercase",
    color: "#6B7F73",
  },
  td: { borderBottom: "1px solid #1B2822", padding: "10px 10px 10px 0", verticalAlign: "top", fontSize: 13 },

  card: { border: "1px solid #26362E", borderRadius: 12, background: "#0D1411", padding: 14, marginBottom: 10 },
  pre: { whiteSpace: "pre-wrap", fontFamily: BODY, margin: "6px 0", fontSize: 13 },

  dim: { color: "#6B7F73", fontSize: 12 },
  late: { color: "#C4705A", fontSize: 12 },
  ok: { color: "#6FBF8F", fontSize: 12 },

  thumb: { maxWidth: "100%", maxHeight: 180, border: "1px solid #33473C", borderRadius: 10, display: "block", marginBottom: 6 },
  cardImg: { maxWidth: "100%", maxHeight: 340, border: "1px solid #26362E", borderRadius: 10, display: "block", margin: "10px 0" },
  dropzone: {
    border: "1px dashed #33473C",
    borderRadius: 12,
    padding: 18,
    fontFamily: MONO,
    fontSize: 10,
    letterSpacing: ".1em",
    textTransform: "uppercase",
    color: "#6B7F73",
    textAlign: "center",
    cursor: "text",
    background: "#0D1411",
  },

  footer: { borderTop: "1px solid #26362E", marginTop: 30, paddingTop: 14 },
  footLink: {
    border: "1px solid #26362E",
    background: "none",
    color: "#6B7F73",
    fontFamily: MONO,
    fontSize: 10,
    letterSpacing: ".14em",
    textTransform: "uppercase",
    cursor: "pointer",
    padding: "8px 14px",
  },
};
