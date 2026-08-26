import {
  academicsContext,
  cardsContext,
  goalsContext,
  missionContext,
  aviationContext,
  readinessContext,
  weatherContext,
  NOT_IMPLEMENTED,
} from "./cirrusContext.js";

/* ============================================================
   CIRRUS — STRUCTURED ACTION ENGINE (Stage 5)

   The model proposes; FlightPlan disposes. Gemini never executes
   anything. It returns a structured intent, which is treated as
   untrusted input and must survive, in order:

     1. shape check      — is this even an action object?
     2. registry lookup  — is the name on the explicit allowlist?
     3. validation       — do the parameters match the declared schema?
     4. permission       — decided HERE, from the registry, never by
                           the model
     5. handler          — a real function referenced by the registry,
                           never a name resolved from model output

   There is no dynamic dispatch. The registry is a Map, so a model
   returning "__proto__", "constructor", "toString" or any other
   inherited key finds nothing. There is no eval, no Function(), no
   SQL, no table selection, no URL construction, and no path by which
   model output reaches a Supabase query or a secret.

   PERMISSIONS ARE NOT NEGOTIABLE. Fields like requiresApproval,
   permission, execute_immediately, force or confirm are stripped from
   model output before anything else happens. If the registry says
   delete_flashcard is DELETE, it is DELETE, no matter what the model
   claims.

   STAGE 5 SCOPE: EDIT and DELETE actions are recognized, validated and
   classified, then return approval_required with a safe proposal. They
   do NOT execute. The approval transaction layer is Stage 6.
   ============================================================ */

/* ---------- permissions (application-defined, authoritative) ---------- */
export const PERMISSIONS = {
  READ: "read",
  CREATE: "create",
  EDIT: "edit",
  DELETE: "delete",
};

/** Only these run without approval. EDIT/DELETE never do in Stage 5. */
const AUTO_EXECUTE = new Set([PERMISSIONS.READ, PERMISSIONS.CREATE]);

/** Model-supplied fields that must never influence policy. */
const IGNORED_MODEL_FIELDS = [
  "requiresApproval",
  "requires_approval",
  "permission",
  "permissionLevel",
  "execute_immediately",
  "executeImmediately",
  "force",
  "confirm",
  "confirmed",
  "approved",
  "skipApproval",
  "admin",
];

/* ---------- limits ---------- */
const MAX_TEXT = 2000;
const MAX_SHORT_TEXT = 200;
const MAX_BULK_CARDS = 50;
const MAX_QUERY = 200;
const MAX_RESULTS = 50;
const MAX_HISTORY = 50;

/* ---------- ids ----------
   Same format as the rest of the app (App.jsx `uid`). Reimplemented
   rather than imported because cirrusActions must not import App.jsx:
   that would close an App -> cirrus -> cirrusActions -> App cycle. */
const uid = () => Math.random().toString(36).slice(2, 10);
const freshId = (list) => {
  let id = uid();
  const taken = new Set((list || []).map((x) => x && x.id));
  while (taken.has(id)) id = uid();
  return id;
};

/* ---------- results ---------- */
const success = (action, result) => ({ status: "success", action, result });
const approvalRequired = (action, permission, proposal) => ({
  status: "approval_required",
  action,
  permission,
  proposal,
  note: "Cirrus cannot perform this without your explicit approval.",
});
const failure = (code, message, action = null) => ({
  status: "error",
  code,
  ...(action ? { action } : {}),
  message,
});
const unsupported = (action, reason) => ({
  status: "unsupported",
  action,
  code: "not_implemented",
  message: reason,
});

/* ============================================================
   PARAMETER VALIDATION
   Explicit schemas. No loose object reaches a handler.
   ============================================================ */
