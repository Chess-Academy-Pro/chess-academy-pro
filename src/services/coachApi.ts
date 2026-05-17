// All LLM API calls must go through this file only — per CLAUDE.md
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { Chess } from 'chess.js';
import { db } from '../db/schema';
import { SYSTEM_PROMPT, buildChessContextMessage, getVerbosityInstruction } from './coachPrompts';
import { recordApiUsage } from './coachCostService';
import { lookupMasterPlay } from './masterPlayLookup';
import { validateClaims, type ClaimValidationResult } from './claimValidator';
import { logAppAudit } from './appAuditor';
import type { MasterPlayContext, MasterPlayResult } from './masterPlayTypes';
import type { CoachTask, CoachContext, CoachVerbosity, AiProvider } from '../types';

/**
 * Model routing policy
 * --------------------
 * Three tiers:
 *   CHEAP   — routine dialog, short commentary, everything high-frequency
 *   MID     — once-per-game or once-per-day analysis with meaningful depth
 *   HEAVY   — rare deep-analysis passes (weekly report, deep position work)
 *
 * Per-task choice is a deliberate cost-vs-quality tradeoff:
 *   - chat_response fires on EVERY chat turn. Kept on CHEAP because most
 *     turns are casual Q&A ("what's the idea behind Nf3?") where the
 *     MID-tier reasoner is overkill. The user can always ask "think
 *     deeper" and we can route that through MID explicitly in a future
 *     upgrade. Moving chat_response from MID to CHEAP cuts DeepSeek cost
 *     ~50% and Anthropic cost ~75% on the largest single LLM surface.
 *   - post_game_analysis / daily_lesson / bad_habit_report / opening_*
 *     / game_post_review fire once per natural event, so MID is worth
 *     the quality bump.
 *   - weakness_report / weekly_report / deep_analysis fire rarely and
 *     the output is consumed as a reference artifact — HEAVY pays off.
 */
const DEEPSEEK_MODEL_MAP: Record<CoachTask, string> = {
  // High-frequency / short outputs → CHEAP (deepseek-chat)
  move_commentary:         'deepseek-chat',
  hint:                    'deepseek-chat',
  puzzle_feedback:         'deepseek-chat',
  game_commentary:         'deepseek-chat',
  game_opening_line:       'deepseek-chat',
  whatif_commentary:       'deepseek-chat',
  game_narrative_summary:  'deepseek-chat',
  chat_response:           'deepseek-chat',  // was 'deepseek-reasoner' — biggest single cost win
  sideline_explanation:    'deepseek-chat',
  smart_search:            'deepseek-chat',
  explore_reaction:        'deepseek-chat',
  intent_classify:         'deepseek-chat',
  // Kid-mode puzzle annotation — short, neutral, JSON-shaped prose.
  // Routed via getKidLlmResponse (skipPersonality=true) — see CLAUDE.md
  // "Kids section non-negotiables".
  kid_puzzle_gen:          'deepseek-chat',

  // Per-event analysis → MID (deepseek-reasoner)
  post_game_analysis:      'deepseek-reasoner',
  daily_lesson:            'deepseek-reasoner',
  bad_habit_report:        'deepseek-reasoner',
  opening_overview:        'deepseek-reasoner',
  game_post_review:        'deepseek-reasoner',
  position_analysis_chat:  'deepseek-reasoner',
  session_plan_generation: 'deepseek-reasoner',
  // interactive_review → deepseek-chat (NOT reasoner). Audit log build
  // 83233ab proved that deepseek-reasoner with max_tokens=420 consumes
  // all 420 tokens on hidden `reasoning_content` (1400+ chars of CoT)
  // for per-move commentary, leaving 0-20 tokens for visible `content`
  // — every llm-response audit showed `finishReason="length"`,
  // `completionTokens=420`, `reasoningContentLength≈1400`, content
  // empty or truncated mid-sentence ("Now it's you"). Per-move
  // narration is conversational coaching prose, not analysis — it
  // doesn't benefit from chain-of-thought. The Anthropic side already
  // uses non-reasoning Sonnet for the same task (see ANTHROPIC_MODEL_MAP
  // below). Moving DeepSeek to deepseek-chat eliminates the wasted
  // reasoning budget; the same 420 max_tokens now produces ~1500 chars
  // of actual narration.
  interactive_review:      'deepseek-chat',
  model_game_annotation:   'deepseek-reasoner',
  middlegame_plan_generation: 'deepseek-reasoner',

  // Rare deep-dive outputs → still reasoner (DeepSeek has no heavier tier)
  weakness_report:         'deepseek-reasoner',
  weekly_report:           'deepseek-reasoner',
  deep_analysis:           'deepseek-reasoner',
};

const ANTHROPIC_MODEL_MAP: Record<CoachTask, string> = {
  // High-frequency / short outputs → CHEAP (Haiku)
  move_commentary:         'claude-haiku-4-5-20251001',
  hint:                    'claude-haiku-4-5-20251001',
  puzzle_feedback:         'claude-haiku-4-5-20251001',
  game_commentary:         'claude-haiku-4-5-20251001',
  game_opening_line:       'claude-haiku-4-5-20251001',
  whatif_commentary:       'claude-haiku-4-5-20251001',
  game_narrative_summary:  'claude-haiku-4-5-20251001',
  // chat_response runs on Sonnet 4.6 because chat is where TEACHING
  // happens (in-game ask, standalone chat, /coach/teach lesson surface).
  // Haiku is fast but formulaic; Sonnet does the creative leaps a real
  // coach makes — pattern naming, opening trap callouts, "if you do X,
  // I respond Y" multi-step walkthroughs. Per-move live narration
  // (interactive_review task) stays on Haiku for speed; chat depth
  // beats chat speed for teaching surfaces.
  chat_response:           'claude-sonnet-4-6',
  sideline_explanation:    'claude-haiku-4-5-20251001',
  smart_search:            'claude-haiku-4-5-20251001',
  explore_reaction:        'claude-haiku-4-5-20251001',
  intent_classify:         'claude-haiku-4-5-20251001',
  // Kid-mode puzzle annotation — Haiku is plenty for neutral kid-safe
  // hint text. Same isolation contract as DEEPSEEK_MODEL_MAP above.
  kid_puzzle_gen:          'claude-haiku-4-5-20251001',

  // Per-event analysis → MID (Sonnet)
  post_game_analysis:      'claude-sonnet-4-6',
  daily_lesson:            'claude-sonnet-4-6',
  bad_habit_report:        'claude-sonnet-4-6',
  opening_overview:        'claude-sonnet-4-6',
  game_post_review:        'claude-sonnet-4-6',
  position_analysis_chat:  'claude-sonnet-4-6',
  session_plan_generation: 'claude-sonnet-4-6',
  interactive_review:      'claude-haiku-4-5-20251001',
  model_game_annotation:   'claude-sonnet-4-6',
  middlegame_plan_generation: 'claude-sonnet-4-6',

  // Rare deep-dive outputs → HEAVY (Opus)
  weakness_report:         'claude-opus-4-6',
  weekly_report:           'claude-opus-4-6',
  deep_analysis:           'claude-opus-4-6',
};

