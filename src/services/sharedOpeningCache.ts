/**
 * Cross-user shared opening cache via Supabase.
 *
 * When user A generates a lesson for "Sicilian Najdorf", the LLM-built
 * tree is mirrored into a shared Supabase table. When user B requests
 * the same opening later, they get user A's tree instantly without
 * spending another LLM call.
 *
 * Resolution flow in surface routing:
 *   1. Static registry (curated openings like Vienna)
 *   2. Local Dexie cache
 *   3. Shared Supabase cache  ← THIS MODULE
 *   4. LLM gen (slow ~30-60s)
 *
 * After step 4, the new tree is mirrored back into BOTH the local
 * Dexie cache (for instant re-load) and the shared Supabase cache
 * (so the next user benefits).
 *
 * If Supabase isn't configured, this module silently no-ops and the
 * surface routing falls through to LLM gen as if step 3 didn't exist.
 *
 * Migration: supabase/migrations/0004_shared_opening_cache.sql.
 *
 * PROMPT VERSION
 * --------------
 * Bump PROMPT_VERSION whenever the system prompt or tree schema
 * changes in a way that should invalidate prior cached trees. Reads
 * ignore rows below the current version, so old shapes don't leak
 * into the new build's UI.
 */
import { db } from '../db/schema';
import { logAppAudit } from './appAuditor';
import {
  validateWalkthroughTree,
  validateTreeMoveLegality,
} from '../data/openingWalkthroughs/validate';
import type { WalkthroughTree } from '../types/walkthroughTree';

/** Bumped whenever prompt-shape changes invalidate prior trees.
 *
 *  v1: initial DB-grounded prompt (commit 9844e79)
 *  v2: trap-prompt at every transition + 32K tokens (commit 0732cae)
 *
 *  Increment when shipping a prompt change that affects tree shape
 *  or move depth. Reads filter to >= this value; writes record this
 *  value so older clients can still read forward-compatible rows. */
export const PROMPT_VERSION = 2;

interface SharedCacheConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

interface SharedCacheRow {
  normalized_name: string;
  display_name: string;
  eco: string;
  tree: WalkthroughTree;
  generated_at: string;
  generated_by_user_id: string | null;
  prompt_version: number;
}

/** Pull Supabase config from the active profile's preferences. Mirrors
 *  syncService.getSyncConfig but only needs URL + anon key (no
 *  per-user folder). Returns null when not configured. */
async function getCacheConfig(): Promise<SharedCacheConfig | null> {
  try {
    const profile = (await db.profiles.get('main'));
    if (!profile) return null;
    const prefs = profile.preferences as unknown as Record<string, unknown>;
    const url = (prefs.supabaseUrl as string | null) ?? null;
    let anonKey: string | null = null;
    const encrypted = prefs.supabaseAnonKeyEncrypted as string | null | undefined;
    const iv = prefs.supabaseAnonKeyIv as string | null | undefined;
    if (encrypted && iv) {
      try {
        const { decryptApiKey } = await import('./cryptoService');
        anonKey = await decryptApiKey(encrypted, iv);
      } catch {
        anonKey = null;
      }
    }
    if (!anonKey) {
      anonKey = (prefs.supabaseAnonKey as string | null) ?? null;
    }
    if (!url || !anonKey) return null;
    return { supabaseUrl: url, supabaseAnonKey: anonKey };
  } catch {
    return null;
  }
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/** Validate a tree pulled from shared cache before returning. Same
 *  guards we apply to local Dexie cache reads — broken trees should
 *  not leak into the runtime. */
function isTreeShapeValid(tree: WalkthroughTree): boolean {
  try {
    const structural = validateWalkthroughTree(tree).filter(
      (i) => i.severity === 'error',
    );
    if (structural.length > 0) return false;
    const legality = validateTreeMoveLegality(tree).filter(
      (i) => i.severity === 'error',
    );
    if (legality.length > 0) return false;
    return true;
  } catch {
    return false;
  }
}

/** Read a tree from the shared Supabase cache. Returns null when
 *  not configured / not found / row is below the current prompt
 *  version / row's tree fails validation. Silently caught — never
 *  throws to the caller. */
export async function readSharedCache(
  openingName: string,
): Promise<WalkthroughTree | null> {
  const config = await getCacheConfig();
  if (!config) return null;
  const normalized = normalize(openingName);
  try {
    const url =
      `${config.supabaseUrl}/rest/v1/shared_opening_cache?` +
      `normalized_name=eq.${encodeURIComponent(normalized)}` +
      `&prompt_version=gte.${PROMPT_VERSION}` +
      `&select=*&limit=1`;
    const response = await fetch(url, {
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
      },
    });
    if (!response.ok) {
      void logAppAudit({
        kind: 'dexie-error',
        category: 'subsystem',
        source: 'sharedOpeningCache.read',
        summary: `read failed for "${openingName}" — HTTP ${response.status}`,
      });
      return null;
    }
    const rows = (await response.json()) as SharedCacheRow[];
    if (rows.length === 0) return null;
    const tree = rows[0].tree;
    if (!isTreeShapeValid(tree)) {
      void logAppAudit({
        kind: 'dexie-error',
        category: 'subsystem',
        source: 'sharedOpeningCache.read',
        summary: `discarded invalid shared-cache tree for "${openingName}"`,
      });
      return null;
    }
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'sharedOpeningCache.read',
      summary: `shared-cache HIT for "${openingName}" (generated ${rows[0].generated_at} v${rows[0].prompt_version})`,
    });
    return tree;
  } catch (err) {
    void logAppAudit({
      kind: 'dexie-error',
      category: 'subsystem',
      source: 'sharedOpeningCache.read',
      summary: `read threw for "${openingName}"`,
      details: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Write a tree to the shared Supabase cache. Fire-and-forget — the
 *  caller doesn't wait or care about the result. UPSERT semantics
 *  via on_conflict so an existing row gets refreshed. */
export async function writeSharedCache(
  openingName: string,
  tree: WalkthroughTree,
): Promise<void> {
  const config = await getCacheConfig();
  if (!config) return;
  const normalized = normalize(openingName);
  try {
    const url =
      `${config.supabaseUrl}/rest/v1/shared_opening_cache?` +
      `on_conflict=normalized_name`;
    const body: Partial<SharedCacheRow> = {
      normalized_name: normalized,
      display_name: tree.openingName,
      eco: tree.eco,
      tree,
      prompt_version: PROMPT_VERSION,
    };
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      void logAppAudit({
        kind: 'dexie-error',
        category: 'subsystem',
        source: 'sharedOpeningCache.write',
        summary: `write failed for "${openingName}" — HTTP ${response.status}`,
      });
      return;
    }
    void logAppAudit({
      kind: 'coach-surface-migrated',
      category: 'subsystem',
      source: 'sharedOpeningCache.write',
      summary: `wrote "${openingName}" to shared cache (v${PROMPT_VERSION})`,
    });
  } catch (err) {
    void logAppAudit({
      kind: 'dexie-error',
      category: 'subsystem',
      source: 'sharedOpeningCache.write',
      summary: `write threw for "${openingName}"`,
      details: err instanceof Error ? err.message : String(err),
    });
  }
}
