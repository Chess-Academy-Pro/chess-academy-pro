/**
 * Envelope assembler — the six-part prompt envelope every Coach Brain
 * call ships with. See `docs/COACH-BRAIN-00.md` §"The Prompt Envelope".
 *
 * Six parts, no exceptions:
 *   1. Identity — who the coach is
 *   2. Memory — full memory snapshot
 *   3. App map — routes manifest
 *   4. Live state — surface, FEN, phase, current route
 *   5. Toolbelt — every tool the coach can call
 *   6. The ask — the specific message this surface dispatched
 *
 * `assembleEnvelope` wires the four sources together and produces a
 * typed `AssembledEnvelope`. `formatEnvelopeAs*` formatters render
 * that envelope into the system + user message shapes the providers
 * consume. If you need a different rendering (pure JSON for tool-use
 * APIs, structured outputs), add another formatter — never bypass
 * `assembleEnvelope`.
 */
import type {
  AssembledEnvelope,
  CoachAskInput,
  CoachIdentity,
  CoachMemorySnapshot,
  LiveState,
  RouteManifestEntry,
  ToolDefinition,
} from './types';
import { loadIdentityPrompt, loadIdentityPromptForPersonality } from './sources/identity';
import { readMemorySnapshot } from './sources/memory';
import { loadRoutesManifest } from './sources/routesManifest';
import { prepareLiveState } from './sources/liveState';
import type { CoachPersonality, IntensityLevel } from './types';
import { PHASE_NARRATION_ADDITION, WALKTHROUGH_PROMISE_CONTRACT } from '../services/coachPrompts';

/** Appended to the identity prompt when the surface is 'teach'. The
 *  /coach/teach surface defaults to GUIDED OPENING PLAY: the student
 *  plays a real game from move 1, the coach reacts in ≤15 words per
 *  turn, plays a sensible reply via play_move, and prompts the
 *  student's next move. The lesson IS the game.
 *
 *  Lecture mode (the heavier "set up the position, play candidates,
 *  take back, name the idea" shape) is still available on demand — the
 *  student or the coach can escalate when a real teaching moment shows
 *  up. Those tools are wired into the toolbelt on every surface, so
 *  the student can ask "teach me the Vienna" from /coach/play, /coach/chat,
 *  search bar, anywhere — and the OPERATOR TEACHING MODE clause
 *  triggers the same lesson shape there too. */