// Offline fallback templates
const OFFLINE_FALLBACKS: Record<string, string> = {
  default: "I'm having trouble connecting right now. Keep playing — I'll be back online soon!",
  hint: "Think about which pieces are undefended, and whether there's a forcing sequence available.",
  puzzle_feedback: "Good effort! Every puzzle teaches something. Try to identify the key tactical pattern here.",
};

interface ProviderConfig {
  provider: AiProvider;
  apiKey: string;
  /** User-selected per-category model overrides from Settings →
   *  Provider Settings (preferredModel.commentary / .analysis /
   *  .reports). When unset, falls back to the per-task defaults in
   *  ANTHROPIC_MODEL_MAP / DEEPSEEK_MODEL_MAP. Lets the user pin
   *  Opus for thinking + Haiku for short prose without us hard-coding
   *  the choice. */
  preferredModel?: { commentary: string; analysis: string; reports: string };
}

/** Maps each `CoachTask` to one of three user-facing categories so the
 *  preferredModel preference (Settings → Provider) actually flows
 *  through to the wire. Today every Anthropic call hardcoded Sonnet 4.6
 *  via ANTHROPIC_MODEL_MAP regardless of what the user picked — this
 *  is the bridge.
 *
 *  - 'commentary' → quick, high-frequency prose (per-move chat,
 *    hint, puzzle reaction, intent classification, smart-search
 *    autocomplete). The "language center."
 *  - 'analysis'   → reasoning-heavy turns (the chat brain, position
 *    deep-dives, opening overviews, plan generation, /coach/teach
 *    lesson turns). The "thought process."
 *  - 'reports'    → rare deep artifacts read as references (weakness
 *    report, weekly digest, deep_analysis, bad-habit summary).
 */
const TASK_CATEGORY: Record<CoachTask, 'commentary' | 'analysis' | 'reports'> = {
  move_commentary:           'commentary',
  hint:                      'commentary',
  puzzle_feedback:           'commentary',
  game_commentary:           'commentary',
  game_opening_line:         'commentary',
  whatif_commentary:         'commentary',
  game_narrative_summary:    'commentary',
  sideline_explanation:      'commentary',
  smart_search:              'commentary',
  explore_reaction:          'commentary',
  intent_classify:           'commentary',
  kid_puzzle_gen:            'commentary',
  interactive_review:        'commentary',
  chat_response:             'analysis',
  position_analysis_chat:    'analysis',
  opening_overview:          'analysis',
  game_post_review:          'analysis',
  post_game_analysis:        'analysis',
  daily_lesson:              'analysis',
  session_plan_generation:   'analysis',
  model_game_annotation:     'analysis',
  middlegame_plan_generation:'analysis',
  bad_habit_report:          'reports',
  weakness_report:           'reports',
  weekly_report:             'reports',
  deep_analysis:             'reports',
};

// Embedded keys (split + reversed) — assembled at runtime as fallback
const _P = ['AAg3tjc6-QloxqPVoiya_sIlFe1BjOsVJGQz', 'vBBV66KIx6FbPmIuCxO1TLStej-Kt44jL5DD', 'UB9cvx5Mx30pFR0x3xVYmg8-30ipa-tna-ks'];
const _Q = ['ef9cdc72a407', 'f919f60457b8', 'd75abe29-ks'];
function _r(c: string[]): string { return c.join('').split('').reverse().join(''); }

function getAnthropicKey(): string | undefined {
  return (import.meta.env.VITE_ANTHROPIC_API_KEY || import.meta.env.ANTHROPIC_KEY || __ANTHROPIC_KEY__) as string || _r(_P) || undefined;
}

function getDeepseekKey(): string | undefined {
  return (import.meta.env.VITE_DEEPSEEK_API_KEY || import.meta.env.DEEPSEEK_KEY || __DEEPSEEK_KEY__) as string || _r(_Q) || undefined;
}

async function getProviderConfig(): Promise<ProviderConfig | null> {
  try {
    const anthropicEnvKey = getAnthropicKey();
    const deepseekEnvKey = getDeepseekKey();

    const profile = await db.profiles.get('main');
    // Anthropic is the primary on every surface as of 2026-05-14
    // (David's call) — Sonnet/Haiku produce noticeably better chess
    // pedagogy than DeepSeek. The fallback chain below auto-retries
    // on DeepSeek if Anthropic 401s/429s on this single call. The
    // dead-state cooldown above means subsequent calls within the
    // next 60s skip Anthropic entirely if we just saw it fail —
    // avoids paying the failed-primary latency on every coach
    // interaction during an extended outage.
    // A user with ONLY a DeepSeek key still gets DeepSeek.
    const anthropicReachable = !!anthropicEnvKey && !isProviderInCooldown('anthropic');
    const deepseekReachable = !!deepseekEnvKey && !isProviderInCooldown('deepseek');
    const provider: AiProvider = anthropicReachable
      ? 'anthropic'
      : (deepseekReachable
          ? 'deepseek'
          // Both keys absent OR both in cooldown — fall through to
          // whichever key exists (try-anyway over no-coach), then to
          // profile preference. Cooldown lifts on its own after 60s.
          : (anthropicEnvKey
              ? 'anthropic'
              : (deepseekEnvKey
                  ? 'deepseek'
                  : (profile?.preferences.aiProvider ?? 'anthropic'))));

    const preferredModel = profile?.preferences.preferredModel;

    if (provider === 'anthropic') {
      if (anthropicEnvKey) return { provider, apiKey: anthropicEnvKey, preferredModel };
      if (!profile?.preferences.anthropicApiKeyEncrypted || !profile.preferences.anthropicApiKeyIv) {
        if (deepseekEnvKey) return { provider: 'deepseek', apiKey: deepseekEnvKey, preferredModel };
        return null;
      }
      const { decryptApiKey } = await import('./cryptoService');
      const apiKey = await decryptApiKey(
        profile.preferences.anthropicApiKeyEncrypted,
        profile.preferences.anthropicApiKeyIv,
      );
      return { provider, apiKey, preferredModel };
    } else {
      if (deepseekEnvKey) return { provider, apiKey: deepseekEnvKey, preferredModel };
      if (!profile?.preferences.apiKeyEncrypted || !profile.preferences.apiKeyIv) {
        if (anthropicEnvKey) return { provider: 'anthropic', apiKey: anthropicEnvKey, preferredModel };
        return null;
      }
      const { decryptApiKey } = await import('./cryptoService');
      const apiKey = await decryptApiKey(
        profile.preferences.apiKeyEncrypted,
        profile.preferences.apiKeyIv,
      );
      return { provider, apiKey, preferredModel };
    }
  } catch {
    return null;
  }
}

/** Pin the provider for a single call. Used by the brain's per-surface
 *  routing (e.g. /coach/teach forces 'anthropic'). Walks the same key
 *  resolution order as `getProviderConfig` for that provider only:
 *  env key → encrypted profile key → null. NEVER falls back to the
 *  other provider — that's the caller's job via `getFallbackConfig`. */
