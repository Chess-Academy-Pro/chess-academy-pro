/**
 * coachMemoryStore
 * ----------------
 * The coach's unified, persistent memory. One store for every memory
 * type the coach can carry across surfaces, games, and sessions.
 *
 * WO-COACH-MEMORY-UNIFY-01 ships the foundation. Only `intendedOpening`
 * is populated today; every other field is schema-defined so future
 * feature WOs (hints, preferences, blunder patterns, growth map) plug
 * in without re-architecting.
 *
 * Persistence: Dexie `meta` key-value (`coachMemory.v1`), 250 ms
 * debounced writes. Auto-hydrated on first module import — the store
 * is a singleton, hydration runs once per app lifecycle. Cross-device
 * sync rides the existing `exportUserData` / `pushToCloud` pattern
 * once `db.meta` is added to the export surface (follow-up WO).
 *
 * Audit discipline: every write and every clear emits an audit entry
 * from inside the store action. Callers never need to remember to
 * emit — the store is the single source of truth for both state and
 * observability.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { db } from '../db/schema';
import { logAppAudit } from '../services/appAuditor';

// ─── Schema (only intendedOpening populated in this WO) ─────────────────────

/** Color-scoped opening commitment. Persists until the user explicitly
 *  clears it or the line is exhausted in a live game. */
export interface IntendedOpening {
  name: string;
  color: 'white' | 'black';
  setAt: number;
  capturedFromSurface: string;
}

/** Unified coach conversation entry. Populated by WO-LIVE-COACH-01.
 *
 *  Captures every coach utterance and (eventually) every user reply
 *  across surfaces — live game interjections, chat panels, phase
 *  narration, hints, review walk callouts, blunder alerts. The
 *  `surface` field tags origin so future cross-game queries can
 *  filter ("show me everything you said during my last 3 games" /
 *  "what did I tell you about my opening preferences in chat?").
 *
 *  Persists across games and sessions per UNIFY-01 pattern (Dexie +
 *  future Supabase ride along the same export path). */
export interface CoachMessage {
  id: string;
  timestamp: number;
  surface:
    | 'live-coach'
    | 'chat-home'
    | 'chat-coach-tab'
    | 'chat-in-game'
    | 'chat-review-ask'
    | 'chat-review-practice'
    | 'chat-smart-search'
    | 'chat-teach'
    | 'phase'
    | 'hint'
    | 'review-walk'
    | 'blunder';
  role: 'coach' | 'user';
  text: string;
  gameId?: string;
  ply?: number;
  fen?: string;
  trigger?:
    | 'great-move'
    | 'missed-tactic'
    | 'opponent-blunder'
    | 'eval-swing-wrong'
    | 'recovery'
    | null;
}

/** Schema-only — not populated in this WO. */
export interface CoachPreferences {
  likes: string[];
  dislikes: string[];
  style: 'sharp' | 'positional' | 'solid' | null;
}

/** Per-position hint request. Populated by WO-HINT-REDESIGN-01.
 *  Each entry survives across games and sessions so the coach can
 *  surface patterns ("you've needed help on forks three times this
 *  week"). One record per position-of-asking; if the user escalates
 *  through tiers, the same record's `tierReached` increments. */
export interface HintRequestRecord {
  /** Stable id for the position-of-asking. Re-used across tier
   *  escalations on the same FEN. */
  id: string;
  timestamp: number;
  /** Game id from `gameState.gameId` so future cross-game queries can
   *  filter by game. Empty string if the caller didn't provide one. */
  gameId: string;
  moveNumber: number;
  ply: number;
  fen: string;
  bestMoveUci: string;
  bestMoveSan: string;
  tierReached: 1 | 2 | 3;
  /** Where the user actually stopped — equals tierReached at request
   *  time, finalized on the next move played. */
  tierStoppedAt: 1 | 2 | 3;
  /** Filled when the user plays their next move on the same FEN.
   *  Null until finalized. */
  userPlayedBestMove: boolean | null;
  /** Optional LLM-assigned tag describing the position type
   *  ("fork", "pin", "center-collapse"). Reserved for future
   *  classification — not populated in this WO. */
  classificationTag: string | null;
}

