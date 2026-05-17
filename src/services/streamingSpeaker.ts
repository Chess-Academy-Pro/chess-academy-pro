/**
 * streamingSpeaker — shared sentence-by-sentence Polly chain helper.
 *
 * Every Coach surface that streams an LLM response and speaks each
 * completed sentence as it lands has the same shape:
 *   1. First sentence: `speakIfFree` so a phase-narration / hint /
 *      tactic-alert in flight gets to finish without being clipped.
 *   2. Subsequent sentences: chained via `speakForced` so each Polly
 *      call awaits the previous one's audio (single-engine, no
 *      Polly+Web-Speech overlap).
 *
 * The bug this helper fixes: when first-sentence `speakIfFree` drops
 * (because Polly was busy), the original chain still kicked off
 * `speakForced` for sentence 2+ — which CUT OFF the very thing
 * `speakIfFree` was trying to protect. The polite-drop semantic was
 * undone the moment the second sentence arrived.
 *
 * Production audit (build 6459def+) Finding 167 caught this on
 * /coach/play; the same pattern existed unfixed in CoachAnalysePage
 * and ExplainPositionSessionView. Centralizing the chain logic here
 * so all surfaces get the fix and any future streaming surface picks
 * it up by default.
 */
import { voiceService } from './voiceService';

export interface StreamingSpeaker {
  /** Add a completed sentence to the speech chain. Trims; empty
   *  sentences are silently dropped. The first sentence speaks via
   *  `speakIfFree` (defers to in-flight speech). When that drop
   *  happens (Polly was busy at first-sentence time), every
   *  subsequent sentence in this stream is also dropped — the chain
   *  is "abandoned" so the in-flight narration plays through cleanly.
   *  Otherwise sentences chain via `speakForced`, each awaiting the
   *  previous one's audio. */
  add(sentence: string): void;
  /** Total sentences that were added (including dropped ones). */
  count(): number;
  /** True when the first sentence found Polly busy and the stream
   *  is abandoned. Surfaces that want to know whether to fire a
   *  fallback "speak the full response at the end" can check this. */
  isAbandoned(): boolean;
  /** Force-abandon the stream (e.g. user pressed Stop, or component
   *  unmounted). Subsequent `.add()` calls become no-ops; in-flight
   *  Polly playback is NOT stopped (call voiceService.stop() for that). */
  abandon(): void;
}

/** Create a fresh streaming speaker for one LLM stream. Caller stores
 *  the instance in a ref and calls `add` for each completed sentence
 *  emitted by the streaming sentence dispatcher. */
export function createStreamingSpeaker(): StreamingSpeaker {
  let chain: Promise<void> = Promise.resolve();
  let sentenceCount = 0;
  let abandoned = false;
  let chainStarted = false;

  return {
    add(sentence: string): void {
      const trimmed = sentence.trim();
      if (!trimmed) return;
      if (abandoned) {
        // Still count attempts so callers can distinguish
        // "no sentences ever arrived" from "sentences arrived but
        // the stream was deferred" via count() vs isAbandoned().
        sentenceCount += 1;
        return;
      }
      sentenceCount += 1;
      if (!chainStarted) {
        chainStarted = true;
        // Snapshot isPlaying BEFORE speakIfFree mutates state. If
        // Polly is busy right now, the first sentence's speakIfFree
        // will drop politely — we honor that drop by abandoning the
        // rest of this batch. Defensive `typeof` check so unit-test
        // mocks of voiceService that omit `isPlaying` don't throw —
        // those mocks intentionally elide the playback subsystem.
        if (typeof voiceService.isPlaying === 'function' && voiceService.isPlaying()) {
          abandoned = true;
        }
        chain = voiceService.speakIfFree(trimmed).catch(() => undefined);
      } else {
        chain = chain
          .then(() => voiceService.speakForced(trimmed))
          .catch(() => undefined);
      }
    },
    count(): number {
      return sentenceCount;
    },
    isAbandoned(): boolean {
      return abandoned;
    },
    abandon(): void {
      abandoned = true;
    },
  };
}

/** A streaming dispatcher pairs a {@link StreamingSpeaker} with an
 *  accumulating-text cursor. Surfaces that stream an LLM response
 *  chunk-by-chunk feed the ENTIRE accumulated text on every chunk;
 *  the dispatcher tracks how much of that text it has already
 *  consumed and only dispatches newly-completed sentences past the
 *  cursor.
 *
 *  Without this cursor, the naive shape (loop over the full
 *  accumulated text on every chunk) speaks every previously-completed
 *  sentence again on every chunk — a 5-sentence response over 20
 *  chunks queues ~50 narration calls, with the first sentence
 *  speaking ~20 times. Production audit 2026-05-16: David reported
 *  "Training plan voice loop" on /coach/plan; same bug shape lived
 *  in ExplainPositionSessionView, CoachAnalysePage, and any other
 *  surface that lazily processes `accumulated` instead of just the
 *  new tail.
 */
export interface StreamingDispatcher {
  /** Push the latest accumulated text from the LLM stream. Dispatches
   *  any newly-completed sentences (past the internal cursor) to the
   *  wrapped speaker. Idempotent on repeat calls with the same input. */
  push(accumulatedText: string): void;
  /** Total sentences dispatched (forwarded from the wrapped speaker). */
  count(): number;
  isAbandoned(): boolean;
  abandon(): void;
}

/** Create a dispatcher that owns a fresh StreamingSpeaker. Callers can
 *  optionally pass a pre-built speaker to wire in custom test mocks.
 *  The sentence-terminator regex MUST be NON-global (no `/g` flag) —
 *  the dispatcher slices its input internally and relies on `.exec()`
 *  starting fresh from index 0 each call. */
export function createStreamingDispatcher(
  sentenceRegex: RegExp,
  speaker: StreamingSpeaker = createStreamingSpeaker(),
): StreamingDispatcher {
  let cursor = 0;
  return {
    push(accumulatedText: string): void {
      if (accumulatedText.length <= cursor) return; // no new text
      const tail = accumulatedText.slice(cursor);
      let offset = 0;
      let match: RegExpExecArray | null;
      while ((match = sentenceRegex.exec(tail.slice(offset))) !== null) {
        const endIdx = match.index + match[1].length;
        const sentence = tail.slice(offset, offset + endIdx).trim();
        if (sentence) speaker.add(sentence);
        offset += endIdx;
      }
      cursor += offset;
    },
    count: () => speaker.count(),
    isAbandoned: () => speaker.isAbandoned(),
    abandon: () => speaker.abandon(),
  };
}
