import React, { useState, useEffect, useMemo } from "react";

/* ============================================================
   FLIGHTPLAN — AVIATION MODULE
   Self-contained. Uses the CSS variables already defined on .hub,
   so it inherits the palette and cabin lighting automatically.
   ============================================================ */

/* ---------- endpoints ---------- */
export const STATION = "KBTL";
export const METAR_URL = "https://flightplan-metar.nicholasmcarmody.workers.dev/";
// Worker must support ?type=taf for this to return anything; degrades quietly.
export const TAF_URL = METAR_URL + "?type=taf";

const FIELD = { lat: 42.3073, lon: -85.2515, elev: 939 }; // W.K. Kellogg, Battle Creek

/* ---------- small local helpers (kept here so this file stands alone) ---------- */
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

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const fmt1 = (x) => (Math.round(num(x) * 10) / 10).toFixed(1);

// Deterministic per calendar date AND per pool, so a refresh never changes today's
// content and two pools don't rotate in lockstep. FNV-1a over "YYYY-MM-DD:key".
function daySeed(key, iso = todayISO()) {
  let h = 0x811c9dc5;
  const str = `${iso}:${key}`;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
const ofTheDay = (arr, key) => arr[daySeed(key) % arr.length];

/* ---------- week position ---------- */
// Monday = 1 … Sunday = 7. daysLeft counts today as one of them.
export function weekPosition(d = new Date()) {
  const idx = ((d.getDay() + 6) % 7) + 1;
  return { idx, daysLeft: 8 - idx, elapsed: idx };
}

const roundTo = (v, step) => Math.round(v / step) * step;
const trim = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : fmt1(v));

/* Convert a weekly target into what's actually owed today.
   Returns null when nothing is owed — either it's finished or you're far enough
   ahead that inventing work would be noise. */
export function todaysShare(target, done, { step = 1, min = 0 } = {}) {
  const t = num(target);
  if (t <= 0) return null;

  const { idx, daysLeft } = weekPosition();
  const remaining = t - num(done);
  if (remaining <= 0) return { need: 0, state: "complete", remaining: 0, daysLeft };

  // "Ahead" means a full day banked — you've already done what tomorrow night
  // would require. Merely being a few minutes up on pace still earns a task,
  // otherwise a good week quietly stops asking anything of you.
  const bankedThroughTomorrow = (t * Math.min(7, idx + 1)) / 7;
  const ahead = num(done) >= bankedThroughTomorrow;

  let need = remaining / Math.max(1, daysLeft);
  need = Math.max(min, roundTo(need, step));

  return {
    need,
    remaining,
    daysLeft,
    state: ahead ? "ahead" : need > 0 ? "todo" : "complete",
  };
}

/* ============================================================
   DATA MODEL EXTENSION
   ============================================================ */
export const blankAviation = () => ({
  flights: [],
  countdowns: [],
  dailyTasks: [],
  semester: { start: "", end: "" },
  minimums: { ceiling: 2500, vis: 5, wind: 20, xwind: 12, gust: 25 },
  pilot: {
    goal: "private",
    flightReview: "",
    medical: "",
    medicalClass: "3",
    runways: "05/23, 13/31",
  },
});

export function migrateAviation(d) {
  const base = blankAviation();
  return {
    flights: (d?.flights || []).map((f) => ({ ...blankFlight(), ...f })),
    countdowns: d?.countdowns || [],
    dailyTasks: d?.dailyTasks || [],
    semester: { ...base.semester, ...(d?.semester || {}) },
    minimums: { ...base.minimums, ...(d?.minimums || {}) },
    pilot: { ...base.pilot, ...(d?.pilot || {}) },
  };
}

export const blankFlight = () => ({
  id: uid(),
  date: todayISO(),
  aircraft: "",
  ident: "",
  route: "",
  total: 0,
  dual: 0,
  pic: 0,
  solo: 0,
  xc: 0,
  night: 0,
  actualInst: 0,
  simInst: 0,
  sim: 0,
  dayLdg: 0,
  nightLdg: 0,
  approaches: 0,
  remarks: "",
});

/* ============================================================
   METAR PARSING
   ============================================================ */
export function parseMetar(raw) {
  if (!raw) return null;
  const out = { raw, wind: null, visSM: null, ceiling: null, temp: null, dew: null, altim: null };
  const t = raw.split(/\s+/);

  // wind: dddssKT, dddssGggKT, VRBssKT
  const wm = raw.match(/\b(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?KT\b/);
  if (wm) {
    out.wind = {
      dir: wm[1] === "VRB" ? "VRB" : Number(wm[1]),
      speed: Number(wm[2]),
      gust: wm[3] ? Number(wm[3]) : null,
    };
  }

  // visibility: 10SM, 1 1/2SM, 1/2SM, M1/4SM
  const vm = raw.match(/\b(M?)(\d+)?\s?(\d+\/\d+)?SM\b/);
  if (vm) {
    let v = 0;
    if (vm[2]) v += Number(vm[2]);
    if (vm[3]) {
      const [a, b] = vm[3].split("/").map(Number);
      v += a / b;
    }
    out.visSM = vm[1] === "M" ? Math.max(0, v - 0.01) : v;
  }

  // ceiling: lowest BKN/OVC/VV layer, in feet AGL
  let ceil = null;
  t.forEach((tok) => {
    const cm = tok.match(/^(BKN|OVC|VV)(\d{3})$/);
    if (cm) {
      const ft = Number(cm[2]) * 100;
      if (ceil === null || ft < ceil) ceil = ft;
    }
  });
  out.ceiling = ceil;

  const tm = raw.match(/\b(M?\d{2})\/(M?\d{2})\b/);
  if (tm) {
    const conv = (s) => (s.startsWith("M") ? -Number(s.slice(1)) : Number(s));
    out.temp = conv(tm[1]);
    out.dew = conv(tm[2]);
  }

  const am = raw.match(/\bA(\d{4})\b/);
  if (am) out.altim = (Number(am[1]) / 100).toFixed(2);

  return out;
}

export function flightCategory(p) {
  if (!p) return null;
  const c = p.ceiling === null ? 99999 : p.ceiling;
  const v = p.visSM === null ? 99 : p.visSM;
  if (c < 500 || v < 1) return "LIFR";
  if (c < 1000 || v < 3) return "IFR";
  if (c <= 3000 || v <= 5) return "MVFR";
  return "VFR";
}

const CAT_CLASS = { VFR: "cat-vfr", MVFR: "cat-mvfr", IFR: "cat-ifr", LIFR: "cat-lifr" };

/* ---------- wind components against a runway ---------- */
function windComponents(wind, runwayHeadingDeg) {
  if (!wind || wind.dir === "VRB") return null;
  const diff = (((wind.dir - runwayHeadingDeg) % 360) + 540) % 360 - 180;
  const rad = (diff * Math.PI) / 180;
  return {
    head: Math.round(wind.speed * Math.cos(rad)),
    cross: Math.round(wind.speed * Math.sin(rad)),
    side: diff >= 0 ? "R" : "L",
    off: Math.abs(Math.round(diff)),
  };
}

function parseRunways(str) {
  // "05/23, 13/31" -> [{name:"05",hdg:50},{name:"23",hdg:230},...]
  const out = [];
  (str || "").split(",").forEach((pair) => {
    pair
      .trim()
      .split("/")
      .forEach((end) => {
        const n = end.trim();
        if (/^\d{1,2}[LRC]?$/.test(n)) {
          out.push({ name: n.padStart(2, "0"), hdg: parseInt(n, 10) * 10 });
        }
      });
  });
  return out;
}

/* ============================================================
   SUN TIMES (NOAA approximation, no network)
   ============================================================ */
export function sunTimes(date, lat, lon) {
  const rad = Math.PI / 180;
  const start = new Date(date.getFullYear(), 0, 0);
  const doy = Math.floor((date - start) / 86400000);

  const gamma = ((2 * Math.PI) / 365) * (doy - 1 + (date.getHours() - 12) / 24);
  const eqtime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  const cosH =
    Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) -
    Math.tan(lat * rad) * Math.tan(decl);
  if (cosH > 1 || cosH < -1) return null;
  const ha = Math.acos(cosH) / rad;

  const noonUTCmin = 720 - 4 * lon - eqtime;
  const toLocal = (utcMin) => {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setUTCHours(0, 0, 0, 0);
    return new Date(d.getTime() + utcMin * 60000);
  };

  return {
    sunrise: toLocal(noonUTCmin - 4 * ha),
    sunset: toLocal(noonUTCmin + 4 * ha),
  };
}

const clock = (d) =>
  d ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";

/* ============================================================
   LIVE WEATHER
   ============================================================ */