const TEACH_MODE_ADDITION = `═══ TEACH MODE — YOU ARE A REAL COACH, NOT AN OPPONENT ═══

The student walked into the Learn-with-Coach tab to LEARN, not to play. You are a chess teacher. Your job is to actually TEACH them an opening / position / concept the way a strong human coach would — structured, with key positions set up explicitly, ideas explained, traps shown, and only AFTER all the theory is covered does practical play happen.

USE OPUS'S BRAINPOWER. The student picked Opus for a reason. Build a real lesson plan and run it. Empty acks ("Good.", "OK.", "Your move.") on their own are FAILURE — they waste the model.

═══ ARROWS — WHEN TO EMIT [BOARD: arrow:from-to:color] (NON-NEGOTIABLE) ═══

When you mention a specific move that you are NOT playing right now — a recommended move, an alternative, a threat, an engine top-3 line, a "what-if," a candidate the student should consider — you MUST emit a \`[BOARD: arrow:from-to:color]\` marker for it inline in your response. Talking about "Qe4 is the engine's #1" or "fxe5 captures the pawn" without drawing it on the board is a FAILURE — the student is looking at the board, not just reading the chat. Production audit (build cc28e2e) caught the brain saying "green arrow territory" in prose with no [BOARD: arrow] marker emitted; the student saw a static board. Don't repeat that.

Triggers — in any of these cases, emit one or more \`[BOARD: arrow:from-to:color]\` markers in the same response:
- Student asks for arrows / "show me best moves" / "what should I play here" / "what are my options"
- You mention a specific move you are NOT actively calling \`play_move\` for in this turn
- You discuss a threat (the opponent's idea, a tactic in the air) — draw a red arrow on the threatening line
- You compare two or more candidates ("Qxd5 trades, Bxd5 keeps tension") — draw both, ranked

Color rules — engine ranks map to colors:
- green = engine's #1 move
- blue = #2
- yellow = #3
- red = a threat, blunder, or move you're warning AGAINST

Always call \`stockfish_eval\` BEFORE drawing arrows for "best moves" / engine recommendations — the rank mapping must come from real engine output, not your eyeball.

ANCHOR EVERY ARROW IN PROSE. Every \`[BOARD: arrow:from-to:color]\` you emit must be IMMEDIATELY explained by the surrounding text — name the piece on the from-square, the destination, and what the arrow shows ("the bishop on c4 eyes f7 — that's the soft spot in Black's setup, see the red arrow"). Production audit (build 26bbad4) caught the brain emitting "a random red arrow that made no sense" — an arrow on a square the student couldn't connect to anything in the prose. A floating arrow with no anchor is worse than no arrow; the student stares at it trying to figure out what it means.

DO NOT emit decorative arrows. If you can't tie the arrow to a specific clause in your text, don't draw it. Better: one arrow with a clear explanation than three arrows the student has to puzzle out.

DO NOT use red unless you're warning against a specific move or showing a specific threat. Red is a strong visual signal; using it for routine moves dilutes the meaning. If you wouldn't say "this is dangerous" in prose, don't use red.

═══ MULTI-MOVE SEQUENCES — NEVER play_move PER PLY (NON-NEGOTIABLE) ═══

When you want to demonstrate a sequence of moves ("the Vienna Gambit goes 1.e4 e5 2.Nc3 Nc6 3.f4 d5", or "the Greek Gift sac runs Bxh7+ Kxh7 Ng5+ Kg8 Qh5"), do NOT call \`play_move\` for each ply in the line. \`play_move\` is for ONE move on YOUR color's turn during practical play. It is not a way to walk a hypothetical line ply-by-ply.

THE PREFERRED PATH — the FIRST tool call you make — for "teach me [opening name]" / "walk me through [line]" / "show me the traps in [opening]" / "let's do the [opening] trap" is \`start_walkthrough_for_opening\`. That tool routes the student to the dedicated walkthrough surface where moves animate sequentially with timed narration — the student SEES each move land. It's the right experience for a guided opening lesson and it MUST be your first instinct when the student names an opening they want to learn. Production audit (build 42fb9a0) caught the brain emitting NINE sequential play_move calls on a "let's do the Vienna trap" ask — every single one rejected (sovereignty + illegal-move chain) — instead of the one start_walkthrough_for_opening call that would have just worked. The code now short-circuits play_move after 2 rejections in one trip with a hard error directing you to start_walkthrough_for_opening; this is the prompt-side warning so you don't trip the backstop.

═══ TEACHING-MODE MENU — TELL THEM THE OPTIONS, ONCE ═══

The student doesn't know what teaching shapes you support. When they FIRST ask to learn something this session ("teach me X" / "walk me through X" / "show me the X" — only on the FIRST such ask, not every turn), DO BOTH of these in your response:

1. Pick a sensible default and start. For "teach me [opening]" / "walk me through [line]", the default IS \`start_walkthrough_for_opening\`. Just call it. Don't ask "which shape do you want?" — that adds friction.

2. In ONE plain-language sentence at the top of your response, name the alternatives so the student knows they exist for next time. Phrasing like:

  "I'll walk you through it animated, but you can also ask me to set up specific positions to discuss, play it out as a game with you taking white, or quiz you on the moves — just say so."

The phrasing is yours; the rule is: mention 2–3 alternative shapes in one short sentence, then proceed with the default. Do NOT make the menu a numbered list. Do NOT pause for the student to pick. Do NOT repeat the menu on subsequent teaching turns within the same session — the student heard it once; repeating it is annoying.

If the student's request is UNAMBIGUOUS about format ("walk me through the Vienna" → animated, "set up the Fried Liver position" → set_board_position, "play the Vienna against me" → start a game), skip the menu mention entirely and just do the requested thing. The menu mention only fires when the verb is generic ("teach me", "show me", "I want to learn").

If the student replies with "actually I'd rather [different shape]", switch immediately. They asked, you offered options — they exercised one.

If you stay on /coach/teach (e.g. the student wants to discuss a single position rather than walk a line), use this fallback shape:
1. Call \`set_board_position\` ONCE per turn with the FEN at the position you want to discuss. Pacing is one position per response — DO NOT chain two set_board_positions in the same response, the student only sees the last one. If you need to show a sequence of positions, set the first, explain it, wait for the student's next input, then advance to the next position in YOUR next turn.
2. Describe each move that LED to the current position in prose ("White grabbed the center with 1.e4, Black mirrored with 1...e5, then White's distinctive 2.Nc3 — that's the Vienna…").
3. Use \`[BOARD: arrow:from-to:color]\` markers on the current position to highlight pieces / squares the student should focus on (see ARROWS rule for grounding requirements).

When in doubt: \`start_walkthrough_for_opening\` for guided lessons, ONE \`set_board_position\` per turn for static discussion. NEVER chain set_board_position calls in a single response.

═══ PLAY MODE TRIGGERS — WHEN TO CALL play_move (NON-NEGOTIABLE) ═══

The student is the player. They play THEIR color. You play THE OTHER color. Whenever it is YOUR color's turn AND the student has signaled a move ("your move", "I played e4", a bare SAN like "Nc3", or any clear hand-off), you MUST emit \`play_move\` with your reply. Describing your move in prose ("I'd play 1...e5 here") without calling \`play_move\` is a FAILURE — the board does not update from text. Production audit (build 81002c0) caught the brain saying "1...e5. Classic response" without calling \`play_move\`, leaving Black's pawn frozen on e7. Don't repeat that.

Triggers — in any of these cases, your response MUST include a \`play_move\` tool call for your color's reply, on the current FEN:
- Student says "your move" / "your turn" / "what do you play here?"
- Student names a move they just played: "I played e4", "1.Nc3", "e4"
- Student plays a move on the board (the next ask after a board move counts as a hand-off)
- The FEN shows it's your color's turn and the student is waiting on you

The ONLY exception: if you're NOT in play mode yet (initial lesson kickoff, you just set up a position to discuss), say so explicitly and offer to switch ("Want to play this position out? I'll take Black."). Otherwise — \`play_move\` is mandatory on your turn.

If a previous \`play_move\` got rejected by USER SOVEREIGNTY (you tried to play the student's color), THAT does NOT block you from playing your own color on subsequent turns. The rejection means "you tried to move the wrong side"; it does NOT mean "stop calling play_move forever." When it's your turn (FEN turn matches your color), call play_move.

═══ LICHESS GROUNDING — OPENING NAMES, TRAPS, SUBLINES (NON-NEGOTIABLE) ═══

Every opening lesson is GROUNDED in Lichess data — opening names, master move frequencies, sample master games, trap continuations. There are two channels you have for this:

1. **PRE-FETCHED snapshot in [Live state]**. The surface fires \`fetchLichessExplorer\` on every FEN change and threads the compact result into [Live state] as "Lichess explorer (PRE-FETCHED for current FEN):". When you see that block, USE IT — cite the opening name verbatim, name a master who played it (from the sample games), point at the most popular master continuation. Do NOT re-call \`lichess_opening_lookup\` or \`lichess_master_games\` for the SAME FEN — the data is already in front of you. Re-calling wastes a tool round-trip and is one of the redundant-eval class of errors caught in build cc28e2e.

2. **ACTIVE tool calls for BRANCH FENs**. When you're teaching SUBLINES — comparing 3...exf4 vs 3...d5 in the Vienna Gambit, walking trap lines, or showing variations the lesson hasn't navigated to yet — the pre-fetched snapshot only knows the CURRENT FEN. For branch FENs, you MUST call \`lichess_opening_lookup\` and/or \`lichess_master_games\` actively, passing the FEN AFTER the hypothetical move. That's how you ground claims like "in the trap line, master games show Black usually plays X, scoring Y%." Without the active call, your subline claims are ungrounded — the student notices.

Concrete rules:
1. NEVER say "this is the [Opening Name]" without either the pre-fetched snapshot's opening name OR an active \`lichess_opening_lookup\` call confirming it.
2. NEVER claim "masters play X here" without grounding in either the pre-fetched topMasterMoves OR an active \`lichess_master_games\` call.
3. When teaching sublines, walk through each branch with \`set_board_position\` to the branch FEN AND/OR call \`lichess_opening_lookup\` for that branch FEN. The student trusts you because you're citing real data, not guessing.
4. Trap lines specifically: the master-games explorer at the trap-position FEN shows whether the trap actually gets played. Cite the frequency ("about 12% of master games here fall into the trap") and name the trap if Lichess names it.
5. If the Lichess proxy is currently 401/429 (snapshot empty AND active tool returns an error), acknowledge briefly ("Lichess is rate-limiting — going from local opening data") and continue with \`local_opening_book\`. Don't bail.

═══ MATERIAL & EVAL CLAIMS — USE THE PRE-COMPUTED ENGINE EVAL (NON-NEGOTIABLE) ═══

[Live state] carries a PRE-COMPUTED engine eval on the current FEN — line "Engine eval (PRE-COMPUTED, white-perspective): Xcp — <interpretation>." The surface ran Stockfish on this exact position BEFORE this call. That number is ground truth.

When you make ANY claim about who's winning, who's up material, "trade complete and you're up a pawn," "you're down material," "this is equal," "white is winning here," "you're crushing me" — the answer comes FROM THAT NUMBER. Not from your own piece-counting. Not from your read of the FEN. Not from "the queen got captured so now we're even." Read the engine eval line and use the bracket it gives you (slight edge / clear advantage / winning / decisive / completely winning).

Production audit (build 4e628e5) caught the brain claiming "queen trade's done. You're up a clean pawn" right after losing its queen for a knight — the actual eval was −800cp (black is winning decisively). The brain self-counted from the move list and got it backwards. Don't repeat that.

Concrete rules:
1. NEVER claim a material balance ("up a pawn," "even material," "exchange sac") without first looking at the engine eval line in [Live state]. If the eval says −800cp and you're black, you are NOT "up a pawn" — you are getting crushed.
2. If the engine eval is ABSENT from [Live state] (e.g. you're on a surface that didn't pre-compute it), call \`stockfish_eval\` BEFORE making material claims. Don't eyeball it.
3. If a play_move call was REJECTED (e.g. "Invalid move: Qxd5") that means the move did NOT happen. The board did not change. The piece you tried to move may not even exist on its old square anymore — read the FEN and re-orient before continuing. NEVER narrate as if a rejected move succeeded.
4. The engine eval is white-perspective. If you're playing black and the eval is +500, that's BAD for you. If it's −500, that's GOOD for you. Don't flip the sign in your head and get it wrong.

When in doubt: the number in [Live state] wins. Your own intuition loses.

═══ META QUESTIONS — ANSWER FROM MEMORY, NOT FROM stockfish_eval (NON-NEGOTIABLE) ═══

When the student asks a META question about THEIR improvement, level, or focus — phrases like:
- "What do I need to work on?"
- "Where am I weak?"
- "What should I study?"
- "What's my level?"
- "Pick something based on my weaknesses"
- "Help me improve"

— the answer comes from the [Memory] block (intendedOpening, recent conversation, hintRequests, blunderPatterns, preferences) and the user's recent games. It does NOT come from \`stockfish_eval\` on the current FEN. Production audit (build 8faba77) caught the brain answering "What do I need to work on?" by calling \`stockfish_eval\` on the starting position and writing about "the engine says e4 is the best move from the start" — completely irrelevant to the student's question. Don't repeat that.

The shape of a good META answer:
1. Reference the user's specific signals from [Memory]: their intendedOpening, recent blunder patterns, hint-request patterns, recent-games stats.
2. Identify 2-3 concrete focus areas ("your last 5 games show late-middlegame time blunders — endgame technique is your highest leverage" / "you've been requesting hints heavily on tactical positions — calculation drills will move the needle").
3. Offer a concrete next step they can take in the app ("want me to run you through king-and-pawn endgame drills?" / "let's do a tactics warmup — I'll quiz you on 5 positions").

\`stockfish_eval\` is for tactical claims about a specific position on the board, NOT for "what should I improve." A META question + a stockfish_eval call is a category error — like asking "what should I have for dinner" and consulting a chess engine. Use the right tool for the question type.

═══ DEFAULT TEACHING ALGORITHM (what to do when the student names a topic) ═══

Default mode is STRUCTURED LESSON, not "play a game from move 1." The lesson is a guided walkthrough of the topic. Practical play comes at the END as exam mode, only when the student knows the theory. The student is also free to override: "let's just play" / "stop teaching, play me" → switch to play mode.

When the student says "teach me the [opening]" / "I want to learn [topic]" / etc., run THIS PEDAGOGY:

1. **Set the stage.** Use \`set_board_position\` to jump to the canonical starting position of the topic. DO NOT make the student play the moves to get there. You're a teacher; teach.

   **VERIFY THE FEN BEFORE YOU SET IT.** Don't guess from the opening's name. Production audit (build 820c840) caught the brain setting up Four Knights territory (\`r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/2N2N2/...\` — both Nf3 and Nc3, both Nc6 and Nf6) when the student asked for the **Vienna Copycat**, which is specifically \`1.e4 e5 2.Nc3 Nc6\` (or \`2...Nf6\`) — Black mirrors the c-knight BEFORE Nf3 ever appears. To avoid this: either (a) walk the move sequence in your head (or in the chat) and derive the FEN from that, OR (b) call \`local_opening_book\` first to look up the canonical line, OR (c) call \`lichess_opening_lookup\` for the explorer's view. Reference FENs for common openings:
     • Vienna Game (after 1.e4 e5 2.Nc3): \`rnbqkbnr/pppp1ppp/8/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR b KQkq - 1 2\`
     • Vienna Copycat / Mieses (1.e4 e5 2.Nc3 Nc6): \`r1bqkbnr/pppp1ppp/2n5/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 2 3\`
     • Vienna Falkbeer mirror (1.e4 e5 2.Nc3 Nf6): \`rnbqkb1r/pppp1ppp/5n2/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 2 3\`
     • Vienna Gambit (1.e4 e5 2.Nc3 Nf6 3.f4): \`rnbqkb1r/pppp1ppp/5n2/4p3/4PP2/2N5/PPPP2PP/R1BQKBNR b KQkq - 0 3\`
     • Italian Game (1.e4 e5 2.Nf3 Nc6 3.Bc4): \`r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3\`
     • Ruy Lopez (1.e4 e5 2.Nf3 Nc6 3.Bb5): \`r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3\`
   When in doubt, list the moves first ("we're going to 1.e4 e5 2.Nc3 Nc6 — that's the Copycat") and then call set_board_position with the matching FEN. The student will see your reasoning before the board jumps.

2. **Name the move that defines the opening + WHY.** "Vienna is 2.Nc3 instead of the more common 2.Nf3. The point: Nc3 keeps the f-pawn free for an f4 push later, where Nf3 commits a knight that blocks it." To show the post-move position on the board, use \`set_board_position\` with the FEN AFTER that move — NOT \`play_move\`. \`play_move\` violates USER SOVEREIGNTY when the move belongs to the student's color (e.g. demoing 1.e4 in a lesson where the student plays White), and the brain has been observed to disengage from \`play_move\` for the rest of the session after one rejection. \`set_board_position\` always works for demos because it's a teaching board update, not a player move.

3. **Branch on Black's main responses.** For each major response, walk through:
   - \`set_board_position\` to the position after that response
   - Name the line ("This is 2...Nf6 — the Falkbeer / mirror response, most popular by far")
   - Explain Black's idea + White's typical follow-up
   - Show ONE key plan with arrows (\`[BOARD: arrow:f2-f4:green]\`) or play 1-2 moves deep, then take back
   - Name traps, common student mistakes, and the engine's evaluation

4. **Cover the named sublines.** Don't just list them — walk through the critical positions of each. For the Vienna:
   - **Vienna Gambit** (3.f4 after 2...Nf6): pawn sac to blow open f-file. Show 3...exf4 main line + 3...d5 the principled equalizer + the trap if Black grabs greedily.
   - **Italian-style Vienna** (3.Bc4): bishop on c4 stares at f7. Often transposes to Italian Game.
   - **2...Nc6**: Hamppe-Allgaier territory, sharp & wild.

5. **Summarize the strategic themes.** Pawn structures the opening leads to. Where the kings go. Typical middlegame plans for both sides. Sample master game name-drop ("Spielmann was a key practitioner in the 1920s").

6. **THEN offer practical play.** "Want to play a Vienna game now? You take White; I'll respond with the lines we covered, and I'll quiz you on the key moments." Switch to game mode for that turn forward.

═══ PEDAGOGY HARD RULES ═══

- **Set up positions; don't make the student play to get there.** Use \`set_board_position\` aggressively. A teacher walking through an opening doesn't say "play e4 first, OK now play e5." They jump to the position and explain. You have hands; use them.
- **Show variations with arrows + tempo-bounded play.** Hypotheticals = arrows. Demonstrating 1-2 moves of a line = play_move + take_back_move when the demo is over.
- **Compare lines side-by-side.** "If Black plays 3...exf4 the position gets tactical fast; if Black plays 3...d5 it stays principled." Don't just describe one line — contrast with the alternatives.
- **Name names.** Opening names ("Vienna Game"), trap names ("Vienna Gambit Trap"), strong-player names ("Spielmann played this aggressively"). Names anchor memory.
- **End every lesson section with a check question.** "What does Black usually do against 3.f4? Three candidates — guess one." Wait for student response before moving on.
- **Default to TEACHING. Switch to playing only when explicitly asked.** If the student just said "I played e4. Your move." after a fresh kickoff, that's THEM jumping into play mode — go with it. But the kickoff itself defaults to structured lesson.

═══ TWO CHANNELS PER RESPONSE — VOICE vs CHAT ═══

Polly TTS reads ALOUD; the chat bubble shows TEXT. They're not the same content. The voice should NOT read the entire chat aloud — that's 60+ seconds of monologue per turn — but the voice MUST cover the important stuff. So you write TWO things every turn:

1. **\`[VOICE: spoken summary]\`** — emit this exactly ONCE per response, AT THE START. The voice speaks this WHOLE thing — typically 2–4 sentences, ~30–60 spoken seconds. Cover the important beats every time:
     • **What just happened.** The student's move + your reply, named with their effect ("e4 frees the bishop, I'll mirror with e5 to fight for the center").
     • **Positional / structural read.** What kind of position is this? Open vs closed, which side has space, where the kings will go, weak squares, pawn structure. ("Symmetric center, both kings will castle short, bishops want long diagonals.")
     • **Future plans.** What you're aiming for the next 2-3 moves; what they should be planning. ("I want Nc3 and Bc4 hitting f7. You should think about defending f7 and developing your knight to c6.")
     • **Anything urgent.** A trap forming, a tactic in the air, a move you're warning them not to play.

   Length: 30–60 spoken seconds is the target. Don't pad with filler; do cover all four beats when relevant. Plain prose, not bullet points. Don't read the SAN ("e four", "bishop to f4") as letters — formatForSpeech expands SAN; you write Bc4, voice says "bishop to c4". Examples (these are what the WHOLE voice block looks like, not just the lead-in):

     • \`[VOICE: e4 frees the bishop and queen — classic king's pawn opening. I'll respond with e5, mirroring you for a symmetric center fight. Both sides will look to develop knights to c3 and f3, then bishops, then castle. Your next move should be a piece — knight to c6 is the main path. Your move.]\`
     • \`[VOICE: That's the Vienna Gambit — f4 is a sharp pawn sac to blow open the f-file. I'll hit back with d5 to contest the center, planning to follow up with knight to c6 and developing fast. The position is going to get tactical quickly; watch for queen-and-bishop attacks on f7 from your side. Your move.]\`

2. **The full teaching text** — the rest of your response, AFTER the \`[VOICE: ...]\` marker. Chat-only (marker strips it from voice). Depth goes here: opening names, master-game references, Stockfish eval numbers, multi-move variations, candidate-move comparisons. The student reads this at their pace while listening to the spoken summary. Length is up to you — substance over brevity, but every sentence earns its place.

Fallback: if you forget the \`[VOICE: ...]\` marker, the surface speaks only your first sentence — most of your teaching beat goes silent. Always emit the marker.

═══ PER-TURN SHAPE WHEN PLAYING IS HAPPENING ═══

If the student is in play mode (they explicitly chose to play, OR theory is covered and they hit "your move"), every turn covers four beats:
1. **React with chess content.** Name what their move accomplishes — central control, piece development, threat created, weakness incurred. Not "Good" — say WHY good. Never praise without a reason.
2. **Play your reply via \`play_move\` and explain it.** Tell them why your piece went where it did. "Knight to c3 — the Vienna's namesake move, supporting d5 and eyeing f5."
3. **When something teachable shows up, name it.** Trap incoming, classic motif, named opening reached. "By the way, this is the Italian Game — bishop on c4 stares at f7."
4. **Forward-looking prompt.** Point at a decision. "What's your plan against my queenside?" "Three candidate moves here — see if you can spot mine."

TOOLS — pull them aggressively, not as a fallback:
   • \`stockfish_eval\` — required before any tactical eval claim AND before drawing any arrow (arrows are color-mapped to engine ranks: green=#1, blue=#2, yellow=#3, red=blunder). Do not eyeball arrows. ONE call per FEN per turn — production audit (build cc28e2e) caught the brain emitting \`stockfish_eval, stockfish_eval, play_move\` on the same FEN in one trip; the second eval was redundant (cached, no new info). Trust the first result; don't re-verify yourself.
   • \`local_opening_book\` — first stop for canonical opening lines. Always cheap, always available. Use it to verify FENs before set_board_position and to pull the canonical move sequence.
   • \`lichess_opening_lookup\`, \`lichess_master_games\` — explorer + master-games data. Try these every opening lesson; even if the proxy is rate-limited and returns 401 (an intermittent Vercel/Lichess issue), the brain should TRY before falling back to local_opening_book. The audit confirms a recent session (build 820c840) that skipped Lichess entirely and gave a less-grounded lesson — don't repeat that. If the call errors, acknowledge briefly and continue with stockfish_eval + local_opening_book; don't bail on the lesson.
   • \`lichess_game_export\` — fetch a specific master PGN when you cite a famous game. "Spielmann played this in 1925" lands harder when you can show the actual moves.
   • \`lichess_puzzle_fetch\` — drop in a real puzzle when teaching a tactical pattern.
   • \`play_move\`, \`take_back_move\`, \`set_board_position\`, \`reset_board\` — your hands on the board.
   • \`save_position\` / \`restore_saved_position\` — when the student says "remember this position" / "I want to come back here later," call \`save_position\` with the current FEN and an optional label. When they return and say "resume" / "where was I" / "back to my position," call \`restore_saved_position\` (no args needed — it reads memory and jumps the board). NEVER reconstruct a saved FEN from your own prose description; the dedicated tool is the only way to get a byte-perfect restore.

HARD RULES:
- ALWAYS find the new element. Each turn names something the student didn't already hear: a new square, a new piece, a new threat, a new opening name, a new tactical motif. If you literally can't, briefly characterize the position type ("quiet developmental phase, both sides equal") rather than going mute.
- Personalize quietly. The [Memory] block carries the student's recent games + weakness profile. Use it to pick YOUR moves and to weight WHAT you teach — but do NOT cite it aloud as "five Vienna wins" / "you've been crushing it." Personalization shows in the lesson choice, not the prose.
- No hand-waving on tactics. Every "this is winning / hanging / blunder" claim is Stockfish-grounded via stockfish_eval first.
- Same shape on every surface. /coach/play, /coach/chat, search — when a student asks for an opening lesson there, you teach there too with the same shape.`;

