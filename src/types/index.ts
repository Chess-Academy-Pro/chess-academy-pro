// ─── Puzzle ──────────────────────────────────────────────────────────────────

export interface PuzzleRecord {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  themes: string[];
  openingTags: string | null;
  popularity: number;
  nbPlays: number;
  // SRS fields
  srsInterval: number;
  srsEaseFactor: number;
  srsRepetitions: number;
  srsDueDate: string;
  srsLastReview: string | null;
  userRating: number;
  attempts: number;
  successes: number;
}

// ─── Mistake Puzzles ─────────────────────────────────────────────────────────

export type MistakeClassification = 'inaccuracy' | 'mistake' | 'blunder' | 'miss';
export type MistakePuzzleStatus = 'unsolved' | 'solved' | 'mastered';
export type MistakePuzzleSourceMode = 'coach' | 'lichess' | 'chesscom';
export type MistakeGamePhase = 'opening' | 'middlegame' | 'endgame';

export interface MistakeNarration {
  intro: string;
  moveNarrations: string[];
  outro: string;
  conceptHint: string; // Conceptual hint when player makes wrong move (e.g. "Think about reinforcing the center")
}

export interface MistakePuzzle {
  id: string;
  fen: string;
  playerMove: string;
  playerMoveSan: string;
  bestMove: string;
  bestMoveSan: string;
  moves: string;
  cpLoss: number;
  classification: MistakeClassification;
  gamePhase: MistakeGamePhase;
  moveNumber: number;
  sourceGameId: string;
  sourceMode: MistakePuzzleSourceMode;
  playerColor: 'white' | 'black';
  promptText: string;
  narration: MistakeNarration;
  createdAt: string;
  // Game context fields
  opponentName: string | null;
  gameDate: string | null;
  openingName: string | null;
  evalBefore: number | null;
  // SRS fields
  srsInterval: number;
  srsEaseFactor: number;
  srsRepetitions: number;
  srsDueDate: string;
  srsLastReview: string | null;
  status: MistakePuzzleStatus;
  attempts: number;
  successes: number;
  tacticType?: TacticType | null;
}

// ─── Opening Annotations ────────────────────────────────────────────────────

export interface AnnotationArrow {
  from: string;
  to: string;
  color?: string; // defaults to 'green' if omitted
  delay?: number; // seconds after annotation appears (default 0 = immediate)
}

export interface AnnotationHighlight {
  square: string;
  color?: string; // defaults to 'rgba(255, 255, 0, 0.4)' if omitted
  delay?: number; // seconds after annotation appears (default 0 = immediate)
}

export interface OpeningMoveAnnotation {
  san: string;
  /** Display annotation text (shown in the AnnotationCard). */
  annotation: string;
  /** Optional voice-narration text for this move. When present, the walkthrough
   *  will speak this string instead of `annotation` so the spoken script can
   *  diverge from the display text (e.g. simpler grammar, no abbreviations).
   *  When absent, callers fall back to a derived form of `annotation`. */
  narration?: string;
  /** Shorter narration used for higher speed tiers (Study/Review). When absent,
   *  the speed-tier sentence trim from `annotation` is used as today. */
  shortNarration?: string;
  pawnStructure?: string;
  plans?: string[];
  alternatives?: string[];
  moveOrderNote?: string;
  arrows?: AnnotationArrow[];
  highlights?: AnnotationHighlight[];
  /** Optional one-sentence coach hint surfaced when the user asks for help. */
  coachHint?: string;
  /** Stockfish evaluation in centipawns at this move (positive = white better). */
  evaluation?: number;
}

// ─── Common Mistakes ──────────────────────────────────────────────────────

export interface CommonMistake {
  fen: string;
  wrongMove: string;
  correctMove: string;
  explanation: string;
}

// ─── Checkpoint Quiz ──────────────────────────────────────────────────────

export interface CheckpointQuizItem {
  fen: string;
  type?: 'move' | 'plan';
  // Move-type fields
  correctMove?: string;
  // Plan-type fields (multiple choice)
  question?: string;
  choices?: string[];
  correctIndex?: number;
  hint: string;
  concept: string;
}

export interface OpeningSubLine {
  name: string;
  type?: 'variation' | 'trap' | 'warning';
  moveAnnotations: OpeningMoveAnnotation[];
}

export interface OpeningAnnotations {
  openingId: string;
  moveAnnotations: OpeningMoveAnnotation[];
  subLines?: OpeningSubLine[];
}

// ─── Opening ─────────────────────────────────────────────────────────────────

export type SidelineFrequency = 'common' | 'uncommon' | 'rare';
export type SidelineDanger = 'safe' | 'tricky' | 'critical';

export interface OpeningVariation {
  name: string;
  pgn: string;
  explanation: string;
  frequency?: SidelineFrequency;
  danger?: SidelineDanger;
  deviationMove?: number;
}

// ─── Model Games ────────────────────────────────────────────────────────────

export interface ModelGameCriticalMoment {
  moveNumber: number;
  color: 'white' | 'black';
  fen: string;
  annotation: string;
  concept: string;
  arrows?: AnnotationArrow[];
  highlights?: AnnotationHighlight[];
}

export interface ModelGame {
  id: string;
  openingId: string;
  white: string;
  black: string;
  whiteElo: number | null;
  blackElo: number | null;
  result: GameResult;
  year: number;
  event: string;
  pgn: string;
  overview: string;
  criticalMoments: ModelGameCriticalMoment[];
  middlegameTheme: string;
  lessonSummary: string;
}

// ─── Middlegame Plans ───────────────────────────────────────────────────────

export interface PawnBreak {
  move: string;
  explanation: string;
  fen: string;
  arrows?: AnnotationArrow[];
}

export interface PieceManeuver {
  piece: string;
  route: string;
  explanation: string;
  arrows?: AnnotationArrow[];
}

