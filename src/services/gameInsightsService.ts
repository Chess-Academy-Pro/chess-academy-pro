import { db } from '../db/schema';
import { getRepertoireOpenings } from './openingService';
import { reconstructMovesFromGame } from './gameReconstructionService';
import { calculateAccuracy, getClassificationCounts } from './accuracyService';
import { getPhaseBreakdown } from './gamePhaseService';
import { uciMoveToSan } from '../utils/uciToSan';
import { detectMissedTactics } from './missedTacticService';
import { getMistakePuzzleStats } from './mistakePuzzleService';
import { gameNeedsAnalysis } from './gameAnalysisService';
import { getOpeningNameByEco } from './openingDetectionService';
import type {
  GameRecord,
  MoveClassificationCounts,
  PhaseAccuracy,
  MissedTactic,
  OverviewInsights,
  OpeningInsights,
  OpeningAggregateStats,
  MistakeInsights,
  CostlyMistake,
  TacticInsights,
  TacticalMoment,
  GamePhase,
  TacticType,
} from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const AI_NAMES = ['AI Coach', 'Stockfish Bot'];

function getPlayerColorWithUsername(
  game: GameRecord,
  username: string | null,
): 'white' | 'black' | null {
  if (AI_NAMES.includes(game.white)) return 'black';
  if (AI_NAMES.includes(game.black)) return 'white';
  if (username) {
    const lower = username.toLowerCase();
    if (game.white.toLowerCase() === lower) return 'white';
    if (game.black.toLowerCase() === lower) return 'black';
  }
  return null;
}

function getOpponentName(game: GameRecord, playerColor: 'white' | 'black'): string {
  return playerColor === 'white' ? game.black : game.white;
}

function getOpponentElo(game: GameRecord, playerColor: 'white' | 'black'): number | null {
  return playerColor === 'white' ? game.blackElo : game.whiteElo;
}

function isWin(game: GameRecord, playerColor: 'white' | 'black'): boolean {
  return (playerColor === 'white' && game.result === '1-0') ||
    (playerColor === 'black' && game.result === '0-1');
}

function isLoss(game: GameRecord, playerColor: 'white' | 'black'): boolean {
  return (playerColor === 'white' && game.result === '0-1') ||
    (playerColor === 'black' && game.result === '1-0');
}

function isDraw(game: GameRecord): boolean {
  return game.result === '1/2-1/2';
}

function addClassifications(
  target: MoveClassificationCounts,
  source: MoveClassificationCounts,
): void {
  target.brilliant += source.brilliant;
  target.great += source.great;
  target.good += source.good;
  target.book += source.book;
  target.miss += source.miss;
  target.inaccuracy += source.inaccuracy;
  target.mistake += source.mistake;
  target.blunder += source.blunder;
}