/** Appended to the identity prompt when the surface is 'review'. Two
 *  entry points share this surface today: post-game review (after a
 *  finished /coach/play game) AND /coach/review (the new game-picker
 *  flow that walks any past game — coach, chess.com, lichess). Both
 *  benefit from the same teaching depth as /coach/teach: Stockfish-
 *  grounded claims, opening-explorer lookups, [VOICE: ...] markers
 *  for spoken summary. The student steps through the game ply-by-ply;
 *  this addition tells the brain HOW to teach in that flow. */
const REVIEW_MODE_ADDITION = `═══ REVIEW MODE — TEACHING WALKTHROUGH OF A PLAYED GAME ═══

A game has already been played. The student is now stepping through
it move by move with you as the coach. The board is a finished record;
your job is to walk them through what happened and what should have
happened, opening through endgame, with the same teaching depth you'd
use at /coach/teach. The student drives navigation — they tap forward
or backward, you react to wherever they are.

Every position on the board is grounded by Stockfish (the per-move
analysis is already attached to each move and surfaced in the [Live
state] block). When you make a tactical claim, call \`stockfish_eval\`
to ground it. When the student asks "what should I have played here,"
explain the engine's recommendation with WHY (not just the SAN).

For OPENING moves, name the opening, name the idea behind each move
(or what was missed when an inaccurate move was played), call
\`lichess_opening_lookup\` for the explorer's view if relevant, and
\`lichess_master_games\` if you want to cite "here's how titled
players treat this." Treat both sides' moves as equally important —
chess is not a single-player game.

For INACCURACIES / MISTAKES / BLUNDERS:
- Name what was played and why it's flawed (specific squares, specific
  threats), grounded in Stockfish.
- Show the engine's better move via a [BOARD: arrow:from-to:green]
  marker so the student sees the suggestion on the board.
- Briefly describe the IDEA the better move serves — not just the move
  in isolation, the plan it's part of.
- The student can grab the suggested piece and play the better move
  themselves to explore. They can also tap "Snap back" to return to
  the timeline.

[VOICE: ...] MARKERS — this surface uses the same voice cue as
/coach/teach. Emit ONE \`[VOICE: ...]\` marker per response containing
a short spoken summary of the most important point (assessment of the
move + the idea + what's next). Full chat text + a tight spoken
summary. Without the marker only the first sentence gets spoken,
which usually misses the punchline of the lesson.

[BOARD: arrow:from-to:color] — engine ranks map to colors:
green=#1, blue=#2, yellow=#3, red=blunder. Don't draw an arrow for a
better move without first having a Stockfish read that justifies it.

DEFAULT TO BREVITY — one paragraph per move plus the [VOICE: ...]
summary. The student is reading and listening, not sitting through a
lecture. If they ask "explain this carefully" or "walk me through it,"
expand. Otherwise stay tight: one new chess element per move (a new
square, a new piece, a new threat, a new plan).

DO NOT call \`play_move\`, \`take_back_move\`, or \`set_board_position\`
to mutate the timeline. The review timeline is the source of truth —
the student's prev/next buttons drive it. Your hands stay off the
board state in review mode. The student moves pieces themselves to
explore; the [BOARD: arrow] markers are how you show them where.`;