export interface PlayableMiddlegameLine {
  fen: string;
  moves: string[];
  annotations: string[];
  arrows: AnnotationArrow[][];
  title: string;
}

export interface MiddlegamePlan {
  id: string;
  openingId: string;
  criticalPositionFen: string;
  title: string;
  overview: string;
  pawnBreaks: PawnBreak[];
  pieceManeuvers: PieceManeuver[];
  strategicThemes: string[];
  endgameTransitions: string[];
  arrows?: AnnotationArrow[];
  highlights?: AnnotationHighlight[];
  playableLines?: PlayableMiddlegameLine[];
}

// ─── Opening Narrations (DB-Driven Hybrid System) ─────────────────────────

export interface OpeningNarration {
  id: string;
  openingName: string;
  variation: string;
  moveSan: string;
  fen: string | null;
  narrations: string[];
  approved: boolean;
}

// ─── Content Generation (LLM Pipeline) ─────────────────────────────────────

export type GeneratedContentType =
  | 'model_game_annotation'
  | 'middlegame_plan'
  | 'sideline_explanation'
  | 'deep_annotation';

export interface GeneratedContent {
  id: string;
  openingId: string;
  type: GeneratedContentType;
  content: string;
  groundingData: string;
  generatedAt: string;
}

export interface DrillAttempt {
  correct: boolean;
  time: number;
  date: string;
}

export interface OpeningPlayResult {
  openingId: string;
  openingMovesTotal: number;
  openingMovesCorrect: number;
  firstDeviationMove: number | null;
  correctMoveAtDeviation: string | null;
  finalEval: number | null;
  recommendation: string;
}

export interface OpeningRecord {
  id: string;
  eco: string;
  name: string;
  pgn: string;
  uci: string;
  fen: string;
  color: 'white' | 'black';
  style: string;
  isRepertoire: boolean;
  overview: string | null;
  keyIdeas: string[] | null;
  traps: string[] | null;
  warnings: string[] | null;
  variations: OpeningVariation[] | null;
  // Drillable trap/warning lines for Train mode
  trapLines?: OpeningVariation[] | null;
  warningLines?: OpeningVariation[] | null;
  drillAccuracy: number;
  drillAttempts: number;
  lastStudied: string | null;
  // Woodpecker Method tracking
  woodpeckerReps: number;
  woodpeckerSpeed: number | null;   // avg seconds to complete main line
  woodpeckerLastDate: string | null; // ISO date of last Woodpecker drill
  // Per-variation mastery (parallel array to variations)
  variationAccuracy?: number[];
  // Last 10 drill attempts for rolling mastery calculation
  drillHistory?: DrillAttempt[];
  // Chess Reps-style line tracking (indices into variations array)
  linesDiscovered?: number[];
  linesPerfected?: number[];
  // Favorites (WO-3)
  isFavorite: boolean;
  // Gambit flag (true for openings loaded from gambits.json)
  isGambit?: boolean;
  // Pro repertoire link (null for personal/ECO openings)
  proPlayerId?: string | null;
}

// ─── Pro Repertoires ────────────────────────────────────────────────────────

export interface ProPlayer {
  id: string;
  name: string;
  title: string;
  rating: number;
  style: string;
  description: string;
  imageInitials: string;
}

// ─── DB Meta ──────────────────────────────────────────────────────────────────

export interface MetaRecord {
  key: string;
  value: string;
}

// ─── Games ───────────────────────────────────────────────────────────────────

export type MoveClassification =
  | 'brilliant'
  | 'great'
  | 'good'
  | 'book'
  | 'miss'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder';

export interface MoveAnnotation {
  moveNumber: number;
  color: 'white' | 'black';
  san: string;
  evaluation: number | null;
  bestMove: string | null;
  classification: MoveClassification;
  comment: string | null;
}

export type GameSource = 'lichess' | 'chesscom' | 'master' | 'import' | 'coach';
export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

// ─── Platform Stats (Chess.com / Lichess import) ───────────────────────────