function useWeather() {
  const [state, setState] = useState({ metar: null, taf: null, at: null, error: null });

  useEffect(() => {
    let dead = false;

    const grab = async (url) => {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      return Array.isArray(j) ? j[0] : j;
    };

    const pull = async () => {
      try {
        const m = await grab(METAR_URL);
        const raw = m?.rawOb || m?.rawText || null;
        if (!raw) throw new Error("no observation");
        if (!dead) setState((s) => ({ ...s, metar: raw, at: Date.now(), error: null }));
      } catch (e) {
        if (!dead) setState((s) => ({ ...s, error: e.message }));
      }
      try {
        const t = await grab(TAF_URL);
        const raw = t?.rawTAF || t?.rawOb || t?.rawText || null;
        // only accept it if it actually looks like a TAF
        if (raw && /\bTAF\b/.test(raw) && !dead) setState((s) => ({ ...s, taf: raw }));
      } catch {
        /* TAF is optional — stay quiet */
      }
    };

    pull();
    const t = setInterval(pull, 10 * 60 * 1000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, []);

  return state;
}

/* ---------- teletype ticker ---------- */
function Ticker({ text, speed = 12 }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    const t = setInterval(() => {
      setN((x) => {
        if (x >= text.length) {
          clearInterval(t);
          return x;
        }
        return x + 1;
      });
    }, speed);
    return () => clearInterval(t);
  }, [text, speed]);
  return (
    <span>
      {text.slice(0, n)}
      {n < text.length && <span className="caret" />}
    </span>
  );
}

/* ============================================================
   BRIEFING STRIP — compact, expandable
   ============================================================ */
