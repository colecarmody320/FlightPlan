/* ============================================================
   CIRRUS — PRONUNCIATION NORMALIZATION (TTS only)

   Written text and spoken text want different things from the same
   fact. "10:00" is the clearest way to WRITE a time and one of the
   worst ways to SAY one: the synthesiser has to guess whether that is
   ten o'clock, ten hundred, or one-zero-colon-zero-zero, and on a long
   sentence it sometimes guesses differently halfway through and slurs
   the lot.

   Everything here runs on the ElevenLabs copy only. The transcript on
   screen keeps its original formatting, always.

   THE RULE THAT KEEPS THIS HONEST: normalization may only change how a
   fact SOUNDS, never which fact it is. "10:00" may become "ten
   o'clock"; it may never become "ten thirty". Where a form is genuinely
   ambiguous, the original is left alone rather than guessed at — a
   slightly awkward reading is much cheaper than a confidently wrong
   time.

   SURGICAL BY DESIGN. Ordinary prose passes through untouched. Only
   forms that are known to be read badly are rewritten, because every
   rule here is a chance to corrupt a sentence that was already fine.
   ============================================================ */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty"];

/** 0–59 in words. That is the whole range a clock needs. */
function smallNumber(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const r = n % 10;
  return r ? `${TENS[t]}-${ONES[r]}` : TENS[t];
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/* Acronyms that a synthesiser tends to slur into a non-word. Spacing
   the letters is what makes it spell them out; the ones that are
   genuinely pronounced as words are deliberately absent, because
   spelling those out would be worse than leaving them alone.

   FlightPlan's own vocabulary sits alongside the aviation set — WMU and
   KAZO come up constantly in this app and are read badly by default. */
export const SPOKEN_ACRONYMS = {
  // Airspace, rules, weather
  VFR: "V F R", IFR: "I F R", MVFR: "M V F R", LIFR: "L I F R",
  IMC: "I M C", VMC: "V M C", TFR: "T F R", NOTAM: "NOTAM",
  ATIS: "ATIS", AWOS: "A W O S", ASOS: "A S O S", TAF: "TAF",
  ATC: "A T C", CTAF: "C TAF", FBO: "F B O", FSS: "F S S",
  // Navigation and approach
  ILS: "I L S", VOR: "V O R", NDB: "N D B", DME: "D M E",
  GPS: "G P S", RNAV: "AR-nav", LPV: "L P V", LNAV: "L-nav", VNAV: "V-nav",
  // Altitude and speed
  AGL: "A G L", MSL: "M S L", IAS: "I A S", TAS: "T A S",
  KIAS: "K I A S", KTAS: "K T A S", AOA: "A O A", VSI: "V S I",
  // Operations and people
  PIC: "P I C", SIC: "S I C", CFI: "C F I", CFII: "C F double I",
  ATP: "A T P", FAA: "F A A", TSA: "T S A", NTSB: "N T S B",
  // Aircraft and planning
  POH: "P O H", AFM: "A F M", RPM: "R P M", CG: "C G",
  ETA: "E T A", ETD: "E T D", ETE: "E T E", XC: "cross country",
  // FlightPlan's own
  WMU: "W M U", KAZO: "K A Z O",
};

/** Units that are written short and said long. */
const UNITS = {
  ft: "feet", nm: "nautical miles", kt: "knots", kts: "knots",
  mph: "miles per hour", rpm: "R P M", hr: "hour", hrs: "hours",
  min: "minutes", mins: "minutes", sec: "seconds", secs: "seconds",
  gal: "gallons", lbs: "pounds", lb: "pounds",
};

/**
 * Says one clock time.
 *
 * Deliberately conservative about the 12/24-hour question: an hour
 * above 12 is unambiguously 24-hour and is read that way; anything
 * below is read as a plain clock time. A meridiem, when written, is
 * kept and the "o'clock" dropped, because "ten o'clock AM" is not
 * something anyone says.
 */
export function spokenTime(hourRaw, minuteRaw, meridiem) {
  const h = Number.parseInt(hourRaw, 10);
  const m = Number.parseInt(minuteRaw, 10);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h > 23 || m > 59) return null;

  const suffix = meridiem ? ` ${meridiem.replace(/[.\s]/g, "").toUpperCase()}` : "";
  const hourWord = h === 0 ? "twelve" : smallNumber(h > 12 && !meridiem ? h : h > 12 ? h - 12 : h);

  if (m === 0) {
    // "ten o'clock", but "ten AM" — never both.
    if (suffix) return `${hourWord}${suffix}`;
    // A 24-hour ":00" is "fourteen hundred", not "fourteen o'clock".
    return h > 12 ? `${hourWord} hundred` : `${hourWord} o'clock`;
  }
  // "ten oh five" reads better than "ten five" and is unambiguous.
  const minuteWord = m < 10 ? `oh ${ONES[m]}` : smallNumber(m);
  return `${hourWord} ${minuteWord}${suffix}`;
}

