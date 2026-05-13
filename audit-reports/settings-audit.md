# Settings audit
Generated: 2026-05-13T23:33:58.000Z
Audit of every preference field written by Settings code, with read-site counts.
Output of `node scripts/audit-settings.mjs`.

## Summary

- **Total settings fields**: 46
- **Active** (runtime reads > 0): 45
- **Orphan** (runtime reads = 0 — saves but does nothing): 1

## ⚠️  Orphaned settings (write only, no runtime read)

These pref fields are written by Settings UI but no runtime code outside Settings/ reads them. Either remove the UI or wire them up.

- **`key`** — labels: "Verbosity", "Coach Narration"

## All settings, by read frequency

| Field | Runtime reads | Labels | Example read site |
|---|---|---|---|
| `glowBrightness` | 🟢 17 | — | src/components/Board/ChessBoard.tsx:140 |
| `showEngineLines` | 🟢 16 | "Eval Bar", "Engine Lines" | src/components/Coach/CoachGamePage.tsx:789 |
| `showEvalBar` | 🟢 16 | "Sound Effects", "Eval Bar" | src/components/Coach/CoachGamePage.tsx:788 |
| `coachVerbosity` | 🟢 14 | "Coach Narration", "Blunder Alerts" | src/components/Coach/CoachGamePage.tsx:2659 |
| `voiceEnabled` | 🟢 14 | "Show Hints", "Voice Narration" | src/components/Openings/WalkthroughMode.tsx:96 |
| `moveQualityFlash` | 🟢 13 | "Move Quality Flash", "Show Hints" | src/components/Board/ControlledChessBoard.tsx:144 |
| `showHints` | 🟢 12 | "Move Quality Flash", "Show Hints" | src/components/Openings/OpeningPlayMode.tsx:121 |
| `coachPersonality` | 🟢 11 | — | src/components/Coach/CoachGamePage.tsx:1960 |
| `pieceSet` | 🟢 10 | "Board Glow Color", "Piece Set" | src/components/Board/ChessBoard.tsx:144 |
| `systemVoiceURI` | 🟢 10 | — | src/App.tsx:126 |
| `voiceSpeed` | 🟢 8 | — | src/App.tsx:129 |
| `blackPieceGlowColor` | 🟢 7 | — | src/components/Board/ChessBoard.tsx:141 |
| `whitePieceGlowColor` | 🟢 7 | — | src/components/Board/ChessBoard.tsx:140 |
| `highlightLastMove` | 🟢 6 | "Highlight Last Move", "Show Legal Moves" | src/components/Board/ControlledChessBoard.tsx:118 |
| `boardColor` | 🟢 5 | "Board Glow Color", "Board Color" | src/components/Board/ChessBoard.tsx:138 |
| `coachNarration` | 🟢 5 | "Coach Narration" | src/services/coachCommentaryPolicy.ts:42 |
| `coachResponseLength` | 🟢 5 | — | src/components/Coach/CoachGamePage.tsx:1964 |
| `pollyEnabled` | 🟢 5 | — | src/db/schema.ts:291 |
| `pollyVoice` | 🟢 5 | — | src/db/schema.ts:292 |
| `aiProvider` | 🟢 4 | — | src/components/Coach/CoachPanel.tsx:23 |
| `masterAllOff` | 🟢 4 | "Highlight Last Move" | src/db/schema.ts:140 |
| `moveMethod` | 🟢 4 | "Move Method" | src/components/Board/ControlledChessBoard.tsx:122 |
| `pieceAnimationSpeed` | 🟢 4 | "Show Coordinates", "Piece Animation" | src/components/Board/ControlledChessBoard.tsx:121 |
| `showCoordinates` | 🟢 4 | "Show Legal Moves", "Show Coordinates" | src/components/Board/ControlledChessBoard.tsx:120 |
| `coachCommentaryVerbosity` | 🟢 3 | "Coach Narration", "Blunder Alerts" | src/services/coachCommentaryPolicy.ts:46 |
| `lichessTokenEncrypted` | 🟢 3 | — | src/components/Games/ImportPage.tsx:53 |
| `phaseNarrationVerbosity` | 🟢 3 | — | src/utils/coachNarration.ts:33 |
| `showLegalMoves` | 🟢 3 | "Highlight Last Move", "Show Legal Moves" | src/components/Board/ControlledChessBoard.tsx:119 |
| `autoPromoteQueen` | 🟡 2 | — | src/db/schema.ts:139 |
| `boardGlowColor` | 🟡 2 | — | src/hooks/useBoardGlow.ts:17 |
| `boardOrientation` | 🟡 2 | — | src/db/schema.ts:134 |
| `coachBlunderAlerts` | 🟡 2 | "Blunder Alerts", "Tactic Alerts" | src/components/Coach/CoachGamePage.tsx:1201 |
| `coachMissedTacticTakeback` | 🟡 2 | "Positional Tips", "Missed Tactic Takeback" | src/components/Coach/CoachGamePage.tsx:1200 |
| `coachPositionalTips` | 🟡 2 | "Tactic Alerts", "Positional Tips" | src/components/Coach/CoachGamePage.tsx:1203 |
| `coachTacticAlerts` | 🟡 2 | "AI Provider & Models", "Blunder Alerts" | src/components/Coach/CoachGamePage.tsx:1202 |
| `dailySessionMinutes` | 🟡 2 | — | src/hooks/useSettings.ts:107 |
| `moveConfirmation` | 🟡 2 | — | src/db/schema.ts:138 |
| `soundEnabled` | 🟡 2 | "Sound Effects", "Eval Bar" | src/hooks/usePieceSound.ts:20 |
| `supabaseUrl` | 🟡 2 | — | src/services/sharedOpeningCache.ts:73 |
| `coachReviewVoice` | 🟡 1 | "Missed Tactic Takeback", "Review Voice Narration" | src/hooks/useSettings.ts:123 |
| `monthlyBudgetCap` | 🟡 1 | — | src/services/coachCostService.ts:83 |
| `pieceSoundLength` | 🟡 1 | — | src/hooks/usePieceSound.ts:31 |
| `pieceSoundPitch` | 🟡 1 | — | src/hooks/usePieceSound.ts:28 |
| `pieceSoundTone` | 🟡 1 | — | src/hooks/usePieceSound.ts:29 |
| `pieceSoundWaveform` | 🟡 1 | — | src/hooks/usePieceSound.ts:30 |
| `key` | 🔴 0 | "Verbosity", "Coach Narration" | — |

