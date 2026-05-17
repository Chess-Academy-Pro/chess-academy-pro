/**
 * sanitizeCoachText — strips LLM directive markup so the user never
 * sees or hears it.
 *
 * The legacy agent protocol asked the model to emit inline tags like
 * `[[ACTION:name {"json":"args"}]]` which the dispatcher parsed.
 * The new architecture uses structured `tool_calls` from the provider
 * API, but DeepSeek (and occasionally Anthropic) still pattern-match
 * to the inline-tag shape. Polly was reading those aloud verbatim.
 *
 * This module is the defense-in-depth filter:
 *   1. `sanitizeCoachText` — pure function, strips markup from a full
 *      string and collapses whitespace.
 *   2. `sanitizeCoachStream` — streaming-safe variant. Returns the
 *      portion safe to emit NOW plus any pending text that contains
 *      a half-arrived marker, which the caller buffers until the next
 *      chunk closes the marker.
 *
 * Markup shapes handled:
 *   - `[[DIRECTIVE:args]]` — double-bracket form (canonical)
 *   - `[DIRECTIVE:args]`   — single-bracket legacy form
 *
 * `DIRECTIVE` is one or more uppercase letters / digits / underscores,
 * starting with a letter. `args` can be any text including JSON with
 * nested braces (`{`, `}`); the regex is non-greedy on `]]` so the
 * first matching closer terminates the marker. Single closing
 * brackets `]` inside JSON args (e.g. `[1,2,3]`) are tolerated.
 */

/** Match `[[DIRECTIVE:...args...]]` non-greedy on `]]` so multiple
 *  markers in one string strip independently. `[\s\S]` matches
 *  newlines too — the LLM sometimes wraps long tool-args across
 *  lines. */
const DOUBLE_MARKUP_RE = /\[\[[A-Z][A-Z0-9_]*(?::[\s\S]*?)?\]\]/g;

/** Legacy single-bracket form `[DIRECTIVE:args]`. `args` is `[^\]]*`
 *  because legacy tags didn't support nested `]`. */
const SINGLE_MARKUP_RE = /\[[A-Z][A-Z0-9_]+:[^\]]*\]/g;

/** Internal: strip markup AND collapse the runs of internal
 *  whitespace stripped tags leave behind (e.g. "X  Y" → "X Y"), but
 *  preserve a trailing space if the caller is mid-stream (don't trim
 *  the ends — splice safety across chunk boundaries depends on that
 *  trailing whitespace surviving). The full-string variant trims the
 *  ends; the streaming variant doesn't. */
function stripMarkup(text: string): string {
  return text
    .replace(DOUBLE_MARKUP_RE, '')
    .replace(SINGLE_MARKUP_RE, '')
    // Collapse runs of horizontal whitespace BUT preserve newlines.
    // `[ \t]+` only matches spaces/tabs so paragraph breaks survive.
    .replace(/[ \t]{2,}/g, ' ');
}

/** Strip directive markup from a complete string AND trim the ends.
 *  Use this for full chat-bubble text and for the final flush of a
 *  streaming buffer. Pure function. */
export function sanitizeCoachText(text: string | null | undefined): string {
  if (!text) return '';
  return stripMarkup(text).trim();
}

/** Defense-in-depth markup strip exposed for the TTS pipeline. Same
 *  shape as `sanitizeCoachText` but skips the trim so the caller can
 *  splice with surrounding whitespace. Used by `voiceService`'s
 *  `sanitizeForTTS` so any `[VOICE: ...]` / `[[ACTION:...]]` /
 *  `[BOARD: ...]` directive that slipped past the per-surface strip
 *  never reaches Polly verbatim. Production audit (build 6459def+)
 *  showed Polly speaking `[VOICE: Let's walk through where it all...`
 *  and `[[ACTION:play_move {...}]]` aloud — sanitizeForTTS was the
 *  single chokepoint that didn't run a markup strip. */
export function stripCoachMarkup(text: string): string {
  if (!text) return text;
  return stripMarkup(text);
}

/**
 * Prepare a sanitized prose chunk for Polly TTS. Strips formatting
 * tokens that have no spoken value (markdown bold `**word**`, italic
 * `__word__`, horizontal rules `---`, list bullets `* `, leading
 * `1.` / `2.` from numbered lists when on their own line).
 *
 * The streaming sentence dispatcher otherwise ships these tokens as
 * standalone "sentences" (Polly voices `**1.**` and `---` literally),
 * which makes the lesson sound like it stalled on a single chunk.
 */