export interface TimeControlStats {
  rating: number;
  best: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface PlatformStats {
  platform: 'chesscom' | 'lichess';
  username: string;
  fetchedAt: string;
  rapid?: TimeControlStats;
  blitz?: TimeControlStats;
  bullet?: TimeControlStats;
  puzzleRating?: number;
}

export interface GameRecord {
  id: string;
  pgn: string;
  white: string;
  black: string;
  result: GameResult;
  date: string;
  event: string;
  eco: string | null;
  whiteElo: number | null;
  blackElo: number | null;
  source: GameSource;
  annotations: MoveAnnotation[] | null;
  coachAnalysis: string | null;
  isMasterGame: boolean;
  openingId: string | null;
  /** True when analyzeAllGames has completed full Stockfish per-move
   *  analysis on this game. False / undefined for freshly-imported
   *  games that only have sparse detectBlunders annotations. Every
   *  consumer that needs accuracy, move-quality stats, or weakness
   *  profiling should check this flag instead of guessing from
   *  annotation density (the old `annotations.length >= moves/2`
   *  heuristic). */
  fullyAnalyzed?: boolean;
}

// ─── Flashcards ──────────────────────────────────────────────────────────────

export type FlashcardType = 'best_move' | 'name_opening' | 'explain_idea';

export interface FlashcardRecord {
  id: string;
  openingId: string;
  type: FlashcardType;
  questionFen: string;
  questionText: string;
  answerMove: string | null;
  answerText: string;
  srsInterval: number;
  srsEaseFactor: number;
  srsRepetitions: number;
  srsDueDate: string;
  srsLastReview: string | null;
}

// ─── Settings Enums (WO-5) ───────────────────────────────────────────────────

export type PieceAnimationSpeed = 'none' | 'fast' | 'medium' | 'slow';
export type CoachVerbosity = 'none' | 'fast' | 'medium' | 'slow' | 'unlimited';

/** How much the coach says at live phase transitions (opening→middlegame
 *  and middlegame→endgame). Separate from CoachVerbosity because the
 *  surfaces have different shapes: phase narration fires at most twice
 *  per game; in-game commentary can fire every move. Added by
 *  WO-PHASE-NARRATION-01. */
export type PhaseNarrationVerbosity = 'off' | 'brief' | 'standard' | 'full';
export type MoveMethod = 'drag' | 'click' | 'both';
export type AiProvider = 'deepseek' | 'anthropic';

// ─── User Profile ─────────────────────────────────────────────────────────────

export interface SkillRadar {
  opening: number;
  tactics: number;
  endgame: number;
  memory: number;
  calculation: number;
}

export interface BadHabit {
  id: string;
  description: string;
  occurrences: number;
  lastSeen: string;
  isResolved: boolean;
}

export interface UserPreferences {
  theme: string;
  boardColor: string;
  pieceSet: string;
  showEvalBar: boolean;
  showEngineLines: boolean;
  soundEnabled: boolean;
  voiceEnabled: boolean;
  /** Coach-specific voice narration toggle, persisted separately
   *  from `voiceEnabled` so the user can silence the coach without
   *  disabling all in-app audio. Defaults to true (trainer-mode
   *  default) and syncs with appStore.coachVoiceOn. */
  coachVoiceOn?: boolean;
  dailySessionMinutes: number;
  aiProvider: AiProvider;
  apiKeyEncrypted: string | null;
  apiKeyIv: string | null;
  anthropicApiKeyEncrypted: string | null;
  anthropicApiKeyIv: string | null;
  /** Supabase anon key stored encrypted via cryptoService. Paired
   *  with supabaseAnonKeyIv. Optional so older profiles without the
   *  sync feature wired up don't need a migration. */
  supabaseAnonKeyEncrypted?: string | null;
  supabaseAnonKeyIv?: string | null;
  preferredModel: {
    commentary: string;
    analysis: string;
    reports: string;
  };
  monthlyBudgetCap: number | null;
  estimatedSpend: number;
  elevenlabsKeyEncrypted: string | null;
  elevenlabsKeyIv: string | null;
  elevenlabsVoiceId: string | null;
  // Amazon Polly TTS (server-side, no API key in browser)
  pollyEnabled: boolean;
  pollyVoice: string;
  voiceSpeed: number;
  // Kokoro TTS (open-source, in-browser)
  kokoroEnabled: boolean;
  kokoroVoiceId: string;
  // System voice (Web Speech API)
  systemVoiceURI: string | null;
  // Board Display (WO-5)
  highlightLastMove: boolean;
  showLegalMoves: boolean;
  showCoordinates: boolean;
  pieceAnimationSpeed: PieceAnimationSpeed;
  // Piece Sound Customization (WO-COACH-PIECE-SOUND-CUSTOM). Layered ON
  // TOP of the existing style-set / event-type defaults so move /
  // capture / castle / check stay distinguishable. Each value is
  // 0–100; defaults below produce the current sound character.
  /** Pitch multiplier 0–100 (0 = 0.5×, 50 = 1.0×, 100 = 2.0×). */
  pieceSoundPitch?: number;
  /** Tone (low-pass filter brightness) 0–100 (0 = warmest, 100 = brightest). */
  pieceSoundTone?: number;
  /** Waveform character 0–100 — continuous blend across
   *  sine → triangle → square → sawtooth. 0 = pure sine. */
  pieceSoundWaveform?: number;
  /** Length multiplier 0–100 (0 = 0.5×, 50 = 1.0×, 100 = 2.0×). */
  pieceSoundLength?: number;
  boardOrientation: boolean;
  // Feedback & Coaching (WO-5)
  moveQualityFlash: boolean;
  showHints: boolean;
  // Game Behavior (WO-5)
  moveMethod: MoveMethod;
  moveConfirmation: boolean;
  autoPromoteQueen: boolean;
  // Master Control (WO-5)
  masterAllOff: boolean;
  // Coach Gameplay Settings
  coachBlunderAlerts?: boolean;
  coachTacticAlerts?: boolean;
  coachPositionalTips?: boolean;
  coachMissedTacticTakeback?: boolean;
  coachReviewVoice?: boolean;
  coachVerbosity?: CoachVerbosity;
  /** Live phase-transition narration verbosity. 'off' silences the
   *  coach at phase boundaries; 'brief'/'standard'/'full' set the
   *  depth. Default 'standard'. Added by WO-PHASE-NARRATION-01. */
  phaseNarrationVerbosity?: PhaseNarrationVerbosity;
  /** Coach personality voice — picks the body of the system prompt.
   *  See `src/coach/sources/personalities.ts`. Defaults to 'default'
   *  (the original Danya voice). WO-COACH-PERSONALITIES (PR B). */
  coachPersonality?: import('../coach/types').CoachPersonality;
  /** Per-personality Polly voice override. Empty / missing entries
   *  fall back to PERSONALITY_VOICE_DEFAULTS in voiceService.ts.
   *  WO-COACH-PERSONALITY-VOICE — voice + personality are orthogonal
   *  dials. Lets the user pair any voice with any personality
   *  ("drill-sergeant Ruth" / "flirtatious Stephen"). */
  coachPersonalityVoices?: Partial<
    Record<import('../coach/types').CoachPersonality, string>
  >;
  /** Per-personality SECONDARY voice override. Used for short alerts
   *  / interjections (tactic warnings, opponent-blunder live-coach
   *  calls) so the user hears a different timbre for "watch out"
   *  than for the main narration. WO-VOICE-LAYER-01 (b). When unset,
   *  falls back to PERSONALITY_SECONDARY_VOICE_DEFAULTS in
   *  voiceService.ts. */
  coachPersonalitySecondaryVoices?: Partial<
    Record<import('../coach/types').CoachPersonality, string>
  >;
  /** Profanity dial. Default 'none'. Settings UI seeds the dial with
   *  the per-personality default at first selection (e.g.
   *  drill-sergeant → 'hard'), but once a value is stored here it
   *  overrides the personality default until the user resets it. */
  coachProfanity?: import('../coach/types').IntensityLevel;
  /** Mockery dial. Default 'none'. */
  coachMockery?: import('../coach/types').IntensityLevel;
  /** Flirt dial. Default 'none'. */
  coachFlirt?: import('../coach/types').IntensityLevel;
  /**
   * Controls when the coach invokes the LLM for per-move commentary
   * during play-against games.
   *   - 'key-moments' (default): only blunders, mistakes, brilliants,
   *     and greats trigger an LLM call. Other moves use a short
   *     deterministic tactic suffix or stay silent. Cuts per-game
   *     LLM spend ~60%.
   *   - 'every-move': legacy — call the LLM on every move (expensive).
   *   - 'off': never call the LLM mid-game; commentary comes purely
   *     from the local tactic classifier.
   * When unset, treat as 'key-moments' so users who haven't touched
   * the setting automatically benefit from the cost reduction.
   */
  coachCommentaryVerbosity?: 'key-moments' | 'every-move' | 'off';
  /** How much the coach says PER TURN when it does talk. Wired through
   *  to the brain's TEACH_MODE_ADDITION + OPERATOR_BASE_BODY teaching
   *  block to clamp response length. (Distinct from the older
   *  `coachVerbosity` field above, which controls speech *pace*.)
   *    - 'minimal'  → one short sentence, ≤8 words ("Nf6 — your move.")
   *    - 'normal'   → one short sentence, ≤15 words (default)
   *    - 'verbose'  → full lecture shape, no length cap (set up
   *                   positions, demonstrate, name the IDEA, etc.)
   *  When unset, treat as 'normal'. */
  coachResponseLength?: 'minimal' | 'normal' | 'verbose';
  // Neon Glow Settings
  glowBrightness?: number;         // 0–200, default 100 — master dimmer for all glow
  boardGlowColor?: string;         // rgb string e.g. "0, 229, 255" — single color for all squares
  whitePieceGlowColor?: string;    // rgb string e.g. "0, 255, 136" — glow color for white pieces
  blackPieceGlowColor?: string;    // rgb string e.g. "168, 85, 247" — glow color for black pieces
  // Import accounts
  chessComUsername?: string;
  lichessUsername?: string;
  // Auto-import scheduler — bookkeeping for the biweekly background sync
  // started at app boot. Epoch ms timestamp of the most recent successful
  // import per service; the scheduler skips a service whose stamp is less
  // than AUTO_IMPORT_INTERVAL_MS old. Set to null/undefined to force a
  // run on next boot.
  lastChessComAutoImportAt?: number | null;
  lastLichessAutoImportAt?: number | null;
  // Lichess API token (encrypted, for puzzle activity/dashboard)
  lichessTokenEncrypted?: string | null;
  lichessTokenIv?: string | null;
  /**
   * Persistent "what the coach has learned about this student" notes.
   * Short natural-language observations emitted by the coach (via the
   * `[[REMEMBER: ...]]` tag in its replies) and injected into every
   * coach prompt so advice stays consistent over time. Bounded to
   * avoid runaway growth; see coachMemoryService for limits.
   */
  coachMemory?: string[];
}

export interface UserProfile {
  id: string;
  name: string;
  isKidMode: boolean;
  currentRating: number;
  puzzleRating: number;
  xp: number;
  level: number;
  currentStreak: number;
  longestStreak: number;
  streakFreezes: number;
  lastActiveDate: string;
  skillRadar: SkillRadar;
  badHabits: BadHabit[];
  preferences: UserPreferences;
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export type SessionBlockType =
  | 'opening_review'
  | 'puzzle_drill'
  | 'flashcards'
  | 'game_analysis'
  | 'endgame_drill'
  | 'master_game_study';

export interface SessionBlock {
  type: SessionBlockType;
  targetMinutes: number;
  openingId?: string;
  puzzleTheme?: string;
  gameId?: string;
  completed: boolean;
}

export interface SessionPlan {
  blocks: SessionBlock[];
  totalMinutes: number;
}

export interface SessionRecord {
  id: string;
  date: string;
  profileId: string;
  durationMinutes: number;
  plan: SessionPlan;
  completed: boolean;
  puzzlesSolved: number;
  puzzleAccuracy: number;
  xpEarned: number;
  coachSummary: string | null;
}

// ─── SRS ─────────────────────────────────────────────────────────────────────

export type SrsGrade = 'again' | 'hard' | 'good' | 'easy';

export interface SrsResult {
  interval: number;
  easeFactor: number;
  repetitions: number;
  dueDate: string;
}

// ─── Stockfish ───────────────────────────────────────────────────────────────

export interface AnalysisLine {
  rank: number;
  evaluation: number;
  moves: string[];
  mate: number | null;
}

export interface StockfishAnalysis {
  bestMove: string;
  evaluation: number;
  isMate: boolean;
  mateIn: number | null;
  depth: number;
  topLines: AnalysisLine[];
  nodesPerSecond: number;
}

// ─── Coach ───────────────────────────────────────────────────────────────────

export type CoachDifficulty = 'easy' | 'medium' | 'hard';

export type HintLevel = 0 | 1 | 2 | 3;

// ─── Board Annotations ──────────────────────────────────────────────────────

export interface BoardArrow {
  startSquare: string;
  endSquare: string;
  color: string;
}

export interface BoardHighlight {
  square: string;
  color: string;
}

export interface GhostMoveData {
  fromSquare: string;
  toSquare: string;
  /** Piece code like 'wN', 'bQ' — matches pieceSetService keys */
  piece: string;
  capturedSquare: string | null;
}

export interface BoardAnnotationCommand {
  type: 'arrow' | 'highlight' | 'show_position' | 'practice' | 'clear';
  arrows?: BoardArrow[];
  highlights?: BoardHighlight[];
  fen?: string;
  label?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /**
   * How this message was produced.
   * - 'voice' — the user spoke this (or the assistant is replying to a
   *   voice turn). UI hides the text bubble and shows a speaking
   *   indicator; TTS is the primary output.
   * - 'text' (default) — user typed it / reading is the primary output.
   * Assistant messages inherit this from the preceding user turn so
   * the reply honours the same modality.
   */
  modality?: 'voice' | 'text';
  metadata?: {
    actions?: { type: string; id: string }[];
    annotations?: BoardAnnotationCommand[];
  };
}

export type CoachGameStatus = 'pregame' | 'playing' | 'blunder_pause' | 'gameover' | 'postgame';
export type CoachGameResult = 'win' | 'loss' | 'draw' | 'ongoing';

export interface CoachGameMove {
  moveNumber: number;
  san: string;
  fen: string;
  isCoachMove: boolean;
  commentary: string;
  evaluation: number | null;
  classification: MoveClassification | null;
  expanded: boolean;
  bestMove: string | null;
  bestMoveEval: number | null;
  preMoveEval: number | null;
}

export interface KeyMoment {
  moveNumber: number;
  fen: string;
  explanation: string;
  type: 'blunder' | 'brilliant' | 'turning_point';
}

export interface CoachGameState {
  gameId: string;
  playerColor: 'white' | 'black';
  targetStrength: number;
  moves: CoachGameMove[];
  hintsUsed: number;
  currentHintLevel: HintLevel;
  takebacksUsed: number;
  status: CoachGameStatus;
  result: CoachGameResult;
  keyMoments: KeyMoment[];
}

export type CoachTask =
  | 'move_commentary'
  | 'hint'
  | 'puzzle_feedback'
  | 'post_game_analysis'
  | 'daily_lesson'
  | 'bad_habit_report'
  | 'weekly_report'
  | 'deep_analysis'
  | 'opening_overview'
  | 'chat_response'
  | 'game_commentary'
  | 'game_opening_line'
  | 'game_post_review'
  | 'position_analysis_chat'
  | 'session_plan_generation'
  | 'weakness_report'
  | 'interactive_review'
  | 'whatif_commentary'
  | 'game_narrative_summary'
  | 'model_game_annotation'
  | 'middlegame_plan_generation'
  | 'sideline_explanation'
  | 'smart_search'
  | 'explore_reaction'
  | 'intent_classify';

export interface CoachContext {
  fen: string;
  lastMoveSan: string | null;
  moveNumber: number;
  pgn: string;
  openingName: string | null;
  stockfishAnalysis: StockfishAnalysis | null;
  playerMove: string | null;
  moveClassification: MoveClassification | null;
  playerProfile: {
    rating: number;
    weaknesses: string[];
  };
  additionalContext?: string;
}

export interface OpeningAnnotationContext {
  fen: string;
  moveNumber: number;
  openingName: string | null;
  lastMoves: string[];
  currentMoveSan: string | null;
  additionalContext?: string;
}

// ─── Weakness Analysis ──────────────────────────────────────────────────────

export type WeaknessCategory =
  | 'tactics'
  | 'openings'
  | 'opening_weakspots'
  | 'endgame'
  | 'calculation'
  | 'positional'
  | 'time_management';

export interface WeaknessTrainingAction {
  route: string;
  buttonLabel: string;
  state?: Record<string, unknown>;
}

export interface WeaknessItem {
  category: WeaknessCategory;
  label: string;
  metric: string;
  severity: number; // 0-100, higher = worse
  detail: string;
  trainingAction?: WeaknessTrainingAction;
}

export interface StrengthItem {
  title: string;
  detail: string;
  category: WeaknessCategory;
  metric: string;
}

export interface WeaknessProfile {
  computedAt: string;
  items: WeaknessItem[];
  strengths: string[];
  strengthItems: StrengthItem[];
  overallAssessment: string;
}

// ─── Weakness-to-Drill System ───────────────────────────────────────────────

export interface WeaknessTheme {
  theme: string;
  specificPattern: string;
  frequency: number;
  sampleFens: string[];
  avgCentipawnLoss: number;
}

export interface WeaknessDrillItem {
  mistakePuzzle: MistakePuzzle;
  themeKey: string;
}

export interface WeaknessDrillSession {
  themes: WeaknessTheme[];
  drillItems: WeaknessDrillItem[];
  generatedAt: string;
}

export type ReviewMode = 'analysis' | 'whatif' | 'practice' | 'guided_lesson';

// ─── Opening Weak Spots ─────────────────────────────────────────────────────

export interface OpeningWeakSpot {
  id: string;
  openingId: string;
  openingName: string;
  fen: string;
  moveIndex: number;
  correctMoveSan: string;
  failCount: number;
  lastFailedAt: string;
  lastDrilledAt: string | null;
}


export interface ReviewState {
  mode: ReviewMode;
  currentMoveIndex: number;
  whatIfMoves: string[];
  whatIfStartFen: string | null;
}

export interface CriticalMoment {
  moveNumber: number;
  fen: string;
  playerMove: string;
  bestMove: string;
  evaluation: number;
  bestEvaluation: number;
  explanation: string;
  type: 'blunder' | 'mistake' | 'inaccuracy' | 'brilliant' | 'turning_point';
  relatedWeakness: string | null;
}

// ─── Game Phase Analysis ─────────────────────────────────────────────────────

export type GamePhase = 'opening' | 'middlegame' | 'endgame';

export interface PhaseAccuracy {
  phase: GamePhase;
  accuracy: number;
  moveCount: number;
  mistakes: number;
}

// ─── Missed Tactic Detection ─────────────────────────────────────────────────

export type TacticType =
  | 'fork'
  | 'pin'
  | 'skewer'
  | 'discovered_attack'
  | 'back_rank'
  | 'hanging_piece'
  | 'promotion'
  | 'deflection'
  | 'overloaded_piece'
  | 'trapped_piece'
  | 'clearance'
  | 'interference'
  | 'zwischenzug'
  | 'x_ray'
  | 'double_check'
  | 'removing_the_guard'
  | 'tactical_sequence';

export interface MissedTactic {
  moveIndex: number;
  playerMoved: string;
  bestMove: string;
  fen: string;
  evalSwing: number;
  tacticType: TacticType;
  explanation: string;
}

// ─── Game Insights ──────────────────────────────────────────────────────────

export type InsightsTab = 'overview' | 'openings' | 'mistakes' | 'tactics';

export interface OverviewInsights {
  totalGames: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  winRateWhite: number;
  winRateBlack: number;
  avgElo: number;
  avgAccuracy: number;
  highestBeaten: { name: string; elo: number; gameId: string } | null;
  lowestLostTo: { name: string; elo: number; gameId: string } | null;
  classificationCounts: MoveClassificationCounts;
  totalMoves: number;
  avgMovesPerGame: number;
  avgBrilliantsPerGame: number;
  avgMistakesPerGame: number;
  avgBlundersPerGame: number;
  avgInaccuraciesPerGame: number;
  bestMoveAgreement: number;
  phaseAccuracy: PhaseAccuracy[];
  accuracyWhite: number;
  accuracyBlack: number;
  strengths: string[];
  /** Games with full Stockfish per-move analysis (drives every accuracy
   *  and move-quality stat above). */
  analyzedGameCount: number;
  /** Games imported but lacking full per-move analysis. When > 0 the UI
   *  surfaces a CTA — otherwise the user sees 0% across the board with
   *  no hint why. */
  gamesNeedingAnalysis: number;
}

export interface OpeningAggregateStats {
  name: string;
  eco: string | null;
  openingId: string | null;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  avgAccuracy: number;
  gameIds: string[];
}

export interface OpeningInsights {
  repertoireCoverage: { inBook: number; offBook: number };
  mostPlayedWhite: OpeningAggregateStats[];
  mostPlayedBlack: OpeningAggregateStats[];
  winRateByOpening: OpeningAggregateStats[];
  drillAccuracyByOpening: { name: string; accuracy: number; attempts: number }[];
  strengths: string[];
}

export interface CostlyMistake {
  gameId: string;
  moveNumber: number;
  san: string;
  cpLoss: number;
  classification: string;
  opponentName: string;
  date: string;
  openingName: string | null;
  phase: MistakeGamePhase;
}

export interface MistakeInsights {
  errorBreakdown: { blunders: number; mistakes: number; inaccuracies: number };
  missedWins: number;
  avgCpLoss: number;
  errorsByPhase: { phase: GamePhase; errors: number; avgCpLoss: number }[];
  errorsBySituation: { winning: number; equal: number; losing: number };
  thrownWins: number;
  lateGameCollapses: number;
  costliestMistakes: CostlyMistake[];
  puzzleProgress: { unsolved: number; solved: number; mastered: number };
  totalGames: number;
  strengths: string[];
}

export interface TacticalMoment {
  gameId: string;
  moveNumber: number;
  san: string;
  fen: string;
  evalSwing: number;
  tacticType: TacticType;
  explanation: string;
  opponentName: string;
  date: string;
  openingName: string | null;
}

export interface TacticInsights {
  tacticsFound: { brilliant: number; great: number };
  avgBrilliantsPerGame: number;
  avgGreatPerGame: number;
  tacticsByType: { type: TacticType; count: number }[];
  bestSequences: TacticalMoment[];
  worstMisses: TacticalMoment[];
  missedByType: { type: TacticType; count: number; avgCost: number }[];
  foundVsMissed: { found: number; missed: number };
  awarenessRate: number;
  missedByPhase: { phase: GamePhase; count: number }[];
  totalGames: number;
  strengths: string[];
}

// ─── Classified Tactics (persisted) ─────────────────────────────────────────

export interface ClassifiedTactic {
  id: string;
  sourceGameId: string;
  moveIndex: number;
  fen: string;
  bestMoveUci: string;
  bestMoveSan: string;
  playerMoveUci: string;
  playerMoveSan: string;
  playerColor: 'white' | 'black';
  tacticType: TacticType;
  evalSwing: number;
  explanation: string;
  // Game context
  opponentName: string | null;
  gameDate: string | null;
  openingName: string | null;
  // Training tracking
  puzzleAttempts: number;
  puzzleSuccesses: number;
  createdAt: string;
}

export interface TacticMotifStats {
  tacticType: TacticType;
  missedInGames: number;
  puzzleAttempts: number;
  puzzleAccuracy: number;
  gameAwareness: number;
}

// ─── Tactics Training Program ────────────────────────────────────────────────

export type SetupPuzzleDifficulty = 1 | 2 | 3;
export type SetupPuzzleStatus = 'unsolved' | 'solved' | 'mastered';

export interface SetupPuzzle {
  id: string;
  setupFen: string;
  solutionMoves: string;
  tacticFen: string;
  tacticMoves: string;
  tacticType: TacticType;
  difficulty: SetupPuzzleDifficulty;
  sourceGameId: string | null;
  sourceMistakePuzzleId: string | null;
  playerColor: 'white' | 'black';
  openingName: string | null;
  srsInterval: number;
  srsEaseFactor: number;
  srsRepetitions: number;
  srsDueDate: string;
  srsLastReview: string | null;
  status: SetupPuzzleStatus;
  attempts: number;
  successes: number;
  createdAt: string;
}

export interface TacticTypeStats {
  tacticType: TacticType;
  puzzleAccuracy: number;
  puzzleAttempts: number;
  gameMissCount: number;
  gameSpotCount: number;
  gameTotalOccurrences: number;
  gameSpotRate: number;
  gap: number;
  byPhase: Record<MistakeGamePhase, number>;
  byOpening: Record<string, number>;
}

export interface TacticalProfile {
  computedAt: string;
  stats: TacticTypeStats[];
  totalGamesMissed: number;
  totalGamesAnalyzed: number;
  weakestTypes: TacticType[];
}

// ─── Theme ───────────────────────────────────────────────────────────────────

export interface AppTheme {
  id: string;
  name: string;
  colors: {
    bg: string;
    bgSecondary: string;
    surface: string;
    border: string;
    text: string;
    textMuted: string;
    accent: string;
    accentHover: string;
    success: string;
    error: string;
    warning: string;
  };
}

// ─── Kid Mode ────────────────────────────────────────────────────────────────

export type ChessPiece = 'king' | 'queen' | 'rook' | 'bishop' | 'knight' | 'pawn';

export interface KidLesson {
  piece: ChessPiece;
  title: string;
  description: string;
  fen: string;
  highlightSquares: string[];
}

// ─── Pawn's Journey ──────────────────────────────────────────────────────────

export type JourneyChapterId =
  | 'pawn'
  | 'rook'
  | 'bishop'
  | 'knight'
  | 'queen'
  | 'king'
  | 'tactics'
  | 'first-game';

export const JOURNEY_CHAPTER_ORDER: readonly JourneyChapterId[] = [
  'pawn',
  'rook',
  'bishop',
  'knight',
  'queen',
  'king',
  'tactics',
  'first-game',
] as const;

export interface JourneyLesson {
  id: string;
  title: string;
  story: string;
  fen: string;
  highlightSquares: string[];
  instruction: string;
}

export interface JourneyPuzzle {
  id: string;
  fen: string;
  solution: string[];
  hint: string;
  successMessage: string;
}

export interface JourneyChapter {
  id: JourneyChapterId;
  title: string;
  subtitle: string;
  icon: string;
  lessons: JourneyLesson[];
  puzzles: JourneyPuzzle[];
  storyIntro: string;
  storyOutro: string;
  requiredPuzzleScore: number;
}

export interface JourneyChapterProgress {
  chapterId: JourneyChapterId;
  lessonsCompleted: number;
  puzzlesCompleted: number;
  puzzlesCorrect: number;
  completed: boolean;
  bestScore: number;
  completedAt: string | null;
}

export interface JourneyProgress {
  chapters: Partial<Record<JourneyChapterId, JourneyChapterProgress>>;
  currentChapterId: JourneyChapterId;
  startedAt: string;
  completedAt: string | null;
}

// ─── Kid Game Config ─────────────────────────────────────────────────────────

// ─── Board Utils ────────────────────────────────────────────────────────────

export interface DetectedOpening {
  eco: string;
  name: string;
  plyCount: number;
}

export interface CapturedPieces {
  white: string[];
  black: string[];
}

export interface GameAccuracy {
  white: number;
  black: number;
  moveCount: number;
}

export interface MoveClassificationCounts {
  brilliant: number;
  great: number;
  good: number;
  book: number;
  miss: number;
  inaccuracy: number;
  mistake: number;
  blunder: number;
}

export interface GameAnalysisSummary {
  accuracy: GameAccuracy;
  classificationCounts: MoveClassificationCounts;
  phaseBreakdown: PhaseAccuracy[];
  missedTactics: MissedTactic[];
  keyMoments: KeyMoment[];
  playerColor: 'white' | 'black';
  result: CoachGameResult;
}

export type KidGameId = 'pawns-journey' | 'fairy-tale';

export interface KidGameConfig {
  gameId: KidGameId;
  title: string;
  icon: string;
  routePrefix: string;
  chapters: JourneyChapter[];
  chapterOrder: readonly JourneyChapterId[];
}

// ─── Mini-Games ─────────────────────────────────────────────────────────────

export type MiniGameId = 'pawn-wars' | 'blocker';

export type MiniGameDifficulty = 1 | 2 | 3;

export type MiniGameHighlightMode = 'all' | 'danger' | 'none';

export type MiniGamePhase = 'intro' | 'playing' | 'won' | 'lost';

export interface MiniGameAiConfig {
  /** Probability (0–1) of making the scored "best" move vs a random pawn move */
  bestMoveChance: number;
  /** Whether AI tries to block/capture the player's most advanced pawn */
  blocksAdvancedPawn: boolean;
  /** Whether AI prioritises pushing its own most advanced pawn */
  prioritizesAdvancement: boolean;
  /** For Blocker: file index (0-based, c=0 d=1 e=2 f=3) of the AI's target pawn */
  targetPawnFile?: string;
}

export interface MiniGameLevelConfig {
  level: MiniGameDifficulty;
  title: string;
  description: string;
  /** Starting FEN — kings placed in corners for chess.js legality */
  startFen: string;
  /** Player colour */
  playerColor: 'w' | 'b';
  /** Which square highlights to show */
  highlightMode: MiniGameHighlightMode;
  /** Whether the AI's target pawn is visually marked (Blocker only) */
  showTargetPawn: boolean;
  /** AI behaviour */
  aiConfig: MiniGameAiConfig;
  /** Narrative intro spoken before game */
  storyIntro: string;
  /** Narrative on win */
  storyWin: string;
  /** Narrative on loss */
  storyLoss: string;
}

export interface MiniGameLevelProgress {
  completed: boolean;
  stars: number;
  hintsUsed: number;
}

export interface MiniGameProgress {
  levels: Partial<Record<number, MiniGameLevelProgress>>;
}

// ─── Guided Game Tutorial ───────────────────────────────────────────────────

export interface GuidedMove {
  /** Move number (1-based, shared by white/black pairs) */
  moveNumber: number;
  /** Standard algebraic notation, e.g. "e4", "Bc4", "Qxf7#" */
  san: string;
  /** FEN position AFTER this move */
  fen: string;
  /** 'w' for White's move, 'b' for Black's move */
  color: 'w' | 'b';
  /** If true, the app auto-animates this move. If false, the kid plays it. */
  autoPlay: boolean;
  /** Coach narration displayed and spoken at this move */
  narration?: string;
  /** Squares to highlight on the board */
  highlightSquares?: string[];
  /** Teaching concept label, e.g. "center control", "development" */
  teachingConcept?: string;
  /** If true, awards a milestone star */
  isMilestone?: boolean;
  /** Feedback text when the kid plays the wrong move */
  wrongMoveResponse?: string;
}

export type GuidedGameDifficulty = 1 | 2 | 3;

export interface GuidedGame {
  id: string;
  title: string;
  description: string;
  difficulty: GuidedGameDifficulty;
  estimatedMinutes: number;
  storyIntro: string;
  storyOutro: string;
  /** Starting FEN (usually the standard starting position) */
  startFen: string;
  /** The player's color in this game */
  playerColor: 'w' | 'b';
  moves: GuidedMove[];
}

export interface GuidedGameProgress {
  completed: boolean;
  stars: number;
  bestTime: number | null;
}

// ─── Lichess Opening Explorer ────────────────────────────────────────────────

export interface LichessExplorerGame {
  id: string;
  white: { name: string; rating: number };
  black: { name: string; rating: number };
  winner: 'white' | 'black' | null;
  year: number;
  month: string;
}

export interface LichessExplorerMove {
  uci: string;
  san: string;
  averageRating: number;
  white: number;
  draws: number;
  black: number;
  game: LichessExplorerGame | null;
}

export interface LichessExplorerResult {
  white: number;
  draws: number;
  black: number;
  moves: LichessExplorerMove[];
  topGames: LichessExplorerGame[];
  opening: { eco: string; name: string } | null;
}

// ─── Lichess Cloud Eval ──────────────────────────────────────────────────────

export interface LichessCloudEvalPv {
  moves: string;
  cp?: number;
  mate?: number;
}

export interface LichessCloudEval {
  fen: string;
  knodes: number;
  depth: number;
  pvs: LichessCloudEvalPv[];
}

// ─── Lichess Puzzle Dashboard ────────────────────────────────────────────────

export interface LichessPuzzleThemeResult {
  firstWins: number;
  replayWins: number;
  nb: number;
}

export interface LichessPuzzleDashboard {
  days: number;
  global: LichessPuzzleThemeResult;
  themes: Record<string, { results: LichessPuzzleThemeResult }>;
}

// ─── Lichess Puzzle Activity ─────────────────────────────────────────────────

export interface LichessPuzzleActivityEntry {
  date: number;
  puzzleId: string;
  win: boolean;
}

// ─── Bishop Mini-Games ──────────────────────────────────────────────────────

export type BishopGamePhase = 'menu' | 'playing' | 'won' | 'lost';

export interface BishopVsPawnsLevel {
  level: number;
  description: string;
  bishopStart: string;
  pawnSquares: string[];
  showBishopMoves: boolean;
  showThreatenedSquares: boolean;
}

export interface ColorWarsLevel {
  level: number;
  description: string;
  lightBishopStart: string;
  darkBishopStart: string;
  enemyPieces: Array<{ square: string; piece: string }>;
  timerSeconds: number;
  showBishopMoves: boolean;
  showEnemyGlow: boolean;
}

// ─── Smart Search ────────────────────────────────────────────────────────────

export type SmartSearchCategory = 'opening' | 'game' | 'mistake' | 'puzzle';

export interface SmartSearchResult {
  category: SmartSearchCategory;
  id: string;
  title: string;
  subtitle: string;
  route: string;
}

export interface SearchIntent {
  table: 'openings' | 'games' | 'mistakePuzzles' | 'puzzles';
  filters: SearchFilter[];
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
  limit?: number;
}

export interface SearchFilter {
  field: string;
  op: 'eq' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte';
  value: string | number | boolean;
}

// ─── Endgame Progress ────────────────────────────────────────────────────────

/** Per-position progress record for the endgame lesson surface.
 *  Tracks whether the student has played a given position perfectly
 *  on their first try (mastery), the running play count, and the
 *  last play timestamp. The composite id `${lessonId}::${fen}`
 *  scopes records to a specific position within a specific lesson
 *  so the same FEN appearing in two lessons gets two records.
 *
 *  `mastered` is sticky — once true, subsequent plays don't unset
 *  it. The student earned mastery; we don't take it away if they
 *  later make a mistake on a retry. */
export interface EndgameProgressRecord {
  /** Composite key: `<lessonId>::<fen>`. */
  id: string;
  /** Lesson slug — index for "all positions in a lesson" queries. */
  lessonId: string;
  /** Position FEN this record describes. */
  fen: string;
  /** True once the student has completed the playout on first try
   *  without a wrong drop. Sticky — never goes false after going
   *  true. */
  mastered: boolean;
  /** Total number of times the student has completed the playout
   *  for this position. */
  timesPlayed: number;
  /** Total number of wrong-move attempts across all plays. Used
   *  for "you needed N tries" UX. */
  totalWrongAttempts: number;
  /** Unix ms timestamp of the last completed playout. */
  lastPlayedAt: number;
}