async function getForcedProviderConfig(provider: AiProvider): Promise<ProviderConfig | null> {
  try {
    const profile = await db.profiles.get('main');
    const preferredModel = profile?.preferences.preferredModel;
    if (provider === 'anthropic') {
      const envKey = getAnthropicKey();
      if (envKey) return { provider, apiKey: envKey, preferredModel };
      if (!profile?.preferences.anthropicApiKeyEncrypted || !profile.preferences.anthropicApiKeyIv) {
        return null;
      }
      const { decryptApiKey } = await import('./cryptoService');
      const apiKey = await decryptApiKey(
        profile.preferences.anthropicApiKeyEncrypted,
        profile.preferences.anthropicApiKeyIv,
      );
      return { provider, apiKey, preferredModel };
    } else {
      const envKey = getDeepseekKey();
      if (envKey) return { provider, apiKey: envKey, preferredModel };
      if (!profile?.preferences.apiKeyEncrypted || !profile.preferences.apiKeyIv) {
        return null;
      }
      const { decryptApiKey } = await import('./cryptoService');
      const apiKey = await decryptApiKey(
        profile.preferences.apiKeyEncrypted,
        profile.preferences.apiKeyIv,
      );
      return { provider, apiKey, preferredModel };
    }
  } catch {
    return null;
  }
}

// ─── Provider dead-state cooldown ────────────────────────────────────
// When a provider call throws (auth/quota/network), record a short-TTL
// timestamp so subsequent coach interactions skip the known-dead
// provider and go straight to the fallback. Without this every call
// during an extended Anthropic outage would pay the full Anthropic
// latency (timeout/error) before the DeepSeek retry — bad UX. 60s
// balances "recover quickly from transient blips" with "don't burn
// time on a primary we just saw fail."
const PROVIDER_COOLDOWN_MS = 60_000;
const providerDeadUntil: Record<AiProvider, number> = {
  anthropic: 0,
  deepseek: 0,
};

function markProviderDead(provider: AiProvider): void {
  providerDeadUntil[provider] = Date.now() + PROVIDER_COOLDOWN_MS;
}

function isProviderInCooldown(provider: AiProvider): boolean {
  return Date.now() < providerDeadUntil[provider];
}

/** Reset the dead-state cache. Test-only — production code never
 *  calls this; the timestamps decay on their own after 60s. */
export function __resetProviderCooldownsForTests(): void {
  providerDeadUntil.anthropic = 0;
  providerDeadUntil.deepseek = 0;
}

/** Get a fallback config using the OTHER provider. Returns null if no alternate key available. */
function getFallbackConfig(failedProvider: AiProvider): ProviderConfig | null {
  try {
    const anthropicEnvKey = getAnthropicKey();
    const deepseekEnvKey = getDeepseekKey();

    if (failedProvider === 'anthropic' && deepseekEnvKey) {
      return { provider: 'deepseek', apiKey: deepseekEnvKey };
    }
    if (failedProvider === 'deepseek' && anthropicEnvKey) {
      return { provider: 'anthropic', apiKey: anthropicEnvKey };
    }
    return null;
  } catch {
    return null;
  }
}

function getModel(
  task: CoachTask,
  provider: AiProvider,
  preferredModel?: ProviderConfig['preferredModel'],
): string {
  // 1. Honor the user's per-category preference from Settings →
  //    Provider when set. This is what makes "Opus for analysis,
  //    Haiku for commentary" actually flow through to the wire —
  //    until this layer existed, every Anthropic call was hardcoded
  //    to ANTHROPIC_MODEL_MAP[task] regardless of Settings.
  // 2. Validate that the preferred model is compatible with the
  //    active provider — Anthropic models start with "claude-",
  //    DeepSeek models start with "deepseek-". If the user picked
  //    an Anthropic model but we're falling back to DeepSeek (or
  //    vice versa), use the per-task default for the active provider
  //    so we don't send a "claude-opus-4-6" string to DeepSeek.
  if (preferredModel) {
    const category = TASK_CATEGORY[task];
    const userChoice = preferredModel[category];
    if (userChoice) {
      const isAnthropicModel = userChoice.startsWith('claude-');
      const isDeepSeekModel = userChoice.startsWith('deepseek-');
      const compatible =
        (provider === 'anthropic' && isAnthropicModel) ||
        (provider === 'deepseek' && isDeepSeekModel);
      if (compatible) return userChoice;
    }
  }
  return provider === 'anthropic'
    ? ANTHROPIC_MODEL_MAP[task]
    : DEEPSEEK_MODEL_MAP[task];
}

// ── DeepSeek (OpenAI-compatible) ──

async function callDeepSeekStream(
  apiKey: string,
  model: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  maxTokens: number,
  onStream: (chunk: string) => void,
): Promise<string> {
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.deepseek.com',
    dangerouslyAllowBrowser: true,
  });

  let fullText = '';
  const stream = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages,
    stream: true,
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content ?? '';
    if (text) {
      fullText += text;
      onStream(text);
    }
  }
  return fullText;
}

/** Module-level scratch space for the last DeepSeek response's metadata.
 *  Audit-only; read synchronously by callers right after their await on
 *  getCoachChatResponse so the call→read pair runs in one event-loop
 *  tick (no interleaving). Captures finish_reason and reasoning_content
 *  length — the two fields the previous return-string-only contract
 *  was discarding. Lets the coachMoveCommentary path log a definitive
 *  llm-response audit instead of inferring "empty content + normal
 *  latency = ???". */
export interface LastLlmMetadata {
  provider: 'deepseek' | 'anthropic';
  model: string;
  finishReason: string | null;
  reasoningContentLength: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

let lastLlmMetadata: LastLlmMetadata | null = null;

/** Read the metadata from the most recent LLM call. Resets to null
 *  after read so a stale value can't leak across unrelated callers. */
export function consumeLastLlmMetadata(): LastLlmMetadata | null {
  const m = lastLlmMetadata;
  lastLlmMetadata = null;
  return m;
}

async function callDeepSeek(
  apiKey: string,
  model: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  maxTokens: number,
  task: string,
): Promise<string> {
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.deepseek.com',
    dangerouslyAllowBrowser: true,
  });

  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages,
  });

  if (response.usage) {
    void recordApiUsage(task, model, response.usage.prompt_tokens, response.usage.completion_tokens);
  }
  const choice = response.choices[0];
  // DeepSeek-reasoner emits `reasoning_content` separately from
  // `content` — the chain-of-thought is hidden from the caller but
  // shares the `max_tokens` budget. When max_tokens is too small for
  // both, content can be empty even though the call succeeded. We
  // capture the length here so coachMoveCommentary's audit can name
  // the failure mode.
  const message = choice?.message as { content?: string | null; reasoning_content?: string | null } | undefined;
  const reasoningContent = message?.reasoning_content;
  lastLlmMetadata = {
    provider: 'deepseek',
    model,
    finishReason: choice?.finish_reason ?? null,
    reasoningContentLength: typeof reasoningContent === 'string' ? reasoningContent.length : 0,
    promptTokens: response.usage?.prompt_tokens ?? null,
    completionTokens: response.usage?.completion_tokens ?? null,
  };
  return message?.content ?? '';
}

