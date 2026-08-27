/* ============================================================
   CIRRUS — AGENT TURN

   One user message, as many tool calls as the job needs, one reply at
   the end.

   WHAT WAS WRONG BEFORE. A turn was: ask the model, run at most one
   action, stop. So "add these six events" created one event and then
   described the second, and the user had to type "continue" five more
   times. The model was never shown what happened — it had no way to
   know the first create succeeded, so it could not sensibly decide
   what to do next.

   WHAT THIS DOES. After an action runs, its OUTCOME is written back
   into the conversation as an observation the model can see, and the
   model is asked again. It keeps going until it stops asking for
   actions. The observation is the important half: without it this is
   just a retry loop.

   APPROVAL STILL STOPS IT, AND THAT IS DELIBERATE. Creating and
   reading run unattended — the user asking for six events is authority
   to make six events. Changing or deleting raises the same approval
   card it always has, and the loop parks there rather than pressing on.
   It is resumable, so approving picks the batch back up where it left
   off; the user presses one button instead of retyping the request.
   Nothing here can widen what an action is allowed to do: this module
   never sees a permission, and the registry re-validates every call.

   BRAKES. A loop that calls a model that asks for another call needs
   limits that do not depend on the model behaving:
     - a ceiling on steps per turn
     - the same action twice in a row is a loop, not progress
     - consecutive failures stop it
     - an error that makes every later call pointless (auth) stops it
       immediately rather than failing eight more times
   ============================================================ */

export const AGENT_LIMITS = {
  /* Six events can easily be twelve calls once duplicate checks are
     counted, and a mixed batch more. High enough not to truncate real
     work, low enough to bound a runaway. */
  MAX_STEPS: 24,
  /** Identical action repeated this many times in a row = stuck. */
  MAX_REPEATS: 2,
  /** Consecutive failed actions before giving up on the batch. */
  MAX_CONSECUTIVE_FAILURES: 3,
};

export const STOP = {
  DONE: "done",                      // the model stopped asking
  AWAITING_APPROVAL: "awaiting_approval",
  MAX_STEPS: "max_steps",
  REPEATED: "repeated_action",
  FAILING: "consecutive_failures",
  BLOCKED: "blocked",                // nothing later can work
  SEND_FAILED: "send_failed",
};

/** Statuses that mean the action did what it said. */
const SUCCEEDED = new Set(["success", "approved"]);
/** Statuses where a human has to decide before anything else happens. */
const NEEDS_USER = new Set(["approval_required", "pending", "ambiguous", "pending_exists"]);

/**
 * A stable identity for an action call, so "the same thing again" can
 * be recognised. Keys are sorted because object order is not meaningful
 * and the model does not emit it consistently.
 */
export function actionFingerprint(action) {
  if (!action || typeof action !== "object") return "";
  const name = String(action.action || "");
  const params = action.parameters || {};
  const keys = Object.keys(params).sort();
  const flat = keys.map((k) => `${k}=${JSON.stringify(params[k])}`).join("&");
  return `${name}(${flat})`;
}

/**
 * Does this failure make every later action pointless?
 *
 * Being wrong in the cautious direction costs the user the rest of a
 * batch, so this only fires on faults that are unambiguously about the
 * connection itself rather than about one record.
 */
export function isBlocking(outcome) {
  if (!outcome) return false;
  const code = String(outcome.code || "").toLowerCase();
  const msg = String(outcome.message || "").toLowerCase();
  if (["unauthenticated", "forbidden", "not_connected", "auth", "token_expired"].includes(code)) return true;
  return (
    msg.includes("not connected") ||
    msg.includes("sign in") ||
    msg.includes("authoriz") ||
    msg.includes("authentic")
  );
}

/**
 * What the model is told after an action runs.
 *
 * Written as a plain observation, not as a new instruction: the model
 * should decide what to do next from the FACTS, and a nudge like
 * "now do the next one" is how a loop ends up inventing work nobody
 * asked for. Failures are reported as plainly as successes so it can
 * route around one bad record instead of retrying it forever.
 */
export function observationFor(action, outcome, describe) {
  const name = action?.action || "action";
  const status = outcome?.status || "unknown";
  let line;

  if (SUCCEEDED.has(status)) {
    const said = (describe && describe(outcome)) || "Done.";
    line = `${name}: SUCCEEDED. ${said}`;
  } else if (status === "approval_required") {
    line = `${name}: WAITING FOR THE USER TO APPROVE. Nothing has changed yet. Do not retry it and do not start anything that depends on it.`;
  } else {
    const why = outcome?.message || outcome?.code || "no reason given";
    line = `${name}: FAILED. ${why}`;
  }

  return (
    `[FlightPlan executed an action on your behalf]\n${line}\n\n` +
    `If more of the user's request is still outstanding, send the next action block now. ` +
    `If everything is finished, reply to the user with one short summary of what happened ` +
    `and no action block. Do not narrate the steps you are about to take.`
  );
}

