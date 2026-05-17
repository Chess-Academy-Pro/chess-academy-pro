/**
 * Anthropic provider — wired but dark.
 *
 * Today's `getCoachChatResponse` already routes to Anthropic when the
 * user has an Anthropic key configured. This provider exists so that
 * flipping `COACH_PROVIDER` env var (read in `coachService.ts`) routes
 * brain calls explicitly through the Anthropic-flavoured path. Today
 * it shares the same wrapper as DeepSeek — provider selection happens
 * one layer deeper via `getProviderConfig`. When we eventually want
 * provider-specific prompt shapes or tool-use blocks, this file is
 * where Anthropic-specific behaviour lands.
 *
 * Privacy callout (per COACH-BRAIN-00): DeepSeek is China-hosted.
 * The brain's eventual flip to Anthropic is meant to be a one-line
 * change at the `COACH_PROVIDER` level. Keep that easy.
 */
import { getCoachChatResponse, type MasterGroundingOptions } from '../../services/coachApi';
import { parseActions } from '../../services/coachActionDispatcher';
import type {
  AssembledEnvelope,
  Provider,
  ProviderCallOptions,
  ProviderResponse,
  ProviderToolCall,
} from '../types';
import { formatEnvelopeAsSystemPrompt, formatEnvelopeAsUserMessage } from '../envelope';

const PROVIDER_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 2000;

function buildResponse(raw: string): ProviderResponse {
  const parsed = parseActions(raw);
  const toolCalls: ProviderToolCall[] = parsed.actions.map((a, i) => ({
    id: `tc-${Date.now()}-${i}`,
    name: a.name,
    args: a.args,
  }));
  return {
    text: parsed.cleanText.trim(),
    toolCalls,
    raw: { fullResponse: raw },
  };
}

async function callAnthropicViaCoachApi(
  envelope: AssembledEnvelope,
  onChunk?: (chunk: string) => void,
  options?: ProviderCallOptions,
): Promise<ProviderResponse> {
  const systemPrompt = formatEnvelopeAsSystemPrompt(envelope);
  const userMessage = formatEnvelopeAsUserMessage(envelope);
  // Force Anthropic at the API layer too. Without this, getCoachChatResponse
  // would re-pick the provider via `getProviderConfig` based on which key is
  // available, which can route the call to DeepSeek even though the brain
  // chose anthropicProvider. The /coach/teach surface must always hit
  // Anthropic (Sonnet/Haiku) regardless of the global default.
  // Task defaults to 'chat_response' (claude-sonnet-4-6); legacy
  // /coach/play call sites passing through the spine override this
  // to keep Haiku/Reasoner routing for cost-sensitive paths.
  const task = options?.task ?? 'chat_response';
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const promise = getCoachChatResponse(
    [{ role: 'user', content: userMessage }],
    systemPrompt,
    onChunk,
    task,
    maxTokens,
    'medium',
    'anthropic',
    undefined,        // skipPersonality — coach lane, personality blocks apply
    options?.grounding as MasterGroundingOptions | undefined, // WO-COACH-MASTER-INTEGRATION
  );
  const timeout = new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error('coach-brain-anthropic-timeout')), PROVIDER_TIMEOUT_MS),
  );
  let raw: string;
  try {
    raw = await Promise.race([promise, timeout]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: `(coach-brain provider error: ${message})`,
      toolCalls: [],
      raw: { error: message },
    };
  }
  return buildResponse(raw);
}

export const anthropicProvider: Provider = {
  name: 'anthropic',
  async call(envelope: AssembledEnvelope, options?: ProviderCallOptions): Promise<ProviderResponse> {
    return callAnthropicViaCoachApi(envelope, undefined, options);
  },
  /** First-sentence-fast streaming. The brain hands `onChunk` here so
   *  the TTS dispatcher in CoachTeachPage / GameChatPanel can split on
   *  sentence boundaries and play the first Polly utterance within
   *  ~1s of the model emitting it — instead of waiting for the full
   *  response. Tool-call markers (`[[ACTION:name {args}]]`) are still
   *  parsed from the FULL accumulated response after streaming
   *  completes, so the dispatcher fires every action regardless of
   *  whether streaming was on. */
  async callStreaming(envelope, onChunk, options) {
    return callAnthropicViaCoachApi(envelope, onChunk, options);
  },
};