export function formatForSpeech(text: string): string {
  if (!text) return '';
  return text
    // Markdown bold / italic — keep the inner words, drop the markers.
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // Stray bold/italic marker pairs with no inner content.
    .replace(/\*{1,3}/g, '')
    .replace(/_{2,}/g, '')
    // Horizontal rules — drop entirely.
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    // Leading list bullet on its own line: "* foo" → "foo".
    .replace(/^\s*[-*]\s+/gm, '')
    // Numbered-list leader on its own line: "1. foo" → "foo". Only
    // strip when followed by space + word so we don't eat "3.Bc4" SAN.
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Streaming-safe sanitize. The caller buffers chunk text, calls this
 *  on the buffer after each chunk arrives, and:
 *   - dispatches `result.safe` to TTS / chat (sanitized prose)
 *   - keeps `result.pending` in the buffer for the next chunk
 *
 *  Detection: find the LAST `[[` in the buffer. If a `]]` exists
 *  after that `[[`, every marker in the buffer is complete and the
 *  whole buffer is safe to sanitize. If no `]]` follows the last
 *  `[[`, the marker is in flight — return the safe prefix and hold
 *  everything from `[[` onward in `pending`.
 *
 *  Single `[` is also held back if it's at the end of the buffer
 *  (the next chunk might land another `[` to make `[[`). Same for
 *  `]` at the very end (could be the start of `]]`).
 */
export function sanitizeCoachStream(
  buffer: string | null | undefined,
): { safe: string; pending: string } {
  if (!buffer) return { safe: '', pending: '' };

  // Last `[[` open in the buffer.
  const lastDoubleOpen = buffer.lastIndexOf('[[');
  if (lastDoubleOpen !== -1) {
    const closingAfter = buffer.indexOf(']]', lastDoubleOpen);
    if (closingAfter === -1) {
      // Marker open and not yet closed — hold it. Strip markup from
      // the safe prefix but DO NOT trim/collapse whitespace; the
      // caller stitches consecutive `safe` outputs together and
      // collapsing here would eat inter-chunk spaces.
      return {
        safe: stripMarkup(buffer.slice(0, lastDoubleOpen)),
        pending: buffer.slice(lastDoubleOpen),
      };
    }
  }

  // No incomplete `[[`. Guard against a single `[` at the tail (next
  // chunk could complete `[[`).
  if (buffer.endsWith('[')) {
    return {
      safe: stripMarkup(buffer.slice(0, -1)),
      pending: '[',
    };
  }

  return { safe: stripMarkup(buffer), pending: '' };
}

/**
 * Sentence-end matcher used by every streaming-voice dispatcher in
 * the Coach tab. Matches one sentence + its terminator, but only
 * when the terminator is followed by whitespace or end-of-buffer
 * AND not preceded by a digit (so "+0.8" / "3.Bc4" don't false-
 * positive split into pieces).
 *
 * Audit-driven (#29): three different regexes were in use across
 * GameChatPanel, CoachChatPage, and CoachTeachPage. CoachChatPage's
 * lacked the `(?<!\d)` lookbehind, so SAN move
 * numbers ("1.", "12.") split sentences and Polly voiced "1." /
 * "Nc3 Nc6 3." as separate utterances.
 *
 * Use this regex with `RegExp.exec` in a loop; `match[1]` is the
 * full sentence including the terminator. Slice the buffer to
 * `match.index + match[1].length` after each match.
 */
export const SENTENCE_END_RE = /([^.!?\n]+(?<!\d)[.!?\n])(?=\s|$)/;

/**
 * Strip the spine's wrapped provider error from text. The Coach
 * Brain Spine returns `text: '(coach-brain provider error: <msg>)'`
 * when the underlying provider call rejects. Six call sites used
 * to inline this strip; some surfaces forgot it entirely (chat
 * pages voiced the error message verbatim).
 *
 * Returns empty string when the wrap is detected, original text
 * otherwise. Pure function.
 */
export function unwrapSpineError(text: string): string {
  return text.startsWith('(coach-brain provider error:') ? '' : text;
}