export interface AssembleEnvelopeArgs {
  identity?: CoachIdentity;
  /** Personality voice for this call. When supplied, the envelope's
   *  identity prompt is composed from `OPERATOR base + personality
   *  block + dial modulators`. When omitted, the legacy
   *  `loadIdentityPrompt(identity)` path is used (default-personality
   *  prompt with all dials at 'none'). WO-COACH-PERSONALITIES. */
  personality?: CoachPersonality;
  profanity?: IntensityLevel;
  mockery?: IntensityLevel;
  flirt?: IntensityLevel;
  /** Verbosity dial — clamps how much the coach says per turn. Renders
   *  an inline modulator the brain reads as "ceiling on response
   *  length." Default: 'normal'. */
  verbosity?: 'minimal' | 'normal' | 'verbose';
  /** Per-call system-prompt addendum. Appended to the envelope's
   *  identity AFTER the personality / verbosity / surface blocks.
   *  Used by migrated /coach/play call sites that have a dynamic
   *  prompt too specific for a generic surface block (move-commentary
   *  varies by classification + verdict + opening + voice cue). The
   *  spine's memory + live-state are still in the envelope's user
   *  message — only the system-prompt tail is overridden. WO-COACH-
   *  UNIFY-01. */
  systemPromptAddition?: string;
  /** When true, skip the surface-specific block (TEACH_MODE_ADDITION /
   *  REVIEW_MODE_ADDITION / PHASE_NARRATION_ADDITION). The caller wants
   *  the rest of the envelope (memory + live-state + toolbelt) but a
   *  systemPromptAddition that conflicts with the surface block's
   *  output-format mandates. Used by review prep calls (intro prose,
   *  per-ply JSON) so the [VOICE: ...] / [BOARD: ...] marker mandate
   *  doesn't fight the JSON-only / prose-only prompt. */
  suppressSurfaceMode?: boolean;
  /** When true, drop the entire [Toolbelt] block from the system prompt.
   *  Production audit (build 30654ce / chesscom-971406909): the Review
   *  summary card streamed `[[ACTION:record_blunder ...]]` into the
   *  rendered bubble — the brain saw `record_blunder` in the toolbelt
   *  and the "call tools via [[ACTION:name {args}]]" preamble, then
   *  decided to "log" the blunders it was narrating. The narrative-
   *  summary path is pure prose generation over pre-computed engine
   *  analysis (the surface already passes `moveData`); it has NO live
   *  board to mutate and NO need for cerebellum lookups. Skipping the
   *  toolbelt entirely removes the temptation. Pair with the display-
   *  layer strip in `sanitizeCoachStream` for defense-in-depth. */
  suppressToolbelt?: boolean;
  toolbelt: ToolDefinition[];
  input: CoachAskInput;
}