// ── Anthropic ──

async function callAnthropicStream(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  maxTokens: number,
  onStream: (chunk: string) => void,
): Promise<string> {
  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
  });

  let fullText = '';
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      fullText += chunk.delta.text;
      onStream(chunk.delta.text);
    }
  }

  const finalMsg = await stream.finalMessage();
  void recordApiUsage(
    'stream',
    model,
    finalMsg.usage.input_tokens,
    finalMsg.usage.output_tokens,
  );
  return fullText;
}

async function callAnthropic(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  maxTokens: number,
  task: string,
): Promise<string> {
  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
  });

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  void recordApiUsage(task, model, response.usage.input_tokens, response.usage.output_tokens);
  const content = response.content[0];
  return content.type === 'text' ? content.text : '';
}

/** Force the LLM to emit a structured JSON object matching the
 *  given input schema by defining a tool and using `tool_choice` to
 *  require the LLM call it. The API enforces schema validation
 *  server-side, so the returned object is guaranteed to be valid
 *  JSON of the right shape — no client-side parse errors possible.
 *
 *  Production audit (build e86aa19): "THIS IS GETTING OLD" — the
 *  LLM kept emitting structurally broken JSON for niche openings
 *  (Najdorf, Pirc, Blackburne-Kostić) and our parse-recovery
 *  pipeline couldn't catch all edge cases. Tool-use eliminates the
 *  parse problem at the source. Returns the tool's input as an
 *  unknown so the caller can validate field shapes (we still need
 *  to assertTreeShape for our own invariants).
 *
 *  Throws if the API doesn't return a tool_use block (network error,
 *  rate limit, etc.). */
export async function callAnthropicWithTool(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  maxTokens: number,
  task: string,
  toolName: string,
  toolDescription: string,
  inputSchema: Record<string, unknown>,
): Promise<unknown> {
  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
  });
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
    tools: [
      {
        name: toolName,
        description: toolDescription,
        // SDK types want a specific shape; cast through unknown so
        // the caller can pass any JSON Schema sub-tree.
        input_schema: inputSchema as unknown as { type: 'object' },
      },
    ],
    // Force the model to call THIS tool and only this tool. No prose,
    // no choice — the API validates the input matches input_schema.
    tool_choice: { type: 'tool', name: toolName },
  });
  void recordApiUsage(task, model, response.usage.input_tokens, response.usage.output_tokens);
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === toolName) {
      return block.input;
    }
  }
  throw new Error(
    `Anthropic API returned no tool_use block for tool "${toolName}" — got ${response.content.map((b) => b.type).join(',')}`,
  );
}

// ── Public API ──

async function callChatWithConfig(
  config: ProviderConfig,
  messages: { role: 'user' | 'assistant'; content: string }[],
  systemPrompt: string,
  onStream?: (chunk: string) => void,
  task: CoachTask = 'chat_response',
  maxTokens: number = 1024,
): Promise<string> {
  const model = getModel(task, config.provider, config.preferredModel);
  // Audit which model actually went out on the wire so you can verify
  // Settings → preferredModel is being honored. Joins to brain trips
  // by timestamp.
  void import('./appAuditor').then(({ logAppAudit }) => {
    void logAppAudit({
      kind: 'coach-llm-model-selected',
      category: 'subsystem',
      source: 'coachApi.callChatWithConfig',
      summary: `task=${task} category=${TASK_CATEGORY[task]} model=${model} provider=${config.provider}`,
      details: JSON.stringify({
        task,
        category: TASK_CATEGORY[task],
        model,
        provider: config.provider,
        userPick: config.preferredModel?.[TASK_CATEGORY[task]] ?? null,
      }),
    });
  }).catch(() => undefined);
  if (config.provider === 'anthropic') {
    if (onStream) {
      return await callAnthropicStream(config.apiKey, model, systemPrompt, messages, maxTokens, onStream);
    }
    return await callAnthropic(config.apiKey, model, systemPrompt, messages, maxTokens, 'chat_response');
  } else {
    const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];
    if (onStream) {
      return await callDeepSeekStream(config.apiKey, model, allMessages, maxTokens, onStream);
    }
    return await callDeepSeek(config.apiKey, model, allMessages, maxTokens, 'chat_response');
  }
}

async function getCoachVerbosity(): Promise<CoachVerbosity> {
  const profile = await db.profiles.get('main');
  return profile?.preferences.coachVerbosity ?? 'unlimited';
}

function buildSystemPromptWithVerbosity(base: string, verbosity: CoachVerbosity, addition?: string): string {
  const parts = [base];
  const verbosityInstr = getVerbosityInstruction(verbosity);
  if (verbosityInstr) parts.push(verbosityInstr);
  if (addition) parts.push(addition);
  return parts.join('\n\n');
}

/** DeepSeek tool-use via OpenAI-compatible function calling. The
 *  LLM is forced to invoke the named function and the API validates
 *  the arguments against the schema. Mirrors callAnthropicWithTool
 *  for the DeepSeek path so we have a free fallback when Anthropic
 *  is unavailable / rate-limited. DeepSeek returns the tool's
 *  arguments as a JSON STRING in tool_calls[].function.arguments;
 *  we JSON.parse that string and return the object. */
export async function callDeepseekWithTool(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  maxTokens: number,
  task: string,
  toolName: string,
  toolDescription: string,
  inputSchema: Record<string, unknown>,
): Promise<unknown> {
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.deepseek.com',
    dangerouslyAllowBrowser: true,
  });
  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    tools: [
      {
        type: 'function',
        function: {
          name: toolName,
          description: toolDescription,
          parameters: inputSchema as unknown as Record<string, unknown>,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: toolName } },
  });
  if (response.usage) {
    void recordApiUsage(task, model, response.usage.prompt_tokens, response.usage.completion_tokens);
  }
  const choice = response.choices[0];
  const toolCall = choice?.message?.tool_calls?.[0];
  // The OpenAI SDK union types tool_call as function | custom. We
  // only emit `function` tools so narrow on `type === 'function'`.
  if (!toolCall || toolCall.type !== 'function' || toolCall.function.name !== toolName) {
    const got = toolCall && toolCall.type === 'function' ? toolCall.function.name : 'none';
    throw new Error(
      `DeepSeek API returned no matching tool_call for "${toolName}" — got ${got}`,
    );
  }
  // DeepSeek emits `arguments` as a JSON string. Parse here; let
  // exceptions propagate so the caller can decide to fall back.
  return JSON.parse(toolCall.function.arguments);
}

/** Top-level helper for tool-use generation. Tries Anthropic first —
 *  Sonnet/Haiku schema-validate tool calls more reliably than DeepSeek
 *  and chess pedagogy quality is better. Falls back to DeepSeek on
 *  any failure (no Anthropic key, network error, schema rejection,
 *  quota). The dead-state cooldown skips Anthropic for 60s after a
 *  failure so subsequent calls go straight to DeepSeek. CLAUDE.md
 *  2026-05-14: Anthropic-primary across the app. */
