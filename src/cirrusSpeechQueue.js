/* ============================================================
   CIRRUS — SERIALIZED SPEECH QUEUE

   One utterance is split into sentences, synthesised in order, and
   played strictly one at a time. Nothing else may make a sound.

   WHY SPLIT AT ALL. A single long synthesis request is where the
   gibberish came from: past a certain length the model's output
   degrades — it starts clean and slurs into noise — and one bad request
   ruins the whole reply. Several short requests each stay in the range
   the model handles well, and a failure costs one sentence instead of
   the answer.

   WHY THIS IS DANGEROUS, AND WHAT MAKES IT SAFE. Chunking creates
   exactly the failure it is meant to cure if two chunks can ever
   overlap or arrive out of order. So ordering is not left to timing:

     - ONE cursor advances through the chunks, and it only advances
       after the previous chunk's playback has RESOLVED.
     - Every chunk carries its generation. A chunk whose generation is
       stale is discarded rather than played, wherever it was.
     - `cancel()` bumps the generation, so everything in flight —
       synthesis, playback, a queued chunk — becomes stale at once.
     - A new utterance cancels the previous one before it queues
       anything of its own.

   Synthesis may run ahead of playback: chunk N+1 is fetched while N is
   still speaking, which is where the latency saving comes from. Fetch
   order is irrelevant to play order, because playback consumes the
   chunk list by index and never by arrival.
   ============================================================ */

/** Target size for one synthesis request. Comfortably inside the range
    the model reads cleanly, and long enough that most replies are one
    or two chunks. */
export const CHUNK_TARGET_CHARS = 320;

/** A chunk is never allowed past this, even if a "sentence" is longer —
    at which point it is split at a clause or a word, never mid-word. */
export const CHUNK_MAX_CHARS = 420;

/** How far synthesis may run ahead of playback. One is enough to hide
    the round trip; more would spend credits on audio a barge-in is
    about to discard. */
export const PREFETCH_AHEAD = 1;

/* Abbreviations whose full stop does NOT end a sentence. Splitting
   after one of these is how "at 9 a.m. tomorrow" becomes two chunks and
   an audible stumble in the middle of a phrase. */
const NON_TERMINAL = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st",
  "a.m", "p.m", "am", "pm",
  "approx", "etc", "vs", "e.g", "i.e", "no", "fig",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/** Does the full stop at `index` actually end a sentence? */
function terminates(text, index) {
  const ch = text[index];
  if (ch === "!" || ch === "?") return true;
  if (ch !== ".") return false;

  // A decimal point, a version, an ellipsis: never a sentence end.
  if (/\d/.test(text[index - 1] || "") && /\d/.test(text[index + 1] || "")) return false;
  if (text[index + 1] === "." || text[index - 1] === ".") return false;

  // The word this stop belongs to.
  const before = text.slice(0, index);
  const word = (before.match(/([A-Za-z][A-Za-z.]*)$/) || [])[1] || "";
  const bare = word.toLowerCase().replace(/\.$/, "");
  if (NON_TERMINAL.has(bare)) return false;
  // A single initial ("J. Smith") is not a sentence either.
  if (word.length === 1) return false;

  return true;
}

/**
 * Splits text into sentences, then packs them into chunks.
 *
 * Never splits inside a word, a number, a time, or an abbreviation —
 * the boundaries considered are sentence ends first, then clause
 * punctuation, and only as a last resort a space.
 */