/** Schema-only — not populated in this WO. */
export interface BlunderPattern {
  id: string;
  pattern: string;
  occurrences: number;
  lastSeen: number;
}

/** A FEN the student asked the coach to "remember for later." Set by
 *  the `save_position` tool; restored by the `restore_saved_position`
 *  tool. Only one slot — saving overwrites. Production audit (build
 *  95a1785) showed the brain reconstructing positions from its own
 *  prose description on resume and corrupting them (the c6 knight
 *  vanished). The dedicated slot stores the EXACT FEN string verbatim
 *  so resume is byte-perfect. */
export interface SavedPosition {
  fen: string;
  label: string | null;
  savedAt: number;
}

/** Schema-only — not populated in this WO. */
export interface GrowthMapEntry {
  id: string;
  topic: string;
  masteryLevel: number;
  lastReviewed: number;
}

/** Schema-only — not populated in this WO. */
export interface GameSummary {
  id: string;
  ts: number;
  result: 'win' | 'loss' | 'draw';
  openingName: string | null;
}

/** Training Plan rolodex per-color active-card pointer. Each color
 *  remembers which favorited opening sits at the front of its stack.
 *  Persists across sessions so the rolodex resumes where the student
 *  left off. PR-4 of WO-ROLODEX-UI-01 adds `favoritedAt` and
 *  `userOrderedFavorites` to this same store; this shape is the
 *  PR-1 slice. */
export interface RolodexActiveCard {
  white: string | null;
  black: string | null;
}

interface CoachMemoryState {
  intendedOpening: IntendedOpening | null;
  conversationHistory: CoachMessage[];
  preferences: CoachPreferences;
  hintRequests: HintRequestRecord[];
  blunderPatterns: BlunderPattern[];
  growthMap: GrowthMapEntry[];
  gameHistory: GameSummary[];
  /** Explicit save: the student asked the coach to "remember this
   *  position." Sticky — only overwritten by another save or
   *  explicit clear, NEVER by auto-save. */
  savedPosition: SavedPosition | null;
  /** Auto-save: the surface writes this on every board mutation so
   *  a sudden app exit still leaves the most recent live FEN
   *  recoverable. Different slot from `savedPosition` so per-move
   *  auto-saves don't clobber an explicit save. On resume, the
   *  brain prefers `savedPosition`; falls back to `autoSavedPosition`
   *  when no explicit save exists. */
  autoSavedPosition: SavedPosition | null;
  /** Training Plan rolodex: per-color id of the card at the front of
   *  the stack. Null means "no active card yet" (e.g. zero favorites
   *  in that color, or the rolodex has never been touched). Updated
   *  via `setActiveOpeningCard`, which also bumps
   *  `lastActiveRolodexColor`. */
  activeOpeningCardId: RolodexActiveCard;
  /** Training Plan rolodex: which color's folder was last touched.
   *  Drives the mobile manila-tab default ("open the folder I was
   *  last using"). Null on a fresh user with no rolodex history. */
  lastActiveRolodexColor: 'white' | 'black' | null;
  hydrated: boolean;
}

export type IntentClearReason =
  | 'user-said-forget'
  | 'user-said-play-anything'
  | 'intent-left-book';