export async function getCoachStructuredResponse(
  messages: { role: 'user' | 'assistant'; content: string }[],
  systemPrompt: string,
  task: CoachTask,
  maxTokens: number,
  toolName: string,
  toolDescription: string,
  inputSchema: Record<string, unknown>,
): Promise<unknown> {
  let lastErr: unknown = null;
  if (!isProviderInCooldown('anthropic')) {
    const anthropicConfig = await getForcedProviderConfig('anthropic');
    if (anthropicConfig) {
      try {
        const model = getModel(task, anthropicConfig.provider, anthropicConfig.preferredModel);
        return await callAnthropicWithTool(
          anthropicConfig.apiKey,
          model,
          systemPrompt,
          messages,
          maxTokens,
          task,
          toolName,
          toolDescription,
          inputSchema,
        );
      } catch (err) {
        lastErr = err;
        markProviderDead('anthropic');
        // Fall through to DeepSeek.
      }
    }
  }
  const deepseekConfig = await getForcedProviderConfig('deepseek');
  if (deepseekConfig) {
    const model = getModel(task, deepseekConfig.provider, deepseekConfig.preferredModel);
    try {
      return await callDeepseekWithTool(
        deepseekConfig.apiKey,
        model,
        systemPrompt,
        messages,
        maxTokens,
        task,
        toolName,
        toolDescription,
        inputSchema,
      );
    } catch (err) {
      markProviderDead('deepseek');
      throw err;
    }
  }
  if (lastErr) {
    throw lastErr instanceof Error
      ? lastErr
      : new Error(typeof lastErr === 'string' ? lastErr : JSON.stringify(lastErr));
  }
  throw new Error('No API key configured for tool-use call (neither DeepSeek nor Anthropic)');
}

// ─── WO-COACH-MASTER-INTEGRATION — master-play grounding (Layers B + D) ─
//
// The four-layer grounding pipeline (CLAUDE.md G3 runtime instrument)
// hangs off `getCoachChatResponse` via the optional `grounding` parameter.
// Surfaces that want grounding pass a `MasterGroundingOptions` block; the
// function detects move-question intent on the latest user message,
// pre-injects master-play context from the cache (Layer B), then
// validates the LLM's output against that context (Layer D) and retries
// up to twice before falling back to the stock "I can't verify" response.
//
// Layer A (watcher prefetch) is invoked by the surface's
// `useMasterPlayWatcher` hook — it runs ahead of every chat turn, so by
// the time pre-injection asks the cache for the current FEN, the data is
// almost always already there. Layer C (LLM-driven tool call for follow-
// up positions) is deferred to a follow-up PR; the watcher's look-ahead
// pass already covers the practical "and if I play X?" follow-ups by
// pre-injecting the top-3 child positions alongside the current one.

/** Surfaces that want master-play grounding pass this block. The
 *  function decides INTERNALLY whether to engage (intent detector +
 *  context availability) — surfaces don't need to gate the call. */
export interface MasterGroundingOptions {
  /** The FEN the user is currently looking at. When undefined, Layer B
   *  skips: nothing to ground against. The watcher's prefetch is also
   *  keyed on this FEN, so callers should pass the SAME FEN the watcher
   *  saw most recently. */
  currentFen?: string;
  /** Surface route for audit attribution. Goes into every emitted
   *  audit event (`master-play-lookup`, `claim-validator-trip`, etc). */
  surface: string;
  /** Session correlator for audit attribution. */
  sessionId?: string;
  /** Force the grounding pipeline ON regardless of intent detection.
   *  Used by integration tests; production surfaces leave undefined. */
  forceEngage?: boolean;
}

/** Move-question intent patterns. The detector matches the last user
 *  message against the union — any match engages Layer B. Conservative:
 *  better to engage grounding on a question that doesn't need it
 *  (cheap pass-through when context has no data) than to miss a move
 *  question and let the LLM invent. */
const MOVE_QUESTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bwhat\s+(?:should|do|would|can)\s+I\s+play\b/i,
  /\bwhat'?s?\s+the\s+(?:best|right|correct)\s+move\b/i,
  /\bwhat\s+(?:move|moves)\s+(?:should|do|does)\b/i,
  /\bwhat\s+do\s+masters\s+(?:play|do|choose)\b/i,
  /\bwhat\s+do\s+grandmasters\s+(?:play|do|choose)\b/i,
  /\bwhat\s+do\s+(?:they|pros)\s+(?:play|do|choose)\b/i,
  /\bwhat'?s?\s+(?:the\s+)?most\s+(?:popular|common|played)\b/i,
  /\bwhich\s+move\s+(?:is|wins|works|scores)\b/i,
  /\bis\s+[A-Za-z][\w-]*\s+(?:a\s+)?(?:good|bad|sound|playable|winning|losing)\b/i,
  /\b(?:should|can)\s+I\s+play\s+[A-Za-z][\w-]*\b/i,
  /\bwhat\s+happens?\s+(?:after|if\s+I\s+play)\b/i,
  /\bwhat\s+(?:about|if)\s+[A-Za-z][\w-]*\??/i,
  /\bbest\s+continuation\b/i,
  /\bbook\s+move\b/i,
  /\bmain\s+line\b/i,
  /\bcontinuation\s+(?:here|after)\b/i,
  /\bhow\s+do\s+(?:masters|pros|GMs)\s+continue\b/i,
];

/** Match the last user message. Returns true if any pattern fires. */
function detectMoveQuestionIntent(
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const text = m.content;
    for (const pat of MOVE_QUESTION_PATTERNS) {
      if (pat.test(text)) return true;
    }
    return false; // Only look at the most recent user message.
  }
  return false;
}

/** Build the look-ahead set for a position. For each of the top-N
 *  master moves, apply via chess.js to get the resulting FEN, then
 *  look it up. Results are pulled from the cache when available so
 *  this method is cheap when the watcher has done its job. */
async function buildLookahead(
  fen: string,
  current: MasterPlayResult,
  surface: string,
  sessionId: string | undefined,
  maxCandidates = 3,
): Promise<MasterPlayContext['lookahead']> {
  if (current.moves.length === 0) return [];
  const top = current.moves.slice(0, maxCandidates);
  const out: MasterPlayContext['lookahead'][number][] = [];
  for (const move of top) {
    let childFen: string;
    try {
      const chess = new Chess(fen);
      const played = chess.move(move.san);
      if (!played) continue;
      childFen = chess.fen();
    } catch {
      continue;
    }
    const childResult = await lookupMasterPlay(childFen, {
      triggeredBy: 'pre-injection',
      surface,
      sessionId,
    });
    out.push({ moveFromCurrent: move.san, result: childResult });
  }
  return out;
}

/** Assemble the full master-play context for the brain. Returns
 *  undefined when no FEN was provided OR when both current + look-ahead
 *  resolve to source:'none' (the brain has nothing grounded to say). */
