# Coach Chat — UX Contract + Audit Coverage

How `/coach/chat` SHOULD work, and what the audit
(`scripts/audit-coach-chat.mjs` + `CoachChatPage.test.tsx`) currently
exercises.

The surface is **`/coach/chat`** (component:
[`src/components/Coach/CoachChatPage.tsx`](../src/components/Coach/CoachChatPage.tsx)).
It's the standalone "Chat with Coach" entry point — separate from the
in-game chat panel on `/coach/play` and the ask-about-position panel
on `/coach/review`.

**Current state: 15/15 prod-audit expectations green + 18/18 unit
tests (`CoachChatPage.test.tsx`).**

Run:
- `node scripts/audit-coach-chat.mjs` — drives prod
- `npx vitest run src/components/Coach/CoachChatPage` — unit tests
- `AUDIT_SMOKE_URL=http://localhost:5173 node scripts/audit-coach-chat.mjs`
  — drives local dev

## 1. Page render

| # | Contract |
|---|---|
| 1.1 | `/coach/chat` mounts `[data-testid="coach-chat-page"]`. |
| 1.2 | Header renders coach avatar + "Chat with Coach" title + Online/Typing status. Back arrow returns to `/coach`. |
| 1.3 | Voice toggle `[data-testid="voice-toggle"]` renders in the header (`Volume2` when unmuted, `VolumeOff` when muted). Clicking flips state + stops in-flight TTS. |
| 1.4 | When `chatMessages.length === 0`, the empty-state greeting renders: avatar + "How can I help you today?" + 6 starter chips `[data-testid="coach-starter-chip"]`. |
| 1.5 | When `chatMessages.length > 0`, the greeting is hidden and messages render via `ChatMessage` (user/assistant testids). |
| 1.6 | `[data-testid="chat-input"]` + `chat-text-input` + `chat-send-btn` render at the bottom; send disabled while `isStreaming`. |

## 2. Fast-paths (no LLM round-trip)

`handleSend` has three deterministic branches that fire BEFORE the
slow LLM ask. Each MUST append both user and assistant entries to the
session store AND mirror the same turn into `useCoachMemoryStore`'s
`conversationHistory` so the brain's next envelope reflects the
back-and-forth.

| # | Contract |
|---|---|
| 2.1 | `detectNarrationToggle(text)` match — appends user + ack to session, calls `applyNarrationToggle`, mirrors both turns into memory. If `enable === true`, navigates to `/coach/session/play-against?narrate=1`. |
| 2.2 | `READ_THIS_RE.test(text)` match with a previous assistant message — appends user to session, mirrors user into memory, force-unmutes voice (`setVoiceMuted(false)`), speaks the prior assistant message via `voiceService.speakForced`. |
| 2.3 | `routeChatIntent(text)` returns non-null — appends user + ack to session, mirrors both turns into memory, navigates to `routed.path` if set. Otherwise stays on `/coach/chat`. |
| 2.4 | All three branches `return` before the LLM path so the slow async call never runs for fast-path matches. |

## 3. LLM path

| # | Contract |
|---|---|
| 3.1 | `coachService.ask({ surface: 'standalone-chat', ask, liveState })` runs with `maxToolRoundTrips: 3` so the brain can call `stockfish_eval` / `lichess_opening_lookup` and synthesize a grounded answer. |
| 3.2 | `onChunk` accumulates the streamed reply; the visible bubble shows it via `setStreamingContent` after stripping `[BOARD:...]` / `[ACTION:...]` / `[[ACTION:...]]` tags. |
| 3.3 | Voice gating: `shouldSpeak = !voiceMutedRef.current || modality === 'voice'`. When speaking, sentences are flushed on `.!?\n` (with `(?<!\d)` lookbehind so SAN move numbers like "1." stay atomic) and chained through `voiceService.speakForced` to keep a single Polly engine. |
| 3.4 | `onNavigate` callback supplied so the brain's `navigate_to_route` tool can take the user anywhere. |
| 3.5 | After the stream resolves, the final assistant message is appended to the session store + mirrored into memory. |
| 3.6 | If `coachService.ask` throws, a failure stub appends to session + memory so the transcript doesn't show "user asked X, then nothing." |

## 4. Hydration + routing

| # | Contract |
|---|---|
| 4.1 | On mount, `useCoachSessionStore.hydrate()` runs once; `setCurrentRoute('/coach/chat')` publishes the active route. |
| 4.2 | `handleSend` short-circuits when `!activeProfile || isStreaming || !hydrated` — prevents transcript ordering races on cold start. |
| 4.3 | `?q=<text>` URL param auto-sends on mount (`useEffect` with `autoSentQueryRef` guard), then strips itself from the URL via `setSearchParams({...}, { replace: true })`. |
| 4.4 | Refreshing or returning to `/coach/chat` restores the persisted transcript from Dexie (`coachSession.v1` key in `meta` store). |

## 5. Audit coverage