export function splitForSpeech(input, { target = CHUNK_TARGET_CHARS, max = CHUNK_MAX_CHARS } = {}) {
  const text = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];

  /* --- 1. sentences --- */
  const sentences = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!/[.!?]/.test(text[i])) continue;
    if (!terminates(text, i)) continue;
    // Take any closing quote or bracket with the sentence it belongs to.
    let end = i + 1;
    while (end < text.length && /["'”’)\]]/.test(text[end])) end++;
    sentences.push(text.slice(start, end).trim());
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);

  /* --- 2. anything still too long, split at a safe inner boundary --- */
  const pieces = [];
  for (const sentence of sentences) {
    if (sentence.length <= max) {
      pieces.push(sentence);
      continue;
    }
    let rest = sentence;
    while (rest.length > max) {
      // Prefer a clause break, then a space. Never a bare character
      // cut: that is what splits a word or a number in half.
      const window = rest.slice(0, max);
      let cut = Math.max(
        window.lastIndexOf("; "),
        window.lastIndexOf(", "),
        window.lastIndexOf(" — "),
        window.lastIndexOf(": "),
      );
      if (cut > target * 0.4) cut += 1;          // keep the punctuation
      else cut = window.lastIndexOf(" ");
      if (cut <= 0) cut = max;                   // one impossible word
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
  }

  /* --- 3. pack small sentences together so we make fewer requests --- */
  const chunks = [];
  let current = "";
  for (const piece of pieces) {
    if (!current) {
      current = piece;
    } else if (current.length + 1 + piece.length <= target) {
      current = `${current} ${piece}`;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);

  return chunks.filter(Boolean);
}

/** Dev-only logging. Silent in production, and never logs in a way that
    could reach a user's console in a deployed build. */
function makeLogger(enabled, sink) {
  if (!enabled) return () => {};
  const log = sink || ((...a) => console.log(...a));
  return (event, fields) => {
    try {
      log(`[cirrus-tts] ${event}`, fields);
    } catch {
      /* a broken console must never break speech */
    }
  };
}

/**
 * Builds the queue.
 *
 * `synthesize(text)` → `{ ok, blob }` or `{ ok: false, code }`.
 * `playBlob(blob, signal)` → resolves when that clip FINISHES playing.
 *   `signal.cancelled` lets a player abandon a clip mid-flight.
 * `onSpeakingChange(bool)` mirrors real playback, nothing else.
 */
export function createSpeechQueue({
  synthesize,
  playBlob,
  onSpeakingChange,
  stopPlayback,
  debug = false,
  logSink = null,
} = {}) {
  const log = makeLogger(debug, logSink);

  let generation = 0;
  let speaking = false;
  let requestSeq = 0;

  const setSpeaking = (v) => {
    if (speaking === v) return;
    speaking = v;
    onSpeakingChange?.(v);
  };

  /** Invalidates everything in flight. */
  function cancel(reason = "cancel") {
    generation += 1;
    log("cancel", { reason, generation });
    stopPlayback?.();
    setSpeaking(false);
  }

  async function speak(text) {
    // A new utterance always supersedes the old one, before it queues
    // anything of its own.
    cancel("superseded-by-new-utterance");
    const gen = generation;
    const requestId = `r${++requestSeq}`;

    const chunks = splitForSpeech(text);
    log("queued", { requestId, generation: gen, chunks: chunks.length, text });
    if (!chunks.length) return { ok: false, code: "nothing_to_speak" };

    const stale = () => gen !== generation;

    /* Synthesis runs ahead; playback consumes strictly by index. The
       two never negotiate — index order IS play order. */
    const pending = new Array(chunks.length).fill(null);
    const fetchChunk = (i) => {
      if (i >= chunks.length || pending[i]) return;
      log("synth:start", { requestId, chunk: i + 1, of: chunks.length });
      pending[i] = Promise.resolve()
        .then(() => synthesize(chunks[i]))
        .then((r) => {
          log("synth:done", { requestId, chunk: i + 1, ok: Boolean(r?.ok) });
          return r;
        })
        .catch((err) => ({ ok: false, code: "unknown", detail: err?.message }));
    };

    for (let i = 0; i <= PREFETCH_AHEAD && i < chunks.length; i++) fetchChunk(i);

    let spokeAnything = false;
    let lastError = null;

    for (let i = 0; i < chunks.length; i++) {
      if (stale()) {
        log("abandoned", { requestId, chunk: i + 1, why: "stale" });
        return { ok: false, code: "superseded" };
      }

      const result = await pending[i];
      if (stale()) {
        log("abandoned", { requestId, chunk: i + 1, why: "stale-after-synth" });
        return { ok: false, code: "superseded" };
      }

      // Keep the pipe full for the chunk after next.
      fetchChunk(i + 1 + PREFETCH_AHEAD);

      if (!result?.ok || !result.blob) {
        lastError = result || { ok: false, code: "unknown" };
        log("synth:failed", { requestId, chunk: i + 1, code: lastError.code });
        /* One bad chunk does not silence the rest of the answer — but
           if the very first one fails there is nothing to salvage, and
           the caller should hear about it as a failure. */
        if (i === 0 && chunks.length === 1) return lastError;
        continue;
      }

      setSpeaking(true);
      log("play:start", { requestId, chunk: i + 1, of: chunks.length, bytes: result.blob.size });

      const signal = { get cancelled() { return gen !== generation; } };
      let outcome;
      try {
        outcome = await playBlob(result.blob, signal);
      } catch (err) {
        outcome = { ok: false, code: "playback_error", detail: err?.message };
      }

      log("play:end", { requestId, chunk: i + 1, ok: Boolean(outcome?.ok), code: outcome?.code });

      if (stale()) return { ok: false, code: "superseded" };
      if (outcome?.ok) {
        spokeAnything = true;
        continue;
      }
      if (outcome?.code === "superseded") return outcome;
      /* Playback was refused rather than interrupted — autoplay policy,
         a decode failure. Trying the remaining chunks would just repeat
         it, so stop and report. */
      setSpeaking(false);
      return outcome || { ok: false, code: "playback_error" };
    }

    setSpeaking(false);
    log("finished", { requestId, spokeAnything });
    if (!spokeAnything) return lastError || { ok: false, code: "nothing_to_speak" };
    return { ok: true };
  }

  return {
    speak,
    cancel,
    get speaking() { return speaking; },
    get generation() { return generation; },
    /** Test seam: how many chunks a given text would become. */
    plan: (text) => splitForSpeech(text),
  };
}
