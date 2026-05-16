/**
 * favorite_opening — add an opening to the user's favorites
 * (Training Plan rolodex).
 *
 * Write tool. Idempotent — re-calling on an already-favorited
 * opening returns `{ ok: true, alreadyFavorited: true }` instead
 * of flipping it off. This matters because the brain may
 * confidently emit the same `favorite_opening` call twice in a
 * round if the user repeats themselves; treating each call as a
 * toggle would unfavorite on the second call.
 *
 * Resolution: accepts `name` (preferred — most callers pass a
 * canonical opening name like "Italian Game") or `ecoCode` (e.g.
 * "C50"). Name uses fuzzy search via `searchOpenings`; ECO uses
 * the direct `getOpeningByEco` index. If both are provided, name
 * wins. If neither resolves, returns `{ ok: false, error: ... }`.
 *
 * Per WO-ROLODEX-PLUMBING-01 item 5 — wires the rolodex's
 * "favorite the italian" / "add caro-kann to my training plan"
 * AI search natural-language path. The SmartSearchBar fast-path
 * (parseCoachIntent in coachAgent.ts) is the deterministic
 * regex-first route; this tool is the LLM-fallback for phrasings
 * the regex doesn't catch.
 */
import type { Tool } from '../../types';
import {
  searchOpenings,
  getOpeningByEco,
  toggleFavorite,
} from '../../../services/openingService';

export const favoriteOpeningTool: Tool = {
  name: 'favorite_opening',
  category: 'cerebrum',
  kind: 'write',
  description:
    "Add an opening to the user's favorites (the Training Plan rolodex). Idempotent — already-favorited openings stay favorited (not toggled off). Accepts a canonical opening name (preferred) or an ECO code; resolves to a single OpeningRecord and flips its isFavorite flag to true if it wasn't already.",
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Canonical opening name as it appears in the openings database (e.g. "Italian Game", "Caro-Kann Defense", "Sicilian Defense"). Fuzzy-matched; the best hit wins.',
      },
      ecoCode: {
        type: 'string',
        description:
          'ECO code (e.g. "C50", "B10"). Used when `name` is absent or when the user gave an ECO directly. Single-row exact match.',
      },
    },
    // JSON Schema can't naturally express "one of name or ecoCode";
    // both fields are optional at the schema layer and execute()
    // validates the "at least one" constraint at runtime, returning
    // a clean error instead of a schema rejection.
    required: [],
  },
  async execute(args) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const ecoCode = typeof args.ecoCode === 'string' ? args.ecoCode.trim() : '';
    if (!name && !ecoCode) {
      return { ok: false, error: 'Either `name` or `ecoCode` is required.' };
    }
    try {
      // Resolution chain: name wins over ECO. Name → fuzzy search,
      // top hit. ECO → direct index, first row.
      let target: { id: string; name: string; isFavorite: boolean } | null = null;
      if (name) {
        const matches = await searchOpenings(name);
        if (matches.length > 0) {
          target = { id: matches[0].id, name: matches[0].name, isFavorite: matches[0].isFavorite };
        }
      }
      if (!target && ecoCode) {
        const ecoMatches = await getOpeningByEco(ecoCode);
        if (ecoMatches.length > 0) {
          target = { id: ecoMatches[0].id, name: ecoMatches[0].name, isFavorite: ecoMatches[0].isFavorite };
        }
      }
      if (!target) {
        return {
          ok: false,
          error: `No opening matched name="${name}" ecoCode="${ecoCode}".`,
        };
      }
      // Idempotent: only flip when currently false. toggleFavorite
      // is a toggle, so calling it on a `true` value would flip it
      // back to false — exactly the bug this guard prevents.
      if (target.isFavorite) {
        return {
          ok: true,
          result: {
            id: target.id,
            name: target.name,
            isFavorite: true,
            alreadyFavorited: true,
          },
        };
      }
      const newValue = await toggleFavorite(target.id);
      return {
        ok: true,
        result: {
          id: target.id,
          name: target.name,
          isFavorite: newValue,
          alreadyFavorited: false,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