function validateValue(name, spec, value) {
  const t = spec.type;

  if (t === "string") {
    if (typeof value !== "string") return `\`${name}\` must be a string`;
    if (!spec.allowEmpty && !value.trim()) return `\`${name}\` must not be empty`;
    const max = spec.maxLength || MAX_TEXT;
    if (value.length > max) return `\`${name}\` exceeds ${max} characters`;
    return null;
  }

  if (t === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `\`${name}\` must be a finite number`;
    }
    if (spec.min != null && value < spec.min) return `\`${name}\` must be at least ${spec.min}`;
    if (spec.max != null && value > spec.max) return `\`${name}\` must be at most ${spec.max}`;
    if (spec.integer && !Number.isInteger(value)) return `\`${name}\` must be a whole number`;
    return null;
  }

  if (t === "boolean") {
    if (typeof value !== "boolean") return `\`${name}\` must be true or false`;
    return null;
  }

  if (t === "enum") {
    if (typeof value !== "string" || !spec.values.includes(value)) {
      return `\`${name}\` must be one of: ${spec.values.join(", ")}`;
    }
    return null;
  }

  if (t === "objectArray") {
    if (!Array.isArray(value)) return `\`${name}\` must be an array`;
    if (!value.length) return `\`${name}\` must not be empty`;
    const max = spec.maxItems || MAX_BULK_CARDS;
    if (value.length > max) return `\`${name}\` exceeds ${max} items`;
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return `\`${name}[${i}]\` must be an object`;
      }
      const err = validateParams(spec.item, item, `${name}[${i}].`);
      if (err) return err;
    }
    return null;
  }

  return `\`${name}\` has an unsupported type`;
}

/**
 * Validates against an explicit schema and returns a *new* object
 * containing only declared keys. Unknown keys are rejected rather than
 * passed through, so nothing undeclared reaches a handler.
 */
export function validateParams(schema, params, prefix = "") {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return `${prefix || "parameters"} must be an object`;
  }

  for (const key of Object.keys(params)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      return `unknown parameter \`${prefix}${key}\``;
    }
  }

  for (const [key, spec] of Object.entries(schema)) {
    const value = params[key];
    if (value === undefined || value === null) {
      if (spec.required) return `missing required parameter \`${prefix}${key}\``;
      continue;
    }
    const err = validateValue(`${prefix}${key}`, spec, value);
    if (err) return err;
  }

  return null;
}

function cleanParams(schema, params) {
  const out = {};
  for (const key of Object.keys(schema)) {
    if (params[key] !== undefined && params[key] !== null) out[key] = params[key];
  }
  return out;
}

/* ============================================================
   WRITE SAFETY
   Every write goes through `update(fn)`, whose updater receives the
   CURRENT persisted state at apply time — not any snapshot read
   earlier. The merge happens inside that updater, so a change the user
   made in between is preserved. Appends never overwrite: an existing
   id always wins and the new record takes a fresh one.
   ============================================================ */
function appendRecord(update, listKey, record) {
  update((d) => {
    const list = d[listKey] || [];
    // Re-check against current state, not the state read a moment ago.
    const rec = list.some((x) => x && x.id === record.id)
      ? { ...record, id: freshId(list) }
      : record;
    return { ...d, [listKey]: [...list, rec] };
  });
}

function appendMany(update, listKey, records) {
  update((d) => {
    const list = d[listKey] || [];
    const taken = new Set(list.map((x) => x && x.id));
    const safe = records.map((r) => {
      let rec = r;
      if (taken.has(rec.id)) rec = { ...rec, id: freshId([...list, ...records]) };
      taken.add(rec.id);
      return rec;
    });
    return { ...d, [listKey]: [...list, ...safe] };
  });
}

/* ---------- shared lookups ---------- */
const courseByCode = (data, code) =>
  (data.courses || []).find(
    (c) => String(c.code || "").toLowerCase() === String(code || "").toLowerCase()
  );

const requireUpdate = (rt) =>
  typeof rt.update === "function" ? null : failure("unavailable", "No write channel is available.");

/* ============================================================
   ACTION REGISTRY
   A Map, so model-supplied names can never resolve to inherited
   properties. Each entry names a real handler function; no handler is
   ever looked up from a model-provided string.
   ============================================================ */
const REGISTRY = new Map();

const define = (name, def) => REGISTRY.set(name, { name, ...def });

/* ---------------- READ ---------------- */
define("get_due_cards", {
  permission: PERMISSIONS.READ,
  description: "Cards due for review now, with counts and weak topics.",
  schema: {},
  handler: (_p, rt) => success("get_due_cards", cardsContext(rt.data, rt.helpers)),
});

