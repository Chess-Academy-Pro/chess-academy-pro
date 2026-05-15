// AI voice synthesis — all coach speech goes through here
// Fallback chain: Amazon Polly → Web Speech API
// Only this file may call TTS APIs.

import { speechService } from './speechService';
import { voicePackService } from './voicePackService';
import { getSharedAudioContext } from './audioContextManager';
import { stripCoachMarkup, formatForSpeech } from './sanitizeCoachText';
import { db } from '../db/schema';
import type { CoachPersonality } from '../coach/types';
import { useAppStore } from '../stores/appStore';
import { resolveCoachNarration } from '../utils/coachNarration';

// WO-COACH-PERSONALITY-VOICE — voice and personality are orthogonal
// dials. Each personality has a default voice (the one that matches
// its base mood best out of the box), but the user can override any
// pairing in Settings. The personality drives the *prompt* (what the
// coach says); the voice drives the *timbre* (who says it). Any voice
// can deliver any personality — Ruth doing drill-sergeant, Stephen
// doing flirtatious, etc.
export const PERSONALITY_VOICE_DEFAULTS: Record<CoachPersonality, string> = {
  default: 'ruth',         // generative — sultry, low female (current pre-personality default)
  soft: 'joanna',          // neural — warm, encouraging female
  edgy: 'stephen',         // neural — dry, sharper male
  flirtatious: 'ruth',     // generative — sultry, low female
  'drill-sergeant': 'matthew', // generative — direct, deep male
};

/** Per-personality SECONDARY voice — used for short alerts /
 *  interjections (tactic warnings, opponent-blunder live-coach
 *  calls) so a different timbre cuts through the main narration.
 *  Defaults pair a contrasting timbre (different gender / engine)
 *  for each personality. WO-VOICE-LAYER-01 (b). */
export const PERSONALITY_SECONDARY_VOICE_DEFAULTS: Record<CoachPersonality, string> = {
  default: 'matthew',          // generative male contrasts Ruth (default primary)
  soft: 'stephen',             // neural male contrasts Joanna
  edgy: 'kendra',              // neural female contrasts Stephen
  flirtatious: 'gregory',      // generative male contrasts Ruth — sultry partner-voice
  'drill-sergeant': 'salli',   // neural female contrasts Matthew
};

/** Resolve which Polly voice to send to the API for the active
 *  personality. The user's per-personality override map (from
 *  Settings → Coach → Personality) wins when set; otherwise we use
 *  the personality's hardcoded default. The legacy `pollyVoice`
 *  preference acts as the "default personality" voice when no
 *  per-personality override exists for `default`. */
export function resolvePollyVoice(
  personality: CoachPersonality | undefined,
  personalityVoices: Partial<Record<CoachPersonality, string>> | undefined,
  legacyPollyVoice: string,
): string {
  const p: CoachPersonality = personality ?? 'default';
  const override = personalityVoices?.[p];
  if (override) return override;
  if (p === 'default') return legacyPollyVoice || PERSONALITY_VOICE_DEFAULTS.default;
  return PERSONALITY_VOICE_DEFAULTS[p];
}

/** Resolve the secondary voice (used for tactic alerts + short
 *  interjections so they cut through with a different timbre). When
 *  the user hasn't picked an override, falls back to
 *  PERSONALITY_SECONDARY_VOICE_DEFAULTS. WO-VOICE-LAYER-01 (b). */
export function resolvePollySecondaryVoice(
  personality: CoachPersonality | undefined,
  secondaryVoices: Partial<Record<CoachPersonality, string>> | undefined,
): string {
  const p: CoachPersonality = personality ?? 'default';
  const override = secondaryVoices?.[p];
  if (override) return override;
  return PERSONALITY_SECONDARY_VOICE_DEFAULTS[p];
}

/** Absolute URL for Polly TTS — needed when running inside Capacitor WKWebView */
const VERCEL_ORIGIN = 'https://chess-academy-pro.vercel.app';
const isCapacitor = typeof window !== 'undefined' && window.location.protocol === 'capacitor:';

export function getTtsUrl(text: string, voice: string, useSsml = true, style?: string): string {
  const base = isCapacitor ? VERCEL_ORIGIN : '';
  // SSML default-on so Polly gets engine-aware structure (paragraph
  // on generative voices, prosody slowdown on neural). Short clips
  // / warmups opt out to avoid empty-SSML edge cases.
  // The optional `style` param tunes per-personality prosody on
  // Neural voices (rate / pitch / volume) — e.g., flirtatious ⇒
  // slower + lower pitch (sultry register), drill-sergeant ⇒
  // faster + louder. Generative voices ignore it.
  const ssmlParam = useSsml ? '&ssml=1' : '';
  const styleParam = style ? `&style=${encodeURIComponent(style)}` : '';
  return `${base}/api/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}${ssmlParam}${styleParam}`;
}

/** Available Amazon Polly voices (served via /api/tts endpoint) */
export const POLLY_VOICES = [
  { id: 'ruth',     name: 'Ruth',     description: 'Generative female', engine: 'generative' },
  { id: 'matthew',  name: 'Matthew',  description: 'Generative male',   engine: 'generative' },
  { id: 'danielle', name: 'Danielle', description: 'Generative female', engine: 'generative' },
  { id: 'gregory',  name: 'Gregory',  description: 'Generative male',   engine: 'generative' },
  { id: 'joanna',   name: 'Joanna',   description: 'Neural female',     engine: 'neural' },
  { id: 'stephen',  name: 'Stephen',  description: 'Neural male',       engine: 'neural' },
  { id: 'kendra',   name: 'Kendra',   description: 'Neural female',     engine: 'neural' },
  { id: 'kimberly', name: 'Kimberly', description: 'Neural female',     engine: 'neural' },
  { id: 'salli',    name: 'Salli',    description: 'Neural female',     engine: 'neural' },
  { id: 'joey',     name: 'Joey',     description: 'Neural male',       engine: 'neural' },
  { id: 'ivy',      name: 'Ivy',      description: 'Neural child',      engine: 'neural' },
  { id: 'kevin',    name: 'Kevin',    description: 'Neural child',      engine: 'neural' },
] as const;

// Web Speech fallback settings
const WEB_SPEECH_FALLBACK = { rate: 0.95, pitch: 0.78 };

/** Master kill-switch for the Web Speech tier. Disabled because the
 *  current sentence-streaming pattern was firing Polly AND Web Speech
 *  on the same content, producing overlapping coach voices. Re-enable
 *  once the dual-engine queueing is repaired so only one tier speaks
 *  any given chunk. */
const WEB_SPEECH_FALLBACK_ENABLED = false;