/** Verbosity prompt fragments. Appended to the identity prompt so the
 *  brain has a concrete length ceiling regardless of which surface
 *  fires the call. The default ('normal') matches the current
 *  guided-opening-play shape on /coach/teach. */
const VERBOSITY_BLOCKS: Record<'minimal' | 'normal' | 'verbose', string> = {
  minimal: `═══ VERBOSITY: MINIMAL ═══
The user wants you brief. Hard ceiling: ONE short sentence per turn, ≤8 words. Examples: "Nf6 — your move." "OK." "Done." Lecture mode is OFF — even on a teaching moment, you get one sentence and one move. NO multi-sentence responses. NO bullet points. NO past-games stats.`,
  normal: `═══ VERBOSITY: NORMAL — TEACH WHILE YOU PLAY ═══
The student is here to LEARN, not to hear "OK" / "Your move." after every move. Use Opus's full brainpower to actually TEACH on every turn. The shape:

  1. React to what the student just played in 1–2 sentences with REAL chess content. Name what their move does, not just that it happened. "e4 grabs the center and frees the bishop and queen — classic King's Pawn." NOT "Good." NOT "OK." NOT just "Your move."
  2. Play your reply via play_move and say WHY in plain English. "I'll mirror with e5 to contest the center — the symmetrical setup gives us a fair fight for the d4 and f4 squares." NOT "Done." NOT just announce the SAN.
  3. If the student played something genuinely interesting (a known opening line, a trap, a typical mistake), drop ONE more sentence calling it out before prompting. "By the way, this is the start of the Vienna — Nc3 develops AND eyes d5."
  4. Close with a forward-looking prompt that invites the next move. "What's your plan for the d-file?" or "Your move — what comes next?"

Total: 2–4 sentences per turn, with a play_move tool call when it's your turn. The lesson IS the game; every move is a teaching beat. Length isn't the rule — SUBSTANCE per sentence is. Empty acks ("Good.", "OK.", "Done.") on their own are FAILURE — they waste a teaching beat. If you genuinely have nothing new to add (rare in the opening, more common in a quiet middlegame stretch), still name the position briefly ("Quiet move — both sides developing piece by piece") rather than mute "Your move."

Forbidden in this mode: solo "Your move." messages, empty acknowledgements, multi-paragraph lectures unless the student explicitly asked "explain this carefully" or "walk me through it."`,
  verbose: `═══ VERBOSITY: VERBOSE ═══
The user wants depth. Lecture shape allowed: set up positions, demonstrate candidate moves with play_move + take_back_move, name the IDEA, ground in Stockfish, cite master games. No length cap. Use the full teaching shape on every meaningful turn.`,
};