## Potential redundancy clusters (labels share a keyword)

- **"narration"** appears in 9 fields: `coachVerbosity`, `voiceEnabled`, `showHints`, `coachNarration`, `coachCommentaryVerbosity`, `coachMissedTacticTakeback`, `coachPositionalTips`, `coachReviewVoice`, `key`
- **"move"** appears in 7 fields: `voiceEnabled`, `moveQualityFlash`, `showHints`, `highlightLastMove`, `masterAllOff`, `moveMethod`, `showLegalMoves`
- **"alerts"** appears in 5 fields: `coachVerbosity`, `coachCommentaryVerbosity`, `coachBlunderAlerts`, `coachPositionalTips`, `coachTacticAlerts`
- **"voice"** appears in 5 fields: `voiceEnabled`, `showHints`, `coachMissedTacticTakeback`, `coachPositionalTips`, `coachReviewVoice`
- **"tactic"** appears in 5 fields: `coachBlunderAlerts`, `coachMissedTacticTakeback`, `coachPositionalTips`, `coachTacticAlerts`, `coachReviewVoice`
- **"coach"** appears in 4 fields: `coachVerbosity`, `coachNarration`, `coachCommentaryVerbosity`, `key`
- **"blunder"** appears in 4 fields: `coachVerbosity`, `coachCommentaryVerbosity`, `coachBlunderAlerts`, `coachTacticAlerts`
- **"positional"** appears in 4 fields: `coachBlunderAlerts`, `coachMissedTacticTakeback`, `coachPositionalTips`, `coachTacticAlerts`
- **"tips"** appears in 4 fields: `coachBlunderAlerts`, `coachMissedTacticTakeback`, `coachPositionalTips`, `coachTacticAlerts`
- **"missed"** appears in 4 fields: `coachMissedTacticTakeback`, `coachPositionalTips`, `coachTacticAlerts`, `coachReviewVoice`
- **"takeback"** appears in 4 fields: `coachMissedTacticTakeback`, `coachPositionalTips`, `coachTacticAlerts`, `coachReviewVoice`
- **"eval"** appears in 3 fields: `showEngineLines`, `showEvalBar`, `soundEnabled`