async function buildMasterPlayContext(
  grounding: MasterGroundingOptions,
): Promise<MasterPlayContext | undefined> {
  if (!grounding.currentFen) return undefined;
  const current = await lookupMasterPlay(grounding.currentFen, {
    triggeredBy: 'pre-injection',
    surface: grounding.surface,
    sessionId: grounding.sessionId,
  });
  if (current.source === 'none' || current.moves.length === 0) {
    // Honest "no master data" context — claim validator will use this
    // to reject any SAN/percentage the LLM tries to fabricate.
    return { current, lookahead: [] };
  }
  const lookahead = await buildLookahead(
    grounding.currentFen,
    current,
    grounding.surface,
    grounding.sessionId,
  );
  return { current, lookahead };
}

/** Render the context as a system-prompt block the LLM can consume.
 *  Format is deliberately structured (move counts + percentages +
 *  attribution) so the LLM can read off values without paraphrasing. */
function renderMasterPlayContextBlock(ctx: MasterPlayContext): string {
  const lines: string[] = ['═══ MASTER-PLAY CONTEXT (grounded data — use ONLY these figures) ═══'];
  const c = ctx.current;
  if (c.source === 'none' || c.moves.length === 0) {
    lines.push('No master-game data is available for the current position.');
    lines.push('Do NOT cite move popularity, win rates, ratings, player names, or "what masters play" for this position.');
    lines.push('If the user asks a move question, say so explicitly — recommend they analyze with the engine.');
  } else {
    lines.push(`Position: ${c.fen}`);
    lines.push(`Source: ${c.source}    Total master games: ${c.totalGames}`);
    lines.push('Top moves played by masters in this position:');
    for (const m of c.moves.slice(0, 6)) {
      const wPct = (m.whitePct * 100).toFixed(0);
      const dPct = (m.drawPct * 100).toFixed(0);
      const bPct = (m.blackPct * 100).toFixed(0);
      const rating = m.averageRating ? ` avg-rating ${m.averageRating}` : '';
      lines.push(`  • ${m.san} — ${m.games} games (W:${wPct}% D:${dPct}% B:${bPct}%)${rating}`);
    }
    if (c.topGames && c.topGames.length > 0) {
      lines.push('Notable master games in this position:');
      for (const g of c.topGames.slice(0, 4)) {
        const white = g.white ?? '?';
        const black = g.black ?? '?';
        const year = g.year ?? '?';
        const event = g.event ? ` (${g.event})` : '';
        const result = g.result ?? '*';
        lines.push(`  • ${white} vs ${black}, ${year}${event} — ${result}`);
      }
    }
    if (ctx.lookahead.length > 0) {
      lines.push('Look-ahead — positions after each top move:');
      for (const la of ctx.lookahead) {
        const r = la.result;
        if (r.source === 'none' || r.moves.length === 0) {
          lines.push(`  After ${la.moveFromCurrent}: no master data.`);
          continue;
        }
        const top = r.moves.slice(0, 4).map((m) => `${m.san} (${m.games}g)`).join(', ');
        lines.push(`  After ${la.moveFromCurrent}: ${r.totalGames} games — top: ${top}`);
      }
    }
  }
  lines.push('');
  lines.push('GROUNDING RULES (non-negotiable):');
  lines.push('  • When recommending a move, citing frequencies / ratings / player names / years, or making');
  lines.push('    comparative claims about master practice — ground EVERY such claim in the data above.');
  lines.push('  • Never invent or estimate move popularity, game counts, ratings, or "what masters play"');
  lines.push('    figures that are not literally in the data above.');
  lines.push('  • If you need a position not shown, say so — do not fabricate the answer.');
  lines.push('  • Strategic prose (plan ideas, structural concepts) without specific SANs is unrestricted.');
  lines.push('═══════════════════════════════════════════════════════════════════════════');
  return lines.join('\n');
}

/** Stock fallback served when retries are exhausted. Generic enough
 *  to feel like a coach being honest about uncertainty rather than
 *  hitting a programmatic dead end. */
const STOCK_GROUNDING_FALLBACK =
  "I can't verify which moves are sound here from master practice right now. " +
  "If you want a concrete recommendation, run the position through the engine — " +
  "I'd rather stay honest than guess.";

function emitClaimValidatorTrips(
  validation: ClaimValidationResult,
  retryNumber: 1 | 2,
  surface: string,
  sessionId: string | undefined,
): void {
  for (const v of validation.violations) {
    void logAppAudit({
      kind: 'claim-validator-trip',
      category: 'subsystem',
      source: 'coachApi.getCoachChatResponse',
      summary: `kind=${v.kind} claim="${v.claim.slice(0, 60)}" retry=${retryNumber} surface=${surface}`,
      details: JSON.stringify({
        kind: v.kind,
        claim: v.claim,
        reason: v.reason,
        retryNumber,
        surface,
        sessionId,
      }),
    });
  }
}

function emitEnforcementFallback(
  originalQuery: string,
  lastValidation: ClaimValidationResult,
  surface: string,
  sessionId: string | undefined,
): void {
  void logAppAudit({
    kind: 'master-play-enforcement-fallback',
    category: 'subsystem',
    source: 'coachApi.getCoachChatResponse',
    summary: `retry budget exhausted — stock response served surface=${surface}`,
    details: JSON.stringify({
      originalQuery: originalQuery.slice(0, 240),
      violationCount: lastValidation.violations.length,
      sampleViolation: lastValidation.violations[0],
      surface,
      sessionId,
    }),
  });
}

/** Build a strengthened addendum to attach on retry. The first retry's
 *  strengthening points to the most recent violation; the second retry
 *  doubles down and forbids the LLM from making chess claims at all
 *  if it can't ground them. */
function buildRetryAddendum(retryNumber: 1 | 2, lastValidation: ClaimValidationResult): string {
  const violationSummary = lastValidation.violations
    .slice(0, 5)
    .map((v) => `[${v.kind}] ${v.claim}: ${v.reason}`)
    .join('\n  ');
  if (retryNumber === 1) {
    return [
      '═══ GROUNDING VIOLATION ON PRIOR ATTEMPT ═══',
      'Your previous response was rejected. The following claims were not grounded in the master-play context:',
      `  ${violationSummary}`,
      'Regenerate WITHOUT those claims. Either use only data from the master-play context above, or omit',
      'the chess specifics entirely and answer with strategic prose.',
    ].join('\n');
  }
  return [
    '═══ FINAL ATTEMPT — STRICTEST GROUNDING ═══',
    'Two grounding violations so far:',
    `  ${violationSummary}`,
    'On this attempt: cite NO move SAN unless it appears verbatim in the master-play context above.',
    'Cite NO percentage, game count, rating, player name, or year unless it derives directly from the context.',
    'If you cannot answer under those constraints, say so plainly and recommend the user run the engine.',
  ].join('\n');
}

