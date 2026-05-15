/**
 * local_opening_book — read-only zero-latency lookup against the
 * app's bundled opening book (the same book that powers the
 * "play me a Caro-Kann" repertoire feature). Wraps
 * `getOpeningMoves` + `getNextOpeningBookMove` from
 * `openingDetectionService` so the brain can consult the local
 * book in a single deterministic call instead of either (a) waiting
 * on a Lichess Explorer round-trip or (b) being kept out of the
 * decision by a deterministic engine running outside the spine.
 *
 * The tool returns the next book SAN move for the AI side at the
 * given ply, or null if we have left the book / it is not the AI's
 * turn / the opening name is unknown.
 */
import {
  getOpeningMoves,
  getNextOpeningBookMove,
} from '../../../services/openingDetectionService';
import { useCoachMemoryStore } from '../../../stores/coachMemoryStore';
import type { Tool } from '../../types';

export const localOpeningBookTool: Tool = {
  name: 'local_opening_book',
  category: 'cerebellum',
  kind: 'read',
  description:
    "Look up the next book move for the AI in the app's bundled opening book. Synchronous and zero-latency — call this on every move during the opening when the student has committed to an opening. Returns { nextMoveSan, lineLength, currentPly, openingName, source } where nextMoveSan is null if the line has been left, the AI is not on move, or no opening is set. Prefer this over lichess_opening_lookup when the goal is to play the line; lichess_opening_lookup is for naming an arbitrary position.",
  parameters: {
    type: 'object',
    properties: {
      moveHistory: {
        type: 'string',
        description:
          'Space-separated SAN move history of the current game (e.g. "e4 c6 d4 d5"). Empty string for the starting position.',
      },
      aiColor: {
        type: 'string',
        description: 'Side the AI plays in this game.',
        enum: ['white', 'black'],
      },
      openingName: {
        type: 'string',
        description:
          'Opening name to look up (e.g. "Caro-Kann Defense"). Optional — when omitted the tool falls back to the intended opening currently set in coach memory.',
      },
    },
    required: ['moveHistory', 'aiColor'],
  },
  // eslint-disable-next-line @typescript-eslint/require-await -- CoachTool.execute is typed Promise<...>; this implementation is purely synchronous but must match the interface.
  async execute(args) {
    const rawHistory = typeof args.moveHistory === 'string' ? args.moveHistory : '';
    const aiColor = args.aiColor === 'white' || args.aiColor === 'black'
      ? args.aiColor
      : null;
    if (!aiColor) {
      return { ok: false, error: 'aiColor must be "white" or "black"' };
    }

    const explicitName = typeof args.openingName === 'string' && args.openingName.trim().length > 0
      ? args.openingName.trim()
      : null;
    const memoryName = useCoachMemoryStore.getState().intendedOpening?.name ?? null;
    const openingName = explicitName ?? memoryName;
    const source: 'arg' | 'memory' | 'none' = explicitName
      ? 'arg'
      : memoryName
        ? 'memory'
        : 'none';

    if (!openingName) {
      return {
        ok: true,
        result: {
          nextMoveSan: null,
          lineLength: 0,
          currentPly: rawHistory.trim() === '' ? 0 : rawHistory.trim().split(/\s+/).length,
          openingName: null,
          source,
          reason: 'no opening name provided and no intendedOpening in memory',
        },
      };
    }

    const openingMoves = getOpeningMoves(openingName);
    if (!openingMoves || openingMoves.length === 0) {
      return {
        ok: true,
        result: {
          nextMoveSan: null,
          lineLength: 0,
          currentPly: rawHistory.trim() === '' ? 0 : rawHistory.trim().split(/\s+/).length,
          openingName,
          source,
          reason: 'opening name not found in local book',
        },
      };
    }

    const gameHistory = rawHistory.trim() === '' ? [] : rawHistory.trim().split(/\s+/);
    const nextMoveSan = getNextOpeningBookMove(openingMoves, gameHistory, aiColor);

    return {
      ok: true,
      result: {
        nextMoveSan,
        lineLength: openingMoves.length,
        currentPly: gameHistory.length,
        openingName,
        source,
      },
    };
  },
};