interface CoachMemoryActions {
  setIntendedOpening: (
    next: Omit<IntendedOpening, 'setAt'> & { setAt?: number },
  ) => void;
  clearIntendedOpening: (reason: IntentClearReason) => void;
  /** Snapshot a FEN to memory so the student can resume from this
   *  exact position later. `label` is optional human context
   *  ("Vienna Gambit, move 7"). Overwrites any prior save. */
  setSavedPosition: (input: { fen: string; label?: string }) => void;
  clearSavedPosition: () => void;
  /** Auto-save the current live FEN. Cheap to call on every render.
   *  Skipped (no-op) when the FEN matches the existing autoSaved
   *  to avoid noisy persistence churn. */
  setAutoSavedPosition: (fen: string) => void;
  /** Append a new hint request, OR escalate the tier on an existing
   *  same-FEN record. Returns the id of the (new or existing) record. */
  recordHintRequest: (input: {
    gameId: string;
    moveNumber: number;
    ply: number;
    fen: string;
    bestMoveUci: string;
    bestMoveSan: string;
    tier: 1 | 2 | 3;
  }) => string;
  /** Finalize the most recent hint record after the user plays their
   *  next move. Sets `userPlayedBestMove` and locks `tierStoppedAt`. */
  finalizeHintRequest: (input: {
    fen: string;
    playedMoveUci: string | null;
  }) => void;
  /** Append a coach utterance (or user reply) to the unified
   *  conversation history. Bounded to the last
   *  CONVERSATION_HISTORY_MAX entries to keep persistence stable
   *  across long sessions; older entries fall off in FIFO order.
   *  Emits `coach-memory-conversation-appended` audit. */
  appendConversationMessage: (input: Omit<CoachMessage, 'id' | 'timestamp'> & {
    id?: string;
    timestamp?: number;
  }) => string;
  /** Training Plan rolodex: mark a card as the active front-of-stack
   *  for its color. No-op if the same id is already active for that
   *  color (avoids spurious audit + persist churn on every render).
   *  Pass `null` to clear (used when the last favorite in a color is
   *  unfavorited). */
  setActiveOpeningCard: (color: 'white' | 'black', openingId: string | null) => void;
  hydrate: () => Promise<void>;
}

const CONVERSATION_HISTORY_MAX = 200;

const DEFAULT_STATE: CoachMemoryState = {
  intendedOpening: null,
  conversationHistory: [],
  preferences: { likes: [], dislikes: [], style: null },
  hintRequests: [],
  blunderPatterns: [],
  growthMap: [],
  gameHistory: [],
  savedPosition: null,
  autoSavedPosition: null,
  activeOpeningCardId: { white: null, black: null },
  lastActiveRolodexColor: null,
  hydrated: false,
};

const META_KEY = 'coachMemory.v1';