/**
 * Runs one user turn to completion.
 *
 * Injected rather than imported, so the loop can be tested without a
 * model, a network or a calendar:
 *   send(text)      -> { ok, reply, action, ... }   asks the model
 *   execute(action) -> outcome                      runs it, gated
 *   observe(text)   -> void                         adds hidden history
 *   describe(o)     -> string                       human phrasing
 *   log(event, f)   -> void                         dev-only tracing
 *
 * `resume` continues a run that parked on an approval: pass the state
 * returned last time and the loop picks up from the observation.
 */
export async function runAgentTurn({
  send,
  execute,
  observe,
  describe,
  log = () => {},
  limits = AGENT_LIMITS,
  first = null,
  resume = null,
} = {}) {
  const state = resume || {
    steps: 0,
    executed: [],
    failed: [],
    lastFingerprint: "",
    repeats: 0,
    consecutiveFailures: 0,
  };

  let pending = first;           // a reply we already have in hand
  let lastReply = first?.reply ?? "";

  const finish = (stop, extra = {}) => {
    log("turn:end", { stop, steps: state.steps, ok: state.executed.length, failed: state.failed.length });
    return { stop, state, reply: lastReply, ...extra };
  };

  for (;;) {
    if (!pending) return finish(STOP.DONE);

    const action = pending.action;
    if (!action) return finish(STOP.DONE);          // model stopped asking

    if (state.steps >= limits.MAX_STEPS) {
      return finish(STOP.MAX_STEPS);
    }

    /* Same call as last time means the model is not learning from the
       observations, and running it again would duplicate a record. */
    const fp = actionFingerprint(action);
    if (fp && fp === state.lastFingerprint) {
      state.repeats += 1;
      if (state.repeats >= limits.MAX_REPEATS) {
        log("turn:repeat", { fingerprint: fp });
        return finish(STOP.REPEATED);
      }
    } else {
      state.repeats = 0;
    }
    state.lastFingerprint = fp;

    state.steps += 1;
    log("step:execute", { step: state.steps, action: action.action, fingerprint: fp });

    let outcome;
    try {
      outcome = await execute(action);
    } catch (err) {
      outcome = { status: "error", message: err?.message || "the action threw" };
    }
    log("step:outcome", { step: state.steps, status: outcome?.status, code: outcome?.code });

    /* A human gate. Park — do not press on, and do not lose the work
       already done. */
    if (outcome?.status === "approval_required") {
      state.awaiting = { action, fingerprint: fp };
      return finish(STOP.AWAITING_APPROVAL, { outcome });
    }

    if (SUCCEEDED.has(outcome?.status)) {
      state.executed.push({ action: action.action, outcome });
      state.consecutiveFailures = 0;
    } else if (NEEDS_USER.has(outcome?.status)) {
      // Ambiguous or already-pending: the model must ask, not guess.
      state.failed.push({ action: action.action, outcome });
      return finish(STOP.DONE, { outcome });
    } else {
      state.failed.push({ action: action.action, outcome });
      state.consecutiveFailures += 1;
      if (isBlocking(outcome)) {
        log("turn:blocked", { code: outcome?.code });
        return finish(STOP.BLOCKED, { outcome });
      }
      if (state.consecutiveFailures >= limits.MAX_CONSECUTIVE_FAILURES) {
        return finish(STOP.FAILING, { outcome });
      }
    }

    // Tell the model what happened, then ask it what is next.
    const note = observationFor(action, outcome, describe);
    observe?.(note);

    let next;
    try {
      next = await send(note);
    } catch (err) {
      return finish(STOP.SEND_FAILED, { error: err?.message });
    }
    if (!next?.ok) {
      log("turn:send_failed", { code: next?.code });
      return finish(STOP.SEND_FAILED, { outcome: next });
    }
    lastReply = next.reply ?? lastReply;
    pending = next;
  }
}

/**
 * The one line the user reads at the end.
 *
 * Deliberately counts rather than narrates. The per-step detail is in
 * the transcript already; repeating it here is the "I will now submit
 * the next event" noise this whole change exists to remove.
 */
export function summarize({ stop, state } = {}) {
  const ok = state?.executed?.length || 0;
  const bad = state?.failed?.length || 0;
  if (!ok && !bad) return null;

  const parts = [];
  if (ok) parts.push(`${ok} ${ok === 1 ? "change" : "changes"} made`);
  if (bad) parts.push(`${bad} couldn't be completed`);
  let line = `Done — ${parts.join(", ")}.`;

  if (stop === STOP.BLOCKED) {
    line += " I stopped there because the calendar connection isn't working, so the rest would have failed too.";
  } else if (stop === STOP.MAX_STEPS) {
    line += " That was as far as I could get in one go — tell me to carry on if there's more.";
  } else if (stop === STOP.REPEATED) {
    line += " I stopped because I was about to repeat myself.";
  } else if (stop === STOP.FAILING) {
    line += " I stopped after several failures in a row.";
  } else if (stop === STOP.AWAITING_APPROVAL) {
    return ok ? `${ok} done so far — approve the change above and I'll finish the rest.` : null;
  }
  return line;
}

export default runAgentTurn;