define("search_cards", {
  permission: PERMISSIONS.READ,
  description: "Find cards by text in the front, back or topic.",
  schema: {
    query: { type: "string", required: true, maxLength: MAX_QUERY },
    courseCode: { type: "string", maxLength: MAX_SHORT_TEXT },
    limit: { type: "number", min: 1, max: MAX_RESULTS, integer: true },
  },
  handler: (p, rt) => {
    const q = p.query.trim().toLowerCase();
    const limit = p.limit || 10;
    const course = p.courseCode ? courseByCode(rt.data, p.courseCode) : null;
    if (p.courseCode && !course) {
      return failure("not_found", `No course with code "${p.courseCode}".`, "search_cards");
    }
    const matches = (rt.data.cards || [])
      .filter((c) => !course || c.courseId === course.id)
      .filter((c) =>
        [c.front, c.back, c.topic].some((f) => String(f || "").toLowerCase().includes(q))
      )
      .slice(0, limit)
      .map((c) => ({
        id: c.id,
        front: String(c.front || "").slice(0, MAX_SHORT_TEXT),
        topic: c.topic || "untagged",
        box: c.box,
        due: c.due,
        seen: c.seen,
        missed: c.missed,
      }));
    return success("search_cards", { query: p.query, matches, count: matches.length });
  },
});

define("get_goals", {
  permission: PERMISSIONS.READ,
  description: "Active goals with progress and pace.",
  schema: {},
  handler: (_p, rt) => success("get_goals", goalsContext(rt.data, rt.helpers)),
});

define("get_today_mission", {
  permission: PERMISSIONS.READ,
  description: "Today's mission items and completion.",
  schema: {},
  handler: (_p, rt) => success("get_today_mission", missionContext(rt.data, rt.helpers)),
});

define("get_grade_summary", {
  permission: PERMISSIONS.READ,
  description: "Course grades, targets and gaps.",
  schema: {},
  handler: (_p, rt) => success("get_grade_summary", academicsContext(rt.data, rt.helpers)),
});

define("get_aviation_gpa", {
  permission: PERMISSIONS.READ,
  description: "GPA across aviation-tier courses.",
  schema: {},
  handler: (_p, rt) => {
    const a = academicsContext(rt.data, rt.helpers);
    if (a.state) return success("get_aviation_gpa", a);
    return success("get_aviation_gpa", { gpa: a.gpa.aviation, note: a.gpa.note });
  },
});

define("get_non_aviation_gpa", {
  permission: PERMISSIONS.READ,
  description: "GPA across non-aviation courses.",
  schema: {},
  handler: (_p, rt) => {
    const a = academicsContext(rt.data, rt.helpers);
    if (a.state) return success("get_non_aviation_gpa", a);
    return success("get_non_aviation_gpa", { gpa: a.gpa.nonAviation, note: a.gpa.note });
  },
});

define("get_logbook_totals", {
  permission: PERMISSIONS.READ,
  description: "Logbook hour totals and currency.",
  schema: {},
  handler: (_p, rt) => {
    const av = aviationContext(rt.data, rt.helpers);
    return success("get_logbook_totals", { logbook: av.logbook, currency: av.currency });
  },
});

define("get_recent_flights", {
  permission: PERMISSIONS.READ,
  description: "The most recent logbook entries.",
  schema: { limit: { type: "number", min: 1, max: 20, integer: true } },
  handler: (p, rt) => {
    const av = aviationContext(rt.data, rt.helpers);
    const recent = Array.isArray(av.recentFlights)
      ? av.recentFlights.slice(0, p.limit || 5)
      : av.recentFlights;
    return success("get_recent_flights", { recentFlights: recent });
  },
});

define("get_readiness", {
  permission: PERMISSIONS.READ,
  description: "Exam readiness by course, strongest and weakest areas.",
  schema: {},
  handler: (_p, rt) => success("get_readiness", readinessContext(rt.data, rt.helpers)),
});

define("get_weak_topics", {
  permission: PERMISSIONS.READ,
  description: "Topics with the worst review accuracy.",
  schema: {},
  handler: (_p, rt) => {
    const r = readinessContext(rt.data, rt.helpers);
    if (r.state) return success("get_weak_topics", r);
    return success("get_weak_topics", { weakestTopics: r.weakestTopics });
  },
});

define("get_current_weather", {
  permission: PERMISSIONS.READ,
  description: "Current observation, flight category and personal minimums.",
  schema: {},
  handler: (_p, rt) => success("get_current_weather", weatherContext(rt.data, rt.weather)),
});

/* ---------------- CREATE ---------------- */
const CARD_ITEM_SCHEMA = {
  front: { type: "string", required: true, maxLength: MAX_TEXT },
  back: { type: "string", required: true, maxLength: MAX_TEXT },
  topic: { type: "string", maxLength: MAX_SHORT_TEXT },
};

function buildCard(courseId, item, todayISO) {
  return {
    id: uid(),
    courseId,
    topic: (item.topic || "").trim(),
    front: item.front.trim(),
    back: item.back.trim(),
    frontImg: "",
    backImg: "",
    box: 1,
    ivl: 0,
    due: todayISO(),
    lastReviewed: null,
    seen: 0,
    missed: 0,
  };
}

