import {
  executeCirrusAction,
  executeProtectedAction,
  fingerprintTarget,
  describeTarget,
  permissionFor,
  PERMISSIONS,
  HISTORY_EVENTS,
} from "./cirrusActions.js";

/* ============================================================
   CIRRUS — APPROVAL & TRANSACTION SAFETY (Stage 6)

   Stage 5 classifies an EDIT or DELETE as approval_required and
   refuses to execute it. This layer owns what happens next: a pending
   transaction the user must explicitly approve, which then executes
   once, against current state, or not at all.

   THE MODEL IS NEVER THE APPROVER. Approval can only come from a
   separate user interaction that happens AFTER a proposal exists.
   Nothing in the model's output — approved, requiresApproval,
   permission, execute_immediately — can create, approve, or resolve a
   pending action. Stage 5 already strips those fields; this layer
   never reads them at all.

   VOICE-READY BY CONSTRUCTION. interpretApproval() takes plain text.
   A typed reply and a speech transcript go through the same function
   and the same rules, so Stage 8 adds a transcript source and nothing
   else. There is no voice-specific approval path to diverge.

   STORAGE. Pending transactions live in memory for the session only.
   No table, no localStorage, nothing persisted. A refresh therefore
   abandons any pending action — deliberately: the safe outcome of
   losing approval state is that the change does not happen.
   ============================================================ */

export const APPROVAL_WINDOW_MS = 5 * 60 * 1000;

export const INTENT = {
  APPROVE: "approve",
  REJECT: "reject",
  AMBIGUOUS: "ambiguous",
};

/* ============================================================
   APPROVAL LANGUAGE
   Deliberately strict. Anything that is not an unmistakable approval
   or rejection is AMBIGUOUS, and ambiguous never executes.
   ============================================================ */

/** Words that make an utterance a question or a hedge, whatever else
    it contains. "yes but which card?" must never approve. */
const HEDGES = [
  "maybe", "wait", "hold on", "not sure", "unsure", "perhaps", "probably",
  "what", "which", "why", "how", "when", "where", "who",
  "if", "but", "instead", "actually", "first", "before", "after",
  "explain", "hmm", "think", "unless", "or",
];

const AFFIRMATIVES = new Set([
  "y", "yes", "yeah", "yea", "yep", "yup", "ya", "ok", "okay", "sure",
  "correct", "right", "affirmative", "please do",
]);

const APPROVE_COMMANDS = [
  "do it", "do that", "go ahead", "proceed", "approve", "approved",
  "confirm", "confirmed", "make the change", "make that change",
  "apply it", "apply that", "send it", "execute it", "run it", "delete it",
];

const NEGATIVES = new Set([
  "n", "no", "nope", "nah", "negative", "no thanks",
]);

// Written without apostrophes: normalize() has already removed them.
const REJECT_COMMANDS = [
  "cancel", "stop", "abort", "never mind", "nevermind", "forget it",
  "dont", "do not", "dont do that", "do not do that", "dont do it",
  "dont bother", "leave it", "leave it alone", "skip it", "discard", "reject",
  "no way", "dont delete it", "dont change it",
];

const POLITENESS = ["please", "now", "thanks", "thank you", "for me"];

/** Lowercase, fold contractions, strip punctuation, collapse whitespace.
    Apostrophes are removed rather than kept so "don't" and "dont" are the
    same utterance — a transcript and a typed reply must not diverge. */
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/'/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const hasWord = (s, phrase) =>
  new RegExp(`(^|\\s)${phrase.replace(/\s+/g, "\\s+")}(\\s|$)`).test(s);

function stripPoliteness(s) {
  let out = s;
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of POLITENESS) {
      const re = new RegExp(`(^|\\s)${p}$`);
      if (re.test(out)) {
        out = out.replace(re, "").trim();
        changed = true;
      }
    }
  }
  return out;
}

/** Does the whole utterance consist only of an affirmative and/or command? */
function matchesSet(s, singles, commands) {
  if (!s) return false;
  if (singles.has(s)) return true;
  if (commands.includes(s)) return true;
  // affirmative + command, e.g. "yes do it"
  for (const cmd of commands) {
    if (s.endsWith(` ${cmd}`)) {
      const head = s.slice(0, -(cmd.length + 1)).trim();
      if (singles.has(head)) return true;
    }
  }
  return false;
}

/**
 * Classify a reply as approval, rejection, or ambiguous.
 *
 * Same function for typed text and, later, a speech transcript.
 * Returns AMBIGUOUS for anything it is not certain about — the caller
 * must keep the action pending and ask, never execute.
 */