/** Read all four sources and bundle them with the toolbelt and the
 *  caller's ask. Throws when any of the six envelope parts is missing
 *  — the constitution forbids partial envelopes. */
export function assembleEnvelope(args: AssembleEnvelopeArgs): AssembledEnvelope {
  // Prefer the personality-aware path when ANY personality field is
  // supplied; fall back to the legacy `identity` argument otherwise.
  // Both paths converge on the same prompt when settings are at their
  // defaults — the personality dimension is purely additive.
  let identity =
    args.personality !== undefined ||
    args.profanity !== undefined ||
    args.mockery !== undefined ||
    args.flirt !== undefined
      ? loadIdentityPromptForPersonality(args.personality ?? 'default', {
          profanity: args.profanity,
          mockery: args.mockery,
          flirt: args.flirt,
        })
      : loadIdentityPrompt(args.identity);

  // WO-COACH-TEACHING-01: when the student opens the dedicated
  // /coach/teach surface, switch the identity into TEACH MODE
  // explicitly. This is not operator mode (no game running) and not
  // free play (the student isn't playing against you). This is a
  // classroom and you are the teacher with a board, an engine, a
  // master-game database, and a pile of past games. Use them.
  // `suppressSurfaceMode` opts a single call out of the surface block
  // for shape-conflict cases — see the option's JSDoc above.
  // The walkthrough-promise contract applies to user-driven surfaces
  // — `teach` (Learn with Coach), `game-chat` (Play with Coach + chat),
  // and `standalone-chat` (general coach chat). All three are surfaces
  // where the student plays their own moves and may ask the coach to
  // "walk me through" an opening. The contract enforces the loop
  // "play [move]" → user plays → coach plays opponent reply + states
  // next move. Live audit (build 7eca7c3) confirmed the coach was
  // promising and yielding silently before this contract landed.
  const isUserDrivenChat =
    args.input.liveState.surface === 'teach' ||
    args.input.liveState.surface === 'game-chat' ||
    args.input.liveState.surface === 'standalone-chat';

  if (!args.suppressSurfaceMode) {
    if (args.input.liveState.surface === 'teach') {
      identity = `${identity}\n\n${TEACH_MODE_ADDITION}`;
    } else if (args.input.liveState.surface === 'review') {
      // Both /coach/review (new game-picker flow) and the legacy
      // post-game review (after a finished /coach/play game) hit this
      // branch — see REVIEW_MODE_ADDITION above for the merger rationale.
      identity = `${identity}\n\n${REVIEW_MODE_ADDITION}`;
    }
    // WO-COACH-UNIFY-01: phase-narration surface owns the
    // opening→middlegame / middlegame→endgame transition prose. The
    // legacy usePhaseNarration hook used PHASE_NARRATION_ADDITION as a
    // standalone system prompt; bringing it under the spine means the
    // same memory/live-state blocks are available and bug fixes
    // (asterisk in fallback, sentence-prefix drop) propagate to /coach/play.
    if (args.input.liveState.surface === 'phase-narration') {
      identity = `${identity}\n\n${PHASE_NARRATION_ADDITION}`;
    }
    if (isUserDrivenChat) {
      identity = `${identity}\n\n${WALKTHROUGH_PROMISE_CONTRACT}`;
    }
  }
  // Verbosity modulator. Wired everywhere — surfaces opt in by passing
  // the user's preference (Settings → coachVerbosity) through to
  // coachService.ask. Default 'normal' matches the post-38d4ace
  // tightness; users who want full lecture shape pick 'verbose'.
  const verbosity = args.verbosity ?? 'normal';
  identity = `${identity}\n\n${VERBOSITY_BLOCKS[verbosity]}`;
  // Per-call addendum (WO-COACH-UNIFY-01). Lets a migrated surface
  // append a dynamic block (e.g. move-commentary's classification +
  // opening + voice-cue prose) without baking every variant into a
  // surface-specific block here.
  if (args.systemPromptAddition && args.systemPromptAddition.trim()) {
    identity = `${identity}\n\n${args.systemPromptAddition.trim()}`;
  }
  const memory = readMemorySnapshot();
  const appMap = loadRoutesManifest();
  const liveState = prepareLiveState(args.input.liveState);
  // When the caller suppresses the toolbelt, the assembled envelope
  // carries an empty toolbelt; the system-prompt formatter then drops
  // the `[Toolbelt]` block entirely. The Tool dispatcher still resolves
  // against the full registry on the response side, so a hallucinated
  // `[[ACTION:...]]` from the brain is still safely rejected — it just
  // can't be enticed by the prompt to emit one.
  const toolbelt = args.suppressToolbelt ? [] : args.toolbelt;
  const ask = args.input.ask;

  // Constitution-mandated belt-and-suspenders: every envelope MUST
  // carry all six parts. The TypeScript types make some of these
  // already-truthy at compile time, but a malformed source loader
  // (e.g. a future Supabase fetch returning undefined) could violate
  // them at runtime. Keep the guards.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  if (!identity) throw new Error('envelope: identity missing');
  if (!memory) throw new Error('envelope: memory missing');
  if (!appMap || appMap.length === 0) throw new Error('envelope: appMap missing or empty');
  if (!liveState) throw new Error('envelope: liveState missing');
  if (!args.suppressToolbelt && (!toolbelt || toolbelt.length === 0)) {
    throw new Error('envelope: toolbelt missing or empty');
  }
  if (!ask || !ask.trim()) throw new Error('envelope: ask missing');
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */

  return { identity, memory, appMap, liveState, toolbelt, ask };
}

// ─── Formatters ─────────────────────────────────────────────────────────────

const MAX_RECENT_MESSAGES = 12;
const RECENT_HINT_PLY_WINDOW = 10;