export const useCoachMemoryStore = create<CoachMemoryState & CoachMemoryActions>()(
  subscribeWithSelector((set, get) => ({
    ...DEFAULT_STATE,

    setIntendedOpening: (next) => {
      const withTs: IntendedOpening = {
        name: next.name,
        color: next.color,
        capturedFromSurface: next.capturedFromSurface,
        setAt: next.setAt ?? Date.now(),
      };
      set({ intendedOpening: withTs });
      void logAppAudit({
        kind: 'coach-memory-intent-set',
        category: 'subsystem',
        source: 'useCoachMemoryStore.setIntendedOpening',
        summary: `intent=${withTs.name} color=${withTs.color} from=${withTs.capturedFromSurface}`,
        details: JSON.stringify(withTs),
      });
      schedulePersist(get);
    },

    clearIntendedOpening: (reason) => {
      const prev = get().intendedOpening;
      if (!prev) return;
      set({ intendedOpening: null });
      void logAppAudit({
        kind: 'coach-memory-intent-cleared',
        category: 'subsystem',
        source: 'useCoachMemoryStore.clearIntendedOpening',
        summary: `cleared ${prev.name} reason=${reason}`,
        details: JSON.stringify({ prev, reason }),
      });
      schedulePersist(get);
    },

    setSavedPosition: (input) => {
      const next: SavedPosition = {
        fen: input.fen,
        label: input.label ?? null,
        savedAt: Date.now(),
      };
      set({ savedPosition: next });
      void logAppAudit({
        kind: 'coach-memory-position-saved',
        category: 'subsystem',
        source: 'useCoachMemoryStore.setSavedPosition',
        summary: `saved position label="${next.label ?? ''}"`,
        details: JSON.stringify(next),
      });
      schedulePersist(get);
    },

    clearSavedPosition: () => {
      const prev = get().savedPosition;
      if (!prev) return;
      set({ savedPosition: null });
      void logAppAudit({
        kind: 'coach-memory-position-cleared',
        category: 'subsystem',
        source: 'useCoachMemoryStore.clearSavedPosition',
        summary: `cleared saved position`,
      });
      schedulePersist(get);
    },

    setAutoSavedPosition: (fen) => {
      const prev = get().autoSavedPosition;
      if (prev?.fen === fen) return; // no-op when nothing changed
      set({ autoSavedPosition: { fen, label: null, savedAt: Date.now() } });
      schedulePersist(get);
    },

    recordHintRequest: (input) => {
      const records = get().hintRequests;
      // Re-use the existing record if the user is escalating tiers on
      // the same FEN. Otherwise create a new one.
      const existing = records.find(
        (r) => r.fen === input.fen && r.userPlayedBestMove === null,
      );
      const now = Date.now();
      if (existing) {
        const next = records.map((r) =>
          r.id === existing.id
            ? {
                ...r,
                tierReached: input.tier,
                tierStoppedAt: input.tier,
                bestMoveUci: input.bestMoveUci,
                bestMoveSan: input.bestMoveSan,
              }
            : r,
        );
        set({ hintRequests: next });
        void logAppAudit({
          kind: 'coach-memory-hint-requested',
          category: 'subsystem',
          source: 'useCoachMemoryStore.recordHintRequest',
          summary: `escalated tier=${input.tier} ply=${input.ply}`,
          details: JSON.stringify({ id: existing.id, tier: input.tier, ply: input.ply, fen: input.fen }),
        });
        schedulePersist(get);
        return existing.id;
      }
      const id = `hint-${now}-${Math.random().toString(36).slice(2, 8)}`;
      const record: HintRequestRecord = {
        id,
        timestamp: now,
        gameId: input.gameId,
        moveNumber: input.moveNumber,
        ply: input.ply,
        fen: input.fen,
        bestMoveUci: input.bestMoveUci,
        bestMoveSan: input.bestMoveSan,
        tierReached: input.tier,
        tierStoppedAt: input.tier,
        userPlayedBestMove: null,
        classificationTag: null,
      };
      set({ hintRequests: [...records, record] });
      void logAppAudit({
        kind: 'coach-memory-hint-requested',
        category: 'subsystem',
        source: 'useCoachMemoryStore.recordHintRequest',
        summary: `tier=${input.tier} ply=${input.ply}`,
        details: JSON.stringify({ id, tier: input.tier, ply: input.ply, fen: input.fen }),
      });
      schedulePersist(get);
      return id;
    },

    finalizeHintRequest: ({ fen, playedMoveUci }) => {
      const records = get().hintRequests;
      const target = records.find(
        (r) => r.fen === fen && r.userPlayedBestMove === null,
      );
      if (!target) return;
      const userPlayedBestMove = playedMoveUci === target.bestMoveUci;
      const finalized: HintRequestRecord = {
        ...target,
        userPlayedBestMove,
      };
      set({
        hintRequests: records.map((r) => (r.id === target.id ? finalized : r)),
      });
      void logAppAudit({
        kind: 'coach-memory-hint-recorded',
        category: 'subsystem',
        source: 'useCoachMemoryStore.finalizeHintRequest',
        summary: `tierStoppedAt=${finalized.tierStoppedAt} userPlayedBest=${userPlayedBestMove}`,
        details: JSON.stringify(finalized),
        fen,
      });
      schedulePersist(get);
    },

    setActiveOpeningCard: (color, openingId) => {
      const prev = get().activeOpeningCardId;
      if (prev[color] === openingId && get().lastActiveRolodexColor === color) {
        return; // no-op: same card already at front, folder already last-touched
      }
      const next: RolodexActiveCard = { ...prev, [color]: openingId };
      set({ activeOpeningCardId: next, lastActiveRolodexColor: color });
      void logAppAudit({
        kind: 'coach-memory-rolodex-active-card-set',
        category: 'subsystem',
        source: 'useCoachMemoryStore.setActiveOpeningCard',
        summary: `${color}=${openingId ?? '(none)'}`,
        details: JSON.stringify({ color, openingId, white: next.white, black: next.black }),
      });
      schedulePersist(get);
    },

    appendConversationMessage: (input) => {
      const id = input.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const message: CoachMessage = {
        id,
        timestamp: input.timestamp ?? Date.now(),
        surface: input.surface,
        role: input.role,
        text: input.text,
        gameId: input.gameId,
        ply: input.ply,
        fen: input.fen,
        trigger: input.trigger ?? null,
      };
      const next = [...get().conversationHistory, message].slice(-CONVERSATION_HISTORY_MAX);
      set({ conversationHistory: next });
      void logAppAudit({
        kind: 'coach-memory-conversation-appended',
        category: 'subsystem',
        source: 'useCoachMemoryStore.appendConversationMessage',
        summary: `${message.surface}/${message.role}: ${message.text.slice(0, 60)}`,
        details: JSON.stringify({
          id: message.id,
          surface: message.surface,
          role: message.role,
          length: message.text.length,
          ply: message.ply,
          trigger: message.trigger,
          gameId: message.gameId,
        }),
        fen: message.fen,
      });
      schedulePersist(get);
      return id;
    },

    hydrate: async () => {
      const restored = await loadPersisted();
      if (restored) {
        set({
          intendedOpening: restored.intendedOpening,
          conversationHistory: restored.conversationHistory ?? [],
          preferences: restored.preferences ?? DEFAULT_STATE.preferences,
          hintRequests: restored.hintRequests ?? [],
          blunderPatterns: restored.blunderPatterns ?? [],
          growthMap: restored.growthMap ?? [],
          gameHistory: restored.gameHistory ?? [],
          savedPosition: restored.savedPosition ?? null,
          autoSavedPosition: restored.autoSavedPosition ?? null,
          activeOpeningCardId:
            restored.activeOpeningCardId ?? DEFAULT_STATE.activeOpeningCardId,
          lastActiveRolodexColor:
            restored.lastActiveRolodexColor ?? DEFAULT_STATE.lastActiveRolodexColor,
          hydrated: true,
        });
      } else {
        set({ hydrated: true });
      }
    },
  })),
);