export function interpretApproval(text) {
  const s = normalize(text);
  if (!s) return INTENT.AMBIGUOUS;

  // A question or hedge disqualifies the utterance outright, even if it
  // also contains "yes".
  if (/\?/.test(String(text || ""))) return INTENT.AMBIGUOUS;
  for (const h of HEDGES) {
    if (hasWord(s, h)) return INTENT.AMBIGUOUS;
  }

  const core = stripPoliteness(s);
  if (matchesSet(core, AFFIRMATIVES, APPROVE_COMMANDS)) return INTENT.APPROVE;
  if (matchesSet(core, NEGATIVES, REJECT_COMMANDS)) return INTENT.REJECT;
  return INTENT.AMBIGUOUS;
}

/* ---------- bulk destructive guard ---------- */
const BULK_PATTERNS = [
  /\b(delete|remove|clear|wipe|erase|drop|purge)\b[\s\w]*\b(all|everything|every|entire)\b/,
  /\b(reset|erase|wipe)\b[\s\w]*\b(my )?(data|account|flightplan|everything)\b/,
  /\bdelete\b[\s\w]*\b(cards|decks|goals|flights|courses|logbook)\b\s*$/,
  /\bstart over\b/,
];

/**
 * Bulk destructive requests are refused outright. No registry action
 * performs one, so such a request could only ever be a misunderstanding
 * or an attempt to talk Cirrus into something it cannot do.
 */
export function detectBulkDestructive(text) {
  const s = normalize(text);
  return BULK_PATTERNS.some((re) => re.test(s));
}

/* ============================================================
   PENDING TRANSACTION MANAGER
   ============================================================ */
let counter = 0;
const newTransactionId = () =>
  `cirrus-tx-${Date.now().toString(36)}-${(++counter).toString(36)}`;

/** Safe view for the UI. Never exposes raw parameters. */
function view(p, now = Date.now()) {
  return {
    id: p.id,
    action: p.action,
    permission: p.permission,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    secondsRemaining: Math.max(0, Math.round((Date.parse(p.expiresAt) - now) / 1000)),
    proposal: p.proposal,
    status: p.status,
  };
}