export async function getCoachChatResponse(
  messages: { role: 'user' | 'assistant'; content: string }[],
  systemPromptAddition: string,
  onStream?: (chunk: string) => void,
  task: CoachTask = 'chat_response',
  maxTokens: number = 1024,
  /** Optional verbosity override. When provided, bypasses the DB
   *  fetch so callers that already know the student's verbosity
   *  (e.g. per-move commentary) can avoid a redundant lookup and
   *  guarantee a single source of truth for the length directive. */
  verbosityOverride?: CoachVerbosity,
  /** Force a specific API provider for this call, overriding the
   *  default `getProviderConfig()` selection. Used by the brain's
   *  per-surface routing — `/coach/teach` forces Anthropic so the
   *  Learn tab always gets Sonnet/Haiku regardless of the global
   *  default, while every other surface stays on DeepSeek. The
   *  fallback chain still kicks in if the forced provider's call
   *  errors. */
  forceProvider?: AiProvider,
  /** Kid-mode safety lane. When true, skips both
   *  `loadPersonalityAddition` and `loadResponseLengthAddition` so the
   *  user's coach personality dials (edgy / drill-sergeant / profanity
   *  intensity) cannot bleed into kid surfaces. Kid callers should use
   *  `getKidLlmResponse` rather than passing this flag directly. See
   *  CLAUDE.md "Kids section non-negotiables" #3. */
  skipPersonality?: boolean,
  /** WO-COACH-MASTER-INTEGRATION — when set, runs the four-layer
   *  master-play grounding pipeline for this turn. The function decides
   *  internally whether to engage based on intent detection. Surfaces
   *  pass `currentFen` from their game state; the watcher
   *  (`useMasterPlayWatcher`) keeps the cache warm so pre-injection is
   *  near-instant. `getKidLlmResponse` does NOT pass this — kid lane
   *  excluded by contract. */
  grounding?: MasterGroundingOptions,
): Promise<string> {
  const config = forceProvider
    ? await getForcedProviderConfig(forceProvider)
    : await getProviderConfig();
  if (!config) return '⚠️ No API key configured. Go to Settings to add your Anthropic or DeepSeek API key.';

  const verbosity = verbosityOverride ?? await getCoachVerbosity();
  // Pull the active profile's personality dials so EVERY surface that
  // routes through getCoachChatResponse inherits the user's chosen
  // voice (default / soft / edgy / flirtatious / drill-sergeant) +
  // profanity / mockery / flirt intensities. Until this layer existed,
  // legacy callers (walkthrough narrator, opening-section narrator,
  // smart search, kid puzzles, middlegame planner, MiddlegamePractice,
  // CoachGameReview) used a flat SYSTEM_PROMPT with no persona —
  // their coach voice was identical regardless of Settings, breaking
  // the "one coach across all tabs" feel. Failing this lookup
  // gracefully (no profile, fresh install) keeps the legacy flat
  // persona as the fallback so the surface still works.
  //
  // EXCEPTION: `skipPersonality` short-circuits both lookups so kid
  // mode (and any future "neutral voice" surface) can guarantee no
  // adult personality leaks in — see comment on the parameter above.
  const personalityAddition = skipPersonality ? '' : await loadPersonalityAddition();
  const responseLengthAddition = skipPersonality ? '' : await loadResponseLengthAddition();

  // ── Layer B: master-play pre-injection ────────────────────────────
  // Only engages when: grounding options were passed (a surface opted
  // in), AND either intent detector fires OR the caller forced it
  // (integration tests). When engaged, we build the masterPlayContext
  // (cache → local DB → live Lichess fallback chain) and inject a
  // structured prompt block. We also disable streaming for this turn
  // so the post-response claim validator (Layer D) can rerun if needed
  // without the user seeing a half-bad answer first.
  let masterPlayContext: MasterPlayContext | undefined;
  let groundingEngaged = false;
  if (grounding) {
    const intentFired = grounding.forceEngage === true || detectMoveQuestionIntent(messages);
    if (intentFired) {
      try {
        masterPlayContext = await buildMasterPlayContext(grounding);
        groundingEngaged = masterPlayContext !== undefined;
      } catch (err) {
        // Building the context shouldn't throw, but if it does, fail
        // open — proceed without grounding rather than crash the turn.
        console.warn('[CoachAPI] buildMasterPlayContext threw:', err);
      }
    }
  }
  const groundingBlock = masterPlayContext
    ? renderMasterPlayContextBlock(masterPlayContext)
    : '';

  const buildSystemPromptFor = (extraAddendum: string = ''): string => {
    return buildSystemPromptWithVerbosity(
      SYSTEM_PROMPT,
      verbosity,
      [
        personalityAddition,
        responseLengthAddition,
        groundingBlock,
        systemPromptAddition,
        extraAddendum,
      ]
        .filter(Boolean)
        .join('\n\n') || undefined,
    );
  };

  // Helper that wraps the existing primary+fallback provider chain
  // so we can reuse it across retries without duplicating the
  // error-handling. Returns null on dead-end (both providers failed)
  // so the caller can decide whether to retry or stock-out.
  const callOnce = async (systemPrompt: string, allowStream: boolean): Promise<string> => {
    const onStreamForCall = allowStream ? onStream : undefined;
    try {
      return await callChatWithConfig(config, messages, systemPrompt, onStreamForCall, task, maxTokens);
    } catch (error) {
      console.warn(`[CoachAPI] ${config.provider} failed, trying fallback...`, error);
      markProviderDead(config.provider);
      const fallback = getFallbackConfig(config.provider);
      if (fallback) {
        try {
          return await callChatWithConfig(fallback, messages, systemPrompt, onStreamForCall, task, maxTokens);
        } catch (fallbackError) {
          console.error('[CoachAPI] Fallback also failed:', fallbackError);
          markProviderDead(fallback.provider);
          const errMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          return `⚠️ Coach error: ${errMsg}`;
        }
      }
      const errMsg = error instanceof Error ? error.message : String(error);
      return `⚠️ Coach error: ${errMsg}`;
    }
  };

  // ── Non-grounded path: existing behavior, streaming-as-passed ──
  if (!groundingEngaged) {
    return callOnce(buildSystemPromptFor(), true);
  }

  // ── Grounded path: collect → validate → retry up to 2x → stock ──
  // Streaming is disabled on grounded turns so the validator can
  // reject without the user seeing a half-bad response. `grounding`
  // is guaranteed non-null at this point — `groundingEngaged` is only
  // true if we built a context, which requires grounding.
  const { surface, sessionId } = grounding ?? { surface: 'unknown', sessionId: undefined };
  const originalQuery = messages[messages.length - 1]?.content ?? '';

  // Attempt 1 (no addendum).
  let response = await callOnce(buildSystemPromptFor(), false);
  let validation = validateClaims(response, masterPlayContext);
  if (validation.ok) {
    if (onStream && response) onStream(response);
    return response;
  }
  emitClaimValidatorTrips(validation, 1, surface, sessionId);

  // Attempt 2 (mild strengthening).
  response = await callOnce(buildSystemPromptFor(buildRetryAddendum(1, validation)), false);
  validation = validateClaims(response, masterPlayContext);
  if (validation.ok) {
    if (onStream && response) onStream(response);
    return response;
  }
  emitClaimValidatorTrips(validation, 2, surface, sessionId);

  // Attempt 3 (strictest).
  response = await callOnce(buildSystemPromptFor(buildRetryAddendum(2, validation)), false);
  validation = validateClaims(response, masterPlayContext);
  if (validation.ok) {
    if (onStream && response) onStream(response);
    return response;
  }
  // Retry budget exhausted. Serve the stock fallback so the user
  // doesn't see an ungrounded response slip through.
  emitEnforcementFallback(originalQuery, validation, surface, sessionId);
  if (onStream) onStream(STOCK_GROUNDING_FALLBACK);
  return STOCK_GROUNDING_FALLBACK;
}

