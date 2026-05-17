/**
 * coachService — the Coach Brain spine entry point.
 *
 * Every surface in the app calls `coachService.ask({ surface, ask,
 * liveState })`. The service:
 *   1. Logs `coach-brain-ask-received`.
 *   2. Reads the four sources (identity, memory, app map, live state)
 *      and assembles the six-part envelope.
 *   3. Calls the active provider (DeepSeek by default; flippable to
 *      Anthropic via `COACH_PROVIDER` env var).
 *   4. Dispatches any tool calls the LLM emitted (via the existing
 *      `[[ACTION:name {args}]]` tag protocol parsed inside the
 *      provider).
 *   5. If `maxToolRoundTrips > 1` (BRAIN-04), feeds the tool results
 *      back to the provider as a follow-up turn, allowing the LLM to
 *      see what each tool returned and react with another tool call
 *      or a final answer. Capped at `maxToolRoundTrips` to prevent
 *      runaway loops.
 *   6. Returns the cleaned text from the FINAL turn + a list of every
 *      tool-call id dispatched across all turns.
 *
 * Surface-specific callbacks (`onPlayMove`, `onNavigate`) are threaded
 * into each tool dispatch via `ToolExecutionContext`. Tools that need
 * a real side effect (cerebrum) consume the context; cerebellum tools
 * ignore it.
 *
 * See `docs/COACH-BRAIN-00.md` for the architecture this implements.
 */
import { logAppAudit } from '../services/appAuditor';
import { assembleEnvelope } from './envelope';
import { deepseekProvider } from './providers/deepseek';
import { anthropicProvider } from './providers/anthropic';
import { COACH_TOOLS, getTool, getToolDefinitions } from './tools/registry';
import type {
  AssembledEnvelope,
  CoachAnswer,
  CoachAskInput,
  CoachIdentity,
  CoachPersonality,
  IntensityLevel,
  Provider,
  ProviderName,
  ProviderResponse,
  ToolExecutionContext,
} from './types';

/** Read provider name from `import.meta.env.COACH_PROVIDER`, falling
 *  back to `process.env.COACH_PROVIDER` (Node test envs), default
 *  'anthropic'. Anthropic is the primary; on auth/quota error the
 *  coachApi layer transparently retries on DeepSeek via the existing
 *  fallback chain at `coachApi.ts:782` (`getFallbackConfig`). The
 *  constitution requires this be a one-line flip. */