export function createApprovalManager({ history = null } = {}) {
  // Exactly one pending protected action at a time, so an approval can
  // never be ambiguous about which operation it refers to.
  let pending = null;

  const note = (entry) => {
    if (history && typeof history.record === "function") history.record(entry);
  };

  const clearExpired = () => {
    if (!pending) return;
    if (Date.now() > Date.parse(pending.expiresAt)) {
      note({
        action: pending.action,
        permission: pending.permission,
        status: "expired",
        event: HISTORY_EVENTS.EXPIRED,
        transactionId: pending.id,
        summary: "approval window elapsed",
      });
      pending = null;
    }
  };

  function getPending() {
    clearExpired();
    return pending ? view(pending) : null;
  }

  /**
   * Route a structured intent. READ and CREATE execute immediately via
   * Stage 5. EDIT and DELETE become a pending transaction instead.
   */
  function propose(intent, runtime = {}) {
    clearExpired();

    const result = executeCirrusAction(intent, { ...runtime, history });
    if (result.status !== "approval_required") return result;

    // Refuse to silently replace an existing pending action. The user
    // resolves the first one, or explicitly cancels it.
    if (pending) {
      return {
        status: "pending_exists",
        message:
          "There is already a change waiting for your approval. Approve or cancel it first.",
        existing: view(pending),
      };
    }

    const name = result.action;
    const params = intent?.parameters || {};
    const targetId = typeof params.id === "string" ? params.id : null;

    // Fingerprint the target as it stands now, so we can tell at
    // approval time whether it changed underneath us.
    const fingerprint = targetId ? fingerprintTarget(name, runtime.data || {}, targetId) : null;
    if (targetId && !fingerprint) {
      return { status: "error", code: "target_missing", action: name, message: "That record no longer exists." };
    }

    const now = Date.now();
    pending = {
      id: newTransactionId(),
      action: name,
      // Registry-derived, never model-supplied.
      permission: permissionFor(name),
      parameters: params,
      fingerprint,
      targetId,
      proposal: result.proposal,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + APPROVAL_WINDOW_MS).toISOString(),
      status: "pending",
    };

    note({
      action: name,
      permission: pending.permission,
      status: "approval_required",
      event: HISTORY_EVENTS.PROPOSED,
      transactionId: pending.id,
      summary: "awaiting approval",
    });

    return { status: "approval_required", pending: view(pending), proposal: result.proposal, action: name };
  }

  /**
   * Resolve the pending action from a user reply.
   *
   * `input` is either free text (typed or, later, a transcript) or an
   * explicit { decision: "approve" | "reject" } from a button. Both
   * paths run the same rules; the button simply skips interpretation.
   */
  function resolve(input, runtime = {}) {
    clearExpired();

    if (!pending) {
      return {
        status: "no_pending_action",
        message: "There's nothing waiting for approval.",
      };
    }

    const explicit =
      input && typeof input === "object" && typeof input.decision === "string"
        ? input.decision
        : null;
    const intent = explicit
      ? explicit === "approve"
        ? INTENT.APPROVE
        : INTENT.REJECT
      : interpretApproval(input);

    if (intent === INTENT.AMBIGUOUS) {
      // Keep it pending and say so. Never guess.
      return {
        status: "ambiguous",
        message: "I need a clear yes or no before I make that change.",
        pending: view(pending),
      };
    }

    if (intent === INTENT.REJECT) {
      const p = pending;
      pending = null; // single-use: the id is now dead
      note({
        action: p.action,
        permission: p.permission,
        status: "rejected",
        event: HISTORY_EVENTS.REJECTED,
        transactionId: p.id,
        summary: "declined by user",
      });
      return { status: "rejected", action: p.action, message: "Left unchanged." };
    }

    // APPROVE. Take the transaction and clear it BEFORE executing, so a
    // second "yes" arriving during execution finds nothing and cannot
    // run it twice.
    const p = pending;
    pending = null;

    note({
      action: p.action,
      permission: p.permission,
      status: "approved",
      event: HISTORY_EVENTS.APPROVED,
      transactionId: p.id,
      summary: "approved by user",
    });

    const result = executeProtectedAction(p.action, p.parameters, runtime, p.fingerprint);

    if (result.status === "success") {
      note({
        action: p.action,
        permission: p.permission,
        status: "success",
        event: HISTORY_EVENTS.EXECUTED,
        transactionId: p.id,
        summary: result.result?.applied || "done",
      });
      return { ...result, transactionId: p.id };
    }

    // Failure is terminal for this transaction. Nothing is retried
    // automatically — a destructive action must be re-proposed and
    // re-approved from current state.
    const isConflict = result.code === "conflict_detected" || result.code === "target_missing";
    note({
      action: p.action,
      permission: p.permission,
      status: "error",
      event: isConflict ? HISTORY_EVENTS.CONFLICT : HISTORY_EVENTS.FAILED,
      transactionId: p.id,
      summary: result.code || "failed",
    });
    return { ...result, transactionId: p.id, retried: false };
  }

  /** Explicit cancel, e.g. the panel's Cancel button. */
  function cancel() {
    clearExpired();
    if (!pending) return { status: "no_pending_action" };
    const p = pending;
    pending = null;
    note({
      action: p.action,
      permission: p.permission,
      status: "rejected",
      event: HISTORY_EVENTS.REJECTED,
      transactionId: p.id,
      summary: "cancelled",
    });
    return { status: "rejected", action: p.action };
  }

  return { propose, resolve, cancel, getPending, interpret: interpretApproval };
}

/* ============================================================
   PREVIEW
   Human-readable description of exactly what would change, built from
   trusted application data rather than the model's description.
   ============================================================ */
export function describeProposal(pendingView, data) {
  if (!pendingView) return null;
  const { action, proposal } = pendingView;
  const isDelete = action.startsWith("delete_");

  // Re-read the target so the preview reflects current state, not the
  // state at proposal time.
  const live = proposal?.target?.id ? describeTarget(action, data || {}, proposal.target.id) : null;
  const target = live || proposal?.target || null;

  const label = target
    ? target.kind === "flashcard"
      ? `Flashcard: "${target.front}"${target.topic ? ` (${target.topic})` : ""}`
      : target.kind === "goal"
      ? `Goal: "${target.title}"`
      : `Logbook entry: ${target.date}${target.aircraft ? ` · ${target.aircraft}` : ""}`
    : action;

  const changes = proposal?.changes
    ? Object.entries(proposal.changes).map(([field, next]) => ({
        field,
        current: target && field in target ? target[field] : null,
        proposed: next,
      }))
    : [];

  return {
    action,
    verb: isDelete ? "Delete" : "Change",
    target: label,
    changes,
    effect: proposal?.effect || null,
    caution: proposal?.caution || null,
    targetStillExists: Boolean(live),
  };
}