/* A time, optionally with a meridiem. Anchored so it cannot match part
   of a longer digit run (a ratio, a score, an ISO timestamp). */
/* The whitespace lives INSIDE the optional meridiem group: outside it,
   `\s*` eats the space after a bare time and welds it to the next word
   ("ten thirtyZulu"). The trailing period is deliberately NOT consumed
   either — it is usually the sentence's, and swallowing it silently
   removed full stops from the end of spoken lines. */
const TIME = /(?<![\d:])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp][.\s]?[Mm]))?(?![\d:])/g;

/** Two clock times joined by a dash: a range, and the dash means "to". */
const TIME_RANGE =
  /(\d{1,2}:\d{2}(?:\s*[AaPp][.\s]?[Mm])?)\s*[–—-]\s*(?=(\d{1,2}:\d{2}))/g;

/* ISO date, and the common slash forms. */
const ISO_DATE = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g;

/** Symbols that are read as noise, or not at all, when left in place. */
const SYMBOLS = [
  [/(\d)\s*°\s*F\b/g, "$1 degrees Fahrenheit"],
  [/(\d)\s*°\s*C\b/g, "$1 degrees Celsius"],
  [/(\d)\s*°/g, "$1 degrees"],
  [/(\d)\s*%/g, "$1 percent"],
  [/\s&\s/g, " and "],
  [/(\d)\s*\+\s*(\d)/g, "$1 plus $2"],
  // "w/" and "w/o" are written-only shorthand.
  [/\bw\/o\b/gi, "without"],
  [/\bw\/\b/gi, "with"],
  // A number range: "3-5" is "three to five", not "three minus five".
  [/(?<=\d)\s*[–—]\s*(?=\d)/g, " to "],
];

/**
 * Rewrites a spoken line so a synthesiser reads it the way a person
 * would say it. Returns the input unchanged if anything goes wrong —
 * an awkward reading beats no reply at all.
 */
export function normalizeForSpeech(input) {
  if (input == null) return "";
  let text = String(input);
  if (!text.trim()) return "";

  try {
    /* A range's dash becomes "to" BEFORE the times are reworded, while
       both sides are still recognisable as times. Doing it afterwards
       would mean matching a bare dash, and an em dash in ordinary prose
       ("after 2 p.m. — you're clear") is a pause, not the word "to". */
    // The second time is matched by lookahead only, so it is still in
    // the string — re-emitting it here would duplicate it.
    text = text.replace(TIME_RANGE, "$1 to ");

    /* Times: the reported bug, and the rule most likely to be damaged
       by the others running before it. */
    text = text.replace(TIME, (match, h, m, s, mer) => {
      // A seconds component means this is a duration or a timestamp,
      // not a clock time. Left alone rather than guessed at.
      if (s) return match;
      const said = spokenTime(h, m, mer);
      return said ?? match;
    });


    text = text.replace(ISO_DATE, (match, y, mo, d) => {
      const month = MONTHS[Number.parseInt(mo, 10) - 1];
      if (!month) return match;
      return `${month} ${Number.parseInt(d, 10)}, ${y}`;
    });

    for (const [pattern, replacement] of SYMBOLS) {
      text = text.replace(pattern, replacement);
    }

    /* Units, only when they follow a number. Bare "min" is a word in
       its own right often enough that rewriting it unprompted would do
       more harm than good. */
    /* No trailing `\.?` here for the same reason: "3000 ft." ends a
       sentence, and eating that period ran two sentences together. */
    text = text.replace(
      /(\d)\s*\b(ft|nm|kts?|mph|rpm|hrs?|mins?|secs?|gal|lbs?)\b/gi,
      (match, digit, unit) => {
        const said = UNITS[unit.toLowerCase()];
        return said ? `${digit} ${said}` : match;
      },
    );

    /* Acronyms, whole words only and case-sensitively: "IFR" is the
       rule, "ifr" in the middle of a word is not. */
    text = text.replace(/\b[A-Z][A-Z0-9]{1,5}\b/g, (match) => SPOKEN_ACRONYMS[match] ?? match);

    return text.replace(/\s+/g, " ").trim();
  } catch {
    return String(input).replace(/\s+/g, " ").trim();
  }
}

export default normalizeForSpeech;