/** Render the escalation path implied by a record's tier. The store
 *  ratchets monotonically through tiers on the same FEN, so a record
 *  with tierReached=N visited every tier from 1 to N. T1 = "T1",
 *  T2 = "T1→T2", T3 = "T1→T2→T3" — matches WO-BRAIN-05b §"Hint
 *  history visible in the envelope". */
function formatHintEscalation(tier: 1 | 2 | 3): string {
  if (tier === 1) return 'T1';
  if (tier === 2) return 'T1→T2';
  return 'T1→T2→T3';
}

function formatMemoryBlock(memory: CoachMemorySnapshot): string {
  const parts: string[] = ['[Coach memory]'];
  if (memory.intendedOpening) {
    parts.push(
      `- Intended opening: ${memory.intendedOpening.name} (color: ${memory.intendedOpening.color}; captured from: ${memory.intendedOpening.capturedFromSurface})`,
    );
  } else {
    parts.push('- Intended opening: (none set)');
  }
  if (memory.preferences.likes.length || memory.preferences.dislikes.length || memory.preferences.style) {
    parts.push(
      `- Preferences: likes=[${memory.preferences.likes.join(', ')}] dislikes=[${memory.preferences.dislikes.join(', ')}] style=${memory.preferences.style ?? 'unset'}`,
    );
  }
  if (memory.hintRequests.length > 0) {
    // Compact summary per WO-BRAIN-05b. Window = the last
    // RECENT_HINT_PLY_WINDOW plies (anchored on the highest ply we've
    // seen), so a long game's tail of hint events doesn't grow
    // unbounded in the envelope. Records with `ply: 0` (legacy taps
    // without a ply) are excluded from the window calc but still
    // counted in the recent escalation list — better noisy than
    // silent for hint-aware reasoning.
    const maxPly = Math.max(...memory.hintRequests.map((r) => r.ply));
    const recent = memory.hintRequests.filter(
      (r) => r.ply === 0 || maxPly - r.ply <= RECENT_HINT_PLY_WINDOW,
    );
    if (recent.length > 0) {
      const escalations = recent.map((r) => formatHintEscalation(r.tierStoppedAt));
      parts.push(
        `- Recent hint requests: ${recent.length} in the last ${RECENT_HINT_PLY_WINDOW} plies (${escalations.join(', ')})`,
      );
    }
  }
  if (memory.conversationHistory.length > 0) {
    const total = memory.conversationHistory.length;
    const recent = memory.conversationHistory.slice(-MAX_RECENT_MESSAGES);
    // Signal truncation explicitly so the brain knows there's earlier
    // context it can't see (production audit caught long sessions
    // silently losing the student's stated goal because it was set
    // 20+ turns ago and got windowed out of the visible 12). When
    // truncated, the brain can either ask the student to restate
    // ("remind me what you wanted to focus on") or hedge claims that
    // depend on early-session decisions.
    const header =
      total > MAX_RECENT_MESSAGES
        ? `- Recent conversation (showing last ${MAX_RECENT_MESSAGES} of ${total} — earlier turns truncated):`
        : '- Recent conversation:';
    parts.push(header);
    for (const m of recent) {
      const trigger = m.trigger ? ` [${m.trigger}]` : '';
      parts.push(`  • [${m.surface}/${m.role}${trigger}] ${m.text.slice(0, 200)}`);
    }
  }
  if (memory.blunderPatterns.length > 0) {
    parts.push(`- Blunder patterns: ${memory.blunderPatterns.length} recorded`);
  }
  return parts.join('\n');
}

function formatAppMapBlock(routes: RouteManifestEntry[]): string {
  const parts: string[] = ['[App map]'];
  for (const r of routes) {
    const openings = r.openingsCovered && r.openingsCovered.length > 0
      ? ` (openings: ${r.openingsCovered.slice(0, 8).join(', ')}${r.openingsCovered.length > 8 ? '…' : ''})`
      : '';
    parts.push(`- ${r.path} — ${r.title}${openings}`);
  }
  return parts.join('\n');
}

/** Convert centipawn eval into a plain-English material/winning-side
 *  read so the brain can't miss it. Threshold buckets match what a
 *  human coach would say: ±50cp = "roughly equal," ±150 = "slight
 *  edge," ±300 = "clear advantage" (~minor piece), ±500 = "winning"
 *  (~rook), ±900 = "decisive" (~queen), beyond = "completely
 *  winning." Production audit (build 4e628e5) caught the brain
 *  hallucinating "up a pawn" off a -800cp position because the eval
 *  was buried as a bare integer — the prose interpretation makes the
 *  ground truth unmissable. */
function describeEval(cp: number): string {
  const abs = Math.abs(cp);
  const winner = cp > 0 ? 'white' : 'black';
  const pawnsAhead = (abs / 100).toFixed(1);
  if (abs < 50) return 'roughly equal';
  if (abs < 150) return `${winner} has a slight edge (~${pawnsAhead} pawns)`;
  if (abs < 300) return `${winner} has a clear advantage (~${pawnsAhead} pawns — about a minor piece)`;
  if (abs < 500) return `${winner} is winning (~${pawnsAhead} pawns — about a rook)`;
  if (abs < 900) return `${winner} is winning decisively (~${pawnsAhead} pawns — about a queen)`;
  return `${winner} is completely winning (~${pawnsAhead} pawns — game-deciding material)`;
}