define("create_flashcard", {
  permission: PERMISSIONS.CREATE,
  description: "Add one flashcard to a course.",
  schema: {
    front: { type: "string", required: true, maxLength: MAX_TEXT },
    back: { type: "string", required: true, maxLength: MAX_TEXT },
    topic: { type: "string", maxLength: MAX_SHORT_TEXT },
    courseCode: { type: "string", required: true, maxLength: MAX_SHORT_TEXT },
  },
  handler: (p, rt) => {
    const blocked = requireUpdate(rt);
    if (blocked) return blocked;
    const course = courseByCode(rt.data, p.courseCode);
    if (!course) {
      return failure("not_found", `No course with code "${p.courseCode}".`, "create_flashcard");
    }
    const card = buildCard(course.id, p, rt.helpers.todayISO);
    // Informational only — a near-duplicate is still created, never
    // merged over an existing record.
    const duplicate = (rt.data.cards || []).some(
      (c) =>
        c.courseId === course.id &&
        String(c.front || "").trim().toLowerCase() === card.front.toLowerCase()
    );
    appendRecord(rt.update, "cards", card);
    return success("create_flashcard", {
      id: card.id,
      course: course.code,
      front: card.front,
      topic: card.topic || "untagged",
      duplicateOfExistingFront: duplicate,
    });
  },
});

define("create_flashcards", {
  permission: PERMISSIONS.CREATE,
  description: "Add several flashcards to one course.",
  schema: {
    courseCode: { type: "string", required: true, maxLength: MAX_SHORT_TEXT },
    cards: { type: "objectArray", required: true, maxItems: MAX_BULK_CARDS, item: CARD_ITEM_SCHEMA },
  },
  handler: (p, rt) => {
    const blocked = requireUpdate(rt);
    if (blocked) return blocked;
    const course = courseByCode(rt.data, p.courseCode);
    if (!course) {
      return failure("not_found", `No course with code "${p.courseCode}".`, "create_flashcards");
    }
    const built = p.cards.map((item) => buildCard(course.id, item, rt.helpers.todayISO));
    appendMany(rt.update, "cards", built);
    return success("create_flashcards", {
      course: course.code,
      created: built.length,
      ids: built.map((c) => c.id),
    });
  },
});

define("create_study_session", {
  permission: PERMISSIONS.CREATE,
  description: "Log a completed study session.",
  schema: {
    courseCode: { type: "string", required: true, maxLength: MAX_SHORT_TEXT },
    minutes: { type: "number", required: true, min: 1, max: 1440, integer: true },
    what: { type: "string", maxLength: MAX_SHORT_TEXT },
  },
  handler: (p, rt) => {
    const blocked = requireUpdate(rt);
    if (blocked) return blocked;
    const course = courseByCode(rt.data, p.courseCode);
    if (!course) {
      return failure("not_found", `No course with code "${p.courseCode}".`, "create_study_session");
    }
    const session = {
      id: uid(),
      courseId: course.id,
      date: rt.helpers.todayISO(),
      minutes: p.minutes,
      what: (p.what || "").trim(),
    };
    appendRecord(rt.update, "sessions", session);
    return success("create_study_session", {
      id: session.id,
      course: course.code,
      minutes: session.minutes,
      date: session.date,
    });
  },
});

define("create_goal", {
  permission: PERMISSIONS.CREATE,
  description: "Create a goal with a target.",
  schema: {
    title: { type: "string", required: true, maxLength: MAX_SHORT_TEXT },
    target: { type: "number", required: true, min: 0, max: 100000 },
    type: { type: "enum", values: ["count", "hours", "miles", "gymdays", "checklist"] },
    domain: { type: "enum", values: ["academic", "personal"] },
    unit: { type: "string", maxLength: 32 },
    deadline: { type: "string", maxLength: 10 },
    courseCode: { type: "string", maxLength: MAX_SHORT_TEXT },
  },
  handler: (p, rt) => {
    const blocked = requireUpdate(rt);
    if (blocked) return blocked;
    if (p.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(p.deadline)) {
      return failure("invalid_parameters", "`deadline` must be YYYY-MM-DD.", "create_goal");
    }
    const domain = p.domain || "academic";
    let courseId = "";
    if (domain !== "personal" && p.courseCode) {
      const course = courseByCode(rt.data, p.courseCode);
      if (!course) {
        return failure("not_found", `No course with code "${p.courseCode}".`, "create_goal");
      }
      courseId = course.id;
    }
    const type = p.type || "count";
    const goal = {
      id: uid(),
      title: p.title.trim(),
      type,
      domain,
      courseId,
      target: type === "checklist" ? 0 : Number(p.target),
      unit:
        type === "hours" ? "hrs" : type === "miles" ? "mi" : type === "gymdays" ? "days" : (p.unit || "").trim(),
      deadline: p.deadline || "",
      start: rt.helpers.todayISO(),
      steps: [],
      log: [],
      done: false,
    };
    appendRecord(rt.update, "goals", goal);
    return success("create_goal", { id: goal.id, title: goal.title, target: goal.target, unit: goal.unit });
  },
});

