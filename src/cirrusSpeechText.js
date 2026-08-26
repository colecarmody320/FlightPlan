/* ============================================================
   CIRRUS — WRITTEN REPLY → SPOKEN LINE (Stage 8)

   Chat and speech want different things from the same sentence. The
   transcript keeps whatever shape Cirrus gave it; ElevenLabs should
   receive only what a person would actually say out loud.

   WHY THIS EXISTS WHEN THE PROMPT ALREADY ASKS FOR IT. Companion mode
   tells the model to avoid bullets, headers and markdown — but that is
   a request to a language model, not a guarantee, and one stray "**"
   is read aloud as "asterisk asterisk". It is also not the only source
   of spoken text: outcome descriptions, corrections and error lines all
   go through say(), and none of them were written by the model.

   ONE DIRECTION ONLY. This never adds, reorders or rewords anything. It
   removes notation and nothing else, so what is heard is always a
   subset of what is on screen — a spoken line can never claim something
   the transcript does not.
   ============================================================ */

/** A bare URL is notation, not speech: nobody wants forty characters of
    percent-encoding read to them. Kept deliberately narrow so ordinary
    prose containing a dot is untouched. */
const BARE_URL = /\bhttps?:\/\/\S+|\bwww\.[^\s]+/gi;

/** Fenced blocks are code, tool payloads or JSON — never speech. */
const FENCED_BLOCK = /```[\s\S]*?```/g;

/** Leading list notation: "- ", "* ", "• ", "1. ", "2) ". */
const LIST_MARKER = /^\s{0,6}(?:[-*•+]|\d{1,3}[.)])\s+/;

/** Setext-style rules and separators: "---", "***", "___". */
const RULE_LINE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;

/**
 * Converts one written line into something worth hearing.
 * Returns "" when the line carries no speech at all.
 */
function spokenLine(raw) {
  let s = String(raw);

  if (RULE_LINE.test(s)) return "";

  // "## Today's mission" → "Today's mission". The text is real; only
  // the hashes are notation.
  s = s.replace(/^\s{0,3}#{1,6}\s+/, "");

  // Blockquote and table notation.
  s = s.replace(/^\s{0,3}>\s?/, "");
  if (s.includes("|")) {
    // A table row reads as a list of cells; the pipes themselves are
    // notation. A divider row ("|---|---|") carries nothing.
    if (/^[\s|:-]+$/.test(s)) return "";
    s = s.replace(/\s*\|\s*/g, ", ").replace(/^,\s*|,\s*$/g, "");
  }

  s = s.replace(LIST_MARKER, "");

  // [label](url) → label. The label is what a person would say.
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1");

  // Inline code usually wraps a real name — a task, a course, a field.
  // Keep the contents, drop the backticks.
  s = s.replace(/`([^`]*)`/g, "$1");

  // Emphasis markers, innermost first so "**bold**" does not leave a
  // stray pair behind.
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2");
  // Anything left is unmatched notation rather than emphasis.
  s = s.replace(/\*+/g, "");

  s = s.replace(BARE_URL, "");

  return s.replace(/\s+/g, " ").trim();
}

/**
 * Prepares a reply for ElevenLabs.
 *
 * Lines become sentences: a bulleted list is spoken as a sequence of
 * statements rather than as "dash, dash, dash". Each line is given a
 * terminator if it lacks one, which is also what stops the synthesiser
 * running two unrelated items together in one breath.
 */
export function toSpokenText(input) {
  if (input == null) return "";
  let text = String(input);
  if (!text.trim()) return "";

  try {
    text = text.replace(FENCED_BLOCK, " ");

    const spoken = [];
    for (const line of text.split(/\r?\n/)) {
      const said = spokenLine(line);
      if (!said) continue;
      // A line that ends mid-clause gets a full stop so the next item
      // does not run into it.
      spoken.push(/[.!?:;,…]$/.test(said) ? said : `${said}.`);
    }

    const out = spoken.join(" ").replace(/\s+/g, " ").trim();
    // A reply made entirely of notation (a lone code block, say) leaves
    // nothing to say. Returning "" lets the caller skip synthesis
    // rather than send punctuation to ElevenLabs.
    return out;
  } catch {
    // Never let preparation cost the user their spoken reply: fall back
    // to the original text, which is worse to listen to but not silent.
    return String(input).replace(/\s+/g, " ").trim();
  }
}

export default toSpokenText;
