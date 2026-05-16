/**
 * appRoutesManifest
 * -----------------
 * Hand-maintained source of truth for every navigable route in
 * Chess Academy Pro. The Coach Brain (`src/coach/`) reads this so it
 * knows where every feature lives in the app — when the user says
 * "take me to Bird's Opening" the coach can resolve to a real path.
 *
 * Maintenance rule: when a new route is added to `src/App.tsx`, this
 * file is updated in the same PR. Do NOT auto-generate from the
 * router config — that introduces drift and removes the editorial
 * judgment about WHAT the route is (vs. just what its path is).
 *
 * Schema lives in `src/coach/types.ts` as `RouteManifestEntry`.
 */
import type { RouteManifestEntry } from '../coach/types';

export const APP_ROUTES_MANIFEST: RouteManifestEntry[] = [
  // ─── Top level ────────────────────────────────────────────────────
  {
    path: '/',
    title: 'Home Dashboard',
    description: 'Entry point. Smart search bar opens a chat with the coach. Shows progress at a glance.',
    featuresAvailable: ['coach-chat', 'smart-search', 'progress-summary'],
  },
  // ─── Coach ────────────────────────────────────────────────────────
  {
    path: '/coach/play',
    title: 'Play with the Coach',
    description: 'Live chess game against the coach with adaptive difficulty, hints, and post-game review.',
    featuresAvailable: ['live-play', 'hint-tiers', 'phase-narration', 'live-coach-interjections', 'in-game-chat', 'post-game-review'],
  },
  {
    path: '/coach/chat',
    title: 'Chat with the Coach',
    description: 'Standalone chat with the coach. Persistent across sessions.',
    featuresAvailable: ['chat'],
  },
  {
    path: '/coach/analyse',
    title: 'Analyse a Position',
    description: 'Static position analysis with the coach.',
    featuresAvailable: ['position-analysis'],
  },
  {
    path: '/coach/plan',
    title: 'Coach Session Plan',
    description: 'A session plan the coach can run with the student.',
    featuresAvailable: ['session-plan'],
  },
  {
    path: '/coach/train',
    title: 'Coach Training',
    description: 'Adaptive coach-led training session.',
    featuresAvailable: ['training'],
  },
  {
    path: '/coach/review',
    title: 'Review with Coach',
    description: 'Pick a previously played game (vs Coach, lichess, chess.com) and walk through it move-by-move with the teaching coach. Same teaching style as /coach/teach: Stockfish-grounded claims, [VOICE: ...] spoken summaries, [BOARD: arrow] suggestions for better moves. The student drives navigation; the coach narrates.',
    featuresAvailable: ['game-review', 'teaching-coach', 'voice-narration'],
  },
  {
    path: '/coach/teach',
    title: 'Teach Me',
    description: 'Coach-led teaching surface. The student types or speaks a question ("walk me through the Vienna," "show me the Italian Game"); the coach drives a board, sets up positions, plays candidate moves, takes them back, and explains the IDEA. Full toolbelt: stockfish_eval, lichess_opening_lookup, lichess_master_games, play_move, take_back_move, set_board_position, reset_board.',
    featuresAvailable: ['teach', 'walkthrough'],
  },
  {
    path: '/coach/session/:kind',
    title: 'Coach Session',
    description: 'Dynamic coach session route — kinds include play-against, walkthrough, explain-position, puzzle, continue-middlegame.',
    featuresAvailable: ['session-router'],
  },
  // ─── Openings ─────────────────────────────────────────────────────
  {
    path: '/openings',
    title: 'Opening Explorer',
    description: 'Browse opening repertoires. Each opening has its own deep-dive page.',
    featuresAvailable: ['opening-explorer'],
    openingsCovered: [
      'Italian Game',
      'Vienna Game',
      "King's Indian Defense",
      "Queen's Gambit",
      'Sicilian Defense',
      'Caro-Kann Defense',
      'French Defense',
      'London System',
      "Bird's Opening",
      'Ruy Lopez',
      'Scotch Game',
      'Scandinavian Defense',
      'Pirc Defense',
      'Alekhine Defense',
      "Nimzo-Indian Defense",
      'English Opening',
      "Bishop's Opening",
    ],
  },
  {
    path: '/openings/:id',
    title: 'Opening Detail',
    description: 'Deep dive on a single opening — variations, key ideas, traps, walkthroughs.',
    featuresAvailable: ['opening-walkthrough', 'opening-variations', 'opening-traps'],
  },
  {
    path: '/openings/pro/:playerId',
    title: 'Pro Player Repertoire',
    description: 'Repertoire of a professional player.',
    featuresAvailable: ['pro-repertoire'],
  },
  {
    path: '/openings/pro/:playerId/:id',
    title: 'Pro Player Opening',
    description: 'Specific opening from a professional player\'s repertoire.',
    featuresAvailable: ['pro-opening-walkthrough'],
  },
  // ─── Tactics / puzzles ────────────────────────────────────────────
  {
    path: '/tactics',
    title: 'Tactics Hub',
    description: 'Entry point for puzzle training and tactical drills.',
    featuresAvailable: ['tactics-hub'],
  },
  {
    path: '/tactics/profile',
    title: 'Tactical Profile',
    description: 'Tactical strengths and weaknesses analysis.',
    featuresAvailable: ['tactical-stats'],
  },
  {
    path: '/tactics/classic',
    title: 'Classic Puzzles',
    description: 'Standard puzzle trainer with theme filtering.',
    featuresAvailable: ['puzzle-training'],
  },
  {
    path: '/tactics/adaptive',
    title: 'Adaptive Puzzles',
    description: 'Puzzles tuned to the user\'s tactical weaknesses.',
    featuresAvailable: ['adaptive-puzzles'],
  },
  {
    path: '/tactics/mistakes',
    title: 'My Mistakes',
    description: 'Re-drill mistakes from your own games.',
    featuresAvailable: ['mistake-puzzles'],
  },
  {
    path: '/tactics/weakness',
    title: 'Weakness Puzzles',
    description: 'Puzzles drilling specific weakness themes.',
    featuresAvailable: ['weakness-puzzles'],
  },
  {
    path: '/tactics/weakness-themes',
    title: 'Weakness Themes',
    description: 'Browse available weakness themes.',
    featuresAvailable: ['weakness-theme-picker'],
  },
  {
    path: '/tactics/drill',
    title: 'Tactic Drill',
    description: 'Drill a specific tactical pattern repeatedly.',
    featuresAvailable: ['tactic-drill'],
  },
  {
    path: '/tactics/setup',
    title: 'Tactic Setup',
    description: 'Set up a custom tactic for practice.',
    featuresAvailable: ['tactic-setup'],
  },
  {
    path: '/tactics/create',
    title: 'Create a Tactic',
    description: 'Author a new tactic puzzle.',
    featuresAvailable: ['tactic-authoring'],
  },
  {
    path: '/tactics/lichess',
    title: 'Lichess Puzzles',
    description: 'Synced Lichess puzzle dashboard.',
    featuresAvailable: ['lichess-puzzles'],
  },
  {
    path: '/tactics/opening-traps',
    title: 'Opening Traps',
    description: 'Trap-themed puzzles grouped by opening family. Each tile is a known opening pitfall with a forced refutation. Supports ?opening=<name> query param to filter to a single opening family.',
    featuresAvailable: ['opening-trap-puzzles', 'opening-trap-picker', 'show-the-opening', 'play-it-out'],
  },
  // ─── Weaknesses (insights) ────────────────────────────────────────
  {
    path: '/weaknesses',
    title: 'Game Insights',
    description: 'Cross-game weakness analysis pulled from your mistake patterns.',
    featuresAvailable: ['weakness-insights'],
  },
  // ─── Games library ────────────────────────────────────────────────
  {
    path: '/games',
    title: 'Game Database',
    description: 'Your saved games. Click any to review.',
    featuresAvailable: ['game-library', 'game-review'],
  },
  {
    path: '/games/import',
    title: 'Import Games',
    description: 'Import games from PGN or Lichess username.',
    featuresAvailable: ['pgn-import', 'lichess-import'],
  },
  // ─── Settings ─────────────────────────────────────────────────────
  {
    path: '/settings',
    title: 'Settings',
    description: 'App configuration: voice, narration verbosity, AI provider, sync.',
    featuresAvailable: ['settings'],
  },
  {
    path: '/settings/onboarding',
    title: 'Onboarding',
    description: 'First-run setup including API key configuration.',
    featuresAvailable: ['onboarding'],
  },
  // ─── Debug ────────────────────────────────────────────────────────
  {
    path: '/debug/audit',
    title: 'Audit Log',
    description: 'Internal audit log viewer (deep-link only).',
    featuresAvailable: ['audit-log-viewer'],
  },
  // ─── Kid mode ─────────────────────────────────────────────────────
  {
    path: '/kid',
    title: 'Kid Mode',
    description: 'Child-friendly chess hub.',
    featuresAvailable: ['kid-mode'],
  },
  {
    path: '/kid/journey',
    title: "Kid Journey",
    description: 'Story-led chess journey for kids.',
    featuresAvailable: ['kid-journey'],
  },
  {
    path: '/kid/fairy-tale',
    title: 'Fairy Tale Chess',
    description: 'Storybook chess for younger players.',
    featuresAvailable: ['fairy-tale'],
  },
  {
    path: '/kid/queen-games',
    title: 'Queen Games',
    description: 'Mini-games featuring the queen.',
    featuresAvailable: ['queen-games'],
  },
  {
    path: '/kid/rook-games',
    title: 'Rook Games',
    description: 'Mini-games featuring the rook.',
    featuresAvailable: ['rook-games'],
  },
  {
    path: '/kid/knight-games',
    title: 'Knight Games',
    description: 'Mini-games featuring the knight.',
    featuresAvailable: ['knight-games'],
  },
  {
    path: '/kid/king-escape',
    title: 'King Escape',
    description: 'King-pathing mini-game.',
    featuresAvailable: ['king-escape'],
  },
  {
    path: '/kid/king-march',
    title: 'King March',
    description: 'King-march mini-game.',
    featuresAvailable: ['king-march'],
  },
  {
    path: '/kid/mini-games',
    title: 'Kid Mini-Games',
    description: 'Pawn wars, blocker, and other mini-games.',
    featuresAvailable: ['kid-mini-games'],
  },
  {
    path: '/kid/play-games',
    title: 'Guided Kid Games',
    description: 'Guided games against playful AI for kids.',
    featuresAvailable: ['guided-kid-games'],
  },
  {
    path: '/kid/puzzles',
    title: 'Kid Puzzles',
    description: 'Kid-friendly puzzle set.',
    featuresAvailable: ['kid-puzzles'],
  },
];