/* Domains that genuinely do not exist. Declared so the model gets a
   clean, honest refusal instead of an "unknown action" — and so nobody
   is tempted to invent storage for them. */
define("create_practice_review", {
  permission: PERMISSIONS.CREATE,
  description: "Not supported: review sessions are not stored as records.",
  schema: {},
  handler: () =>
    unsupported(
      "create_practice_review",
      "FlightPlan runs reviews from the existing card queue and does not persist review sessions as records, so there is nothing to create."
    ),
});

define("create_mistake_entry", {
  permission: PERMISSIONS.CREATE,
  description: "Not supported: FlightPlan has no mistake journal.",
  schema: {},
  handler: () =>
    unsupported("create_mistake_entry", NOT_IMPLEMENTED("FlightPlan has no mistake journal feature").reason),
});

/* ---------------- PROTECTED (EDIT / DELETE) ----------------
   Registered and classified, deliberately NOT executable in Stage 5.
   Each builds a safe proposal describing what *would* change, resolved
   against current state so the user sees the real target. */
function describeCard(data, id) {
  const card = (data.cards || []).find((c) => c.id === id);
  if (!card) return null;
  return {
    id: card.id,
    front: String(card.front || "").slice(0, MAX_SHORT_TEXT),
    topic: card.topic || "untagged",
    box: card.box,
    due: card.due,
  };
}

define("update_flashcard", {
  permission: PERMISSIONS.EDIT,
  description: "Change a flashcard's text or topic.",
  schema: {
    id: { type: "string", required: true, maxLength: 64 },
    front: { type: "string", maxLength: MAX_TEXT },
    back: { type: "string", maxLength: MAX_TEXT },
    topic: { type: "string", maxLength: MAX_SHORT_TEXT, allowEmpty: true },
  },
  proposal: (p, rt) => {
    const current = describeCard(rt.data, p.id);
    if (!current) return { error: `No card with id "${p.id}".` };
    const changes = {};
    ["front", "back", "topic"].forEach((k) => {
      if (p[k] !== undefined) changes[k] = String(p[k]).slice(0, MAX_SHORT_TEXT);
    });
    if (!Object.keys(changes).length) return { error: "No changes were specified." };
    return { target: current, changes };
  },
});

define("delete_flashcard", {
  permission: PERMISSIONS.DELETE,
  description: "Remove a flashcard.",
  schema: { id: { type: "string", required: true, maxLength: 64 } },
  proposal: (p, rt) => {
    const current = describeCard(rt.data, p.id);
    if (!current) return { error: `No card with id "${p.id}".` };
    return { target: current, effect: "The card and its review progress would be removed." };
  },
});

define("update_goal", {
  permission: PERMISSIONS.EDIT,
  description: "Change a goal's title, target or deadline.",
  schema: {
    id: { type: "string", required: true, maxLength: 64 },
    title: { type: "string", maxLength: MAX_SHORT_TEXT },
    target: { type: "number", min: 0, max: 100000 },
    deadline: { type: "string", maxLength: 10 },
    done: { type: "boolean" },
  },
  proposal: (p, rt) => {
    const goal = (rt.data.goals || []).find((g) => g.id === p.id);
    if (!goal) return { error: `No goal with id "${p.id}".` };
    const changes = {};
    ["title", "target", "deadline", "done"].forEach((k) => {
      if (p[k] !== undefined) changes[k] = p[k];
    });
    if (!Object.keys(changes).length) return { error: "No changes were specified." };
    return {
      target: { id: goal.id, title: goal.title, current: goal.target, unit: goal.unit },
      changes,
    };
  },
});