export function BriefingStrip({ data }) {
  const { metar, taf, at, error } = useWeather();
  const [open, setOpen] = useState(false);

  const p = useMemo(() => parseMetar(metar), [metar]);
  const cat = flightCategory(p);
  const sun = useMemo(() => sunTimes(new Date(), FIELD.lat, FIELD.lon), []);
  const runways = parseRunways(data.pilot?.runways);
  const mins = data.minimums || {};

  if (!metar) {
    return (
      <span className="brief-dim">
        {error ? `${STATION} — weather unavailable` : `${STATION} — fetching…`}
      </span>
    );
  }

  // best runway = most headwind
  const ranked = runways
    .map((r) => ({ ...r, w: windComponents(p.wind, r.hdg) }))
    .sort((a, b) => (b.w?.head ?? -99) - (a.w?.head ?? -99));
  const best = ranked[0];

  const xwindMax = ranked.reduce(
    (m, r) => (r.w ? Math.min(m, Math.abs(r.w.cross)) : m),
    99
  );

  const checks = [
    { label: "Ceiling", ok: (p.ceiling ?? 99999) >= num(mins.ceiling), val: p.ceiling === null ? "clear" : `${p.ceiling} ft` },
    { label: "Visibility", ok: (p.visSM ?? 99) >= num(mins.vis), val: p.visSM === null ? "—" : `${p.visSM} SM` },
    { label: "Wind", ok: (p.wind?.speed ?? 0) <= num(mins.wind), val: p.wind ? `${p.wind.speed} kt` : "calm" },
    { label: "Gusts", ok: (p.wind?.gust ?? 0) <= num(mins.gust), val: p.wind?.gust ? `${p.wind.gust} kt` : "none" },
    { label: "Crosswind", ok: xwindMax <= num(mins.xwind), val: xwindMax === 99 ? "—" : `${xwindMax} kt` },
  ];
  const failed = checks.filter((c) => !c.ok).length;
  const verdict = failed === 0 ? "GO" : failed <= 1 ? "CAUTION" : "NO-GO";

  const mins_ago = at ? Math.round((Date.now() - at) / 60000) : 0;

  return (
    <div className="brief">
      <button className="brief-head" onClick={() => setOpen(!open)}>
        <span className={`cat ${CAT_CLASS[cat] || ""}`}>{cat}</span>
        <span className="brief-line">
          <Ticker text={metar} />
        </span>
        <span className="brief-toggle">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="brief-body">
          <div className="brief-grid">
            <div>
              <p className="brief-k">Wind</p>
              <p className="brief-v">
                {p.wind
                  ? p.wind.dir === "VRB"
                    ? `Variable ${p.wind.speed} kt`
                    : `${String(p.wind.dir).padStart(3, "0")}° at ${p.wind.speed} kt${
                        p.wind.gust ? ` G${p.wind.gust}` : ""
                      }`
                  : "Calm"}
              </p>
            </div>
            <div>
              <p className="brief-k">Ceiling / Vis</p>
              <p className="brief-v">
                {p.ceiling === null ? "No ceiling" : `${p.ceiling.toLocaleString()} ft`} ·{" "}
                {p.visSM === null ? "—" : `${p.visSM} SM`}
              </p>
            </div>
            <div>
              <p className="brief-k">Temp / Dew</p>
              <p className="brief-v">
                {p.temp === null ? "—" : `${p.temp}°C / ${p.dew}°C`}
                {p.altim ? ` · A${p.altim}` : ""}
              </p>
            </div>
            <div>
              <p className="brief-k">Sunrise / Sunset</p>
              <p className="brief-v">
                {clock(sun?.sunrise)} · {clock(sun?.sunset)}
              </p>
            </div>
          </div>

          {runways.length > 0 && (
            <>
              <p className="brief-k" style={{ marginTop: 14 }}>
                Runways — {STATION}
              </p>
              <table className="brief-tbl">
                <thead>
                  <tr>
                    <th>RWY</th>
                    <th>Headwind</th>
                    <th>Crosswind</th>
                    <th>Off heading</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((r) => (
                    <tr key={r.name} className={best && r.name === best.name ? "rwy-best" : ""}>
                      <td>{r.name}</td>
                      <td>{r.w ? `${r.w.head >= 0 ? "" : "tail "}${Math.abs(r.w.head)} kt` : "—"}</td>
                      <td>{r.w ? `${Math.abs(r.w.cross)} kt ${r.w.side}` : "—"}</td>
                      <td>{r.w ? `${r.w.off}°` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {best && best.w && (
                <p className="brief-note">
                  Favoring runway {best.name} — {Math.abs(best.w.head)} kt down the pipe.
                </p>
              )}
            </>
          )}

          <p className="brief-k" style={{ marginTop: 14 }}>
            Personal minimums
          </p>
          <div className="mins-row">
            {checks.map((c) => (
              <span key={c.label} className={c.ok ? "mins ok" : "mins bad"}>
                {c.label} {c.val}
              </span>
            ))}
          </div>
          <p className={verdict === "GO" ? "verdict go" : verdict === "CAUTION" ? "verdict caution" : "verdict nogo"}>
            {verdict}
            <span className="brief-note">
              {" "}
              — against your minimums, not a substitute for a real preflight briefing.
            </span>
          </p>

          <p className="brief-k" style={{ marginTop: 14 }}>
            TAF
          </p>
          <p className="brief-mono">
            {taf || "Not available — your Worker needs to serve ?type=taf."}
          </p>

          <p className="brief-note" style={{ marginTop: 10 }}>
            Observation {mins_ago > 0 ? `${mins_ago} min old` : "just now"}
            {error ? " · last fetch failed, showing stale data" : ""}
          </p>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   TODAY'S MISSION
   ============================================================ */
export function MissionPanel({ data, go, update, helpers }) {
  const { studyPriority, live, gymDays, sumMiles, weekStart } = helpers;
  const [draft, setDraft] = useState("");

  const today = todayISO();
  const ws = weekStart();
  const { daysLeft } = weekPosition();

  /* ---- manual objectives for today ---- */
  const manual = (data.dailyTasks || []).filter((t) => t.date === today);

  const addManual = () => {
    if (!draft.trim()) return;
    update((d) => {
      d.dailyTasks = [
        ...(d.dailyTasks || []).filter((t) => t.date >= addDays(today, -14)),
        { id: uid(), date: today, title: draft.trim(), done: false },
      ];
      return d;
    });
    setDraft("");
  };

  const toggleManual = (id) =>
    update((d) => {
      d.dailyTasks = (d.dailyTasks || []).map((t) =>
        t.id === id ? { ...t, done: !t.done } : t
      );
      return d;
    });

  const dropManual = (id) =>
    update((d) => {
      d.dailyTasks = (d.dailyTasks || []).filter((t) => t.id !== id);
      return d;
    });

  /* ---- derived daily targets ---- */
  const items = [];

  // 1. manual objectives always come first
  manual.forEach((t) =>
    items.push({
      key: `manual-${t.id}`,
      done: t.done,
      text: t.title,
      note: "your objective",
      toggle: () => toggleManual(t.id),
      drop: () => dropManual(t.id),
    })
  );

  // 2. flashcards — already a daily quantity
  const cardsDue = data.cards.filter((c) => !c.due || c.due <= today).length;
  if (cardsDue > 0) {
    items.push({
      key: "cards",
      done: false,
      text: `Review ${cardsDue} card${cardsDue === 1 ? "" : "s"}`,
      note: "due today by the box schedule",
      action: () => go("cards"),
    });
  } else if (data.cards.length) {
    items.push({ key: "cards", done: true, text: "Review queue is clear", note: "nothing due" });
  }

  // 3. study minutes — weekly goal split across the days left
  const weeklyMin = live(data).reduce((s, c) => s + num(c.weeklyMinutes), 0);
  const doneMin = data.sessions
    .filter((s) => s.date >= ws)
    .reduce((s, x) => s + num(x.minutes), 0);
  const todayMin = data.sessions
    .filter((s) => s.date === today)
    .reduce((s, x) => s + num(x.minutes), 0);

  const study = todaysShare(weeklyMin, doneMin, { step: 5, min: 5 });
  if (study) {
    const top = live(data)
      .map((c) => ({ course: c, ...studyPriority(c, data) }))
      .sort((x, y) => y.score - x.score)[0];
    const label = top ? ` — start with ${top.course.code}` : "";

    if (study.state === "complete") {
      items.push({ key: "study", done: true, text: "Weekly study target met", note: `${doneMin} of ${weeklyMin} min` });
    } else if (study.state === "ahead") {
      items.push({
        key: "study",
        done: true,
        text: "Ahead on study time",
        note: `${doneMin} of ${weeklyMin} min with ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`,
      });
    } else {
      const remainingToday = Math.max(0, study.need - todayMin);
      items.push({
        key: "study",
        done: remainingToday <= 0,
        text:
          remainingToday <= 0
            ? `Study done for today — ${todayMin} min in`
            : `Study ${Math.round(remainingToday)} minutes${label}`,
        note: `${study.remaining} min left this week over ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
        action: () => go("study"),
      });
    }
  }

  // 4. gym days — you either need today or you don't
  const week = (data.personal?.workouts || []).filter((w) => w.date >= ws);
  const gymTarget = num(data.personal?.gymTarget);
  const gymDone = gymDays(week);
  const trainedToday = (data.personal?.workouts || []).some((w) => w.date === today);
  const gymLeft = Math.max(0, gymTarget - gymDone);

  if (gymTarget > 0) {
    if (gymLeft === 0) {
      items.push({ key: "gym", done: true, text: "Gym target met for the week", note: `${gymDone} of ${gymTarget} days` });
    } else if (trainedToday) {
      items.push({ key: "gym", done: true, text: "Trained today", note: `${gymDone} of ${gymTarget} days this week` });
    } else {
      const mustToday = gymLeft >= daysLeft;
      items.push({
        key: "gym",
        done: false,
        text: mustToday ? "Gym today — no slack left" : "Gym today",
        note: `${gymLeft} of ${gymTarget} day${gymLeft === 1 ? "" : "s"} left, ${daysLeft} day${daysLeft === 1 ? "" : "s"} to do them`,
        action: () => go("personal"),
        urgent: mustToday,
      });
    }
  }

  // 5. mileage — weekly target split across the days left
  const milesTarget = num(data.personal?.milesTarget);
  const milesDone = sumMiles(week);
  const milesToday = sumMiles((data.personal?.workouts || []).filter((w) => w.date === today));
  const run = todaysShare(milesTarget, milesDone, { step: 0.5, min: 0.5 });

  if (run) {
    if (run.state === "complete") {
      items.push({ key: "run", done: true, text: "Weekly mileage met", note: `${trim(milesDone)} of ${trim(milesTarget)} mi` });
    } else if (run.state === "ahead") {
      items.push({
        key: "run",
        done: true,
        text: "Ahead on mileage",
        note: `${trim(milesDone)} of ${trim(milesTarget)} mi with ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`,
      });
    } else {
      const leftToday = Math.max(0, run.need - milesToday);
      items.push({
        key: "run",
        done: leftToday <= 0,
        text:
          leftToday <= 0
            ? `Run done for today — ${trim(milesToday)} mi`
            : `Run ${trim(leftToday)} mile${leftToday === 1 ? "" : "s"}`,
        note: `${trim(run.remaining)} mi left this week over ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
        action: () => go("personal"),
      });
    }
  }

  // 6. anything landing in the next few days
  const soon = [...(data.countdowns || [])]
    .map((c) => ({ ...c, n: daysBetween(today, c.date) }))
    .filter((c) => c.n >= 0 && c.n <= 5)
    .sort((a, b) => a.n - b.n)[0];
  if (soon) {
    items.push({
      key: `cd-${soon.id}`,
      done: false,
      text: soon.n === 0 ? `${soon.title} — today` : `Prep for ${soon.title}`,
      note: soon.n === 0 ? "it's today" : `${soon.n} day${soon.n === 1 ? "" : "s"} out`,
      urgent: soon.n <= 2,
    });
  }

  /* ---- pick 3–5: unfinished first, urgent above that ---- */
  const seen = new Set();
  const unique = items.filter((i) => (seen.has(i.key) ? false : seen.add(i.key)));
  const open = unique.filter((i) => !i.done).sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));
  const closed = unique.filter((i) => i.done);
  const shown = [...open, ...closed].slice(0, Math.max(3, Math.min(5, open.length + 2)));
  const doneCount = shown.filter((i) => i.done).length;

  return (
    <div>
      <p className="brief-note" style={{ marginBottom: 10 }}>
        {shown.length === 0
          ? "Nothing outstanding."
          : `${doneCount} of ${shown.length} complete · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left in the week`}
      </p>

      <ul className="mission">
        {shown.map((it) => (
          <li key={it.key} className={it.done ? "done" : ""}>
            <span
              className={it.toggle ? "tick tappable" : "tick"}
              onClick={it.toggle}
              role={it.toggle ? "button" : undefined}
            >
              {it.done ? "✓" : "○"}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              {it.action && !it.done ? (
                <button className="mission-btn" onClick={it.action}>
                  {it.text}
                </button>
              ) : (
                <span className={it.urgent && !it.done ? "urgent" : undefined}>{it.text}</span>
              )}
              {it.note && <p className="brief-note">{it.note}</p>}
            </span>
            {it.drop && (
              <button className="cd-x" onClick={it.drop}>
                ×
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="av-form" style={{ marginTop: 12 }}>
        <input
          className="av-in"
          placeholder="Add an objective for today"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addManual()}
        />
        <button className="av-btn" onClick={addManual}>
          Add
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   COUNTDOWNS + SEMESTER PROGRESS
   ============================================================ */
export function CountdownPanel({ data, update }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");

  const sem = data.semester || {};
  const today = todayISO();

  const add = () => {
    if (!title.trim() || !date) return;
    update((d) => {
      d.countdowns = [...(d.countdowns || []), { id: uid(), title: title.trim(), date }];
      return d;
    });
    setTitle("");
    setDate("");
  };

  const remove = (id) =>
    update((d) => {
      d.countdowns = (d.countdowns || []).filter((c) => c.id !== id);
      return d;
    });

  const setSem = (k, v) =>
    update((d) => {
      d.semester = { ...(d.semester || {}), [k]: v };
      return d;
    });

  let pct = null;
  let daysLeft = null;
  if (sem.start && sem.end) {
    const total = Math.max(1, daysBetween(sem.start, sem.end));
    const gone = daysBetween(sem.start, today);
    pct = Math.max(0, Math.min(100, (gone / total) * 100));
    daysLeft = daysBetween(today, sem.end);
  }

  const list = [...(data.countdowns || [])].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div>
      {pct !== null ? (
        <>
          <p>
            Semester <b>{Math.round(pct)}%</b> done ·{" "}
            <span className="brief-note">
              {daysLeft >= 0 ? `${daysLeft} days left` : "term is over"}
            </span>
          </p>
          <div className="gauge" style={{ marginBottom: 12 }}>
            <span style={{ width: `${pct}%` }} />
          </div>
        </>
      ) : (
        <p className="brief-note">Set your semester dates below to track term progress.</p>
      )}

      {list.length > 0 && (
        <ul className="countdowns">
          {list.map((c) => {
            const n = daysBetween(today, c.date);
            return (
              <li key={c.id}>
                <span className={n < 0 ? "cd-num past" : n <= 7 ? "cd-num soon" : "cd-num"}>
                  {n < 0 ? `${Math.abs(n)}` : n}
                </span>
                <span className="cd-unit">{n < 0 ? "days ago" : n === 1 ? "day" : "days"}</span>
                <span className="cd-title">{c.title}</span>
                <button className="cd-x" onClick={() => remove(c.id)}>
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="av-form">
        <input
          className="av-in"
          placeholder="Checkride, final exam, written…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input className="av-in sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="av-btn" onClick={add}>
          Add countdown
        </button>
      </div>

      <div className="av-form" style={{ marginTop: 8 }}>
        <label className="av-lbl">Semester start</label>
        <input
          className="av-in sm"
          type="date"
          value={sem.start || ""}
          onChange={(e) => setSem("start", e.target.value)}
        />
        <label className="av-lbl">Semester end</label>
        <input
          className="av-in sm"
          type="date"
          value={sem.end || ""}
          onChange={(e) => setSem("end", e.target.value)}
        />
      </div>
    </div>
  );
}

/* ============================================================
   DAILY ITEMS
   ============================================================ */
const ACS_AREAS = [
  "I. Preflight Preparation",
  "II. Preflight Procedures",
  "III. Airport and Seaplane Base Operations",
  "IV. Takeoffs, Landings, and Go-Arounds",
  "V. Performance and Ground Reference Maneuvers",
  "VI. Navigation",
  "VII. Slow Flight and Stalls",
  "VIII. Basic Instrument Maneuvers",
  "IX. Emergency Operations",
  "X. Multiengine Operations",
  "XI. Night Operations",
  "XII. Postflight Procedures",
];

/* Daily content pools.
   Everything here is selected deterministically by calendar date — see daySeed.
   Entries are kept to things that are unambiguous; loose mnemonics and duplicates
   were removed rather than left in to pad the list. */
const ACRONYMS = [
  ["ATOMATOFLAMES", "Day VFR required equipment under 91.205 — altimeter, tachometer, oil pressure, manifold pressure, oil temperature, temperature gauge, fuel gauge, landing gear position lights, airspeed, magnetic compass, ELT, seatbelts."],
  ["FLAPS", "What night VFR adds to the day list — fuses (spares), landing light if operated for hire, anticollision lights, position lights, source of electrical power."],
  ["GRABCARD", "What IFR adds — generator or alternator, radios, altimeter (adjustable), ball, clock, attitude indicator, rate of turn indicator, directional gyro."],
  ["AVIATES", "Inspections to track — annual, VOR check (30 days for IFR), 100-hour, altimeter and pitot-static (24 calendar months), transponder (24 calendar months), ELT, static system."],
  ["ARROW", "Documents aboard the aircraft — airworthiness certificate, registration, radio station license (international only), operating limitations, weight and balance."],
  ["IMSAFE", "Self-assessment before flying — illness, medication, stress, alcohol, fatigue, emotion."],
  ["PAVE", "Risk assessment across four areas — pilot, aircraft, environment, external pressures."],
  ["DECIDE", "Decision-making loop — detect, estimate, choose, identify, do, evaluate."],
  ["NWKRAFT", "Preflight information required by 91.103 — NOTAMs, weather, known ATC delays, runway lengths, alternates, fuel requirements, takeoff and landing distances."],
  ["CIGAR", "Pre-takeoff check — controls, instruments, gas, attitude, run-up."],
  ["GUMPS", "Pre-landing flow — gas, undercarriage, mixture, propeller, switches and seatbelts."],
  ["ANDS", "Magnetic compass acceleration error — accelerate north, decelerate south, when on an easterly or westerly heading."],
  ["UNOS", "Compass turning error in the northern hemisphere — undershoot north, overshoot south."],
  ["THE 5 Ps", "A pre-flight and in-flight review — plan, plane, pilot, passengers, programming."],
  ["SAFETY", "Passenger briefing — seatbelts, air vents and environment, fire extinguisher, exit and emergency, traffic and talking, your questions."],
  ["CRAFT", "Copying an IFR clearance — clearance limit, route, altitude, frequency, transponder."],
  ["WIRE", "Instrument approach briefing basics — weather, instruments, radios, evaluate the approach."],
  ["MATH", "Checking the six-pack before takeoff — magnetic compass, attitude indicator, turn coordinator, heading indicator."],
];

const AIRPORTS = [
  ["KBTL", "W.K. Kellogg Airport, Battle Creek, Michigan — home field for Western Michigan University's College of Aviation."],
  ["KAZO", "Kalamazoo/Battle Creek International — the nearest Class C airspace to Kellogg."],
  ["KGRR", "Gerald R. Ford International, Grand Rapids — the busiest airport in West Michigan."],
  ["KDTW", "Detroit Metropolitan Wayne County — Michigan's largest airport and a major Delta hub."],
  ["KOSH", "Wittman Regional, Oshkosh, Wisconsin — hosts EAA AirVenture each summer, when its traffic volume briefly exceeds any other airport in the world."],
  ["KJFK", "John F. Kennedy International, New York — home of the Canarsie visual approach to runway 13L, flown along a chain of lead-in lights."],
  ["KASE", "Aspen/Pitkin County, Colorado — high elevation, mountainous terrain, and a one-way-in, one-way-out valley."],
  ["KSNA", "John Wayne, Orange County, California — known for a steep noise-abatement departure procedure."],
  ["TNCM", "Princess Juliana International, St. Maarten — the approach to runway 10 passes low over Maho Beach."],
  ["KTEB", "Teterboro, New Jersey — one of the busiest general aviation airports in the United States."],
  ["PAKT", "Ketchikan International, Alaska — sits on an island across the channel from town, reached by ferry."],
  ["KEGE", "Eagle County Regional, Colorado — mountain terrain and special crew qualification requirements."],
  ["KMDW", "Chicago Midway — short runways bounded by city streets on every side."],
  ["KSFO", "San Francisco International — closely spaced parallel runways and a persistent summer marine layer."],
  ["KDCA", "Ronald Reagan Washington National — the River Visual to runway 19 follows the Potomac past restricted airspace."],
  ["KAPA", "Centennial, Colorado — among the busiest general aviation airports in the country, at nearly 5,900 feet elevation."],
  ["KFRG", "Republic Airport, Farmingdale, New York — the former Republic Aviation plant where the P-47 Thunderbolt was built."],
  ["KLGA", "LaGuardia, New York — the Expressway Visual to runway 31 requires a late turn over Queens."],
];

const HISTORY = [
  ["12-17", "1903 — the Wright brothers make the first powered, sustained, controlled flights of a heavier-than-air aircraft at Kitty Hawk, North Carolina."],
  ["05-20", "1927 — Charles Lindbergh departs New York for Paris in the Spirit of St. Louis. Five years later to the day, Amelia Earhart began her solo Atlantic crossing."],
  ["10-14", "1947 — Chuck Yeager exceeds the speed of sound in the Bell X-1 over the Mojave Desert."],
  ["07-20", "1969 — Apollo 11 lands on the Moon."],
  ["03-02", "1969 — Concorde makes its first flight, from Toulouse."],
  ["02-09", "1969 — the Boeing 747 makes its first flight."],
  ["01-15", "2009 — US Airways 1549 ditches in the Hudson River after losing both engines to a bird strike. Everyone aboard survives."],
  ["04-12", "1961 — Yuri Gagarin becomes the first human to reach space."],
  ["06-18", "1983 — Sally Ride becomes the first American woman in space."],
  ["11-14", "1910 — Eugene Ely makes the first airplane takeoff from a ship, flying off USS Birmingham."],
  ["09-17", "1908 — the first fatality in a powered airplane; Orville Wright is badly injured and his passenger, Thomas Selfridge, is killed."],
  ["12-23", "1986 — Voyager completes the first nonstop, non-refueled flight around the world."],
];

const HISTORY_POOL = [
  "Runway numbers are magnetic headings rounded to the nearest ten degrees, which is why they occasionally get renumbered as magnetic variation drifts.",
  "'Mayday' comes from the French venez m'aider. 'Pan-pan' comes from panne, meaning a breakdown.",
  "The flight recorder known as the black box is painted bright orange so it can be found in wreckage.",
  "Transponder 7500 means unlawful interference, 7600 lost communications, and 7700 a general emergency.",
  "Above 18,000 feet everyone sets 29.92 inHg, so all aircraft in the flight levels share one pressure reference.",
  "Left-turning tendency has four causes — torque, P-factor, spiraling slipstream, and gyroscopic precession.",
  "A stall is defined by angle of attack, not airspeed. You can stall at any speed and any attitude.",
  "In a level 60-degree bank the load factor is 2 G, and stall speed rises by the square root of the load factor — about 41 percent.",
  "Density altitude is pressure altitude corrected for nonstandard temperature. It's the altitude your airplane's performance actually believes it's at.",
  "The word cockpit came from sailing, where it named the space the coxswain worked in.",
  "Class A airspace begins at 18,000 feet MSL and requires an instrument flight plan and clearance regardless of the weather.",
  "VOR stations are checked for IFR use every 30 days, and the allowable error differs depending on how you check them.",
];

const CHECKRIDE = [
  ["What documents must be aboard the aircraft?", "Airworthiness certificate, registration, operating limitations, and weight and balance data — remembered as ARROW. The radio station license applies to international flights."],
  ["What inspections are required for VFR flight?", "Annual (12 calendar months), 100-hour if carrying persons for hire or giving instruction for hire, ELT battery, altimeter and pitot-static every 24 calendar months, and transponder every 24 calendar months."],
  ["What are the VFR fuel requirements?", "Day: enough to reach the first point of intended landing plus 30 minutes at normal cruise. Night: plus 45 minutes."],
  ["When is a medical certificate required?", "For acting as pilot in command or as a required crewmember. A student, recreational, or private pilot may use BasicMed in certain conditions, or fly gliders and balloons without one."],
  ["What is the difference between indicated, calibrated, true, and density altitude?", "Indicated is what the altimeter reads. Calibrated corrects for installation error. True is actual height above mean sea level. Density altitude is pressure altitude corrected for nonstandard temperature — the altitude the airplane thinks it's at."],
  ["What causes a stall?", "Exceeding the critical angle of attack. It can happen at any airspeed, any attitude, and any power setting."],
  ["What are the standard cloud clearances in Class E below 10,000 ft?", "Three statute miles visibility, and 500 below, 1,000 above, 2,000 horizontal from clouds."],
  ["What equipment is required to enter Class B airspace?", "A two-way radio, an operable transponder with Mode C, and ADS-B Out. A private certificate or a student endorsement for that specific airspace."],
  ["What is hypoxia and what are the types?", "Insufficient oxygen reaching the tissues. Hypoxic, hypemic, stagnant, and histotoxic."],
  ["What are the oxygen requirements for the crew?", "Above 12,500 ft MSL cabin pressure altitude, the required crew must use oxygen after 30 minutes. Above 14,000 ft, continuously. Above 15,000 ft, it must be offered to passengers."],
  ["What is spatial disorientation and how do you prevent it?", "A mismatch between what your body senses and reality, usually without outside visual reference. Prevent it by trusting the instruments and avoiding conditions that require them if you aren't qualified."],
  ["What is the difference between a special VFR clearance and normal VFR?", "Special VFR is an ATC clearance allowing flight in a surface area with less than basic VFR minimums — one statute mile visibility and clear of clouds. At night it requires an instrument rating and an instrument-capable aircraft."],
  ["What do you do if the engine fails on takeoff?", "Lower the nose to maintain airspeed, land more or less straight ahead within a reasonable arc, and don't attempt a turn back unless you have briefed a specific altitude at which it's achievable."],
  ["What is carburetor icing and when is it most likely?", "Ice forming in the venturi from the temperature drop and moisture. Most likely at high humidity and temperatures between roughly 20 and 70°F, especially at low power settings."],
  ["What are the required preflight actions under 91.103?", "All available information concerning the flight — weather, runway lengths, takeoff and landing distance, fuel, alternates, and delays."],
  ["What is a chandelle?", "A maximum performance climbing turn through 180 degrees, ending just above stall speed with wings level."],
  ["What is load factor and how does it change in a turn?", "The ratio of lift to weight. In a level 60-degree bank it doubles to 2 Gs, and stall speed increases by the square root of the load factor."],
  ["What are the two types of icing certification you should know about?", "Most training aircraft are not certified for flight into known icing. Structural and induction icing are the categories you plan around."],
];


/* The Daily panel is a registry so new aviation features can be dropped in later
   without touching layout. Each entry resolves its content from the calendar date. */
const DAILY_FEATURES = [
  {
    key: "acronym",
    label: "Acronym of the day",
    render: () => {
      const [code, meaning] = ofTheDay(ACRONYMS, "acronym");
      return { headline: code, body: meaning };
    },
  },
  {
    key: "airport",
    label: "Airport of the day",
    render: () => {
      const [ident, blurb] = ofTheDay(AIRPORTS, "airport");
      return { headline: ident, body: blurb };
    },
  },
  {
    key: "history",
    label: null,
    render: () => {
      const now = new Date();
      const md = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const hit = HISTORY.find(([d]) => d === md);
      return {
        label: hit ? "On this day" : "Aviation note",
        body: hit ? hit[1] : ofTheDay(HISTORY_POOL, "history"),
      };
    },
  },
  {
    key: "acs",
    label: "ACS area of the day",
    render: () => ({ body: ofTheDay(ACS_AREAS, "acs") }),
  },
  {
    key: "checkride",
    label: "Checkride question",
    wide: true,
    reveal: true,
    render: () => {
      const [q, a] = ofTheDay(CHECKRIDE, "checkride");
      return { question: q, answer: a };
    },
  },
];

export function DailyPanel() {
  const [revealed, setRevealed] = useState({});

  // recomputed only when the calendar date changes
  const iso = todayISO();
  const cards = useMemo(
    () => DAILY_FEATURES.map((f) => ({ ...f, ...f.render() })),
    [iso]
  );

  return (
    <div className="daily">
      {cards.map((c) => (
        <div key={c.key} className={c.wide ? "daily-item wide" : "daily-item"}>
          <p className="brief-k">{c.label}</p>

          {c.headline && <p className="daily-big">{c.headline}</p>}

          {c.question ? (
            <>
              <p className="daily-body" style={{ marginTop: 6, fontWeight: 600 }}>
                {c.question}
              </p>
              {revealed[c.key] ? (
                <p className="daily-body">{c.answer}</p>
              ) : (
                <button
                  className="av-btn"
                  style={{ marginTop: 8 }}
                  onClick={() => setRevealed((r) => ({ ...r, [c.key]: true }))}
                >
                  Show answer
                </button>
              )}
            </>
          ) : (
            <p className="daily-body" style={{ marginTop: c.headline ? 6 : 6 }}>
              {c.body}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/* ============================================================
   METAR CHALLENGE
   ============================================================ */
const CHALLENGE_BANK = [
  "KBTL 241853Z 27012G18KT 10SM FEW045 SCT250 24/13 A2998",
  "KBTL 250253Z 09006KT 3SM BR OVC008 12/11 A3005",
  "KBTL 251753Z 18015G25KT 1 1/2SM RA BKN006 OVC015 17/16 A2971",
  "KBTL 260153Z 00000KT 1/2SM FG VV002 08/08 A3012",
  "KBTL 261953Z 31009KT 10SM SKC 28/09 A2989",
  "KBTL 270453Z 24018G30KT 5SM -RA BKN025 OVC040 19/15 A2965",
];

export function MetarChallenge() {
  const [i, setI] = useState(() => Math.floor(Math.random() * CHALLENGE_BANK.length));
  const [guess, setGuess] = useState(null);
  const raw = CHALLENGE_BANK[i];
  const p = parseMetar(raw);
  const answer = flightCategory(p);

  const next = () => {
    setGuess(null);
    setI((x) => (x + 1 + Math.floor(Math.random() * (CHALLENGE_BANK.length - 1))) % CHALLENGE_BANK.length);
  };

  return (
    <div>
      <p className="brief-mono" style={{ fontSize: 13 }}>{raw}</p>
      <p className="brief-note" style={{ marginTop: 8 }}>What's the flight category?</p>
      <div style={{ marginTop: 8 }}>
        {["VFR", "MVFR", "IFR", "LIFR"].map((c) => (
          <button
            key={c}
            className={
              guess
                ? c === answer
                  ? "av-btn right"
                  : c === guess
                  ? "av-btn wrong"
                  : "av-btn"
                : "av-btn"
            }
            onClick={() => !guess && setGuess(c)}
          >
            {c}
          </button>
        ))}
      </div>
      {guess && (
        <div style={{ marginTop: 10 }}>
          <p className={guess === answer ? "verdict go" : "verdict nogo"}>
            {guess === answer ? "Correct" : `Not quite — it's ${answer}`}
          </p>
          <p className="brief-note">
            Ceiling {p.ceiling === null ? "none" : `${p.ceiling} ft`} · visibility{" "}
            {p.visSM} SM · wind{" "}
            {p.wind ? `${p.wind.dir}° at ${p.wind.speed}${p.wind.gust ? `G${p.wind.gust}` : ""} kt` : "calm"}
          </p>
          <button className="av-btn" style={{ marginTop: 8 }} onClick={next}>
            Next one
          </button>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   LOGBOOK + CURRENCY + CERTIFICATE PROGRESS
   ============================================================ */
const CERT_REQS = {
  private: {
    label: "Private Pilot (Part 61.109, airplane single-engine)",
    rows: [
      ["Total time", "total", 40],
      ["Dual received", "dual", 20],
      ["Solo", "solo", 10],
      ["Cross-country", "xc", 5],
      ["Night", "night", 3],
      ["Instrument training", "instrTrain", 3],
    ],
  },
  instrument: {
    label: "Instrument Rating (Part 61.65, airplane)",
    rows: [
      ["Cross-country PIC", "xc", 50],
      ["Instrument time", "instrTrain", 40],
      ["Dual instrument", "instrDual", 15],
    ],
  },
  commercial: {
    label: "Commercial Pilot (Part 61.129, airplane single-engine)",
    rows: [
      ["Total time", "total", 250],
      ["PIC", "pic", 100],
      ["Cross-country PIC", "xc", 50],
      ["Dual received", "dual", 20],
      ["Solo or performing PIC duties", "solo", 10],
    ],
  },
};

function totals(flights) {
  const t = {
    total: 0, dual: 0, pic: 0, solo: 0, xc: 0, night: 0,
    actualInst: 0, simInst: 0, sim: 0, dayLdg: 0, nightLdg: 0, approaches: 0,
  };
  flights.forEach((f) => {
    Object.keys(t).forEach((k) => {
      t[k] += num(f[k]);
    });
  });
  t.instrTrain = t.actualInst + t.simInst;
  t.instrDual = t.actualInst + t.simInst;
  return t;
}

function currency(flights, pilot) {
  const today = todayISO();
  const within = (days) => flights.filter((f) => daysBetween(f.date, today) <= days);

  const last90 = within(90);
  const dayLdg = last90.reduce((s, f) => s + num(f.dayLdg), 0);
  const nightLdg = last90.reduce((s, f) => s + num(f.nightLdg), 0);

  const last6mo = flights.filter((f) => daysBetween(f.date, today) <= 183);
  const appr = last6mo.reduce((s, f) => s + num(f.approaches), 0);

  const monthsSince = (iso) => (iso ? Math.floor(daysBetween(iso, today) / 30.44) : null);

  return [
    {
      label: "Passenger currency (day)",
      detail: "3 takeoffs and landings in 90 days",
      have: dayLdg + nightLdg,
      need: 3,
    },
    {
      label: "Passenger currency (night)",
      detail: "3 to a full stop, 1 hr after sunset to 1 hr before sunrise",
      have: nightLdg,
      need: 3,
    },
    {
      label: "Instrument currency",
      detail: "6 approaches, holding, and course intercepting in 6 months",
      have: appr,
      need: 6,
    },
    {
      label: "Flight review",
      detail: "Every 24 calendar months",
      months: monthsSince(pilot?.flightReview),
      limit: 24,
    },
    {
      label: `Medical (class ${pilot?.medicalClass || "3"})`,
      detail: "Duration depends on class and age",
      months: monthsSince(pilot?.medical),
      limit: pilot?.medicalClass === "1" ? 12 : pilot?.medicalClass === "2" ? 12 : 60,
    },
  ];
}

export function FlyingTab({ data, update }) {
  const [sub, setSub] = useState("logbook");
  return (
    <div>
      <nav className="av-subnav">
        {[
          ["logbook", "Logbook"],
          ["currency", "Currency"],
          ["progress", "Certificate"],
          ["minimums", "Minimums"],
          ["drill", "METAR drill"],
        ].map(([k, l]) => (
          <button key={k} className={sub === k ? "av-tab on" : "av-tab"} onClick={() => setSub(k)}>
            {l}
          </button>
        ))}
      </nav>
      {sub === "logbook" && <Logbook data={data} update={update} />}
      {sub === "currency" && <CurrencyView data={data} update={update} />}
      {sub === "progress" && <CertProgress data={data} update={update} />}
      {sub === "minimums" && <Minimums data={data} update={update} />}
      {sub === "drill" && (
        <section className="av-panel">
          <h3 className="av-h3">METAR challenge</h3>
          <MetarChallenge />
        </section>
      )}
    </div>
  );
}

const LOG_FIELDS = [
  ["total", "Total"],
  ["dual", "Dual"],
  ["pic", "PIC"],
  ["solo", "Solo"],
  ["xc", "XC"],
  ["night", "Night"],
  ["actualInst", "Actual"],
  ["simInst", "Sim inst"],
  ["sim", "Sim/ATD"],
  ["dayLdg", "Day ldg"],
  ["nightLdg", "Night ldg"],
  ["approaches", "Appr"],
];

function Logbook({ data, update }) {
  const [f, setF] = useState(blankFlight());
  const flights = [...(data.flights || [])].sort((a, b) => b.date.localeCompare(a.date));
  const t = totals(data.flights || []);

  const add = () => {
    if (!num(f.total)) return;
    update((d) => {
      d.flights = [...(d.flights || []), { ...f, id: uid() }];
      return d;
    });
    setF(blankFlight());
  };

  const remove = (id) =>
    update((d) => {
      d.flights = (d.flights || []).filter((x) => x.id !== id);
      return d;
    });

  return (
    <div>
      <section className="av-panel">
        <h3 className="av-h3">Totals</h3>
        <div className="tot-grid">
          {LOG_FIELDS.map(([k, l]) => (
            <div key={k} className="tot">
              <p className="brief-k">{l}</p>
              <p className="tot-v">{k.includes("Ldg") || k === "approaches" ? t[k] : fmt1(t[k])}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="av-panel">
        <h3 className="av-h3">Log a flight</h3>
        <div className="av-form">
          <input className="av-in sm" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          <input className="av-in sm" placeholder="Type (C172)" value={f.aircraft} onChange={(e) => setF({ ...f, aircraft: e.target.value })} />
          <input className="av-in sm" placeholder="Tail" value={f.ident} onChange={(e) => setF({ ...f, ident: e.target.value })} />
          <input className="av-in" placeholder="Route (KBTL-KAZO-KBTL)" value={f.route} onChange={(e) => setF({ ...f, route: e.target.value })} />
        </div>
        <div className="av-form">
          {LOG_FIELDS.map(([k, l]) => (
            <span key={k} className="av-num">
              <label className="av-lbl">{l}</label>
              <input
                className="av-in xs"
                type="number"
                step="0.1"
                value={f[k]}
                onChange={(e) => setF({ ...f, [k]: e.target.value })}
              />
            </span>
          ))}
        </div>
        <div className="av-form">
          <input className="av-in" placeholder="Remarks" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} />
          <button className="av-btn" onClick={add}>Add flight</button>
        </div>
        <p className="brief-note">Total time is required — everything else is optional.</p>
      </section>

      <section className="av-panel">
        <h3 className="av-h3">Flights ({flights.length})</h3>
        {flights.length === 0 ? (
          <p className="brief-note">Nothing logged yet.</p>
        ) : (
          <div className="av-scroll">
            <table className="brief-tbl">
              <thead>
                <tr>
                  <th>Date</th><th>Type</th><th>Route</th><th>Total</th>
                  <th>Dual</th><th>PIC</th><th>XC</th><th>Night</th><th>Ldg</th><th></th>
                </tr>
              </thead>
              <tbody>
                {flights.slice(0, 60).map((x) => (
                  <tr key={x.id}>
                    <td>{x.date}</td>
                    <td>{x.aircraft}</td>
                    <td>{x.route}</td>
                    <td>{fmt1(x.total)}</td>
                    <td>{fmt1(x.dual)}</td>
                    <td>{fmt1(x.pic)}</td>
                    <td>{fmt1(x.xc)}</td>
                    <td>{fmt1(x.night)}</td>
                    <td>{num(x.dayLdg) + num(x.nightLdg)}</td>
                    <td>
                      <button className="cd-x" onClick={() => remove(x.id)}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function CurrencyView({ data, update }) {
  const rows = currency(data.flights || [], data.pilot || {});
  const setPilot = (k, v) =>
    update((d) => {
      d.pilot = { ...(d.pilot || {}), [k]: v };
      return d;
    });

  return (
    <div>
      <section className="av-panel">
        <h3 className="av-h3">Currency</h3>
        {rows.map((r) => {
          const ok =
            r.need !== undefined ? r.have >= r.need : r.months !== null && r.months < r.limit;
          const unknown = r.need === undefined && r.months === null;
          return (
            <div key={r.label} className="cur-row">
              <span className={unknown ? "cur-dot unk" : ok ? "cur-dot ok" : "cur-dot bad"} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p className="cur-label">{r.label}</p>
                <p className="brief-note">{r.detail}</p>
              </div>
              <span className="cur-val">
                {r.need !== undefined
                  ? `${r.have} / ${r.need}`
                  : unknown
                  ? "not set"
                  : `${r.months} / ${r.limit} mo`}
              </span>
            </div>
          );
        })}
        <p className="brief-note" style={{ marginTop: 12 }}>
          A planning aid built from what you've logged here — not a legal record. Night landing
          currency in particular depends on full-stop landings in the right window, which this
          can't verify for you.
        </p>
      </section>

      <section className="av-panel">
        <h3 className="av-h3">Dates</h3>
        <div className="av-form">
          <label className="av-lbl">Last flight review</label>
          <input
            className="av-in sm"
            type="date"
            value={data.pilot?.flightReview || ""}
            onChange={(e) => setPilot("flightReview", e.target.value)}
          />
          <label className="av-lbl">Medical exam date</label>
          <input
            className="av-in sm"
            type="date"
            value={data.pilot?.medical || ""}
            onChange={(e) => setPilot("medical", e.target.value)}
          />
          <label className="av-lbl">Class</label>
          <select
            className="av-in xs"
            value={data.pilot?.medicalClass || "3"}
            onChange={(e) => setPilot("medicalClass", e.target.value)}
          >
            <option value="1">First</option>
            <option value="2">Second</option>
            <option value="3">Third</option>
          </select>
        </div>
      </section>
    </div>
  );
}

function CertProgress({ data, update }) {
  const goal = data.pilot?.goal || "private";
  const req = CERT_REQS[goal];
  const t = totals(data.flights || []);

  return (
    <section className="av-panel">
      <h3 className="av-h3">Certificate progress</h3>
      <div className="av-form">
        <label className="av-lbl">Working toward</label>
        <select
          className="av-in"
          value={goal}
          onChange={(e) =>
            update((d) => {
              d.pilot = { ...(d.pilot || {}), goal: e.target.value };
              return d;
            })
          }
        >
          <option value="private">Private Pilot</option>
          <option value="instrument">Instrument Rating</option>
          <option value="commercial">Commercial Pilot</option>
        </select>
      </div>

      <p className="brief-note" style={{ marginBottom: 12 }}>{req.label}</p>

      {req.rows.map(([label, key, need]) => {
        const have = num(t[key]);
        const pct = Math.min(100, (have / need) * 100);
        return (
          <div key={key} style={{ marginBottom: 12 }}>
            <p className="cur-label">
              {label} <span className="brief-note">{fmt1(have)} of {need} hrs</span>
            </p>
            <div className={pct >= 100 ? "gauge met" : "gauge"}>
              <span style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}

      <p className="brief-note" style={{ marginTop: 12 }}>
        Simplified minimums for planning. The regulation has specific sub-requirements — particular
        cross-country distances, solo night conditions, and test prep time — that this doesn't
        break out. Check the current FAR with your instructor.
      </p>
    </section>
  );
}

function Minimums({ data, update }) {
  const m = data.minimums || {};
  const setM = (k, v) =>
    update((d) => {
      d.minimums = { ...(d.minimums || {}), [k]: v };
      return d;
    });

  const fields = [
    ["ceiling", "Minimum ceiling (ft AGL)"],
    ["vis", "Minimum visibility (SM)"],
    ["wind", "Max total wind (kt)"],
    ["xwind", "Max crosswind (kt)"],
    ["gust", "Max gust (kt)"],
  ];

  return (
    <section className="av-panel">
      <h3 className="av-h3">Personal minimums</h3>
      <p className="brief-note" style={{ marginBottom: 12 }}>
        These drive the GO / CAUTION / NO-GO readout in the briefing strip on Home. Set them when
        you're on the ground and calm, not when you're deciding whether to fly.
      </p>
      {fields.map(([k, label]) => (
        <div key={k} className="av-form">
          <label className="av-lbl" style={{ minWidth: 180 }}>{label}</label>
          <input
            className="av-in sm"
            type="number"
            value={m[k] ?? ""}
            onChange={(e) => setM(k, e.target.value)}
          />
        </div>
      ))}
      <div className="av-form" style={{ marginTop: 8 }}>
        <label className="av-lbl" style={{ minWidth: 180 }}>Runways at {STATION}</label>
        <input
          className="av-in"
          value={data.pilot?.runways || ""}
          placeholder="05/23, 13/31"
          onChange={(e) =>
            update((d) => {
              d.pilot = { ...(d.pilot || {}), runways: e.target.value };
              return d;
            })
          }
        />
      </div>
      <p className="brief-note">
        Runway ends as pairs. Headings come from the numbers, so wind components stay correct if you
        edit them.
      </p>
    </section>
  );
}

/* ============================================================
   WEAK TOPICS + EXAM READINESS
   ============================================================ */
export function ReadinessView({ data, start, helpers }) {
  const { live, courseGrade } = helpers;
  const today = todayISO();

  const courses = live(data).map((c) => {
    const cards = data.cards.filter((x) => x.courseId === c.id);
    const seen = cards.reduce((s, x) => s + num(x.seen), 0);
    const missed = cards.reduce((s, x) => s + num(x.missed), 0);
    const avgBox = cards.length
      ? cards.reduce((s, x) => s + num(x.box), 0) / cards.length
      : 0;
    const accuracy = seen ? 1 - missed / seen : 0;
    const coverage = Math.min(1, cards.length / 40);
    const maturity = avgBox / 5;
    const dueNow = cards.filter((x) => !x.due || x.due <= today).length;
    const backlog = cards.length ? 1 - dueNow / cards.length : 1;

    const score = Math.round(
      100 * (coverage * 0.25 + maturity * 0.3 + accuracy * 0.3 + backlog * 0.15)
    );
    const label =
      cards.length === 0
        ? "No cards yet"
        : score >= 80
        ? "Exam ready"
        : score >= 60
        ? "Nearly there"
        : score >= 35
        ? "Needs work"
        : "Not ready";

    return { course: c, cards, score, label, accuracy, avgBox, dueNow, seen };
  });

  const topics = {};
  data.cards.forEach((c) => {
    if (!num(c.seen)) return;
    const key = `${c.courseId}||${c.topic || "untagged"}`;
    topics[key] = topics[key] || { ids: [], seen: 0, missed: 0 };
    topics[key].ids.push(c.id);
    topics[key].seen += num(c.seen);
    topics[key].missed += num(c.missed);
  });

  const weak = Object.entries(topics)
    .map(([key, v]) => {
      const [courseId, topic] = key.split("||");
      const code = data.courses.find((c) => c.id === courseId)?.code || "—";
      return { key, code, topic, ...v, rate: v.missed / v.seen };
    })
    .filter((x) => x.seen >= 3 && x.rate > 0)
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 8);

  return (
    <div>
      <section className="av-panel">
        <h3 className="av-h3">Exam readiness</h3>
        {courses.map((c) => (
          <div key={c.course.id} style={{ marginBottom: 14 }}>
            <p className="cur-label">
              {c.course.code} — {c.course.name}{" "}
              <span className={c.score >= 80 ? "rd-ok" : c.score >= 45 ? "rd-mid" : "rd-bad"}>
                {c.cards.length ? `${c.score} · ${c.label}` : c.label}
              </span>
            </p>
            <div className={c.score >= 80 ? "gauge met" : "gauge"}>
              <span style={{ width: `${c.score}%` }} />
            </div>
            <p className="brief-note">
              {c.cards.length} cards · avg box {c.avgBox.toFixed(1)} ·{" "}
              {c.seen ? `${Math.round(c.accuracy * 100)}% accuracy` : "never reviewed"} ·{" "}
              {c.dueNow} waiting
            </p>
          </div>
        ))}
        <p className="brief-note">
          Built from how many cards exist, how far they've climbed the boxes, your accuracy, and how
          much review is backed up. It measures your flashcards, not the exam.
        </p>
      </section>

      <section className="av-panel">
        <h3 className="av-h3">Weak topics</h3>
        {weak.length === 0 ? (
          <p className="brief-note">
            Nothing stands out yet — review some cards and the topics you keep missing will collect
            here.
          </p>
        ) : (
          weak.map((w) => (
            <div key={w.key} className="cur-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <p className="cur-label">
                  {w.code} · {w.topic}
                </p>
                <p className="brief-note">
                  missed {w.missed} of {w.seen} — {Math.round(w.rate * 100)}%
                </p>
              </div>
              <button
                className="av-btn"
                onClick={() => start({ ids: w.ids, label: `${w.code} — ${w.topic}` })}
              >
                Drill
              </button>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

/* ============================================================
   STYLES — leans on the .hub variables already in scope
   ============================================================ */
export const AV_CSS = `
  .hub .brief { width: 100%; }
  .hub .brief-head {
    display: flex; align-items: center; gap: 10px;
    width: 100%; text-align: left;
    background: none; border: none; padding: 0;
    color: inherit; cursor: pointer;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px; letter-spacing: .05em;
  }
  .hub .brief-line { flex: 1; min-width: 0; color: var(--faint); }
  .hub .brief-toggle { color: var(--faint); font-size: 9px; flex: none; }
  .hub .brief-dim { color: var(--faint); font-size: 11px; font-family: 'JetBrains Mono', monospace; }

  .hub .cat {
    flex: none;
    font-size: 10px; font-weight: 600; letter-spacing: .1em;
    padding: 3px 8px; border-radius: 999px;
    border: 1px solid currentColor;
  }
  .hub .cat-vfr  { color: #6FBF8F; }
  .hub .cat-mvfr { color: #6FA8D4; }
  .hub .cat-ifr  { color: #D98F5A; }
  .hub .cat-lifr { color: #C4705A; }

  .hub .brief-body {
    margin-top: 14px; padding-top: 14px;
    border-top: 1px solid var(--line);
    animation: briefIn .3s cubic-bezier(.22,.61,.36,1) both;
  }
  @keyframes briefIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }

  .hub .brief-grid {
    display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }
  .hub .brief-k {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px; letter-spacing: .16em; text-transform: uppercase;
    color: var(--faint); margin: 0;
  }
  .hub .brief-v { font-size: 13px; color: var(--bone); margin: 4px 0 0; font-weight: 500; }
  .hub .brief-note { font-size: 11px; color: var(--faint); margin: 4px 0 0; line-height: 1.5; }
  .hub .brief-mono {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px; color: var(--muted); margin: 6px 0 0; line-height: 1.7;
    word-spacing: .12em;
  }

  .hub .brief-tbl { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
  .hub .brief-tbl th {
    text-align: left; padding: 6px 8px 6px 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px; letter-spacing: .12em; text-transform: uppercase;
    color: var(--faint); border-bottom: 1px solid var(--edge); font-weight: 500;
  }
  .hub .brief-tbl td { padding: 7px 8px 7px 0; border-bottom: 1px solid var(--raised); }
  .hub .brief-tbl .rwy-best td { color: var(--green-bright); }

  .hub .mins-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .hub .mins {
    font-size: 11px; padding: 3px 9px; border-radius: 999px;
    border: 1px solid var(--line);
  }
  .hub .mins.ok { color: var(--green-bright); border-color: rgba(111,191,143,.35); }
  .hub .mins.bad { color: #C4705A; border-color: rgba(196,112,90,.4); }

  .hub .verdict { font-size: 13px; font-weight: 700; letter-spacing: .04em; margin: 10px 0 0; }
  .hub .verdict.go { color: var(--green-bright); }
  .hub .verdict.caution { color: #D98F5A; }
  .hub .verdict.nogo { color: #C4705A; }
  .hub .verdict .brief-note { display: inline; font-weight: 400; }

  /* mission */
  .hub .mission { list-style: none; padding: 0; margin: 0; }
  .hub .mission li {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 8px 0; border-bottom: 1px solid var(--raised);
    font-size: 14px;
  }
  .hub .mission li:last-child { border-bottom: none; }
  .hub .mission li.done { color: var(--faint); }
  .hub .mission .tick { color: var(--green-bright); flex: none; width: 14px; }
  .hub .mission .tick.tappable { cursor: pointer; }
  .hub .mission .urgent { color: #D98F5A; }
  .hub .mission .brief-note { margin-top: 2px; }
  .hub .mission li.done .tick { color: var(--faint); }
  .hub .mission-btn {
    background: none; border: none; padding: 0;
    color: var(--bone); text-align: left; cursor: pointer;
    font-size: 14px; font-family: inherit;
    border-bottom: 1px solid var(--edge);
  }
  .hub .mission-btn:hover { color: var(--green-bright); }

  /* countdowns */
  .hub .countdowns { list-style: none; padding: 0; margin: 0 0 14px; }
  .hub .countdowns li {
    display: flex; align-items: baseline; gap: 8px;
    padding: 7px 0; border-bottom: 1px solid var(--raised);
  }
  .hub .cd-num {
    font-family: 'JetBrains Mono', monospace;
    font-size: 20px; font-weight: 500; color: var(--bone);
    min-width: 34px; text-align: right;
  }
  .hub .cd-num.soon { color: var(--green-bright); }
  .hub .cd-num.past { color: var(--faint); }
  .hub .cd-unit { font-size: 10px; color: var(--faint); text-transform: uppercase; letter-spacing: .1em; }
  .hub .cd-title { flex: 1; font-size: 14px; }
  .hub .cd-x {
    background: none; border: none; color: var(--faint);
    cursor: pointer; font-size: 15px; padding: 0 4px;
  }
  .hub .cd-x:hover { color: #C4705A; }

  /* daily */
  .hub .daily {
    display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  }
  .hub .daily-item {
    border: 1px solid var(--line); border-radius: 12px;
    background: var(--surface); padding: 13px 14px 14px;
    min-width: 0;
  }
  .hub .daily-item.wide { grid-column: 1 / -1; }
  .hub .daily-big {
    font-size: 19px; font-weight: 700; letter-spacing: -.01em;
    color: var(--green-bright); margin: 7px 0 0;
  }
  .hub .daily-body { font-size: 13px; color: var(--muted); margin: 6px 0 0; line-height: 1.55; }

  /* generic aviation controls */
  .hub .av-panel {
    border: 1px solid var(--line); border-radius: 16px;
    background: var(--surface); padding: 18px 20px 20px;
    margin-bottom: 16px;
    box-shadow: 0 10px 30px rgba(0,0,0,.30);
  }
  .hub .av-h3 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px; font-weight: 500; margin: 0 0 14px;
    text-transform: uppercase; letter-spacing: .2em;
    color: var(--green-bright);
  }
  .hub .av-subnav { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 16px; }
  .hub .av-tab {
    background: none; border: none; color: var(--muted);
    font-size: 14px; font-weight: 500; padding: 7px 11px;
    border-radius: 8px; cursor: pointer;
    transition: color .15s ease, background .15s ease;
  }
  .hub .av-tab:hover { color: var(--bone); background: rgba(62,142,99,.10); }
  .hub .av-tab.on { color: var(--green-bright); background: rgba(62,142,99,.14); }

  .hub .av-form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
  .hub .av-in {
    background: var(--raised); color: var(--bone);
    border: 1px solid var(--line); border-radius: 10px;
    padding: 9px 12px; font-size: 13px; font-family: inherit;
    min-width: 170;
  }
  .hub .av-in.sm { min-width: 0; width: 150px; }
  .hub .av-in.xs { min-width: 0; width: 74px; font-family: 'JetBrains Mono', monospace; }
  .hub .av-lbl {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px; letter-spacing: .14em; text-transform: uppercase;
    color: var(--faint);
  }
  .hub .av-num { display: inline-flex; flex-direction: column; gap: 3px; }
  .hub .av-btn {
    border: 1px solid var(--edge); background: transparent;
    color: var(--bone); border-radius: 999px;
    padding: 8px 15px; font-size: 13px; font-weight: 500;
    cursor: pointer; margin-right: 8px;
    transition: border-color .15s ease, color .15s ease;
  }
  .hub .av-btn:hover { border-color: var(--green); color: var(--green-bright); }
  .hub .av-btn.right { border-color: var(--green-bright); color: var(--green-bright); }
  .hub .av-btn.wrong { border-color: #C4705A; color: #C4705A; }

  .hub .av-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }

  .hub .tot-grid {
    display: grid; gap: 10px;
    grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  }
  .hub .tot {
    border: 1px solid var(--line); border-radius: 10px;
    padding: 10px; text-align: center; background: rgba(9,13,11,.4);
  }
  .hub .tot-v {
    font-family: 'JetBrains Mono', monospace;
    font-size: 17px; color: var(--bone); margin: 5px 0 0;
  }

  .hub .cur-row {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 0; border-bottom: 1px solid var(--raised);
  }
  .hub .cur-row:last-child { border-bottom: none; }
  .hub .cur-dot { width: 9px; height: 9px; border-radius: 999px; flex: none; }
  .hub .cur-dot.ok { background: var(--green-bright); }
  .hub .cur-dot.bad { background: #C4705A; }
  .hub .cur-dot.unk { background: var(--edge); }
  .hub .cur-label { font-size: 14px; color: var(--bone); margin: 0; font-weight: 500; }
  .hub .cur-val {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px; color: var(--muted); flex: none;
  }

  .hub .rd-ok { color: var(--green-bright); font-size: 12px; font-weight: 400; }
  .hub .rd-mid { color: #D98F5A; font-size: 12px; font-weight: 400; }
  .hub .rd-bad { color: #C4705A; font-size: 12px; font-weight: 400; }

  @media (max-width: 720px) {
    .hub .av-in, .hub .av-in.sm { width: 100%; }
    .hub .av-in.xs { width: 68px; }
    .hub .av-panel { padding: 14px 14px 16px; border-radius: 14px; }
    .hub .brief-line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  }
`;