function emptyClassifications(): MoveClassificationCounts {
  return { brilliant: 0, great: 0, good: 0, book: 0, miss: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
}

async function getUsername(): Promise<string | null> {
  const profile = await db.profiles.toCollection().first();
  if (!profile) return null;
  return profile.preferences.chessComUsername ??
    profile.preferences.lichessUsername ??
    profile.name;
}

interface AnnotatedGame {
  game: GameRecord;
  playerColor: 'white' | 'black';
}

/** Classify an opening NAME by which color named it. Black-named
 *  openings (Defense, Defence, Indian, Sicilian, etc.) reflect
 *  Black's choice — they should never appear in a user's "Most
 *  played as White" bucket even when the user happened to be
 *  White in the game (which would just mean the user FACED that
 *  defense, not that they played it). Returns 'black' when the
 *  name clearly tags a Black-side opening; 'white' when clearly
 *  White-named; null when ambiguous / joint (Italian Game,
 *  Queen's Gambit Declined, King's Pawn Game) — those get
 *  bucketed by player color as before. */
function openingChoosingColor(name: string | null): 'white' | 'black' | null {
  if (!name) return null;
  const n = name.toLowerCase();
  // Black-named: "Defense"/"Defence", "Indian", and specific Black-
  // defense families. The keyword set covers every B0-B99 + most
  // E00-E99 + Black sidelines in D70-D99 and C00-C19. Reported by
  // David: Scandinavian + Caro-Kann showing up in his "Most played
  // as White" bucket.
  const blackKeywords = [
    'defense', 'defence',
    'indian',
    'sicilian', 'scandinavian', 'caro-kann', 'caro kann',
    'french', 'pirc', 'modern', 'alekhine', 'nimzowitsch',
    'benoni', 'benko', 'budapest', 'slav', 'semi-slav', 'dutch',
    'grunfeld', 'grünfeld',
    'centre counter', 'center counter',
    'counter-gambit', 'countergambit', 'counter gambit',
    'tarrasch defense', 'tarrasch defence',
    'philidor', 'petrov', "petroff",
    'two knights',
    'englund',
  ];
  for (const kw of blackKeywords) {
    if (n.includes(kw)) return 'black';
  }
  return null;
}

async function getPlayerGames(): Promise<AnnotatedGame[]> {
  const allGames = await db.games
    .filter((g) => !g.isMasterGame && g.result !== '*')
    .toArray();
  const username = await getUsername();

  const result: AnnotatedGame[] = [];
  for (const game of allGames) {
    const color = getPlayerColorWithUsername(game, username);
    if (color) {
      result.push({ game, playerColor: color });
    }
  }
  return result;
}

// ─── Overview ─────────────────────────────────────────────────────────────────

export async function getOverviewInsights(): Promise<OverviewInsights> {
  const playerGames = await getPlayerGames();
  const totalGames = playerGames.length;

  if (totalGames === 0) {
    return {
      totalGames: 0, wins: 0, losses: 0, draws: 0,
      winRate: 0, winRateWhite: 0, winRateBlack: 0,
      avgElo: 0, avgAccuracy: 0,
      highestBeaten: null, lowestLostTo: null,
      classificationCounts: emptyClassifications(),
      totalMoves: 0, avgMovesPerGame: 0,
      avgBrilliantsPerGame: 0, avgMistakesPerGame: 0,
      avgBlundersPerGame: 0, avgInaccuraciesPerGame: 0,
      bestMoveAgreement: 0,
      phaseAccuracy: [], accuracyWhite: 0, accuracyBlack: 0,
      strengths: [],
      analyzedGameCount: 0, gamesNeedingAnalysis: 0,
    };
  }

  let wins = 0, losses = 0, draws = 0;
  let whiteGames = 0, whiteWins = 0, blackGames = 0, blackWins = 0;
  let totalElo = 0, eloCount = 0;
  let highestBeaten: OverviewInsights['highestBeaten'] = null;
  let lowestLostTo: OverviewInsights['lowestLostTo'] = null;
  const totalCounts = emptyClassifications();
  let totalMoves = 0;
  let accuracyWhiteSum = 0, accuracyWhiteCount = 0;
  let accuracyBlackSum = 0, accuracyBlackCount = 0;
  let bestMoveMatches = 0, bestMoveTotal = 0;
  const phaseMap: Record<string, { accuracy: number; count: number; mistakes: number }> = {
    opening: { accuracy: 0, count: 0, mistakes: 0 },
    middlegame: { accuracy: 0, count: 0, mistakes: 0 },
    endgame: { accuracy: 0, count: 0, mistakes: 0 },
  };

  for (const { game, playerColor } of playerGames) {
    // W/L/D
    if (isWin(game, playerColor)) wins++;
    else if (isLoss(game, playerColor)) losses++;
    else if (isDraw(game)) draws++;

    // By color
    if (playerColor === 'white') {
      whiteGames++;
      if (isWin(game, playerColor)) whiteWins++;
    } else {
      blackGames++;
      if (isWin(game, playerColor)) blackWins++;
    }

    // Opponent ELO
    const oppElo = getOpponentElo(game, playerColor);
    if (oppElo) {
      totalElo += oppElo;
      eloCount++;

      const oppName = getOpponentName(game, playerColor);
      if (isWin(game, playerColor)) {
        if (!highestBeaten || oppElo > highestBeaten.elo) {
          highestBeaten = { name: oppName, elo: oppElo, gameId: game.id };
        }
      }
      if (isLoss(game, playerColor)) {
        if (!lowestLostTo || oppElo < lowestLostTo.elo) {
          lowestLostTo = { name: oppName, elo: oppElo, gameId: game.id };
        }
      }
    }

    // Annotations-based stats. Only games with FULL Stockfish analysis
    // contribute — sparse `detectBlunders()` annotations on import would
    // otherwise zero out every average (and produce a misleading "zero
    // blunders" strength) because most moves have no classification.
    if (!gameNeedsAnalysis(game)) {
      const moves = reconstructMovesFromGame(game, playerColor);
      if (moves.length === 0) continue;

      totalMoves += moves.length;

      // Classification counts
      const counts = getClassificationCounts(moves, playerColor);
      addClassifications(totalCounts, counts);

      // Accuracy
      const accuracy = calculateAccuracy(moves);
      if (playerColor === 'white') {
        accuracyWhiteSum += accuracy.white;
        accuracyWhiteCount++;
      } else {
        accuracyBlackSum += accuracy.black;
        accuracyBlackCount++;
      }

      // Phase accuracy
      const phases = getPhaseBreakdown(moves, playerColor);
      for (const p of phases) {
        phaseMap[p.phase].accuracy += p.accuracy * p.moveCount;
        phaseMap[p.phase].count += p.moveCount;
        phaseMap[p.phase].mistakes += p.mistakes;
      }

      // Best move agreement — convert UCI bestMove → SAN using the
      // FEN BEFORE the move was played (the previous move's `fen` =
      // current move's pre-fen, or the start position when i === 0).
      // Pre-fix this compared SAN directly to UCI (e.g. "Nf3" vs
      // "g1f3") and `bestMoveMatches` was 0 for every game.
      const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      for (let mi = 0; mi < moves.length; mi++) {
        const move = moves[mi];
        if (move.isCoachMove) continue;
        const isMoveWhite = move.moveNumber % 2 === 1;
        if ((playerColor === 'white' && !isMoveWhite) || (playerColor === 'black' && isMoveWhite)) continue;
        if (move.bestMove && move.san) {
          bestMoveTotal++;
          const preFen = mi > 0 ? moves[mi - 1].fen : STARTING_FEN;
          const bestSan = uciMoveToSan(move.bestMove, preFen);
          if (move.san === bestSan) bestMoveMatches++;
        }
      }
    }
  }

  const winRate = totalGames > 0 ? Math.round((wins / totalGames) * 100) : 0;
  const winRateWhite = whiteGames > 0 ? Math.round((whiteWins / whiteGames) * 100) : 0;
  const winRateBlack = blackGames > 0 ? Math.round((blackWins / blackGames) * 100) : 0;
  const avgElo = eloCount > 0 ? Math.round(totalElo / eloCount) : 0;

  const annotatedGameCount = accuracyWhiteCount + accuracyBlackCount;
  const avgAccuracy = annotatedGameCount > 0
    ? Math.round((accuracyWhiteSum + accuracyBlackSum) / annotatedGameCount)
    : 0;
  const accuracyWhite = accuracyWhiteCount > 0 ? Math.round(accuracyWhiteSum / accuracyWhiteCount) : 0;
  const accuracyBlack = accuracyBlackCount > 0 ? Math.round(accuracyBlackSum / accuracyBlackCount) : 0;

  const phaseAccuracy: PhaseAccuracy[] = (['opening', 'middlegame', 'endgame'] as GamePhase[])
    .map((p) => ({
      phase: p,
      accuracy: phaseMap[p].count > 0 ? Math.round(phaseMap[p].accuracy / phaseMap[p].count) : 0,
      moveCount: phaseMap[p].count,
      mistakes: phaseMap[p].mistakes,
    }));

  const avgMovesPerGame = totalGames > 0 ? Math.round(totalMoves / totalGames) : 0;
  const avgBrilliantsPerGame = annotatedGameCount > 0
    ? Number((totalCounts.brilliant / annotatedGameCount).toFixed(1))
    : 0;
  const avgMistakesPerGame = annotatedGameCount > 0
    ? Number((totalCounts.mistake / annotatedGameCount).toFixed(1))
    : 0;
  const avgBlundersPerGame = annotatedGameCount > 0
    ? Number((totalCounts.blunder / annotatedGameCount).toFixed(1))
    : 0;
  const avgInaccuraciesPerGame = annotatedGameCount > 0
    ? Number((totalCounts.inaccuracy / annotatedGameCount).toFixed(1))
    : 0;
  const bestMoveAgreement = bestMoveTotal > 0 ? Math.round((bestMoveMatches / bestMoveTotal) * 100) : 0;

  // Strengths
  const strengths: string[] = [];
  if (totalCounts.brilliant >= 3) strengths.push(`${totalCounts.brilliant} brilliant moves across ${totalGames} games`);
  const openingPhase = phaseAccuracy.find((p) => p.phase === 'opening');
  if (openingPhase && openingPhase.accuracy >= 75) strengths.push(`Strong opening preparation (${openingPhase.accuracy}% accuracy)`);
  if (winRateWhite >= 60) strengths.push(`${winRateWhite}% win rate as White`);
  if (winRateBlack >= 60) strengths.push(`${winRateBlack}% win rate as Black`);

  // Count games with zero blunders. Only fully-analyzed games qualify —
  // previously this counted games with sparse annotations that simply
  // hadn't been analyzed, producing a false "zero blunders" strength.
  let zeroBlunderGames = 0;
  let analyzedGameCount = 0;
  let gamesNeedingAnalysis = 0;
  for (const { game, playerColor } of playerGames) {
    if (gameNeedsAnalysis(game)) {
      gamesNeedingAnalysis++;
      continue;
    }
    analyzedGameCount++;
    const moves = reconstructMovesFromGame(game, playerColor);
    if (moves.length === 0) continue;
    const counts = getClassificationCounts(moves, playerColor);
    if (counts.blunder === 0) zeroBlunderGames++;
  }
  if (zeroBlunderGames >= 3) strengths.push(`${zeroBlunderGames} games with zero blunders`);

  return {
    totalGames, wins, losses, draws,
    winRate, winRateWhite, winRateBlack,
    avgElo, avgAccuracy,
    highestBeaten, lowestLostTo,
    classificationCounts: totalCounts,
    totalMoves, avgMovesPerGame,
    avgBrilliantsPerGame, avgMistakesPerGame, avgBlundersPerGame, avgInaccuraciesPerGame,
    bestMoveAgreement,
    phaseAccuracy, accuracyWhite, accuracyBlack,
    strengths,
    analyzedGameCount, gamesNeedingAnalysis,
  };
}

// ─── Openings ─────────────────────────────────────────────────────────────────

export async function getOpeningInsights(): Promise<OpeningInsights> {
  const playerGames = await getPlayerGames();
  const repertoire = await getRepertoireOpenings();

  const repertoireEcos = new Set(repertoire.map((o) => o.eco));

  // Group games by ECO + color
  const openingMap = new Map<string, OpeningAggregateStats>();

  let inBook = 0;
  let offBook = 0;

  for (const { game, playerColor } of playerGames) {
    const eco = game.eco;
    const key = eco ?? 'unknown';

    if (eco && repertoireEcos.has(eco)) inBook++;
    else offBook++;

    let entry = openingMap.get(key);
    if (!entry) {
      // Resolve the opening's display name with a 3-tier fallback:
      //   1. User's repertoire — if they have this ECO set up as a
      //      named opening, use that name (most personal / accurate).
      //   2. Lichess DB canonical lookup — translate raw ECO codes
      //      like "C24" into readable names ("Bishop's Opening") so
      //      cards don't read like serial numbers.
      //   3. Final fallback to the ECO string itself, then "Unknown".
      // Pre-fix the surface rendered shareable-insight headlines like
      // "You win 75% with the C24" — users couldn't tell what they
      // were good at without knowing the ECO codes by heart.
      const repOpening = repertoire.find((o) => o.eco === eco);
      const canonical = repOpening?.name ?? getOpeningNameByEco(eco) ?? eco ?? 'Unknown';
      entry = {
        name: canonical,
        eco,
        openingId: repOpening?.id ?? null,
        games: 0, wins: 0, losses: 0, draws: 0,
        winRate: 0, avgAccuracy: 0, gameIds: [],
      };
      openingMap.set(key, entry);
    }

    entry.games++;
    entry.gameIds.push(game.id);
    if (isWin(game, playerColor)) entry.wins++;
    else if (isLoss(game, playerColor)) entry.losses++;
    else if (isDraw(game)) entry.draws++;
  }

  // Compute win rates
  for (const entry of openingMap.values()) {
    entry.winRate = entry.games > 0 ? Math.round((entry.wins / entry.games) * 100) : 0;
  }

  const allOpenings = Array.from(openingMap.values());

  // Split by color
  const whiteOpenings: OpeningAggregateStats[] = [];
  const blackOpenings: OpeningAggregateStats[] = [];

  // Rebuild by color
  const whiteMap = new Map<string, OpeningAggregateStats>();
  const blackMap = new Map<string, OpeningAggregateStats>();

  for (const { game, playerColor } of playerGames) {
    const key = game.eco ?? 'unknown';
    // Same 3-tier name fallback as the combined-opening pass above.
    const repOpening = repertoire.find((o) => o.eco === game.eco);
    const canonical = repOpening?.name ?? getOpeningNameByEco(game.eco) ?? game.eco ?? 'Unknown';

    // Skip openings that are explicitly named for the OTHER color.
    // A user playing White who faced a Scandinavian (B01) shouldn't
    // see "Scandinavian Defence" listed as their "most played as
    // White" — they didn't choose it, their opponent did. Black-
    // named openings (Defenses, Indian Defenses, Sicilian, etc.) are
    // filtered out of the White bucket; the reverse filter is not
    // applied because there's no clean equivalent set of explicitly
    // "White-named" openings (joint names like Italian Game / Queen's
    // Gambit are still bucketed by player color as before).
    const choosingColor = openingChoosingColor(canonical);
    if (playerColor === 'white' && choosingColor === 'black') continue;
    if (playerColor === 'black' && choosingColor === 'white') continue;

    const map = playerColor === 'white' ? whiteMap : blackMap;

    let entry = map.get(key);
    if (!entry) {
      entry = {
        name: canonical,
        eco: game.eco,
        openingId: repOpening?.id ?? null,
        games: 0, wins: 0, losses: 0, draws: 0,
        winRate: 0, avgAccuracy: 0, gameIds: [],
      };
      map.set(key, entry);
    }

    entry.games++;
    entry.gameIds.push(game.id);
    if (isWin(game, playerColor)) entry.wins++;
    else if (isLoss(game, playerColor)) entry.losses++;
    else if (isDraw(game)) entry.draws++;
  }

  for (const entry of whiteMap.values()) {
    entry.winRate = entry.games > 0 ? Math.round((entry.wins / entry.games) * 100) : 0;
    whiteOpenings.push(entry);
  }
  for (const entry of blackMap.values()) {
    entry.winRate = entry.games > 0 ? Math.round((entry.wins / entry.games) * 100) : 0;
    blackOpenings.push(entry);
  }

  whiteOpenings.sort((a, b) => b.games - a.games);
  blackOpenings.sort((a, b) => b.games - a.games);

  // Win rate sorted (min 3 games)
  const winRateByOpening = allOpenings
    .filter((o) => o.games >= 3)
    .sort((a, b) => b.winRate - a.winRate);

  // Best / worst results-by-opening — explicit "which openings treat
  // you well vs. badly" report David asked for. Reuses the same ≥3-
  // games threshold as winRateByOpening so we don't surface lucky-
  // streak noise. Top-5 each end of the sorted list. Same list of
  // openings may show in both if there's a tight cluster — display
  // dedupes by ECO at the UI level.
  const bestResults = winRateByOpening.slice(0, 5);
  const worstResults = [...winRateByOpening].reverse().slice(0, 5);

  // Drill accuracy from repertoire
  const drillAccuracyByOpening = repertoire
    .filter((o) => o.drillAttempts > 0)
    .map((o) => ({
      name: o.name,
      accuracy: Math.round(o.drillAccuracy * 100),
      attempts: o.drillAttempts,
    }))
    .sort((a, b) => b.accuracy - a.accuracy);

  // Strengths
  const strengths: string[] = [];
  const bestOpening = winRateByOpening[0] as typeof winRateByOpening[number] | undefined;
  if (bestOpening && bestOpening.winRate >= 60) {
    const drill = drillAccuracyByOpening.find((d) => d.name === bestOpening.name);
    const drillStr = drill ? `, ${drill.accuracy}% drill accuracy` : '';
    strengths.push(`${bestOpening.name} — ${bestOpening.winRate}% win rate${drillStr}`);
  }
  const totalPlayerGames = playerGames.length;
  if (totalPlayerGames > 0 && inBook / totalPlayerGames >= 0.5) {
    strengths.push(`${Math.round((inBook / totalPlayerGames) * 100)}% of games played in-repertoire`);
  }

  return {
    repertoireCoverage: { inBook, offBook },
    mostPlayedWhite: whiteOpenings.slice(0, 5),
    mostPlayedBlack: blackOpenings.slice(0, 5),
    winRateByOpening,
    bestResults,
    worstResults,
    drillAccuracyByOpening: drillAccuracyByOpening.slice(0, 10),
    strengths,
  };
}

// ─── Mistakes ─────────────────────────────────────────────────────────────────

export async function getMistakeInsights(): Promise<MistakeInsights> {
  const mistakePuzzles = await db.mistakePuzzles.toArray();
  const playerGames = await getPlayerGames();
  const totalGames = playerGames.length;

  // Error breakdown from mistake puzzles
  let blunders = 0, mistakes = 0, inaccuracies = 0;
  let totalCpLoss = 0;
  let cpLossCount = 0;

  // By phase
  const phaseErrors: Record<string, { errors: number; cpLossSum: number; count: number }> = {
    opening: { errors: 0, cpLossSum: 0, count: 0 },
    middlegame: { errors: 0, cpLossSum: 0, count: 0 },
    endgame: { errors: 0, cpLossSum: 0, count: 0 },
  };

  // By situation (eval before mistake)
  let winning = 0, equal = 0, losing = 0;
  let missedWins = 0;

  for (const mp of mistakePuzzles) {
    switch (mp.classification) {
      case 'blunder': blunders++; break;
      case 'mistake': mistakes++; break;
      case 'inaccuracy': inaccuracies++; break;
      case 'miss': missedWins++; break;
    }

    totalCpLoss += mp.cpLoss;
    cpLossCount++;

    // Phase
    const phase = mp.gamePhase;
    phaseErrors[phase].errors++;
    phaseErrors[phase].cpLossSum += mp.cpLoss;
    phaseErrors[phase].count++;

    // Situation based on eval before
    if (mp.evalBefore !== null) {
      const signedEval = mp.playerColor === 'white' ? mp.evalBefore : -mp.evalBefore;
      if (signedEval > 100) winning++;
      else if (signedEval < -100) losing++;
      else equal++;
    }
  }

  const errorsByPhase: MistakeInsights['errorsByPhase'] = (['opening', 'middlegame', 'endgame'] as GamePhase[])
    .map((phase) => ({
      phase,
      errors: phaseErrors[phase].errors,
      avgCpLoss: phaseErrors[phase].count > 0
        ? Math.round(phaseErrors[phase].cpLossSum / phaseErrors[phase].count)
        : 0,
    }));

  // Thrown wins: games where player had +200cp advantage and lost
  let thrownWins = 0;
  for (const { game, playerColor } of playerGames) {
    if (!isLoss(game, playerColor)) continue;
    if (!game.annotations || game.annotations.length === 0) continue;

    const hadAdvantage = game.annotations.some((ann) => {
      if (ann.evaluation === null) return false;
      const signedEval = playerColor === 'white' ? ann.evaluation : -ann.evaluation;
      return signedEval >= 200;
    });
    if (hadAdvantage) thrownWins++;
  }

  // Late-game collapses: 2+ errors in last 10 moves
  let lateGameCollapses = 0;
  for (const { game } of playerGames) {
    if (!game.annotations || game.annotations.length === 0) continue;
    const lastMoves = game.annotations.slice(-10);
    const lateErrors = lastMoves.filter(
      (m) => m.classification === 'blunder' || m.classification === 'mistake',
    ).length;
    if (lateErrors >= 2) lateGameCollapses++;
  }

  // Costliest mistakes
  const costliestMistakes: CostlyMistake[] = mistakePuzzles
    .filter((mp) => mp.classification === 'blunder' || mp.classification === 'mistake')
    .sort((a, b) => b.cpLoss - a.cpLoss)
    .slice(0, 5)
    .map((mp) => ({
      gameId: mp.sourceGameId,
      moveNumber: mp.moveNumber,
      san: mp.playerMoveSan,
      cpLoss: mp.cpLoss,
      classification: mp.classification,
      opponentName: mp.opponentName ?? 'Unknown',
      date: mp.gameDate ?? mp.createdAt.split('T')[0],
      openingName: mp.openingName,
      phase: mp.gamePhase,
    }));

  // Puzzle progress
  const stats = await getMistakePuzzleStats();

  // Strengths
  const strengths: string[] = [];
  const openingPhaseErr = errorsByPhase.find((p) => p.phase === 'opening');
  if (openingPhaseErr && openingPhaseErr.avgCpLoss > 0 && openingPhaseErr.avgCpLoss < 20) {
    strengths.push(`Low opening error rate (${openingPhaseErr.avgCpLoss} cp avg loss)`);
  }
  if (stats.mastered >= 5) {
    strengths.push(`Mastered ${stats.mastered} of ${stats.total} mistake puzzles`);
  }

  return {
    errorBreakdown: { blunders, mistakes, inaccuracies },
    missedWins,
    avgCpLoss: cpLossCount > 0 ? Math.round(totalCpLoss / cpLossCount) : 0,
    errorsByPhase,
    errorsBySituation: { winning, equal, losing },
    thrownWins,
    lateGameCollapses,
    costliestMistakes,
    puzzleProgress: {
      unsolved: stats.unsolved,
      solved: stats.solved,
      mastered: stats.mastered,
    },
    totalGames,
    strengths,
  };
}

// ─── Tactics ──────────────────────────────────────────────────────────────────

export async function getTacticInsights(): Promise<TacticInsights> {
  const playerGames = await getPlayerGames();
  const totalGames = playerGames.length;

  let totalBrilliant = 0, totalGreat = 0;
  const missedByType = new Map<TacticType, { count: number; totalCost: number }>();
  const missedByPhase = new Map<GamePhase, number>();
  const allMissed: MissedTactic[] = [];
  const bestSequences: TacticalMoment[] = [];
  const worstMisses: TacticalMoment[] = [];
  let totalMissed = 0;

  for (const { game, playerColor } of playerGames) {
    if (!game.annotations || game.annotations.length === 0) continue;

    const moves = reconstructMovesFromGame(game, playerColor);
    if (moves.length === 0) continue;

    const counts = getClassificationCounts(moves, playerColor);
    totalBrilliant += counts.brilliant;
    totalGreat += counts.great;

    // Find brilliant/great moves for "best sequences"
    for (const move of moves) {
      if (move.isCoachMove) continue;
      const isMoveWhite = move.moveNumber % 2 === 1;
      if ((playerColor === 'white' && !isMoveWhite) || (playerColor === 'black' && isMoveWhite)) continue;

      if (move.classification === 'brilliant' || move.classification === 'great') {
        const evalSwing = move.evaluation !== null && move.preMoveEval !== null
          ? Math.abs(move.evaluation - move.preMoveEval)
          : 0;
        bestSequences.push({
          gameId: game.id,
          moveNumber: move.moveNumber,
          san: move.san,
          fen: move.fen,
          evalSwing,
          tacticType: 'tactical_sequence',
          explanation: `${move.classification === 'brilliant' ? 'Brilliant' : 'Great'} move`,
          opponentName: getOpponentName(game, playerColor),
          date: game.date,
          openingName: getOpeningNameByEco(game.eco) ?? game.eco,
        });
      }
    }

    // Detect missed tactics
    const missed = detectMissedTactics(moves, playerColor);
    for (const m of missed) {
      totalMissed++;
      allMissed.push(m);

      const existing = missedByType.get(m.tacticType);
      if (existing) {
        existing.count++;
        existing.totalCost += Math.abs(m.evalSwing);
      } else {
        missedByType.set(m.tacticType, { count: 1, totalCost: Math.abs(m.evalSwing) });
      }

      // Phase of missed tactic
      const moveNum = m.moveIndex;
      let phase: GamePhase = 'middlegame';
      if (moveNum <= 10) phase = 'opening';
      else if (moveNum >= 30) phase = 'endgame';
      missedByPhase.set(phase, (missedByPhase.get(phase) ?? 0) + 1);

      worstMisses.push({
        gameId: game.id,
        moveNumber: m.moveIndex,
        san: m.playerMoved,
        fen: m.fen,
        evalSwing: m.evalSwing,
        tacticType: m.tacticType,
        explanation: m.explanation,
        opponentName: getOpponentName(game, playerColor),
        date: game.date,
        openingName: getOpeningNameByEco(game.eco) ?? game.eco,
      });
    }
  }

  // Sort best sequences by eval swing descending
  bestSequences.sort((a, b) => b.evalSwing - a.evalSwing);

  // Sort worst misses by eval swing (most costly first)
  worstMisses.sort((a, b) => Math.abs(b.evalSwing) - Math.abs(a.evalSwing));

  const totalFound = totalBrilliant + totalGreat;
  const awarenessRate = (totalFound + totalMissed) > 0
    ? Math.round((totalFound / (totalFound + totalMissed)) * 100)
    : 0;

  const annotatedGameCount = playerGames.filter(
    ({ game }) => game.annotations && game.annotations.length > 0,
  ).length;

  // Tactics executed by type — from brilliant/great moves
  // We don't have explicit tactic types for found tactics, so we group by type from missed
  // For found, we just report brilliant + great counts

  const missedByTypeArr = Array.from(missedByType.entries())
    .map(([type, data]) => ({
      type,
      count: data.count,
      avgCost: data.count > 0 ? Math.round(data.totalCost / data.count) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const missedByPhaseArr = (['opening', 'middlegame', 'endgame'] as GamePhase[])
    .map((phase) => ({ phase, count: missedByPhase.get(phase) ?? 0 }));

  // Strengths
  const strengths: string[] = [];
  if (awarenessRate >= 70) strengths.push(`${awarenessRate}% tactical awareness rate`);
  if (totalBrilliant >= 3) strengths.push(`${totalBrilliant} brilliant moves found`);
  if (totalGreat >= 5) strengths.push(`${totalGreat} great moves found`);

  return {
    tacticsFound: { brilliant: totalBrilliant, great: totalGreat },
    avgBrilliantsPerGame: annotatedGameCount > 0
      ? Number((totalBrilliant / annotatedGameCount).toFixed(1))
      : 0,
    avgGreatPerGame: annotatedGameCount > 0
      ? Number((totalGreat / annotatedGameCount).toFixed(1))
      : 0,
    tacticsByType: [], // No explicit tactic type tracking for found tactics yet
    bestSequences: bestSequences.slice(0, 5),
    worstMisses: worstMisses.slice(0, 5),
    missedByType: missedByTypeArr,
    foundVsMissed: { found: totalFound, missed: totalMissed },
    awarenessRate,
    missedByPhase: missedByPhaseArr,
    totalGames,
    strengths,
  };
}

// ─── Opening Drilldown ────────────────────────────────────────────────────────

export async function getGamesByOpening(eco: string): Promise<GameRecord[]> {
  return db.games
    .where('eco')
    .equals(eco)
    .filter((g) => !g.isMasterGame)
    .toArray();
}