define("delete_goal", {
  permission: PERMISSIONS.DELETE,
  description: "Remove a goal.",
  schema: { id: { type: "string", required: true, maxLength: 64 } },
  proposal: (p, rt) => {
    const goal = (rt.data.goals || []).find((g) => g.id === p.id);
    if (!goal) return { error: `No goal with id "${p.id}".` };
    return {
      target: { id: goal.id, title: goal.title },
      effect: "The goal and its logged progress would be removed.",
    };
  },
});

define("update_logbook_entry", {
  permission: PERMISSIONS.EDIT,
  description: "Change a logbook flight entry.",
  schema: {
    id: { type: "string", required: true, maxLength: 64 },
    total: { type: "number", min: 0, max: 24 },
    route: { type: "string", maxLength: MAX_SHORT_TEXT },
    aircraft: { type: "string", maxLength: 32 },
    remarks: { type: "string", maxLength: MAX_TEXT, allowEmpty: true },
  },
  proposal: (p, rt) => {
    const f = (rt.data.flights || []).find((x) => x.id === p.id);
    if (!f) return { error: `No logbook entry with id "${p.id}".` };
    const changes = {};
    ["total", "route", "aircraft", "remarks"].forEach((k) => {
      if (p[k] !== undefined) changes[k] = p[k];
    });
    if (!Object.keys(changes).length) return { error: "No changes were specified." };
    return {
      target: { id: f.id, date: f.date, aircraft: f.aircraft, total: f.total },
      changes,
      caution: "Editing the logbook changes hour totals and currency.",
    };
  },
});

define("delete_logbook_entry", {
  permission: PERMISSIONS.DELETE,
  description: "Remove a logbook flight entry.",
  schema: { id: { type: "string", required: true, maxLength: 64 } },
  proposal: (p, rt) => {
    const f = (rt.data.flights || []).find((x) => x.id === p.id);
    if (!f) return { error: `No logbook entry with id "${p.id}".` };
    return {
      target: { id: f.id, date: f.date, aircraft: f.aircraft, total: f.total },
      effect: "Hour totals and currency would change.",
      caution: "Logbook entries are a flight record; removal is not routine.",
    };
  },
});

/* ============================================================
   PROTECTED EXECUTION (Stage 6)

   Protected actions still have no `handler`, so executeCirrusAction()
   — the path model output reaches — still cannot run them. They are
   executed only through executeProtectedAction(), which the approval
   manager calls after a real user approval.

   This function revalidates on its own rather than trusting its
   caller: the target must still exist and must still match the
   fingerprint taken when the proposal was made. A second guard runs
   inside the update() updater, against the state React actually
   applies to, so a change landing in that final gap makes the write a
   no-op instead of an overwrite.
   ============================================================ */

/** FNV-1a, same approach aviation.jsx already uses for day seeds. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/* Which fields make a record "materially changed". FlightPlan keeps no
   per-record updated_at or version, so the fingerprint is a stable hash
   of the fields that matter — no schema change, no migration. */
const PROTECTED_TARGETS = {
  update_flashcard: { list: "cards", fields: ["front", "back", "topic", "box", "due"] },
  delete_flashcard: { list: "cards", fields: ["front", "back", "topic", "box", "due"] },
  update_goal: { list: "goals", fields: ["title", "target", "unit", "deadline", "done"] },
  delete_goal: { list: "goals", fields: ["title", "target", "unit", "deadline", "done"] },
  update_logbook_entry: { list: "flights", fields: ["date", "aircraft", "route", "total", "remarks"] },
  delete_logbook_entry: { list: "flights", fields: ["date", "aircraft", "route", "total", "remarks"] },
};

const findTarget = (data, listKey, id) => (data[listKey] || []).find((r) => r && r.id === id);

/** Fingerprint of a record as it stands right now, or null if absent. */
export function fingerprintTarget(actionName, data, id) {
  const spec = PROTECTED_TARGETS[actionName];
  if (!spec) return null;
  const rec = findTarget(data || {}, spec.list, id);
  if (!rec) return null;
  return hash(spec.fields.map((f) => `${f}=${JSON.stringify(rec[f] ?? null)}`).join("|"));
}

