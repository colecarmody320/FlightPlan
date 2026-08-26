import { supabase } from "./supabase.js";
import { CIRRUS_MODES } from "./cirrusShared.js";
import { buildCirrusSystemPrompt, CIRRUS_TASK_MODES } from "./cirrusPersonality.js";

/* ============================================================
   CIRRUS ASSISTANT SERVICE
   The only place the frontend talks to the Cirrus backend. React
   components call sendCirrusMessage() and never see fetch, Supabase
   functions, or anything provider-shaped — swapping Gemini for
   another provider is a server-side change that this file and the UI
   above it never notice.

   There is no Gemini SDK, endpoint, or API key anywhere in the
   browser bundle: the only network call is to our own authenticated
   Edge Function.

   READ/CONVERSATION ONLY. This returns text for display. It never
   writes to flightplan_data, never calls update(), and returns no
   instruction the caller acts on — a failure yields an error code and
   nothing else, so no failure path can produce data.
   ============================================================ */

const FUNCTION_NAME = "cirrus-chat";

/** Stable codes the UI switches on. Mirrors the Edge Function's taxonomy. */
export const CIRRUS_ERRORS = {
  OFF: "off",
  UNAUTHENTICATED: "unauthenticated",
  FORBIDDEN: "forbidden",
  BAD_REQUEST: "bad_request",
  RATE_LIMITED: "rate_limited",
  PROVIDER_RATE_LIMITED: "provider_rate_limited",
  PROVIDER_TIMEOUT: "provider_timeout",
  PROVIDER_BLOCKED: "provider_blocked",
  PROVIDER_ERROR: "provider_error",
  MALFORMED_PROVIDER_RESPONSE: "malformed_provider_response",
  SERVER_MISCONFIGURED: "server_misconfigured",
  NETWORK_ERROR: "network_error",
  UNKNOWN: "unknown",
};

/** What the user actually sees. Diagnostics stay in the console. */
const MESSAGES = {
  [CIRRUS_ERRORS.OFF]: "Cirrus is off.",
  [CIRRUS_ERRORS.UNAUTHENTICATED]: "Your session expired. Sign in again.",
  [CIRRUS_ERRORS.FORBIDDEN]: "This account can't use Cirrus.",
  [CIRRUS_ERRORS.BAD_REQUEST]: "That message couldn't be sent.",
  [CIRRUS_ERRORS.RATE_LIMITED]: "Too many messages at once. Give it a moment.",
  [CIRRUS_ERRORS.PROVIDER_RATE_LIMITED]: "Cirrus has hit its rate limit. Try again shortly.",
  [CIRRUS_ERRORS.PROVIDER_TIMEOUT]: "Cirrus took too long to respond.",
  [CIRRUS_ERRORS.PROVIDER_BLOCKED]: "Cirrus declined to answer that.",
  [CIRRUS_ERRORS.PROVIDER_ERROR]: "Cirrus is unavailable right now.",
  [CIRRUS_ERRORS.MALFORMED_PROVIDER_RESPONSE]: "Cirrus returned something unreadable.",
  [CIRRUS_ERRORS.SERVER_MISCONFIGURED]: "Cirrus isn't configured yet.",
  [CIRRUS_ERRORS.NETWORK_ERROR]: "Couldn't reach Cirrus. Check your connection.",
  [CIRRUS_ERRORS.UNKNOWN]: "Something went wrong.",
};

const friendly = (code) => MESSAGES[code] || MESSAGES[CIRRUS_ERRORS.UNKNOWN];

const fail = (code, detail) => ({
  ok: false,
  code,
  message: friendly(code),
  ...(detail ? { detail } : {}),
});

/**
 * Allowlist, not denylist. Only these fields can ever reach the
 * network, so no future addition to `data` can leak by default and
 * complete FlightPlan state cannot be sent even by mistake.
 */
function buildStructuredContext({ selectedObject, activeTopic } = {}) {
  const ctx = {};
  if (selectedObject && typeof selectedObject === "object") {
    if (typeof selectedObject.type === "string") ctx.selectedType = selectedObject.type;
    if (typeof selectedObject.id === "string") ctx.selectedId = selectedObject.id;
  }
  if (typeof activeTopic === "string" && activeTopic) ctx.activeTopic = activeTopic;
  return ctx;
}

/** Normalizes whatever the transport threw into one of our codes. */
async function decodeError(error) {
  // supabase-js wraps non-2xx in FunctionsHttpError with the raw Response.
  const res = error?.context;
  if (res && typeof res.json === "function") {
    try {
      const body = await res.json();
      const code = body?.error?.code;
      if (code && MESSAGES[code]) {
        return { code, detail: body?.error?.message };
      }
    } catch {
      /* fall through to status-based mapping */
    }
    if (res.status === 401) return { code: CIRRUS_ERRORS.UNAUTHENTICATED };
    if (res.status === 403) return { code: CIRRUS_ERRORS.FORBIDDEN };
    if (res.status === 429) return { code: CIRRUS_ERRORS.RATE_LIMITED };
    if (res.status >= 500) return { code: CIRRUS_ERRORS.PROVIDER_ERROR };
    return { code: CIRRUS_ERRORS.BAD_REQUEST };
  }

  // No Response at all means it never completed a round trip.
  return { code: CIRRUS_ERRORS.NETWORK_ERROR, detail: error?.message };
}