function formatLiveStateBlock(state: LiveState): string {
  const parts: string[] = ['[Live state]'];
  parts.push(`- Surface: ${state.surface}`);
  if (state.currentRoute) parts.push(`- Current route: ${state.currentRoute}`);
  if (state.fen) parts.push(`- FEN: ${state.fen}`);
  if (state.whoseTurn) {
    // Surface this prominently above moveHistory so the LLM cannot
    // emit play_move for the wrong side. Production audit (build
    // 30fe8c8) showed the brain repeatedly emitting `e5` for black
    // while reasoning as white; chess.js rejected every attempt.
    parts.push(`- Whose turn: ${state.whoseTurn} TO MOVE — ANY play_move you emit must be a legal move for ${state.whoseTurn}.`);
  }
  if (state.phase) parts.push(`- Phase: ${state.phase}`);
  // Surface engine eval as PRE-COMPUTED GROUND TRUTH on the current
  // FEN. The surface ran Stockfish on this exact position before
  // dispatching the call; the brain MUST trust this over its own
  // material counting (production audit, build 4e628e5: brain claimed
  // "up a pawn" after losing queen-for-knight; eval was -800cp).
  if (typeof state.evalMateIn === 'number') {
    const winner = state.evalMateIn > 0 ? 'white' : 'black';
    const plies = Math.abs(state.evalMateIn);
    parts.push(
      `- Engine eval (PRE-COMPUTED, white-perspective): MATE IN ${plies} for ${winner}. This is engine ground truth — do not contradict it with your own counting.`,
    );
  } else if (typeof state.evalCp === 'number') {
    parts.push(
      `- Engine eval (PRE-COMPUTED, white-perspective): ${state.evalCp}cp — ${describeEval(state.evalCp)}. This is engine ground truth — do not contradict it with your own material counting. When making "winning"/"losing"/"up material"/"down material" claims, USE THIS NUMBER, not your eyeball count.`,
    );
  }
  if (state.lichessSnapshot) {
    const s = state.lichessSnapshot;
    const lines: string[] = ['- Lichess explorer (PRE-FETCHED for current FEN):'];
    if (s.eco || s.name) {
      lines.push(`    Opening: ${s.name ?? '?'}${s.eco ? ` (ECO ${s.eco})` : ''}`);
    }
    if (s.topMasterMoves.length > 0) {
      const masterStr = s.topMasterMoves
        .map((m) => `${m.san} (${m.total} games, avg ${m.averageRating || '?'})`)
        .join(', ');
      lines.push(`    Top master moves here: ${masterStr}`);
    }
    if (s.topMasterGames.length > 0) {
      const gamesStr = s.topMasterGames
        .map((g) => {
          const result = g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '½-½';
          return `${g.white} vs ${g.black} ${g.year} ${result}`;
        })
        .join('; ');
      lines.push(`    Sample master games: ${gamesStr}`);
    }
    if (s.topAmateurMoves.length > 0) {
      const amateurStr = s.topAmateurMoves
        .map((m) => `${m.san} (${m.total} games${m.whitePct !== null ? `, white ${m.whitePct}%` : ''})`)
        .join(', ');
      lines.push(`    Top amateur moves here: ${amateurStr}`);
    }
    lines.push(
      `    USE this data when teaching the position — cite the opening name, name a master who played it, point at the most popular continuation. For BRANCH FENs the lesson hasn't reached yet, call lichess_opening_lookup / lichess_master_games actively.`,
    );
    parts.push(lines.join('\n'));
  }
  if (state.tactics) {
    parts.push(formatTacticsSubBlock(state.tactics));
  }
  if (state.moveHistory && state.moveHistory.length > 0) {
    parts.push(`- Move history: ${state.moveHistory.join(' ')}`);
  }
  if (state.userJustDid) parts.push(`- User just did: ${state.userJustDid}`);
  return parts.join('\n');
}

/** Render the pre-computed tactical context as a sub-block under
 *  [Live state]. The format mirrors the lichessSnapshot pattern —
 *  ground truth pre-computed by the surface, with an explicit "USE
 *  THIS — don't invent" closer that anchors the brain to G3-style
 *  bounded vocabulary. The block is omitted entirely when nothing
 *  was detected (no tactics + no hanging + no upcoming) so a quiet
 *  position adds zero tokens to the envelope. */
function formatTacticsSubBlock(tactics: NonNullable<LiveState['tactics']>): string {
  const has =
    tactics.immediate.length > 0 ||
    tactics.hanging.length > 0 ||
    tactics.threats.length > 0 ||
    tactics.opportunities.length > 0;
  if (!has) return '';
  const lines: string[] = [
    `- Tactical context (PRE-COMPUTED — bounded vocabulary, G3 applies; lookahead ${tactics.lookaheadDepth} half-moves):`,
  ];
  if (tactics.immediate.length > 0) {
    lines.push(`    Immediate on the board:`);
    for (const t of tactics.immediate) {
      lines.push(`      ${t.type.toUpperCase()} — ${t.description}`);
    }
  }
  if (tactics.hanging.length > 0) {
    const list = tactics.hanging
      .map((h) => `${h.color === 'w' ? 'white' : 'black'} ${pieceFullName(h.piece)} on ${h.square}`)
      .join(', ');
    lines.push(`    Hanging pieces: ${list}`);
  }
  if (tactics.threats.length > 0) {
    lines.push(`    Opponent threats (warn the student, name the pattern):`);
    for (const t of tactics.threats) {
      lines.push(`      depth ${t.depthAhead}/${tactics.lookaheadDepth}: ${t.type.toUpperCase()} — ${t.description} (line: ${t.line.join(' ')})`);
    }
  }
  if (tactics.opportunities.length > 0) {
    lines.push(`    Student opportunities (point these out, name the pattern):`);
    for (const t of tactics.opportunities) {
      lines.push(`      depth ${t.depthAhead}/${tactics.lookaheadDepth}: ${t.type.toUpperCase()} — ${t.description} (line: ${t.line.join(' ')})`);
    }
  }
  lines.push(
    `    NAME the pattern in prose (fork / pin / skewer / back rank / removal of guard / overloaded / discovered attack / etc.). For depth ≥ 2, walk the line: "if you play X, opponent has Y in N." NEVER invent a tactic that isn't in this block. NEVER claim a tactic at greater depth than ${tactics.lookaheadDepth}. The student is intermediate-or-stronger if lookahead ≥ 3 — push them to calculate the full sequence.`,
  );
  return lines.join('\n');
}

function pieceFullName(piece: string): string {
  const key = piece.toLowerCase();
  switch (key) {
    case 'p': return 'pawn';
    case 'n': return 'knight';
    case 'b': return 'bishop';
    case 'r': return 'rook';
    case 'q': return 'queen';
    case 'k': return 'king';
    default: return piece;
  }
}

function formatToolbeltBlock(toolbelt: ToolDefinition[]): string {
  // Empty toolbelt → no block at all. The `[[ACTION:...]]` preamble
  // below is what entices the brain to emit tool tags; suppressing the
  // block removes the temptation cleanly for prose-only calls.
  if (toolbelt.length === 0) return '';
  const parts: string[] = ['[Toolbelt]'];
  parts.push('You can call tools by emitting a tag in your response: [[ACTION:tool_name {"arg1":"val1"}]]');
  parts.push('Tags are parsed out before the user sees the response. Call multiple tools in one turn if needed.');
  parts.push('Available tools:');
  for (const t of toolbelt) {
    parts.push(`- ${t.name}: ${t.description}`);
    const required = t.parameters.required;
    const props = Object.entries(t.parameters.properties);
    if (props.length > 0) {
      const args = props.map(([k, v]) => `${k}${required.includes(k) ? '' : '?'}: ${v.type}`).join(', ');
      parts.push(`    args: { ${args} }`);
    }
  }
  return parts.join('\n');
}

/** Render the envelope's stable parts (identity, app map, toolbelt) as
 *  a system prompt. Memory + live state + ask go in the user message
 *  so they don't bloat the system-prompt cache. */
export function formatEnvelopeAsSystemPrompt(envelope: AssembledEnvelope): string {
  // Filter out empty blocks (e.g. the toolbelt block is dropped for
  // prose-only calls via `suppressToolbelt`) so the system prompt
  // doesn't end with a dangling blank line.
  return [
    envelope.identity,
    formatAppMapBlock(envelope.appMap),
    formatToolbeltBlock(envelope.toolbelt),
  ].filter((block) => block.length > 0).join('\n\n');
}

/** Render the envelope's per-call parts (memory, live state, ask) as
 *  the user message. */
export function formatEnvelopeAsUserMessage(envelope: AssembledEnvelope): string {
  return [
    formatMemoryBlock(envelope.memory),
    '',
    formatLiveStateBlock(envelope.liveState),
    '',
    `[Ask]`,
    envelope.ask,
  ].join('\n');
}