/** Human-readable description of the target, from trusted app data. */
export function describeTarget(actionName, data, id) {
  const spec = PROTECTED_TARGETS[actionName];
  if (!spec) return null;
  const rec = findTarget(data || {}, spec.list, id);
  if (!rec) return null;
  if (spec.list === "cards") {
    return { kind: "flashcard", id: rec.id, front: String(rec.front || "").slice(0, MAX_SHORT_TEXT),
             topic: rec.topic || "untagged", box: rec.box, due: rec.due };
  }
  if (spec.list === "goals") {
    return { kind: "goal", id: rec.id, title: rec.title, target: rec.target, unit: rec.unit,
             deadline: rec.deadline || null, done: Boolean(rec.done) };
  }
  return { kind: "logbook entry", id: rec.id, date: rec.date, aircraft: rec.aircraft || null,
           route: rec.route || null, total: rec.total };
}

/** The narrow mutation each protected action performs. */
const PROTECTED_APPLY = {
  update_flashcard: (list, p) =>
    list.map((c) =>
      c.id === p.id
        ? {
            ...c,
            ...(p.front !== undefined ? { front: p.front } : {}),
            ...(p.back !== undefined ? { back: p.back } : {}),
            ...(p.topic !== undefined ? { topic: p.topic } : {}),
          }
        : c
    ),
  delete_flashcard: (list, p) => list.filter((c) => c.id !== p.id),
  update_goal: (list, p) =>
    list.map((g) =>
      g.id === p.id
        ? {
            ...g,
            ...(p.title !== undefined ? { title: p.title } : {}),
            ...(p.target !== undefined ? { target: p.target } : {}),
            ...(p.deadline !== undefined ? { deadline: p.deadline } : {}),
            ...(p.done !== undefined ? { done: p.done } : {}),
          }
        : g
    ),
  delete_goal: (list, p) => list.filter((g) => g.id !== p.id),
  update_logbook_entry: (list, p) =>
    list.map((f) =>
      f.id === p.id
        ? {
            ...f,
            ...(p.total !== undefined ? { total: p.total } : {}),
            ...(p.route !== undefined ? { route: p.route } : {}),
            ...(p.aircraft !== undefined ? { aircraft: p.aircraft } : {}),
            ...(p.remarks !== undefined ? { remarks: p.remarks } : {}),
          }
        : f
    ),
  delete_logbook_entry: (list, p) => list.filter((f) => f.id !== p.id),
};

export const CONFLICT = "conflict_detected";
export const TARGET_MISSING = "target_missing";

/**
 * Executes an approved protected action. Only the approval manager
 * should call this, and it revalidates regardless of who does.
 */
export function executeProtectedAction(actionName, params, runtime, expectedFingerprint) {
  const spec = PROTECTED_TARGETS[actionName];
  const def = REGISTRY.get(actionName);
  if (!spec || !def || AUTO_EXECUTE.has(def.permission)) {
    return failure("unknown_action", "Not a protected action.", actionName);
  }
  if (typeof runtime.update !== "function") {
    return failure("unavailable", "No write channel is available.", actionName);
  }

  const data = runtime.data || {};
  const current = findTarget(data, spec.list, params.id);

  // 1. does the target still exist?
  if (!current) {
    return failure(
      TARGET_MISSING,
      "That record no longer exists — it may already have been removed.",
      actionName
    );
  }

  // 2. has it changed materially since the proposal was made?
  const nowPrint = fingerprintTarget(actionName, data, params.id);
  if (expectedFingerprint && nowPrint !== expectedFingerprint) {
    return failure(
      CONFLICT,
      "That record changed after the proposal was made, so it was left untouched. Ask again to work from the current version.",
      actionName
    );
  }

  const before = describeTarget(actionName, data, params.id);

  // 3. apply narrowly, with a final guard against the state React
  //    actually commits to. A mismatch here yields a no-op, never an
  //    overwrite.
  let applied = true;
  runtime.update((d) => {
    const list = d[spec.list] || [];
    const live = list.find((r) => r && r.id === params.id);
    if (!live) {
      applied = false;
      return d;
    }
    const livePrint = hash(
      spec.fields.map((f) => `${f}=${JSON.stringify(live[f] ?? null)}`).join("|")
    );
    if (expectedFingerprint && livePrint !== expectedFingerprint) {
      applied = false;
      return d;
    }
    return { ...d, [spec.list]: PROTECTED_APPLY[actionName](list, params) };
  });

  if (!applied) {
    return failure(
      CONFLICT,
      "That record changed as the action was applied, so it was left untouched.",
      actionName
    );
  }

  return success(actionName, {
    target: before,
    applied: actionName.startsWith("delete_") ? "deleted" : "updated",
  });
}