/** How long to cool down Polly after a failed call before trying again.
 *  A one-off 429 / 503 from AWS or a transient network hiccup shouldn't
 *  permanently disable Polly for the session — we retry after this
 *  window. Short enough that the user gets their premium voice back
 *  within a move or two; long enough to avoid hammering a broken
 *  endpoint. */
const POLLY_COOLDOWN_MS = 15_000;

/** Voice delivery tier currently serving speak() calls. Exposed for
 *  UI so the Settings screen can show "Polly active" vs "Web Speech
 *  fallback". */
export type VoiceTier = 'polly' | 'voice-pack' | 'web-speech' | 'muted';

/** Map piece letters to spoken names. Applied right before TTS so
 *  nothing reaches the speech engine as "P" / "N" / "B" / "R" / "Q" /
 *  "K" — those sound wrong when read aloud. Upstream prompts and
 *  formatters also try to avoid them, but this is the last line of
 *  defense: regardless of source (LLM output that ignored the prompt,
 *  legacy code path, cached response), the student never hears
 *  "hanging P on e4". */
const PIECE_LETTER_NAMES: Record<string, string> = {
  P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king',
};

/** SAN-ish move pattern — captures piece+capture+square/square+promo.
 *  Used to expand shorthand SAN like "Nxf7" or "Bc4" into plain
 *  English before TTS. Kept simple on purpose: false-positives here
 *  just produce slightly odd speech, never crashes. */
const SAN_MOVE_RE = /\b([NBRQK])(x?)([a-h][1-8])\b/g;
/** Pawn-capture SAN (e.g. "exd5", "fxe6") — no piece letter. */
const PAWN_CAPTURE_RE = /\b([a-h])x([a-h][1-8])\b/g;
/** Piece letter immediately followed by a square in any bracketing —
 *  e.g. "P(f3)", "P [f3]", "P <f3>", "P →f3", "P->f3", "P—f3",
 *  "P (on f3)". Covers the "piece-and-location" shorthand that doesn't
 *  use the word "on" (or wraps it in parens). */