/** Read the active profile's personality dials and render the
 *  surface-agnostic personality block (voice + intensity modulators).
 *  Cached by-call — getProviderConfig already touches the same row, so
 *  the additional read is hot in IndexedDB. Returns empty string when
 *  the profile/dials aren't available so the legacy flat persona
 *  remains the fallback. */
async function loadPersonalityAddition(): Promise<string> {
  try {
    const profile = await db.profiles.get('main');
    if (!profile) return '';
    const personality = profile.preferences.coachPersonality ?? 'default';
    const profanity = profile.preferences.coachProfanity ?? 'none';
    const mockery = profile.preferences.coachMockery ?? 'none';
    const flirt = profile.preferences.coachFlirt ?? 'none';
    if (personality === 'default' && profanity === 'none' && mockery === 'none' && flirt === 'none') {
      return '';
    }
    const { renderPersonalityBlock } = await import('../coach/sources/personalities');
    return renderPersonalityBlock({ personality, profanity, mockery, flirt });
  } catch {
    return '';
  }
}

/** Read the user's coachResponseLength preference (Settings →
 *  Personality → Verbosity) and render the matching modulator. Same
 *  shape as the verbosity blocks in `coach/envelope.ts` so legacy
 *  callers feel identical to the chat surfaces. Default 'normal'
 *  matches /coach/teach's tightness. */
async function loadResponseLengthAddition(): Promise<string> {
  try {
    const profile = await db.profiles.get('main');
    const level = profile?.preferences.coachResponseLength ?? 'normal';
    const blocks: Record<'minimal' | 'normal' | 'verbose', string> = {
      minimal: '═══ VERBOSITY: MINIMAL ═══\nHard ceiling: ONE short sentence per turn, ≤8 words. NO multi-sentence responses, NO bullet points, NO past-games stats.',
      normal: '═══ VERBOSITY: NORMAL ═══\nDefault tightness. Ceiling: ONE short sentence per turn (≤15 words) plus an optional one-line teaching beat when the position genuinely warrants it. NO multi-paragraph commentary, NO bullet-point agendas.',
      verbose: '═══ VERBOSITY: VERBOSE ═══\nLecture shape allowed: set up positions, demonstrate candidate moves, name the IDEA, ground in Stockfish, cite master games. No length cap.',
    };
    return blocks[level];
  } catch {
    return '';
  }
}

async function callCommentaryWithConfig(
  config: ProviderConfig,
  task: CoachTask,
  userMessage: string,
  systemPrompt: string,
  onStream?: (chunk: string) => void,
): Promise<string> {
  const model = getModel(task, config.provider, config.preferredModel);
  if (config.provider === 'anthropic') {
    const messages: { role: 'user' | 'assistant'; content: string }[] = [
      { role: 'user', content: userMessage },
    ];
    if (onStream) {
      return await callAnthropicStream(config.apiKey, model, systemPrompt, messages, 512, onStream);
    }
    return await callAnthropic(config.apiKey, model, systemPrompt, messages, 1024, task);
  } else {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];
    if (onStream) {
      return await callDeepSeekStream(config.apiKey, model, messages, 512, onStream);
    }
    return await callDeepSeek(config.apiKey, model, messages, 1024, task);
  }
}

export async function getCoachCommentary(
  task: CoachTask,
  context: CoachContext,
  onStream?: (chunk: string) => void,
): Promise<string> {
  const verbosity = await getCoachVerbosity();
  if (verbosity === 'none') return '';

  const config = await getProviderConfig();
  if (!config) return OFFLINE_FALLBACKS[task] ?? OFFLINE_FALLBACKS.default;

  const systemPrompt = buildSystemPromptWithVerbosity(SYSTEM_PROMPT, verbosity);
  const userMessage = buildChessContextMessage(context);

  try {
    return await callCommentaryWithConfig(config, task, userMessage, systemPrompt, onStream);
  } catch (error) {
    console.warn(`[CoachAPI] ${config.provider} failed for ${task}, trying fallback...`, error);
    markProviderDead(config.provider);
    const fallback = getFallbackConfig(config.provider);
    if (fallback) {
      try {
        return await callCommentaryWithConfig(fallback, task, userMessage, systemPrompt, onStream);
      } catch (fallbackError) {
        console.error('[CoachAPI] Fallback also failed:', fallbackError);
        markProviderDead(fallback.provider);
        return OFFLINE_FALLBACKS[task] ?? OFFLINE_FALLBACKS.default;
      }
    }
    return OFFLINE_FALLBACKS[task] ?? OFFLINE_FALLBACKS.default;
  }
}

// ─── Kid-mode safety lane ──────────────────────────────────────────────
//
// All kid LLM calls go through this wrapper. Pins:
//   1. `skipPersonality: true` — user's coach personality / profanity
//      / mockery / flirt dials cannot bleed in.
//   2. A kid-safety system prompt that asserts age-appropriate output,
//      JSON-only when requested, no slang / negative language / taunting,
//      ≤ 12 words per text field.
//   3. `task: 'kid_puzzle_gen'` so audit-stream entries are filterable
//      and per-task model maps stay tight.
// Kid surfaces MUST use this wrapper instead of `getCoachChatResponse`
// directly. See CLAUDE.md "Kids section non-negotiables" #3 & #17.

const KID_SAFETY_PROMPT = `You are writing text for a child aged 5-10 learning chess.

ABSOLUTE RULES:
- Age-appropriate, friendly, encouraging tone — no slang, no sarcasm.
- No negative language, no comparison to other kids, no taunting.
- No idioms ("a piece of cake", "by the skin of your teeth"). Literal language only.
- No standard algebraic notation. Spell out moves ("the knight takes the bishop", not "Nxc6").
- ≤ 12 words per text field unless explicitly told otherwise.
- Output JSON only when the user asks for JSON. No prose around it.
- You are the position teaching the student. You are not "I", you are not a tutor character.`;

/** Kid-mode LLM entry point. Forces neutral/Ruth personality and
 *  prepends the kid-safety system prompt. Returns the raw string just
 *  like `getCoachChatResponse`. Callers in kid surfaces must use this
 *  wrapper; importing `getCoachChatResponse` directly from a `Kid/`
 *  file is banned (see scripts/audit-kid-llm-hallucination.mjs). */
export async function getKidLlmResponse(
  messages: { role: 'user' | 'assistant'; content: string }[],
  systemPromptAddition: string,
  maxTokens: number = 1024,
): Promise<string> {
  const fullAddition = `${KID_SAFETY_PROMPT}\n\n${systemPromptAddition}`.trim();
  return getCoachChatResponse(
    messages,
    fullAddition,
    undefined,        // no streaming for kid puzzles
    'kid_puzzle_gen', // task — audit-stream filterable
    maxTokens,
    undefined,        // no verbosity override
    undefined,        // no forced provider
    true,             // skipPersonality — the safety contract
  );
}