function resolveProviderName(): ProviderName {
  // Vite-style env (browser builds).
  const viteEnv = (typeof import.meta !== 'undefined'
    ? (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    : undefined);
  const fromVite = viteEnv?.VITE_COACH_PROVIDER ?? viteEnv?.COACH_PROVIDER;
  // Node-style env (vitest, scripts).
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const fromProcess = typeof process !== 'undefined' && process.env
    ? process.env.COACH_PROVIDER
    : undefined;
  const raw = (fromVite ?? fromProcess ?? 'anthropic').toLowerCase();
  return raw === 'deepseek' ? 'deepseek' : 'anthropic';
}

function pickProvider(name: ProviderName): Provider {
  return name === 'anthropic' ? anthropicProvider : deepseekProvider;
}

/** Map the spine's `CoachSurface` enum to a route path the audit
 *  stream + claim-validator audits can attribute against. Used by
 *  the auto-grounding hook to label which surface generated each
 *  master-play event. WO-COACH-MASTER-INTEGRATION. */
function coachSurfaceToRoute(surface: string): string {
  switch (surface) {
    case 'home-chat':       return '/coach/home';
    case 'standalone-chat': return '/coach/chat';
    case 'game-chat':       return '/coach/play';
    case 'move-selector':   return '/coach/play';
    case 'hint':            return '/coach/play';
    case 'phase-narration': return '/coach/play';
    case 'ping':            return '/coach/play';
    case 'review':          return '/coach/review';
    case 'teach':           return '/coach/teach';
    case 'smart-search':    return '/';
    default:                return `/coach/${surface}`;
  }
}

export interface CoachServiceOptions {
  /** Override the active provider. Useful for tests. */
  provider?: ProviderName;
  /** Override the legacy coach identity (default: 'danya'). Kept for
   *  backward compat with pre-personality call sites; new callers use
   *  `personality` + the three intensity dials below. */
  identity?: CoachIdentity;
  /** Personality voice for this call. Defaults to 'default' which
   *  produces the same prompt as the pre-personality build (modulo
   *  three "no-op" dial clauses reinforcing the default behavior).
   *  WO-COACH-PERSONALITIES. */
  personality?: CoachPersonality;
  /** Profanity intensity dial. Default: 'none'. */
  profanity?: IntensityLevel;
  /** Mockery intensity dial. Default: 'none'. */
  mockery?: IntensityLevel;
  /** Flirt intensity dial. Default: 'none'. */
  flirt?: IntensityLevel;
  /** Verbosity dial — clamps how much the coach says per turn. Wired
   *  into the identity prompt's teaching block. Default: 'normal'. */
  verbosity?: 'minimal' | 'normal' | 'verbose';
  /** Inject a custom provider instance (used by tests with a mock). */
  providerOverride?: Provider;
  /** When provided, the service routes through the provider's
   *  streaming path (if implemented) and pipes raw token chunks
   *  here as they arrive. The final returned `CoachAnswer.text` is
   *  the post-action-stripped, full response — same semantics as
   *  `runAgentTurn`'s `onChunk`. WO-BRAIN-02.
   *
   *  Streaming only applies to the FIRST turn of a multi-turn loop.
   *  Follow-up turns (when `maxToolRoundTrips > 1`) always run
   *  non-streaming — intermediate text isn't user-facing. */
  onChunk?: (chunk: string) => void;
  /** Maximum number of provider round-trips for tool result loop-back.
   *  Default `1` preserves BRAIN-01..03 single-pass behavior. Move-
   *  selector surface uses `3` so the brain can fetch data via
   *  cerebellum tools, see results, and emit a `play_move` decision in
   *  a follow-up turn. WO-BRAIN-04. */
  maxToolRoundTrips?: number;
  /** Callback the `play_move` cerebrum tool uses to actually play a
   *  move on the calling surface. Returning `{ ok: false, reason }`
   *  surfaces the failure back to the LLM in the next round-trip so it
   *  can choose differently. WO-BRAIN-04. */
  onPlayMove?: ToolExecutionContext['onPlayMove'];
  /** Callback the `take_back_move` cerebrum tool uses to revert the
   *  board by N half-moves. WO-COACH-OPERATOR-FOUNDATION-01. */
  onTakeBackMove?: ToolExecutionContext['onTakeBackMove'];
  /** Callback the `set_board_position` cerebrum tool uses to jump the
   *  board to an arbitrary FEN. WO-COACH-OPERATOR-FOUNDATION-01. */
  onSetBoardPosition?: ToolExecutionContext['onSetBoardPosition'];
  /** Callback the `reset_board` cerebrum tool uses to restart the game
   *  from the starting position. WO-COACH-OPERATOR-FOUNDATION-01. */
  onResetBoard?: ToolExecutionContext['onResetBoard'];
  /** Callback the `navigate_to_route` cerebrum tool uses to actually
   *  push the user-validated route via react-router. WO-BRAIN-04. */
  onNavigate?: ToolExecutionContext['onNavigate'];
  /** Callback the `quiz_user_for_move` cerebrum tool uses to register
   *  a one-shot quiz on the live board. WO-COACH-LICHESS-OPENINGS. */
  onQuizUserForMove?: ToolExecutionContext['onQuizUserForMove'];
  /** Callback the `start_walkthrough_for_opening` cerebrum tool uses to
   *  hand off to the WalkthroughMode UI. WO-COACH-LICHESS-OPENINGS. */
  onStartWalkthroughForOpening?: ToolExecutionContext['onStartWalkthroughForOpening'];
  /** WO-FOUNDATION-02 trace harness — surface-supplied UUID for
   *  joining audit entries across the pipeline. */
  traceId?: string;
  /** Tool names to exclude from the toolbelt for THIS call. Used by
   *  the coach-turn fallback chain to retry without tools that are
   *  suspected of hanging (e.g. `stockfish_eval` when the engine is
   *  stuck). The LLM physically does not see excluded tools in its
   *  toolbelt, AND the spine refuses to dispatch them if the LLM
   *  hallucinates a call. WO-COACH-RESILIENCE. */
  excludeTools?: readonly string[];
  /** Per-call task hint for model selection. Maps to CoachTask in the
   *  underlying coachApi (move_commentary → cheap, position_analysis_chat
   *  → reasoner, chat_response → sonnet/deepseek-chat, etc.). When
   *  omitted the providers default to 'chat_response'. WO-COACH-UNIFY-01. */
  task?: import('../types').CoachTask;
  /** Per-call max-tokens override. Useful for short one-shot calls
   *  (tactic alerts ~200, move-commentary ~500) where the provider
   *  default of 2000 wastes budget. WO-COACH-UNIFY-01. */
  maxTokens?: number;
  /** Per-call system-prompt addendum, appended to the envelope's
   *  identity. Used by migrated surfaces with a prompt too dynamic
   *  for a generic surface block. WO-COACH-UNIFY-01. */
  systemPromptAddition?: string;
  /** When true, the envelope skips appending the surface-mode block
   *  (TEACH_MODE_ADDITION / REVIEW_MODE_ADDITION / PHASE_NARRATION_ADDITION)
   *  for this call. Used by JSON-only / prose-only prep calls that
   *  want surface='review' for memory + live-state injection but
   *  conflict with the surface block's `[VOICE: ...]` / `[BOARD: ...]`
   *  marker mandate. Production audit (build 6459def+) showed the
   *  review-segments JSON parse failing because the LLM honored both
   *  prompts at once and emitted markdown markers wrapped around the
   *  JSON. Memory + live-state injection still happens regardless. */
  suppressSurfaceMode?: boolean;
  /** When true, drop the entire `[Toolbelt]` block from the envelope's
   *  system prompt. The brain still has identity + app map + memory +
   *  live state, but loses the tool list and the
   *  "call tools via `[[ACTION:name {args}]]`" preamble. Use for
   *  pure-prose / JSON-only calls (Review summary card, intro/closing
   *  narration prep) where no tool is needed and the temptation to
   *  emit `[[ACTION:record_blunder ...]]` leaks raw tags into the
   *  rendered output (production audit, chesscom-971406909). The
   *  spine's response-side dispatcher still rejects hallucinated tool
   *  calls, so this is safe defense-in-depth, not behavior change. */
  suppressToolbelt?: boolean;
  /** Optional getter the spine calls between trips to refresh
   *  `ctx.liveFen`. Without this, the FEN snapshotted at handleSubmit
   *  time stays frozen across all round-trips — so when the brain
   *  successfully plays a move in trip 2, trips 3+ still see the
   *  pre-move FEN and wastes turns trying to play moves for the
   *  side that already moved (production audit, build 38d4ace). The
   *  surface should pass a getter that reads from a ref. */
  getLiveFen?: () => string;
  /** WO-COACH-MASTER-INTEGRATION — master-play grounding for THIS
   *  coach turn. When provided AND intent detection matches a move
   *  question, the brain pre-injects master-play context for the
   *  current FEN + look-ahead positions and validates the LLM's
   *  output (up to 2 retries; stock fallback after exhaustion).
   *  Surfaces pass `{ currentFen, surface }`; the watcher
   *  (`useMasterPlayWatcher`) keeps the cache warm so the pre-
   *  injection path is near-instant. Kid surfaces MUST NOT pass this.
   *  See `MasterGroundingOptions` in `src/services/coachApi.ts`. */
  grounding?: import('../services/coachApi').MasterGroundingOptions;
}

/** Format a list of tool results plus the LLM's previous text into a
 *  follow-up `ask` body. The follow-up envelope keeps the same
 *  identity, memory, app map, live state, and toolbelt — only the
 *  ask changes. */
function formatToolResultsAsFollowUpAsk(
  originalAsk: string,
  previousAssistantText: string,
  results: { name: string; ok: boolean; result?: unknown; error?: string }[],
): string {
  const lines: string[] = [
    '[Original ask]',
    originalAsk,
    '',
  ];
  if (previousAssistantText.trim().length > 0) {
    lines.push('[Your previous response]', previousAssistantText, '');
  }
  lines.push('[Tool results from previous turn]');
  for (const r of results) {
    const payload: string[] = [`ok=${r.ok}`];
    if (r.result !== undefined) payload.push(`result=${JSON.stringify(r.result)}`);
    if (r.error) payload.push(`error=${r.error}`);
    lines.push(`- ${r.name}: ${payload.join(' ')}`);
  }
  // Explicit anti-replay rule. Production audit (build a67a4eb) showed
  // the brain emitting `play_move d5` twice in a row across trips —
  // trip 2's d5 succeeded, then trip 3 emitted d5 again (rejected
  // because d5 was already on the board). The brain was reading
  // "play_move ok" as "the call worked" without realizing the move
  // is now permanently committed. Spell it out.
  const succeededMoves = results
    .filter((r) => r.name === 'play_move' && r.ok)
    .map((r) => {
      const result = r.result as { san?: string } | undefined;
      return result?.san ?? null;
    })
    .filter((san): san is string => san !== null);
  if (succeededMoves.length > 0) {
    lines.push(
      '',
      `IMPORTANT: ${succeededMoves.join(', ')} ${succeededMoves.length === 1 ? 'is' : 'are'} ALREADY ON THE BOARD. Do NOT call play_move again with ${succeededMoves.length === 1 ? 'that move' : 'those moves'} — it would either fail (the move is no longer legal from the new position) or play a different move with the same name (different piece). The board has advanced; your job now is to narrate WHAT YOU JUST DID and prompt the student's next move. Use NO more play_move calls this turn unless you genuinely want to play a NEW different move.`,
    );
  }
  lines.push(
    '',
    'Use these results to decide. Either call additional tools or give your final answer.',
  );
  return lines.join('\n');
}

/** Produce a one-line preview of a tool's result payload so the audit
 *  log surfaces what the tool actually did, not just whether it ok'd.
 *  Audit-driven (#20, #21): paste-back logs used to show
 *  `stockfish_eval ok` with no eval / best-move data, leaving "the
 *  brain made a wrong claim" reports without engine ground truth.
 *  Returns null when the result has no informative shape — in that
 *  case the audit summary stays at the bare ok/error verb. */
function previewToolResult(
  name: string,
  result: { ok: boolean; result?: unknown; error?: string },
): string | null {
  if (!result.ok) return null;
  const r = result.result as Record<string, unknown> | undefined;
  if (!r) return null;
  if (name === 'stockfish_eval' || name === 'stockfish_classify_move') {
    const best = typeof r.bestMove === 'string' ? r.bestMove : null;
    const ev = typeof r.evaluation === 'number' ? r.evaluation : null;
    const isMate = r.isMate === true;
    const mateIn = typeof r.mateIn === 'number' ? r.mateIn : null;
    const depth = typeof r.depth === 'number' ? r.depth : null;
    const parts: string[] = [];
    if (best) parts.push(`best=${best}`);
    if (isMate && mateIn !== null) parts.push(`mate=${mateIn}`);
    else if (ev !== null) parts.push(`eval=${ev > 0 ? '+' : ''}${(ev / 100).toFixed(2)}`);
    if (depth !== null) parts.push(`d${depth}`);
    return parts.length > 0 ? parts.join(' ') : null;
  }
  if (name === 'set_intended_opening') {
    const oname = typeof r.name === 'string' ? r.name : null;
    const color = typeof r.color === 'string' ? r.color : null;
    return oname && color ? `${color} ${oname}` : null;
  }
  if (name === 'set_board_position') {
    const fen = typeof r.fen === 'string' ? r.fen : null;
    return fen ? `fen=${fen.split(' ')[0]}…` : null;
  }
  if (name === 'play_move' || name === 'take_back_move') {
    const san = typeof r.san === 'string' ? r.san : null;
    return san ? `san=${san}` : null;
  }
  if (name === 'lichess_opening_lookup') {
    const eco = typeof r.eco === 'string' ? r.eco : null;
    const oname = typeof r.name === 'string' ? r.name : null;
    return oname || eco ? `${oname ?? '?'} (${eco ?? '?'})` : null;
  }
  return null;
}

async function ask(input: CoachAskInput, options: CoachServiceOptions = {}): Promise<CoachAnswer> {
  // WO-COACH-UNIFY-01 visibility: include task + maxTokens in the
  // ask-received audit so paste-back audit logs show which surface
  // picked which model. Surfaces migrated onto the spine are
  // distinguishable from legacy /coach/play LLM calls (which fire
  // 'coach-llm-model-selected' instead) by the presence of these
  // fields.
  void logAppAudit({
    kind: 'coach-brain-ask-received',
    category: 'subsystem',
    source: 'coachService.ask',
    summary: `surface=${input.surface} task=${options.task ?? 'chat_response'} maxTokens=${options.maxTokens ?? 'default'} ask="${input.ask.slice(0, 60)}"`,
    details: JSON.stringify({
      surface: input.surface,
      askLen: input.ask.length,
      task: options.task ?? 'chat_response',
      maxTokens: options.maxTokens ?? null,
      providerOverride: options.providerOverride?.name ?? null,
    }),
  });

  // WO-FOUNDATION-02 trace harness — fires at the start of every
  // ask, mirroring coach-brain-ask-received but carrying the
  // traceId so the audit pipeline can be reconstructed.

  // WO-FOUNDATION-02: Layer 1 routing moved upstream to
  // GameChatPanel.handleSend. Most user messages never reached this
  // entry point — pre-LLM intercepts at the surface short-circuit
  // first. The router now runs at the surface boundary with the
  // user's raw text. This entry point only sees messages that the
  // surface chose to forward (real LLM round-trips), so router
  // bypass-LLM logic at this layer was dead code.

  const envelope = assembleEnvelope({
    identity: options.identity,
    personality: options.personality,
    profanity: options.profanity,
    mockery: options.mockery,
    flirt: options.flirt,
    verbosity: options.verbosity,
    systemPromptAddition: options.systemPromptAddition,
    suppressSurfaceMode: options.suppressSurfaceMode,
    suppressToolbelt: options.suppressToolbelt,
    toolbelt: getToolDefinitions({ exclude: options.excludeTools }),
    input,
  });

  void logAppAudit({
    kind: 'coach-brain-envelope-assembled',
    category: 'subsystem',
    source: 'coachService.ask',
    summary: `assembled (${envelope.toolbelt.length} tools, ${envelope.appMap.length} routes)`,
    details: JSON.stringify({
      toolbeltSize: envelope.toolbelt.length,
      appMapSize: envelope.appMap.length,
      hasIntendedOpening: envelope.memory.intendedOpening !== null,
      hintRequestCount: envelope.memory.hintRequests.length,
      conversationHistorySize: envelope.memory.conversationHistory.length,
    }),
  });

  // WO-FOUNDATION-02 trace harness — list the tool names the LLM
  // sees in the toolbelt so we can verify play_move / take_back_move
  // / reset_board / set_board_position are present.

  const providerName = options.provider ?? resolveProviderName();
  const provider = options.providerOverride ?? pickProvider(providerName);

  const ctx: ToolExecutionContext = {
    onPlayMove: options.onPlayMove,
    onTakeBackMove: options.onTakeBackMove,
    onSetBoardPosition: options.onSetBoardPosition,
    onResetBoard: options.onResetBoard,
    onNavigate: options.onNavigate,
    onQuizUserForMove: options.onQuizUserForMove,
    onStartWalkthroughForOpening: options.onStartWalkthroughForOpening,
    liveFen: input.liveState.fen,
    traceId: options.traceId,
  };

  // WO-FOUNDATION-02 diagnostic: log the typeof every callback at
  // ctx-build time so we can verify the surface plumbing reached the
  // spine. If onPlayMove is `undefined` here, the surface didn't
  // pass it; if it's `function`, the chain up to here is intact.
   
  console.log('[coachService.ask] ctx-built:', {
    onPlayMove: typeof ctx.onPlayMove,
    onTakeBackMove: typeof ctx.onTakeBackMove,
    onResetBoard: typeof ctx.onResetBoard,
    onSetBoardPosition: typeof ctx.onSetBoardPosition,
    onNavigate: typeof ctx.onNavigate,
  });
  void logAppAudit({
    kind: 'coach-brain-tool-parse-result',
    category: 'subsystem',
    source: 'coachService.ask',
    summary: `ctx-built: onPlayMove=${typeof ctx.onPlayMove} onTakeBackMove=${typeof ctx.onTakeBackMove} onResetBoard=${typeof ctx.onResetBoard} onSetBoardPosition=${typeof ctx.onSetBoardPosition} onNavigate=${typeof ctx.onNavigate}`,
  });

  const dispatchedIds: string[] = [];
  // Cap multi-turn tool loops so a misbehaving brain can't loop forever.
  const maxRoundTrips = Math.max(1, options.maxToolRoundTrips ?? 1);

  let currentEnvelope: AssembledEnvelope = envelope;
  const useStreaming = !!options.onChunk && typeof provider.callStreaming === 'function';
  let lastResponse: ProviderResponse = { text: '', toolCalls: [] };

  for (let trip = 1; trip <= maxRoundTrips; trip++) {
    // Refresh liveFen between trips ONLY (trip > 1). Trip 1 uses the
    // surface-supplied `input.liveState.fen` already wired into
    // ctx.liveFen above — that value carries the surface's authoritative
    // FEN at ask time, including any explicit fenOverride
    // handleStudentMove passed for the post-board-move case. Calling
    // getLiveFen on trip 1 would clobber the correct override with a
    // stale ref value because React hasn't re-rendered yet at the
    // moment coachService.ask runs synchronously inside the same
    // event-handler tick (production audit, build 5df4252: brain saw
    // post-e4 FEN at envelope assembly but starting-position FEN at
    // playMoveTool validation, rejecting "e5" as illegal for white).
    // From trip 2 on, the surface has long since re-rendered AND the
    // brain itself may have played a move via play_move, so the latest
    // gameRef value is the truth and the refresh is what keeps
    // chess.js validation in sync with the live board.
    if (trip > 1 && options.getLiveFen) {
      const fresh = options.getLiveFen();
      if (fresh) ctx.liveFen = fresh;
    }
    void logAppAudit({
      kind: 'coach-brain-provider-called',
      category: 'subsystem',
      source: 'coachService.ask',
      summary: `surface=${input.surface} provider=${provider.name} task=${options.task ?? 'chat_response'} streaming=${useStreaming} trip=${trip}/${maxRoundTrips}`,
      details: JSON.stringify({
        surface: input.surface,
        provider: provider.name,
        task: options.task ?? 'chat_response',
        maxTokens: options.maxTokens ?? null,
        streaming: useStreaming,
        trip,
        maxRoundTrips,
      }),
    });

    // WO-COACH-MASTER-INTEGRATION — auto-build grounding when the
    // surface didn't pass one explicitly. Every coach surface that
    // hands the spine a `liveState.fen` qualifies; the intent detector
    // inside `getCoachChatResponse` decides whether to actually engage
    // the pipeline based on the user's last message. Kid surfaces use
    // `getKidLlmResponse` directly (not coachService.ask), so this
    // path is coach-lane-only by construction.
    const autoGrounding =
      options.grounding ??
      (input.liveState.fen
        ? {
            currentFen: input.liveState.fen,
            surface: coachSurfaceToRoute(input.liveState.surface),
          }
        : undefined);
    const providerCallOptions =
      options.task !== undefined || options.maxTokens !== undefined || autoGrounding
        ? {
            task: options.task,
            maxTokens: options.maxTokens,
            grounding: autoGrounding,
          }
        : undefined;
    lastResponse = useStreaming && options.onChunk && provider.callStreaming
      ? await provider.callStreaming(currentEnvelope, options.onChunk, providerCallOptions)
      : await provider.call(currentEnvelope, providerCallOptions);

    if (lastResponse.toolCalls.length === 0) {
      // No tools emitted — terminal turn. Exit the loop.
      break;
    }

    // Dispatch tool calls. WO-STOCKFISH-SWAP-AND-PERF (part 3):
    // read-only tools (stockfish_eval, lichess lookups, opening book,
    // set_intended_opening, ...) run concurrently via Promise.allSettled
    // so a single LLM trip emitting "look it up + eval the position"
    // doesn't pay sequential network + worker latency. Write tools
    // (play_move, take_back_move, reset_board, set_board_position,
    // navigate_to_route) run sequentially after the read wave to
    // preserve causality — the LLM's intent for these is order-
    // dependent. Tool classification lives on the Tool definition
    // (kind: 'read' | 'write').
    const toolResults: { name: string; ok: boolean; result?: unknown; error?: string }[] = [];
    const readCalls: typeof lastResponse.toolCalls = [];
    const writeCalls: typeof lastResponse.toolCalls = [];
    // WO-COACH-RESILIENCE: refuse to dispatch tools the caller asked
    // to exclude even if the LLM hallucinates a call. Belt and
    // suspenders — the LLM doesn't see the tool in its envelope, but
    // model-side regressions emit unknown calls all the time.
    const excludeSet = options.excludeTools && options.excludeTools.length > 0
      ? new Set(options.excludeTools)
      : null;
    for (const call of lastResponse.toolCalls) {
      // suppressToolbelt = "this call has no tools." Any tool call the
      // brain emits despite that is a hallucination — refuse to
      // dispatch. The display-strip + sanitizeCoachStream still hides
      // the leaked `[[ACTION:...]]` text from the user.
      if (options.suppressToolbelt) {
        void logAppAudit({
          kind: 'coach-brain-tool-skipped',
          category: 'subsystem',
          source: 'coachService.ask',
          summary: `dropped ${call.name} (toolbelt suppressed)`,
          details: JSON.stringify({ id: call.id, name: call.name, reason: 'toolbelt-suppressed', args: call.args }),
        });
        continue;
      }
      if (excludeSet?.has(call.name)) {
        void logAppAudit({
          kind: 'coach-brain-tool-skipped',
          category: 'subsystem',
          source: 'coachService.ask',
          summary: `excluded ${call.name} (resilience fallback)`,
          details: JSON.stringify({ id: call.id, name: call.name, reason: 'excluded', args: call.args }),
        });
        continue;
      }
      const tool = getTool(call.name);
      if (!tool) {
        void logAppAudit({
          kind: 'coach-brain-tool-skipped',
          category: 'subsystem',
          source: 'coachService.ask',
          summary: `unknown ${call.name}`,
          details: JSON.stringify({ id: call.id, name: call.name, reason: 'unknown', args: call.args }),
        });
        continue;
      }
      if (tool.kind === 'write') {
        writeCalls.push(call);
      } else {
        readCalls.push(call);
      }
    }

    const dispatchOne = async (call: typeof lastResponse.toolCalls[number]): Promise<void> => {
       
      const tool = getTool(call.name);
      // Existence already verified above; non-null assertion is safe
      // here because unknown tools were filtered out.
      if (!tool) return;
      try {
        const result = await tool.execute(call.args, ctx);
        dispatchedIds.push(call.id);
        toolResults.push({
          name: call.name,
          ok: result.ok,
          result: result.result,
          error: result.error,
        });
        // Audit-driven (#20, #21): include a high-signal preview of the
        // tool result so paste-back logs surface "stockfish said
        // bestMove=Nf3 eval=+0.4" instead of just "stockfish_eval ok".
        // The full result is still threaded back to the LLM via
        // toolResults; this is observability for the human reading
        // the audit panel.
        const resultPreview = previewToolResult(call.name, result);
        const summarySuffix = resultPreview ? ` ${resultPreview}` : '';
        void logAppAudit({
          kind: 'coach-brain-tool-called',
          category: 'subsystem',
          source: 'coachService.ask',
          summary: `${call.name} ${result.ok ? 'ok' : 'error'}${summarySuffix}`,
          details: JSON.stringify({
            id: call.id,
            name: call.name,
            ok: result.ok,
            error: result.error,
            preview: resultPreview ?? null,
          }),
        });
        // Dedicated tool-call-error trail — captures full error text +
        // the exact args that triggered it. The existing
        // coach-brain-tool-called audit packs args into `details` JSON
        // but for production triage we want a high-signal kind we can
        // filter on directly. See the local_opening_book "aiColor must
        // be 'white' or 'black'" surfaced in the audit log for an
        // example of what this captures.
        if (!result.ok) {
          void logAppAudit({
            kind: 'tool-call-error',
            category: 'subsystem',
            source: 'coachService.ask',
            summary: `${call.name}: ${result.error ?? 'unknown error'}`,
            details: JSON.stringify({
              id: call.id,
              name: call.name,
              args: call.args,
              error: result.error,
            }),
          });
        }
      } catch (err) {
        void logAppAudit({
          kind: 'coach-brain-tool-threw',
          category: 'subsystem',
          source: 'coachService.ask',
          summary: `${call.name} threw`,
          details: err instanceof Error ? err.message : String(err),
        });
        void logAppAudit({
          kind: 'tool-call-error',
          category: 'subsystem',
          source: 'coachService.ask',
          summary: `${call.name} threw: ${err instanceof Error ? err.message : String(err)}`,
          details: JSON.stringify({
            id: call.id,
            name: call.name,
            args: call.args,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          }),
        });
        toolResults.push({
          name: call.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // Phase 1: read-only tools in parallel.
    if (readCalls.length > 0) {
      await Promise.allSettled(readCalls.map(dispatchOne));
    }
    // Phase 2: write tools sequentially, in original emit order.
    // Refresh liveFen BEFORE each write tool so a prior write in the
    // same trip is visible to the next. Production audit (build
    // 21c79dd) caught the brain emitting [set_board_position(endgame
    // FEN), play_move(Kd5)] in one trip; play_move's pre-validation
    // read the STALE starting FEN (snapshotted at trip 1 setup) and
    // rejected Kd5 as illegal because there's no king at d5 in the
    // starting position. The fix mirrors the trip>1 refresh above —
    // any previous write (set_board_position, play_move,
    // take_back_move, reset_board) updates the surface's
    // liveFenRef, and this getter pulls the latest value before the
    // next write validates against it.
    // Track play_move rejections in this trip. After the second one,
    // short-circuit subsequent play_move calls with a stronger error
    // that breaks the brain out of the "demo by sequencing play_move"
    // pattern. Production audit (build 42fb9a0) caught the brain
    // emitting 9 sequential play_move calls in one trip on a "Vienna
    // trap" lesson — every one rejected (sovereignty + illegal-move
    // chain) — instead of using start_walkthrough_for_opening. The
    // prompt rule wasn't enough; this is the code-level backstop.
    let playMoveRejectionsThisTrip = 0;
    for (const call of writeCalls) {
      if (options.getLiveFen) {
        const fresh = options.getLiveFen();
        if (fresh) ctx.liveFen = fresh;
      }
      // Break the cascade: if play_move has already been rejected
      // twice this trip, refuse subsequent play_move calls with
      // explicit redirect guidance. Other tools (set_board_position,
      // take_back_move, etc.) pass through normally.
      if (call.name === 'play_move' && playMoveRejectionsThisTrip >= 2) {
        const error =
          `play_move SHORT-CIRCUITED — this trip has already had ${playMoveRejectionsThisTrip} play_move rejections. ` +
          `STOP attempting to walk through a sequence via play_move. play_move is for ONE move on YOUR color's turn during practical play, not a way to enact hypothetical lines. ` +
          `If the student asked for a guided opening lesson ("teach me [opening]" / "show me the trap"), call start_walkthrough_for_opening with the opening name — that routes them to a surface where each move animates sequentially. ` +
          `If you just want to show one position to discuss, call set_board_position ONCE with the FEN and explain in prose + [BOARD: arrow] markers.`;
        toolResults.push({ name: call.name, ok: false, error });
        void logAppAudit({
          kind: 'tool-call-error',
          category: 'subsystem',
          source: 'coachService.ask',
          summary: `play_move short-circuited after ${playMoveRejectionsThisTrip} rejections this trip`,
          details: JSON.stringify({ id: call.id, args: call.args, rejectionsThisTrip: playMoveRejectionsThisTrip }),
        });
        continue;
      }
      const beforeLen = toolResults.length;
      await dispatchOne(call);
      // Count rejections of play_move only — other tool failures don't
      // indicate the cascading-demo pattern.
      if (call.name === 'play_move') {
        const last = toolResults[toolResults.length - 1];
        if (last && beforeLen < toolResults.length && !last.ok) {
          playMoveRejectionsThisTrip += 1;
        }
      }
    }

    // If we have round-trips remaining AND we dispatched any tools,
    // build a follow-up envelope and loop. Otherwise terminate.
    if (trip < maxRoundTrips && toolResults.length > 0) {
      const followUpAsk = formatToolResultsAsFollowUpAsk(
        envelope.ask,
        lastResponse.text,
        toolResults,
      );
      currentEnvelope = { ...currentEnvelope, ask: followUpAsk };
      // Keep streaming on for follow-up trips. The user perceives
      // each non-streamed trip as a 2–3s silent pause followed by a
      // burst — production audit shows that's the "choppy" feel.
      // Streaming all trips lets each trip's prose start playing
      // within ~500ms of the trip beginning, which is what makes
      // the coach feel like a continuous lesson instead of a
      // sequence of stuttering replies. The previous concern
      // ("intermediate tool-orchestration text leaks to the user")
      // is fine — that prose IS the lesson; the coach narrating
      // "let me check the engine" while the engine call is in
      // flight reads as natural pacing, not orchestration noise.
      // Suppression turned out to be the bigger UX problem.
    } else {
      break;
    }
  }

  void logAppAudit({
    kind: 'coach-brain-answer-returned',
    category: 'subsystem',
    source: 'coachService.ask',
    summary: `surface=${input.surface} provider=${provider.name} task=${options.task ?? 'chat_response'} text=${lastResponse.text.length}c tools=${dispatchedIds.length}`,
    details: JSON.stringify({
      surface: input.surface,
      provider: provider.name,
      task: options.task ?? 'chat_response',
      maxTokens: options.maxTokens ?? null,
      textLength: lastResponse.text.length,
      toolCallsDispatched: dispatchedIds.length,
      textPreview: lastResponse.text.slice(0, 120),
    }),
  });

  return {
    text: lastResponse.text,
    toolCallIds: dispatchedIds,
    provider: provider.name,
  };
}


/** Single-method service object. Surfaces import this and call
 *  `coachService.ask(...)`. No other entry points. */
export const coachService = { ask };

/** Re-export the toolbelt for tests / debugging. */
export { COACH_TOOLS };