const PIECE_LETTER_ADJACENT_SQUARE_RE = /\b([PNBRQK])\s*[([<\-\u2013\u2014\u2192]+\s*(?:on\s+)?([a-h][1-8])\b/g;
/** Parenthesized bare piece letter: "piece at f3 (P)" → "piece at f3 (pawn)". */
const PIECE_LETTER_IN_PARENS_RE = /([([<])([PNBRQK])(?=[)\]>.,;:\s])/g;
/** Isolated piece-letter shorthand after a chess-context word. Kept
 *  narrow enough not to touch "Plan B" in non-chess prose, but broad
 *  enough to cover the verbs and qualifiers LLMs actually emit
 *  when they slip back into SAN shorthand. */
const PIECE_LETTER_AFTER_CONTEXT_RE =
  /\b(hanging|loose|dropped|undefended|attacked|captured|defended|protected|pinned|skewered|forked|trapped|weak|strong|passed|isolated|doubled|exposed|advanced|central|enemy|opposing|opponent's|white's|black's|white|black|the|a|an|my|your|their|our|his|her|its|that|this|these|those|both|either|neither|every|each|one|two|three|save|saving|protect|protecting|lose|losing|take|taking|grab|grabbing|trade|trading|exchange|exchanging|develop|developing|advance|advancing|push|pushing|promote|promoting|sacrifice|sacrificing|hang|hangs)\s+([PNBRQK])\b/gi;
/** Piece letter followed by an action word (on/to/at/from/hangs/etc.).
 *  Runs after the "after-context" pass so both halves of a sentence
 *  like "your P on f3" get caught. */
const ISOLATED_PIECE_LETTER_RE =
  /\b([PNBRQK])\b(?=\s+(?:on|to|at|from|of|takes|is|was|were|are|hangs|hanging|sits|sitting|stands|standing|attacks|attacking|defends|defending|moves|moved|moving|can|could|should|would|will|might|may|goes|going|covers|covering|controls|controlling|threatens|threatening|protects|protecting|supports|supporting)\b)/g;
/** Castling shorthand → plain English. "O-O" sounds nothing like
 *  "castle kingside" when read aloud. */
const CASTLE_KING_RE = /\bO-O\b(?!-)/g;
const CASTLE_QUEEN_RE = /\bO-O-O\b/g;

/** Defense-in-depth second-layer check. Returns true if `text` still
 *  contains piece-letter shorthand that `sanitizeForTTS` should have
 *  expanded but didn't. The auditor wires this after every TTS call
 *  so a new LLM shape slipping past the sanitizer regexes surfaces
 *  in the app audit log. Independent of the narrationAuditor's
 *  factual-claim checks — different failure mode, same defense. */
const LEAK_DETECTOR_RE =
  /\b[PNBRQK]\s+(?:on|to|at|from|hangs|hanging|is|was|takes|attacks|defends|sits|stands|covers|controls|threatens|protects|supports)\b|\b(?:hanging|loose|dropped|undefended|attacked|captured|save|protect|lose|hang|the|a|an|my|your|their|our|his|her|weak|strong|enemy|opposing|black['\u2019]s|white['\u2019]s)\s+[PNBRQK]\b/i;
export function detectSanitizerLeak(text: string): boolean {
  if (!text) return false;
  return LEAK_DETECTOR_RE.test(text);
}

/** Extracted by WO-COACH-NARRATION-06 so the piece-letter normalization
 *  is reusable by UI surfaces that render engine-output text without
 *  going through the TTS pipeline (blunder banners, hanging-piece
 *  alerts, tip bubbles). UI-safe: keeps SAN notation like "Nxf7"
 *  untouched and does NOT expand castling "O-O" — those read fine on
 *  screen and shouldn't be reshaped for visual display. Only the
 *  descriptive-prose shorthand ("White P on h7" → "White pawn on h7",
 *  "hanging N" → "hanging knight") is normalized.
 *  Pure function — safe to call on any string. */
export function normalizePieceShorthand(text: string): string {
  if (!text) return text;
  let out = text;
  // Bracketed / arrowed piece-on-square shorthand: "P(f3)" → "pawn on f3".
  out = out.replace(PIECE_LETTER_ADJACENT_SQUARE_RE, (_, piece: string, square: string) => {
    const name = PIECE_LETTER_NAMES[piece] ?? piece;
    return `${name} on ${square}`;
  });
  // Bare piece letter in parens/brackets: "(P)" → "(pawn)".
  out = out.replace(PIECE_LETTER_IN_PARENS_RE, (_, bracket: string, piece: string) => {
    const name = PIECE_LETTER_NAMES[piece] ?? piece;
    return `${bracket}${name}`;
  });
  // Isolated piece letters after a chess-context word ("hanging P",
  // "save P", "the white B"). Case-insensitive so "White p" → "White pawn".
  out = out.replace(PIECE_LETTER_AFTER_CONTEXT_RE, (_, lead: string, piece: string) => {
    const name = PIECE_LETTER_NAMES[piece.toUpperCase()] ?? piece;
    return `${lead} ${name}`;
  });
  // Piece letter followed by an action word ("P on f3", "N attacks").
  out = out.replace(ISOLATED_PIECE_LETTER_RE, (_, piece: string) => PIECE_LETTER_NAMES[piece] ?? piece);
  return out;
}

/** Matches a full FEN string anywhere in prose — any of the 8 ranks
 *  followed by `w` or `b`, castling rights, and en-passant + halfmove
 *  + fullmove. Production audit (build 5df4252) showed the brain
 *  voicing the entire FEN string out loud as "rnbqkbnr slash pppppppp
 *  slash 8 slash 8 slash 4P3 slash..." — never wanted, always wrong.
 *  The brain shouldn't be including FENs in prose at all (the prompt
 *  rule says so), but this is the belt-and-suspenders strip in case
 *  it does. Optional surrounding backticks/quotes are also stripped. */
const FEN_PATTERN_RE = /[`'"]?\s*([rnbqkpRNBQKP1-8]+\/){7}[rnbqkpRNBQKP1-8]+\s+[wb]\s+[KQkq-]+\s+[a-h1-8-]+\s+\d+\s+\d+\s*[`'"]?/g;

/** Normalise LLM output so the spoken layer never has to read chess
 *  notation aloud. Pure function — safe to call on any string. Wraps
 *  normalizePieceShorthand with the TTS-only transforms (SAN expansion,
 *  castling → plain English, pawn-capture expansion). */
export function sanitizeForTTS(text: string): string {
  if (!text) return text;
  // Strip directive markup first ([VOICE: ...], [[ACTION:...]],
  // [BOARD: ...]) so it can never reach Polly. Per-surface strippers
  // exist (CoachTeachPage, CoachGameReview, sanitizeCoachStream) but
  // production audit showed at least one path — review walk segment
  // narration — bypassing them, and Polly was reading the markers
  // verbatim. This is the chokepoint that catches every caller.
  let out = stripCoachMarkup(text);
  // Strip markdown formatting tokens that Polly would otherwise voice
  // literally. Production audit (build 6459def+) Findings 9-10 caught
  // Polly speaking `**Here's why it hurts so bad for you:**` with the
  // raw asterisks because the streaming dispatchers feed chat-bubble
  // markdown straight to TTS. formatForSpeech strips bold/italic
  // markers and stray `*`/`_` runs without touching SAN notation.
  out = formatForSpeech(out);
  // FEN strings FIRST so they can't get tokenized into nonsense by the
  // SAN regex below (a FEN's "K" / "Q" / "B" / "N" letters look like
  // piece-letter SAN to the SAN_MOVE_RE pattern).
  out = out.replace(FEN_PATTERN_RE, '[the position]');
  // Castling (before piece-letter substitutions mangle the O's).
  out = out.replace(CASTLE_QUEEN_RE, 'castle queenside');
  out = out.replace(CASTLE_KING_RE, 'castle kingside');
  // Pawn captures: "exd5" → "e-pawn takes d5"
  out = out.replace(PAWN_CAPTURE_RE, (_, file: string, dest: string) => `${file}-pawn takes ${dest}`);
  // Piece SAN: "Nxf7" → "knight takes f7", "Bc4" → "bishop to c4"
  out = out.replace(SAN_MOVE_RE, (_, piece: string, capture: string, dest: string) => {
    const name = PIECE_LETTER_NAMES[piece] ?? piece;
    return capture === 'x' ? `${name} takes ${dest}` : `${name} to ${dest}`;
  });
  return normalizePieceShorthand(out);
}

class VoiceService {
  private currentSource: AudioBufferSourceNode | null = null;
  private abortController: AbortController | null = null;
  private playing = false;
  /** Monotonic counter incremented on every `stop()`. Speech chains
   *  can capture this when they queue an utterance and check it
   *  before actually playing — if it advanced, a stop() happened
   *  meanwhile (route change, mic barge-in, manual interrupt) and
   *  the queued utterance should abort. */
  private stopGeneration = 0;
  /** Read-only accessor for chain code. */
  get currentStopGeneration(): number {
    return this.stopGeneration;
  }
  // Default Polly playback rate. Bumped from 1.0 → 1.15 because the
  // User-configurable per-profile via `prefs.voiceSpeed` in Settings.
  // Default 1.0 (natural Polly rate); user request 2026-05-07: bumped
  // accelerated default down to natural pace.
  private speed = 1.0;
  /** Whether the Polly endpoint is currently considered usable. Set by
   *  warmup() on probe success, cleared (temporarily) by speakPolly on
   *  failure. Comes back automatically after POLLY_COOLDOWN_MS so a
   *  transient blip doesn't drop the user to Web Speech for the whole
   *  session. */
  private pollyAvailable = false;
  /** When non-null, Polly is in cooldown until this timestamp. Reads
   *  of `pollyAvailable` treat a past cooldown as expired and
   *  re-enable Polly automatically. */
  private pollyCooldownUntil: number | null = null;
  /** Tier actually used on the last successful speak() call. Read by
   *  the Settings UI to show which voice engine is active. */
  private lastTier: VoiceTier = 'muted';

  /** Max audio-cache entries before LRU eviction. ~50 entries ≈ 5-8MB
   *  depending on utterance length. Prior implementation was
   *  unbounded, which the perf audit flagged as a 90-min-session
   *  memory leak on iOS PWA (~15MB after 60+ narrations). */
  private static readonly AUDIO_CACHE_MAX_ENTRIES = 50;

  /** In-memory LRU cache of Polly audio buffers keyed by "voice:text".
   *  Map iteration order IS insertion order per spec, so the oldest
   *  entry is at the front. On hit we delete+reinsert to mark as
   *  most-recently-used; on eviction we drop the first (oldest) key. */
  private audioCache = new Map<string, ArrayBuffer>();

  /** Mark a cache entry as most-recently-used (move to end of Map). */
  private touchAudioCacheEntry(key: string): ArrayBuffer | undefined {
    const buf = this.audioCache.get(key);
    if (buf === undefined) return undefined;
    this.audioCache.delete(key);
    this.audioCache.set(key, buf);
    return buf;
  }

  /** Insert with LRU eviction of the oldest entry when over cap. */
  private setAudioCacheEntry(key: string, buf: ArrayBuffer): void {
    // Delete-and-reinsert guarantees MRU position even on overwrite.
    this.audioCache.delete(key);
    this.audioCache.set(key, buf);
    if (this.audioCache.size > VoiceService.AUDIO_CACHE_MAX_ENTRIES) {
      const oldest = this.audioCache.keys().next().value;
      if (oldest !== undefined) this.audioCache.delete(oldest);
    }
  }

  /** True when Polly is currently available (warmup succeeded and
   *  we're not in a failure cooldown). Used by the speakInternal
   *  chain and exposed to Settings UI for diagnostics. */
  isPollyLive(): boolean {
    if (this.pollyAvailable) return true;
    if (this.pollyCooldownUntil && Date.now() >= this.pollyCooldownUntil) {
      // Cooldown expired — optimistically clear the flag so the next
      // speak() tries Polly again. If it fails again we'll just come
      // back here on the next call.
      this.pollyCooldownUntil = null;
      this.pollyAvailable = true;
      return true;
    }
    return false;
  }

  /** Tier used on the last successful speak() call. */
  getCurrentTier(): VoiceTier {
    return this.lastTier;
  }

  /** Snapshot of the last speak() attempt — what text, what tier
   *  served it, whether Polly responded with audio, and any error
   *  message. Surfaced via a debug panel (?debug=1) so silent rapid-
   *  fire bugs can be diagnosed without DevTools access. */
  getLastSpeakDiagnostic(): {
    text: string;
    tier: VoiceTier;
    pollyAttempted: boolean;
    pollyOk: boolean | null;
    pollyStatus: number | null;
    audioContextState: string;
    error: string | null;
    timestamp: number;
  } {
    return { ...this.lastSpeakDiagnostic };
  }

  private lastSpeakDiagnostic: {
    text: string;
    tier: VoiceTier;
    pollyAttempted: boolean;
    pollyOk: boolean | null;
    pollyStatus: number | null;
    audioContextState: string;
    error: string | null;
    timestamp: number;
  } = {
    text: '',
    tier: 'muted',
    pollyAttempted: false,
    pollyOk: null,
    pollyStatus: null,
    audioContextState: 'unknown',
    error: null,
    timestamp: 0,
  };

  // Cached preferences to avoid DB read on every speak() call
  private cachedPrefs: {
    voiceEnabled: boolean;
    pollyEnabled: boolean;
    pollyVoice: string;
    /** WO-COACH-PERSONALITY-VOICE: cached for resolvePollyVoice() at
     *  speak time. Defaults to undefined / 'default' so behavior is
     *  unchanged for users who haven't touched personality settings. */
    coachPersonality: CoachPersonality | undefined;
    /** Per-personality voice override map. Empty / missing entries
     *  fall back to PERSONALITY_VOICE_DEFAULTS. */
    coachPersonalityVoices: Partial<Record<CoachPersonality, string>> | undefined;
    /** Per-personality SECONDARY voice override map. Used by speakAlert
     *  for tactic alerts / interjections. WO-VOICE-LAYER-01 (b). */
    coachPersonalitySecondaryVoices: Partial<Record<CoachPersonality, string>> | undefined;
    systemVoiceURI: string | null;
    voiceSpeed: number;
  } | null = null;
  private prefsCacheTime = 0;
  private static CACHE_TTL = 300_000; // 5 min — settings rarely change mid-session

  setSpeed(rate: number): void {
    this.speed = Math.max(0.5, Math.min(2.0, rate));
  }

  getSpeed(): number {
    return this.speed;
  }

  /** Pre-load voice preferences and warm up audio. Call early (e.g. on page mount).
   *  Probes the Polly endpoint — if reachable, enables Polly for the session.
   *  Otherwise Polly stays disabled so speak() falls through to Web Speech instantly. */
  async warmup(): Promise<void> {
    const prefs = await this.loadPrefs();
    // Prime the AudioContext so first decode isn't cold
    getSharedAudioContext();

    if (prefs?.pollyEnabled && prefs.voiceEnabled) {
      // Probe Polly availability with a short timeout
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        // Probe uses plain text (SSML=false) — no need to pay the
        // SSML parse cost for a one-char warmup, and it avoids any
        // chance of empty-SSML edge cases on Polly.
        const url = getTtsUrl('.', prefs.pollyVoice, false);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (res.ok) {
          // Polly is live — enable it and prime AudioContext
          this.pollyAvailable = true;
          const buf = await res.arrayBuffer();
          const ctx = getSharedAudioContext();
          try { await ctx.decodeAudioData(buf); } catch { /* tiny clip may fail — ok */ }
        }
      } catch {
        // Polly unreachable — stays disabled
      }
    }
  }

  private async loadPrefs(): Promise<typeof this.cachedPrefs> {
    const now = Date.now();
    if (this.cachedPrefs && (now - this.prefsCacheTime) < VoiceService.CACHE_TTL) {
      return this.cachedPrefs;
    }
    const profile = await db.profiles.get('main');
    if (!profile) {
      this.cachedPrefs = null;
      return null;
    }
    // Cast to partial — old IndexedDB records may lack newer fields
    const prefs = profile.preferences as Partial<typeof profile.preferences>;
    this.cachedPrefs = {
      voiceEnabled: prefs.voiceEnabled ?? true,
      pollyEnabled: prefs.pollyEnabled ?? false,
      pollyVoice: prefs.pollyVoice || 'ruth',
      coachPersonality: prefs.coachPersonality,
      coachPersonalityVoices: prefs.coachPersonalityVoices,
      coachPersonalitySecondaryVoices: prefs.coachPersonalitySecondaryVoices,
      systemVoiceURI: prefs.systemVoiceURI ?? null,
      voiceSpeed: prefs.voiceSpeed ?? 1.0,
    };
    this.prefsCacheTime = now;
    return this.cachedPrefs;
  }

  /** Invalidate cached preferences (call after settings change). */
  clearCache(): void {
    this.cachedPrefs = null;
    this.prefsCacheTime = 0;
  }

  /** Fire-and-forget audit log of every speak invocation so the next
   *  legacy-voice regression surfaces in one session instead of needing
   *  grep archaeology. Added by WO-LEGACY-VOICE-01. Dynamic import so
   *  voiceService doesn't take a hard dep on appAuditor (which pulls
   *  Dexie — can cold-start early in the app lifecycle). */
  private logSpeakInvoked(method: string, text: string): void {
    const preview = text.slice(0, 40);
    void import('./appAuditor').then(({ logAppAudit }) => {
      void logAppAudit({
        kind: 'voice-speak-invoked',
        category: 'subsystem',
        source: `voiceService.${method}`,
        summary: preview,
        details: text.length > 40 ? `length=${text.length}` : undefined,
      });
    }).catch(() => {
      // Never break speech on an audit-log failure.
    });
  }

  async speak(text: string): Promise<void> {
    this.logSpeakInvoked('speak', text);
    return this.speakInternal(sanitizeForTTS(text), false);
  }

  /** Speak only when nothing is currently playing — DROPS the request
   *  silently if audio is already in flight. Use this for per-move
   *  narrations where the user has explicitly asked the previous
   *  narration to keep playing through subsequent moves. WO-NARR-POLICY-05.
   *
   *  Production audit caught a long opening narration getting cut
   *  mid-sentence the moment the student made their next move,
   *  because every speak() runs `this.stop()` first. speakIfFree
   *  short-circuits before the stop, so the in-flight utterance
   *  finishes naturally. */
  async speakIfFree(text: string): Promise<void> {
    this.logSpeakInvoked('speakIfFree', text);
    if (this.isPlaying() || speechService.isSpeaking) {
      void import('./appAuditor').then(({ logAppAudit }) => {
        void logAppAudit({
          kind: 'voice-speak-invoked',
          category: 'subsystem',
          source: 'voiceService.speakIfFree',
          summary: `dropped (busy): ${text.slice(0, 40)}`,
          details: `length=${text.length} reason=already-playing`,
        });
      }).catch(() => undefined);
      return;
    }
    return this.speakInternal(sanitizeForTTS(text), false);
  }

  /** Speak using the personality's SECONDARY voice — for short tactic
   *  alerts / interjections that should cut through main narration
   *  with a different timbre. WO-VOICE-LAYER-01 (b). Falls back to
   *  the primary speak path if no prefs are loaded. */
  async speakAlert(text: string): Promise<void> {
    this.logSpeakInvoked('speakAlert', text);
    // WO-VOICE-LAYER-01 (b) was originally meant to give tactic alerts
    // a different timbre via a SECONDARY voice. Production audit
    // (build 06b6d5d) showed users hearing "two voices" — the regular
    // coach voice AND the alert voice — which reads as a second
    // character chiming in rather than a coach with a single voice.
    // Drop the secondary-voice override; alerts now use the same
    // primary personality voice as everything else. The
    // PERSONALITY_SECONDARY_VOICE_DEFAULTS map + supporting state
    // is left in place in case we revisit this with a clearer UX
    // signal (e.g. a distinct chime *before* the alert plays).
    return this.speakInternal(sanitizeForTTS(text), false, { useSecondary: false });
  }

  /** Low-latency speak for training modes — skips Polly/voice-packs and DB reads.
   *  Uses cached preferences (from warmup) and goes straight to Web Speech API. */
  async speakFast(text: string): Promise<void> {
    this.logSpeakInvoked('speakFast', text);
    // Mirror the speakInternal Coach Narration = "silent" gate. speakFast
    // bypasses speakInternal for low-latency drills, so we re-check the
    // setting here to keep the Silent promise consistent.
    if (resolveCoachNarration(useAppStore.getState().activeProfile?.preferences) === 'silent') return;
    if (this.cachedPrefs && !this.cachedPrefs.voiceEnabled) return;

    // Stop any in-flight speech without going through the full stop() chain
    if (speechService.isSpeaking) {
      speechService.stop();
    }

    const speed = this.cachedPrefs?.voiceSpeed ?? this.speed;
    if (this.cachedPrefs?.systemVoiceURI) {
      speechService.setVoice(this.cachedPrefs.systemVoiceURI);
    }
    if (WEB_SPEECH_FALLBACK_ENABLED) {
      await speechService.speak(sanitizeForTTS(text), { ...WEB_SPEECH_FALLBACK, rate: speed });
    }
  }

  /** Speak regardless of the voiceEnabled preference.
   *  Used by the voice-chat mic where the user explicitly opted into voice. */
  async speakForced(text: string): Promise<void> {
    this.logSpeakInvoked('speakForced', text);
    return this.speakInternal(sanitizeForTTS(text), true);
  }

  /** Polly-only speakForced. Identical to speakForced but skips the
   *  Web Speech fallback when Polly transiently fails. Used by the
   *  /coach/teach streaming sentence chain so a brief Polly cooldown
   *  doesn't cause the iOS Safari speech-synth tail to overlap with
   *  the next Polly sentence — the production audit (build 30fe8c8)
   *  showed `tts-concurrent-speak prevTier=web-speech` 4× in one
   *  session, which the user heard as "two voices." With this method,
   *  a sentence whose Polly call fails is simply skipped audibly
   *  (still rendered in chat); Polly recovers naturally after the
   *  15s cooldown for the next sentence. Single-engine consistency,
   *  no cancel-tail race. */
  async speakForcedPollyOnly(text: string): Promise<void> {
    this.logSpeakInvoked('speakForcedPollyOnly', text);
    return this.speakInternal(sanitizeForTTS(text), true, { noFallback: true });
  }

  /** Queue a sentence without stopping current speech. For streaming voice responses. */
  speakQueuedForced(text: string): void {
    this.logSpeakInvoked('speakQueuedForced', text);
    // Mirror the speakInternal Coach Narration = "silent" gate. This
    // path goes straight to speechService.queue, so we re-check here.
    if (resolveCoachNarration(useAppStore.getState().activeProfile?.preferences) === 'silent') return;
    if (this.cachedPrefs?.systemVoiceURI) {
      speechService.setVoice(this.cachedPrefs.systemVoiceURI);
    }
    const speed = this.cachedPrefs?.voiceSpeed ?? this.speed;
    if (WEB_SPEECH_FALLBACK_ENABLED) {
      speechService.queue(sanitizeForTTS(text), { rate: speed, pitch: 0.78 });
    }
  }

  private async speakInternal(
    text: string,
    force: boolean,
    opts?: { useSecondary?: boolean; noFallback?: boolean },
  ): Promise<void> {
    // Coach Narration = "silent" is the highest-priority gate: when
    // the user has explicitly set Settings → Coach → Coach Narration
    // to Silent, NO coach-driven speech fires anywhere in the app,
    // regardless of the call site or the `force` flag. This catches
    // the long tail of speakForced/speakForcedPollyOnly/etc. call
    // sites that don't go through a per-site policy gate (the
    // CoachTeachPage welcome line, ack messages, streaming chat
    // sentences, voice-chat mic responses, etc.). Without this gate,
    // those 50+ call sites bypass the unified setting and the
    // "Silent" promise is incomplete. Logged as `voice-speak-silenced`
    // so audit traces still show the attempt was suppressed by policy.
    const narrationPrefs = useAppStore.getState().activeProfile?.preferences;
    if (resolveCoachNarration(narrationPrefs) === 'silent') {
      void import('./appAuditor').then(({ logAppAudit }) => {
        void logAppAudit({
          kind: 'voice-speak-silenced',
          category: 'subsystem',
          source: 'voiceService.speakInternal',
          summary: `silenced by Coach Narration = "silent": "${text.slice(0, 40)}"`,
          details: `length=${text.length} force=${force}`,
        });
      }).catch(() => undefined);
      return;
    }
    // Audit-driven (build 6459def+ Findings 5, 7): the streaming
    // sentence dispatchers can split text like "X . . . " into
    // single-period "sentences" (the SENTENCE_END_RE matches ` .` as
    // one space + terminator). Polly delivers each as an awkward
    // "period" beat. Skip any sanitized text with no letter/digit
    // content — `\p{L}\p{N}` covers Latin, Cyrillic, CJK, etc., so
    // Unicode-content prose still speaks. Pure punctuation, ellipses,
    // dashes, em-dashes, asterisks alone all silently drop.
    if (!/[\p{L}\p{N}]/u.test(text)) {
      void import('./appAuditor').then(({ logAppAudit }) => {
        void logAppAudit({
          kind: 'voice-speak-invoked',
          category: 'subsystem',
          source: 'voiceService.speakInternal',
          summary: `dropped (no speakable content): "${text.slice(0, 40)}"`,
          details: `length=${text.length} reason=no-alphanumeric`,
        });
      }).catch(() => undefined);
      return;
    }
    this.lastSpeakDiagnostic = {
      text: text.slice(0, 80),
      tier: 'muted',
      pollyAttempted: false,
      pollyOk: null,
      pollyStatus: null,
      audioContextState: typeof AudioContext !== 'undefined'
        ? (((globalThis as unknown as { _sharedAudioContext?: AudioContext })._sharedAudioContext)?.state ?? 'no-context')
        : 'no-AudioContext',
      error: null,
      timestamp: Date.now(),
    };
    // Dev-mode guard: warn when a new speak fires while a previous one
    // is still playing. This is the root cause of every "two voices
    // overlap" bug we've fixed — callers doing `void speak(A)` then
    // `void speak(B)` without awaiting. The stop() below handles it
    // gracefully, but the warning helps catch the caller pattern
    // during development.
    if (import.meta.env.DEV && this.playing) {
      console.warn(
        '[VoiceService] speak() called while already playing — previous speech will be cut off.',
        'Caller should `await speak()` or chain with .then() to prevent overlap.',
        { newText: text.slice(0, 60) },
      );
    }
    // Production audit — same condition, persisted to the rolling app
    // audit log so "two voices at once" reports have a record of every
    // racing call (which surface fired the overlap, what was already
    // playing). The dev-mode warn above is invisible to production
    // users; this audit is what we read in the next "Copy for Claude"
    // export. Joins with voice-speak-invoked entries on timestamp for
    // the full racing-caller chain.
    if (this.playing) {
      void import('./appAuditor').then(({ logAppAudit }) => {
        void logAppAudit({
          kind: 'tts-concurrent-speak',
          category: 'subsystem',
          source: 'voiceService.speakInternal',
          summary: `force=${force} prevTier=${this.lastTier} newPreview="${text.slice(0, 40)}"`,
          details: JSON.stringify({
            force,
            prevTier: this.lastTier,
            newTextLength: text.length,
            newPreview: text.slice(0, 80),
          }),
        });
      }).catch(() => {
        // Never break speech on a logging failure.
      });
    }
    // Defense-in-depth: after sanitizeForTTS has run at the call site,
    // scan the result for piece-letter shorthand that still slipped
    // through. Different failure mode than narrationAuditor's
    // factual checks — this catches new LLM shapes the sanitizer
    // vocabulary doesn't know about yet. Fire-and-forget; never
    // blocks the speak path.
    if (detectSanitizerLeak(text)) {
      void import('./appAuditor').then(({ logAppAudit }) => {
        void logAppAudit({
          kind: 'sanitizer-leak',
          category: 'subsystem',
          source: 'voiceService.speakInternal',
          summary: 'Piece-letter shorthand survived sanitizeForTTS',
          details: `text: ${text.slice(0, 300)}`,
        });
      });
    }
    this.stop();

    const prefs = await this.loadPrefs();
    if (!prefs) {
      this.speed = 0.95;
      await this.speakFallback(text);
      this.lastTier = 'web-speech';
      this.lastSpeakDiagnostic.tier = 'web-speech';
      this.lastSpeakDiagnostic.error = 'no prefs loaded';
      return;
    }

    if (!force && !prefs.voiceEnabled) {
      this.lastTier = 'muted';
      this.lastSpeakDiagnostic.tier = 'muted';
      this.lastSpeakDiagnostic.error = 'prefs.voiceEnabled is false';
      return;
    }

    // Register MediaSession pause/stop handlers so Bluetooth headset
    // play/pause buttons and OS-level media controls can interrupt
    // the coach. Without this, tapping pause on AirPods during a
    // narration does nothing (or falls through to the OS default).
    // Re-registered on every speak so handlers always reference the
    // current voiceService instance.
    this.configureMediaSession();

    this.speed = prefs.voiceSpeed;

    // Tier 1: Amazon Polly.
    if (prefs.pollyEnabled && this.isPollyLive()) {
      // WO-COACH-PERSONALITY-VOICE: resolve voice from active
      // personality + per-personality override map, falling back to
      // the legacy pollyVoice when on the 'default' personality with
      // no override.
      // WO-VOICE-LAYER-01 (b): when speakAlert was the entry point,
      // use the SECONDARY voice instead so short alerts cut through
      // main narration with a different timbre.
      const voiceForSpeak = opts?.useSecondary
        ? resolvePollySecondaryVoice(
            prefs.coachPersonality,
            prefs.coachPersonalitySecondaryVoices,
          )
        : resolvePollyVoice(
            prefs.coachPersonality,
            prefs.coachPersonalityVoices,
            prefs.pollyVoice,
          );
      // Narration trace audit — captures the cross-product of voice ×
      // personality × dials at speak time. Loaded lazily so the audit
      // module isn't a hard import for the voice path.
      void this.logNarrationSpoken(text, voiceForSpeak, prefs);
      // WO-VOICE-LAYER-01 (a): per-personality SSML prosody. Neural
      // voices respect rate/pitch/volume so the same Joanna can sound
      // sultry under flirtatious, clipped under drill-sergeant, etc.
      // Generative voices (Ruth/Matthew/Danielle/Gregory) ignore
      // prosody — pass the style through anyway for consistency.
      const success = await this.speakPolly(text, voiceForSpeak, prefs.coachPersonality ?? 'default');
      if (success) {
        this.lastTier = 'polly';
        this.lastSpeakDiagnostic.tier = 'polly';
        return;
      }
    }

    // Tier 2: Offline voice packs.
    if (voicePackService.isReady()) {
      const played = await voicePackService.speak(text, this.speed);
      if (played) {
        this.lastTier = 'voice-pack';
        this.lastSpeakDiagnostic.tier = 'voice-pack';
        return;
      }
    }

    // Tier 3: Web Speech API. Skipped when the caller asked for
    // Polly-only mode (the streaming chain on /coach/teach passes
    // `noFallback: true` so a Polly cooldown doesn't cause the iOS
    // Safari speech-synth tail to overlap with the next Polly
    // sentence — that was the "two voices" complaint).
    if (opts?.noFallback) {
      this.lastTier = 'muted';
      this.lastSpeakDiagnostic.tier = 'muted';
      this.lastSpeakDiagnostic.error =
        'noFallback set; Polly+voice-pack failed; sentence skipped audibly';
      void import('./appAuditor').then(({ logAppAudit }) => {
        void logAppAudit({
          kind: 'polly-fallback',
          category: 'subsystem',
          source: 'voiceService.speakInternal',
          summary: 'Polly+voice-pack failed; noFallback skipped web-speech',
          details: `text: ${text.slice(0, 80)}`,
        });
      }).catch(() => undefined);
      return;
    }
    if (prefs.systemVoiceURI) {
      speechService.setVoice(prefs.systemVoiceURI);
    }
    await this.speakFallback(text);
    this.lastTier = 'web-speech';
    this.lastSpeakDiagnostic.tier = 'web-speech';
    if (!this.lastSpeakDiagnostic.error) {
      this.lastSpeakDiagnostic.error =
        'fell through to web-speech (Polly + voice-packs both failed; web-speech is disabled)';
    }
  }

  /** Register MediaSession action handlers so BT headset / OS media
   *  controls can pause & stop the coach. Safe no-op when the API
   *  isn't available. Called on every speak() since the spec allows
   *  re-registering; browsers dedupe internally. */
  private configureMediaSession(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      // A title makes the BT device show something meaningful on its
      // display when available (some models show track info).
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Chess Academy Coach',
        artist: 'Voice narration',
      });
      navigator.mediaSession.setActionHandler('pause', () => this.stop());
      navigator.mediaSession.setActionHandler('stop', () => this.stop());
      // We don't implement play/seek because TTS isn't resumable in a
      // meaningful way (would require tracking sentence position).
      // Clearing these prevents BT "play" from triggering the OS
      // default (silent) behaviour and getting stuck.
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('seekbackward', null);
      navigator.mediaSession.setActionHandler('seekforward', null);
    } catch {
      // MediaSession throws if a handler isn't supported on the
      // platform — safe to ignore, we fall through to default.
    }
  }

  stop(): void {
    // Bump the generation counter FIRST so any queued chain sees the
    // bump before it would otherwise dispatch its next utterance.
    this.stopGeneration++;
    // Abort any in-flight Polly fetch
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {
        // Already stopped
      }
      this.currentSource = null;
    }
    this.playing = false;
    // Only call cancel() when something is actually speaking — avoids the
    // costly cancel()-induced delay on iOS/Safari when the queue is empty.
    if (speechService.isSpeaking) {
      speechService.stop();
    }
  }

  isPlaying(): boolean {
    return this.playing;
  }

  private pollyKey(text: string, voice: string): string {
    return `${voice}:${text}`;
  }

  /** Mark Polly as temporarily unavailable. Cleared automatically once
   *  POLLY_COOLDOWN_MS elapses (see isPollyLive). Replaces the legacy
   *  permanent-kill behavior that stranded users on Web Speech for the
   *  rest of the session after one transient failure. */
  private coolDownPolly(reason: string): void {
    this.pollyAvailable = false;
    this.pollyCooldownUntil = Date.now() + POLLY_COOLDOWN_MS;
    if (import.meta.env.DEV) {
      console.warn(
        `[VoiceService] Polly cooling down for ${Math.round(POLLY_COOLDOWN_MS / 1000)}s — ${reason}`,
      );
    }
    // Fire the app auditor so Polly degradation is visible post-launch
    // even without console access. Dynamic import to avoid a circular
    // dependency at module-load time.
    void import('./appAuditor').then(({ logAppAudit }) => {
      void logAppAudit({
        kind: 'polly-fallback',
        category: 'subsystem',
        source: 'voiceService.speakPolly',
        summary: `Polly cooling down for ${Math.round(POLLY_COOLDOWN_MS / 1000)}s`,
        details: reason,
      });
    });
  }

  /** WO-COACH-PERSONALITY-VOICE: emit a `coach-narration-spoken` audit
   *  with the resolved voice + active personality + dial settings.
   *  Fires once per Polly speak attempt regardless of whether the
   *  fetch / playback eventually succeeds — a separate `tts-failure`
   *  fires on actual error. */
  private async logNarrationSpoken(
    text: string,
    voice: string,
    prefs: NonNullable<typeof this.cachedPrefs>,
  ): Promise<void> {
    try {
      const { logAppAudit } = await import('./appAuditor');
      // Re-read full prefs from the live store so we can include the
      // dial settings without forcing them through the cached prefs
      // object — the cache only holds the fields voiceService needs at
      // speak time.
      const profile = await db.profiles.get('main');
      const p = (profile?.preferences ?? {}) as Partial<{
        coachProfanity: string;
        coachMockery: string;
        coachFlirt: string;
      }>;
      const personality = prefs.coachPersonality ?? 'default';
      void logAppAudit({
        kind: 'coach-narration-spoken',
        category: 'subsystem',
        source: 'voiceService.speakPolly',
        summary: `voice=${voice} personality=${personality} text="${text.slice(0, 40)}"`,
        details: JSON.stringify({
          voice,
          personality,
          profanity: p?.coachProfanity ?? 'none',
          mockery: p?.coachMockery ?? 'none',
          flirt: p?.coachFlirt ?? 'none',
          textLength: text.length,
          textPreview: text.slice(0, 120),
        }),
      });
    } catch {
      // Audit failures must not break narration.
    }
  }

  private async speakPolly(text: string, voice: string, style?: string): Promise<boolean> {
    this.lastSpeakDiagnostic.pollyAttempted = true;
    try {
      // Cache key includes style so a style change doesn't return
      // a stale audio buffer from an earlier prosody setting.
      const key = this.pollyKey(text, voice) + (style ? `|${style}` : '');
      let arrayBuffer = this.touchAudioCacheEntry(key);

      if (!arrayBuffer) {
        this.abortController = new AbortController();
        const timeoutSignal = AbortSignal.timeout(10_000);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        const combinedSignal = AbortSignal.any
          ? AbortSignal.any([this.abortController.signal, timeoutSignal])
          : this.abortController.signal;
        const url = getTtsUrl(text, voice, true, style);
        const response = await fetch(url, { signal: combinedSignal });
        this.lastSpeakDiagnostic.pollyStatus = response.status;
        this.lastSpeakDiagnostic.pollyOk = response.ok;
        if (!response.ok) {
          this.coolDownPolly(`API error ${response.status}`);
          this.lastSpeakDiagnostic.error = `Polly /api/tts returned ${response.status}`;
          return false;
        }
        arrayBuffer = await response.arrayBuffer();
        this.abortController = null;
        this.setAudioCacheEntry(key, arrayBuffer);
      } else {
        this.lastSpeakDiagnostic.pollyOk = true;
        this.lastSpeakDiagnostic.pollyStatus = 200; // cache hit
      }

      const played = await this.playAudioBuffer(arrayBuffer.slice(0));
      if (!played) {
        this.lastSpeakDiagnostic.error = 'AudioContext suspended (need user gesture)';
        // Audit so "no voice heard" reports have a trail. Production
        // audit (build 77d7b8f) showed coach-narration-spoken firing
        // 5x for a Catalan lesson with the user reporting silence —
        // could not distinguish "Polly fired and audio played fine"
        // from "Polly fetched audio but iOS AudioContext refused to
        // resume." This audit makes the second case visible.
        void import('./appAuditor').then(({ logAppAudit }) => {
          void logAppAudit({
            kind: 'tts-failure',
            category: 'subsystem',
            source: 'voiceService.speakPolly',
            summary: 'Polly fetched audio but AudioContext could not resume — audio not played',
            details: `text (first 80): ${text.slice(0, 80)}; voice=${voice}`,
          });
        }).catch(() => undefined);
        return false;
      }
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return false;
      }
      const msg = error instanceof Error ? error.message : String(error);
      this.lastSpeakDiagnostic.error = `Polly fetch threw: ${msg}`;
      this.coolDownPolly(msg);
      this.playing = false;
      this.currentSource = null;
      return false;
    }
  }

  /** Pre-fetch Polly audio for a list of texts. Call on mount when all
   *  annotations are known so playback is instant later. */
  async prefetchAudio(texts: string[]): Promise<void> {
    const prefs = await this.loadPrefs();
    if (!prefs?.pollyEnabled || !this.isPollyLive() || !prefs.voiceEnabled) return;

    const voice = resolvePollyVoice(
      prefs.coachPersonality,
      prefs.coachPersonalityVoices,
      prefs.pollyVoice,
    );
    const uncached = texts.filter(t => t && !this.audioCache.has(this.pollyKey(t, voice)));
    if (uncached.length === 0) return;

    // Fetch in parallel, 4 at a time to avoid overwhelming the server
    const BATCH = 4;
    for (let i = 0; i < uncached.length; i += BATCH) {
      const batch = uncached.slice(i, i + BATCH);
      await Promise.allSettled(
        batch.map(async (text) => {
          try {
            const url = getTtsUrl(text, voice);
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              this.setAudioCacheEntry(this.pollyKey(text, voice), await res.arrayBuffer());
            }
          } catch {
            // Prefetch failure is non-fatal
          }
        }),
      );
    }
  }

  /** Tier-3 fallback: Web Speech API (system speech synthesizer).
   *
   *  This path is reached ONLY when Polly + voice-packs both fail —
   *  there's no "dual engine overlap" concern because by the time we
   *  get here, no other tier produced audio. Always-on so iOS audio-
   *  device failures (where AudioContext can't unlock) don't produce
   *  total silence — the user at least hears native speech.
   *
   *  The flag-gated paths (speakFast / speakQueuedForced) still
   *  respect WEB_SPEECH_FALLBACK_ENABLED so the original streaming-
   *  overlap bug doesn't reappear in the coach chat. */
  private async speakFallback(text: string): Promise<void> {
    // Audit-driven (build 6459def+ Finding 142): the master kill-switch
    // at line 113 is meant to disable the Web Speech tier entirely.
    // Currently only `speakQueuedForced` honors it — `speakFallback`
    // unconditionally calls `speechService.speak`, which on iOS Safari
    // can hang forever if synthesis is interrupted before producing
    // 'end' or 'error'. That hang propagates up to usePhaseNarration's
    // 60-second `withTimeout`, holding `isNarrating=true` (which gates
    // CoachGamePage board interactivity at line 4062) for the full
    // window — user reported as "board froze for a while after phase
    // shift." With the flag honored here, Polly failures result in
    // silent skips rather than UI-blocking hangs.
    if (!WEB_SPEECH_FALLBACK_ENABLED) return;
    await speechService.speak(text, { ...WEB_SPEECH_FALLBACK, rate: this.speed });
  }

  /**
   * Decode and play a Polly audio buffer. Returns true on successful
   * playback, false when the AudioContext couldn't be resumed (iOS
   * gesture restriction) — signals the caller to fall through to a
   * different tier for THIS call without disabling Polly.
   */
  private async playAudioBuffer(buffer: ArrayBuffer): Promise<boolean> {
    const ctx = getSharedAudioContext();

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // iOS suspends the AudioContext when away from a user gesture
        // and resume() rejects outside one. Signal failure so the
        // caller can fall back to Web Speech (which has its own
        // gesture-unlock rules). Don't throw — this isn't a Polly
        // fault, it's a browser restriction.
        return false;
      }
      // Re-read state; resume() may have succeeded silently or left
      // the context still suspended depending on the browser.
      if ((ctx.state as AudioContextState) !== 'running') {
        return false;
      }
    }

    const audioBuffer = await ctx.decodeAudioData(buffer);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = this.speed;
    source.connect(ctx.destination);

    this.currentSource = source;
    this.playing = true;

    await new Promise<void>((resolve) => {
      source.onended = (): void => {
        this.playing = false;
        this.currentSource = null;
        resolve();
      };
      source.start();
    });
    return true;
  }
}

// Singleton
export const voiceService = new VoiceService();