/* ---------- registry introspection (safe, no handlers exposed) ---------- */
export function listActions() {
  return [...REGISTRY.values()].map((a) => ({
    action: a.name,
    permission: a.permission,
    description: a.description,
    parameters: Object.entries(a.schema).map(([k, v]) => ({
      name: k,
      type: v.type,
      required: Boolean(v.required),
    })),
    autoExecutes: AUTO_EXECUTE.has(a.permission),
  }));
}

export const isKnownAction = (name) =>
  typeof name === "string" && REGISTRY.has(name);

export const permissionFor = (name) =>
  REGISTRY.has(name) ? REGISTRY.get(name).permission : null;

/* ============================================================
   ACTION HISTORY
   Session-local and in-memory only. Nothing is persisted, so no new
   table or schema is introduced. Metadata only — never parameters,
   never card or note text, never tokens or keys.
   ============================================================ */
/** Lifecycle points a protected action can pass through. */
export const HISTORY_EVENTS = {
  PROPOSED: "proposed",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXPIRED: "expired",
  CONFLICT: "conflict",
  EXECUTED: "executed",
  FAILED: "failed",
};

export function createActionHistory(max = MAX_HISTORY) {
  const entries = [];
  return {
    record(entry) {
      entries.push({
        at: new Date().toISOString(),
        action: entry.action || "unknown",
        permission: entry.permission || null,
        status: entry.status,
        // Lifecycle point, when the approval layer supplies one.
        event: entry.event || null,
        // Correlates every entry for one pending transaction.
        transactionId: entry.transactionId || null,
        approval: entry.status === "approval_required" ? "pending" : "not_required",
        ok: entry.status === "success",
        summary: String(entry.summary || "").slice(0, 120),
      });
      if (entries.length > max) entries.splice(0, entries.length - max);
      return entries[entries.length - 1];
    },
    list: () => entries.slice(),
    clear: () => entries.splice(0, entries.length),
  };
}

/* ============================================================
   EXECUTE
   The single entry point. `rawIntent` is untrusted model output.
   ============================================================ */
export function executeCirrusAction(rawIntent, runtime = {}) {
  const history = runtime.history;
  const finish = (result, permission) => {
    if (history && typeof history.record === "function") {
      history.record({
        action: result.action || (typeof rawIntent?.action === "string" ? rawIntent.action.slice(0, 64) : "unknown"),
        permission: permission || null,
        status: result.status,
        summary: result.status === "error" ? result.code : result.action || "",
      });
    }
    return result;
  };

  /* 1. shape */
  if (typeof rawIntent !== "object" || rawIntent === null || Array.isArray(rawIntent)) {
    return finish(failure("invalid_intent", "Action must be an object."));
  }

  const name = rawIntent.action;
  if (typeof name !== "string" || !name) {
    return finish(failure("invalid_intent", "Action must include an `action` name."));
  }

  /* 2. registry — a Map, so inherited keys resolve to nothing */
  if (!REGISTRY.has(name)) {
    return finish(
      failure("unknown_action", `"${String(name).slice(0, 64)}" is not an action Cirrus can take.`)
    );
  }
  const def = REGISTRY.get(name);

  /* 3. strip anything the model said about policy */
  const attemptedOverride = IGNORED_MODEL_FIELDS.filter((f) =>
    Object.prototype.hasOwnProperty.call(rawIntent, f)
  );

  /* 4. validate parameters */
  const rawParams =
    rawIntent.parameters === undefined || rawIntent.parameters === null ? {} : rawIntent.parameters;
  const err = validateParams(def.schema, rawParams);
  if (err) return finish(failure("invalid_parameters", err, name), def.permission);
  const params = cleanParams(def.schema, rawParams);

  /* 5. permission — from the registry, never from the model */
  const permission = def.permission;

  if (!AUTO_EXECUTE.has(permission)) {
    const proposal = def.proposal ? def.proposal(params, runtime) : { params };
    if (proposal && proposal.error) {
      return finish(failure("not_found", proposal.error, name), permission);
    }
    return finish(
      {
        ...approvalRequired(name, permission, proposal),
        ...(attemptedOverride.length
          ? { ignoredModelFields: attemptedOverride }
          : {}),
      },
      permission
    );
  }

  /* 6. execute — a real function from the registry entry */
  try {
    const result = def.handler(params, runtime);
    return finish(
      attemptedOverride.length ? { ...result, ignoredModelFields: attemptedOverride } : result,
      permission
    );
  } catch {
    // Never surface a raw exception: it can carry internal detail.
    return finish(failure("action_failed", "That action could not be completed.", name), permission);
  }
}