/**
 * Send one turn to Cirrus.
 *
 * Returns { ok: true, reply, model } or { ok: false, code, message }.
 * Never throws and never mutates application state.
 */
export async function sendCirrusMessage({
  message,
  history = [],
  mode,
  page,
  selectedObject,
  activeTopic,
  taskMode = CIRRUS_TASK_MODES.NORMAL,
  // Read-only facts about the user's FlightPlan and the list of things
  // Cirrus is allowed to propose. Both are supplied by the caller so
  // this module stays the single network boundary and nothing else.
  appContext = null,
  actions = null,
} = {}) {
  // OFF means zero requests. Guarded here as well as in the UI so no
  // future call site can reach the network while Cirrus is off.
  if (!mode || mode === CIRRUS_MODES.OFF) return fail(CIRRUS_ERRORS.OFF);

  if (typeof message !== "string" || !message.trim()) {
    return fail(CIRRUS_ERRORS.BAD_REQUEST);
  }

  // Check the session locally first: no point spending a round trip to
  // be told we're signed out.
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) return fail(CIRRUS_ERRORS.UNAUTHENTICATED);

  const structuredContext = buildStructuredContext({ selectedObject, activeTopic });

  const systemPrompt = buildCirrusSystemPrompt({
    operatingMode: mode,
    taskMode,
    context: { page, selectedObject, activeTopic },
    appContext: capContext(appContext),
    actions,
  });

  const body = {
    message: message.trim(),
    systemPrompt,
    // Only role/content survive — message ids and timestamps stay local.
    history: history
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
      .map((m) => ({ role: m.role, content: m.content })),
    ...(page ? { page } : {}),
    ...(Object.keys(structuredContext).length ? { structuredContext } : {}),
  };

  let result;
  try {
    result = await supabase.functions.invoke(FUNCTION_NAME, { body });
  } catch (err) {
    return fail(CIRRUS_ERRORS.NETWORK_ERROR, err?.message);
  }

  if (result.error) {
    const { code, detail } = await decodeError(result.error);
    return fail(code, detail);
  }

  const reply = result.data?.reply;
  if (typeof reply !== "string" || !reply.trim()) {
    // The contract is `{ reply: string }`. If a deployed function ever
    // answers 200 with a different shape, name the keys we actually got
    // so the mismatch is diagnosable instead of a dead end. Keys only —
    // never the values, which are conversation content.
    if (typeof console !== "undefined" && console.warn) {
      const shape =
        result.data && typeof result.data === "object"
          ? Object.keys(result.data).join(", ") || "(no keys)"
          : typeof result.data;
      console.warn(
        `[cirrus] Expected a "reply" string from cirrus-chat; received: ${shape}`
      );
    }
    return fail(CIRRUS_ERRORS.MALFORMED_PROVIDER_RESPONSE);
  }

  // A proposed action, if Cirrus made one. Deliberately passed through
  // unvalidated: the action registry is the only thing entitled to
  // decide whether it is real, well-formed, or permitted.
  const raw = result.data?.action;
  const action =
    raw && typeof raw === "object" && typeof raw.action === "string"
      ? { action: raw.action, parameters: raw.parameters && typeof raw.parameters === "object" ? raw.parameters : {} }
      : null;

  return {
    ok: true,
    reply,
    action,
    model: result.data?.model,
    truncated: Boolean(result.data?.truncated),
  };
}

/* The Edge Function caps the system prompt, and a full week of calendar
   plus every other domain can get large. Trim the least useful part —
   depth — rather than letting the whole request be rejected. */
const MAX_CONTEXT_CHARS = 12000;

function capContext(appContext) {
  if (!appContext || typeof appContext !== "object") return null;
  let json = "";
  try {
    json = JSON.stringify(appContext);
  } catch {
    return null;
  }
  if (json.length <= MAX_CONTEXT_CHARS) return appContext;

  // Drop whole domains, largest first, so what survives stays valid
  // rather than becoming a truncated fragment.
  const entries = Object.entries(appContext)
    .map(([k, v]) => [k, v, JSON.stringify(v)?.length || 0])
    .sort((a, b) => b[2] - a[2]);
  const kept = {};
  let used = 0;
  for (const [k, v, size] of [...entries].reverse()) {
    if (used + size > MAX_CONTEXT_CHARS) continue;
    kept[k] = v;
    used += size;
  }
  return Object.keys(kept).length ? kept : null;
}