// ─── Persistence ────────────────────────────────────────────────────────────

interface PersistedShape {
  intendedOpening: IntendedOpening | null;
  conversationHistory: CoachMessage[];
  preferences: CoachPreferences;
  hintRequests: HintRequestRecord[];
  blunderPatterns: BlunderPattern[];
  growthMap: GrowthMapEntry[];
  gameHistory: GameSummary[];
  savedPosition: SavedPosition | null;
  autoSavedPosition: SavedPosition | null;
  activeOpeningCardId: RolodexActiveCard;
  lastActiveRolodexColor: 'white' | 'black' | null;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(get: () => CoachMemoryState): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void writePersisted(get());
  }, 250);
}

async function writePersisted(state: CoachMemoryState): Promise<void> {
  const payload: PersistedShape = {
    intendedOpening: state.intendedOpening,
    conversationHistory: state.conversationHistory,
    preferences: state.preferences,
    hintRequests: state.hintRequests,
    blunderPatterns: state.blunderPatterns,
    growthMap: state.growthMap,
    gameHistory: state.gameHistory,
    savedPosition: state.savedPosition,
    autoSavedPosition: state.autoSavedPosition,
    activeOpeningCardId: state.activeOpeningCardId,
    lastActiveRolodexColor: state.lastActiveRolodexColor,
  };
  try {
    await db.meta.put({ key: META_KEY, value: JSON.stringify(payload) });
  } catch {
    // Persistence is best-effort. Losing it just means the next reload
    // starts fresh — the in-memory store still works.
  }
}

async function loadPersisted(): Promise<Partial<PersistedShape> | null> {
  try {
    const row = await db.meta.get(META_KEY);
    if (!row?.value) return null;
    if (typeof row.value !== 'string') return null;
    return JSON.parse(row.value) as Partial<PersistedShape>;
  } catch {
    return null;
  }
}

// Fire-and-forget hydrate on first import. The store is a singleton so
// this runs once per app lifecycle.
if (typeof window !== 'undefined') {
  void useCoachMemoryStore.getState().hydrate();
}

/** Test-only: synchronously flush the pending persist timer. */
export function __flushCoachMemoryPersistForTests(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    return writePersisted(useCoachMemoryStore.getState());
  }
  return Promise.resolve();
}

/** Test-only: reset the store and clear persisted state. */
export function __resetCoachMemoryStoreForTests(): void {
  useCoachMemoryStore.setState({ ...DEFAULT_STATE, hydrated: true });
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}