| Test | Verifies |
|---|---|
| ✅ `coach-chat-direct` mounts | 1.1, 1.3, 1.6 |
| ✅ `clear-session` renders greeting + 6 chips | 1.4 |
| ✅ `voice-toggle-click` stays present after click | 1.3 |
| ✅ `chip-worst-opening` stays on `/coach/chat`, appends user + ack DOM, **mirrors memory** | 2.3 (intent-router fast-path) |
| ✅ `walkthrough-intent` routes to `/coach/session/walkthrough` | 2.3 (intent-router fast-path with nav) |
| ✅ `q-param-autosend` strips `?q=` after firing, message rendered | 4.3 |
| ✅ Unit: `mirrors intent-routed fast-path turns into the coach memory store` | 2.3 memory contract |
| ✅ Unit: `mirrors LLM-path turns into the coach memory store` | 3.5 memory contract |
| 🟡 Voice gating + sentence flushing logic | 3.3 — not exercised end-to-end. Polly + Web Speech is hard to assert in headless. |
| 🟡 Tag-stripping in display vs spoken text | 3.2 — covered indirectly by ChatMessage tests; no dedicated TAG_STRIP_RE assertion. |
| ❌ Error-stub render on `coachService.ask` throw | 3.6 — needs to throw the LLM mock and assert the failure-stub copy. |
| ❌ Hydration race when `!hydrated` | 4.2 — needs to simulate `hydrate` pending while a chip is clicked. |
| ❌ Refresh restores transcript | 4.4 — Dexie persist tested in `coachSessionStore.test.ts`, not at the page level. |

## 6. Bug log

### 2026-05-14 — Memory-mirror gap on every fast-path

**Symptom:** Probing each of the 6 starter chips and reading
`coachMemory.v1` from Dexie's `meta` store after each click showed
`conversationHistory.length === 0`. The session store correctly
recorded 2 entries (user + ack), but the memory store was empty.

**Disease:** `CoachChatPage.handleSend`'s three fast-paths (narration
toggle, "read this to me", intent router) each called
`appendMessage` on the session store but skipped
`useCoachMemoryStore.appendConversationMessage`. Only the LLM path
performed both writes. The contract was clear (the LLM path's
comment explicitly says "Append the user message into BOTH stores"),
but the fast-paths violated it silently.

**Impact:** The brain's `AssembledEnvelope` includes the conversation
history from memory store, not session store. When the user took any
fast-path turn ("Play the Italian", "What's my worst opening?",
etc.), the brain's NEXT ask had no idea those turns happened. From
the brain's perspective, the user just appeared out of nowhere
asking a fresh question.

**Fix:** Introduced a single `recordTurn(role, text)` helper at the
top of `handleSend` and call it from every branch (narration toggle,
read-this, intent router, LLM stream success, error stub). The
existing LLM-path memory writes were routed through the helper too
so the contract has a single call site.

**Guard:** Two new unit tests + a new `memory-history-gte`
expectation kind in `audit-coach-chat.mjs`. A future regression
would now break both build-time (vitest) and prod-smoke (audit
script).

**Commits:** `1f96dcd0` (fix + audit script + unit tests),
`de084738` (audit-script tightening).

### 2026-05-14 — Same class of bug at 21 sites across sister chat surfaces

After fixing `/coach/chat`, swept the codebase for every other
chat-style surface using David's "sweep, don't spot-fix" rule. Found
the identical violation at 21 more sites:

| File | Sites | Why it mattered |
|---|---:|---|
| `GameChatPanel.tsx` | 10 | Mounted globally via `GlobalCoachDrawer` AND on `/coach/play` — every route in the app exposed the bug. |
| `VoiceChatMic.tsx` | 4 | Voice users hit this hardest — STT-routed phrases mostly hit the deterministic intent router, not the LLM path. |
| `CoachTeachPage.tsx` | 5 | Cached-lesson ack, generation progress ack, success ack, failure ack, catch-all error — none mirrored. |
| `CoachGamePage.tsx` | 2 | The in-game coach's actual move narration + tactic alerts were invisible to the brain. |

Probe pre-fix: a chip-driven turn on any of these surfaces left
`useCoachMemoryStore.conversationHistory.length === 0` even though the
chat UI clearly showed both user + assistant bubbles. The disease was
universal because the contract was implicit ("you should write to both
stores") rather than enforced by a shared helper.

Fix shape (same pattern per surface): introduce a small local
`recordCoachAck(text)` or `recordMemory(role, text)` helper at the top
of the chat handler that wraps `appendConversationMessage`, then call
it at every previously-unpaired site. Surface label varies per file:
`chat-coach-tab` / `chat-in-game` / `chat-home` / `chat-teach`.

Prior audits caught zero of these — only this session's audits
(audit-coach-chat.mjs + Wave 4 spec 2.16) inspected the memory store
at all. Every prior surface-level audit asserted at the chat-bubble
level, which is exactly where this bug is invisible.

**Commit:** `2ff6227a` — single sweep commit across 5 files (4 product
+ 1 audit script wipe-strictness fix + 1 stale CLAUDE.md-policy test
update).

