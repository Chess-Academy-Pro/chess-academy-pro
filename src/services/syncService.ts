import { db } from '../db/schema';
import { exportUserData } from './dbService';
import { decryptApiKey } from './cryptoService';
import type {
  UserProfile,
  PuzzleRecord,
  OpeningRecord,
  SessionRecord,
  FlashcardRecord,
  GameRecord,
  MistakePuzzle,
  ClassifiedTactic,
  SetupPuzzle,
  OpeningWeakSpot,
} from '../types';

interface SyncConfig {
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  syncUserId: string | null;
}

interface CloudBackup {
  name: string;
  created_at: string;
}

/** Meta table row shape. Keys are domain-scoped strings
 *  (`coachMemory.v1`, `openingProgress`, `app-audit-log.v1`, …);
 *  values are serialized JSON blobs. The store treats them as
 *  opaque on sync — each subsystem re-deserializes its own blob on
 *  next read. */
interface MetaRow {
  key: string;
  value: unknown;
}

interface ImportData {
  profiles?: UserProfile[];
  sessions?: SessionRecord[];
  openings?: OpeningRecord[];
  flashcards?: FlashcardRecord[];
  puzzles?: PuzzleRecord[];
  games?: GameRecord[];
  mistakePuzzles?: MistakePuzzle[];
  classifiedTactics?: ClassifiedTactic[];
  setupPuzzles?: SetupPuzzle[];
  openingWeakSpots?: OpeningWeakSpot[];
  /** WO-ROLODEX-UI-01 PR-4: `db.meta` blob carrying coachMemoryStore
   *  state (intendedOpening, savedPosition, the rolodex's
   *  activeOpeningCardId / lastActiveRolodexColor / favoritedAt /
   *  userOrderedFavorites, etc.) for cross-device sync. */
  meta?: MetaRow[];
}

/** Try-decrypt a (`{key}Encrypted`, `{key}Iv`) pair, falling back to
 *  the legacy plaintext `{key}` field if no encrypted record exists.
 *  Returns null when neither form is available. Symmetric with
 *  `SyncSettingsPanel.handleSaveConfig` which encrypts on save. */
async function readEncryptedOrLegacy(
  prefs: Record<string, unknown>,
  encryptedKey: string,
  ivKey: string,
  plaintextKey: string,
): Promise<string | null> {
  const encrypted = prefs[encryptedKey] as string | null | undefined;
  const iv = prefs[ivKey] as string | null | undefined;
  if (encrypted && iv) {
    try {
      return await decryptApiKey(encrypted, iv);
    } catch {
      // Decrypt failed (key derivation mismatch, corrupt record).
      // Leave null; caller's "sync not configured" path will surface
      // a clean error to the user.
      return null;
    }
  }
  return (prefs[plaintextKey] as string | null) ?? null;
}

export async function getSyncConfig(profile: UserProfile): Promise<SyncConfig> {
  const prefs = profile.preferences as unknown as Record<string, unknown>;
  // All three sync fields are now encrypted on save. Each falls back
  // to the legacy plaintext field for profiles saved before the
  // encryption migration — the next Save Config call upgrades them.
  const [supabaseUrl, supabaseAnonKey, syncUserId] = await Promise.all([
    readEncryptedOrLegacy(prefs, 'supabaseUrlEncrypted', 'supabaseUrlIv', 'supabaseUrl'),
    readEncryptedOrLegacy(prefs, 'supabaseAnonKeyEncrypted', 'supabaseAnonKeyIv', 'supabaseAnonKey'),
    readEncryptedOrLegacy(prefs, 'syncUserIdEncrypted', 'syncUserIdIv', 'syncUserId'),
  ]);
  return { supabaseUrl, supabaseAnonKey, syncUserId };
}

export async function pushToCloud(profile: UserProfile): Promise<void> {
  const config = await getSyncConfig(profile);
  if (!config.supabaseUrl || !config.supabaseAnonKey || !config.syncUserId) {
    throw new Error('Sync not configured. Set Supabase URL, anon key, and user ID in settings.');
  }

  const jsonData = await exportUserData();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `${config.syncUserId}/backup-${timestamp}.json`;

  const response = await fetch(
    `${config.supabaseUrl}/storage/v1/object/chess-academy-backups/${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.supabaseAnonKey}`,
        apikey: config.supabaseAnonKey,
      },
      body: jsonData,
      signal: AbortSignal.timeout(20000),
    },
  );

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }

  // Update last sync date
  const prefs = { ...profile.preferences } as unknown as Record<string, unknown>;
  prefs.lastSyncDate = new Date().toISOString();
  await db.profiles.update(profile.id, { preferences: prefs as unknown as UserProfile['preferences'] });
}

export async function listCloudBackups(profile: UserProfile): Promise<CloudBackup[]> {
  const config = await getSyncConfig(profile);
  if (!config.supabaseUrl || !config.supabaseAnonKey || !config.syncUserId) {
    return [];
  }

  const response = await fetch(
    `${config.supabaseUrl}/storage/v1/object/list/chess-academy-backups/${config.syncUserId}`,
    {
      headers: {
        Authorization: `Bearer ${config.supabaseAnonKey}`,
        apikey: config.supabaseAnonKey,
      },
      signal: AbortSignal.timeout(10000),
    },
  );

  if (!response.ok) return [];

  const items = (await response.json()) as CloudBackup[];
  return items.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function pullFromCloud(profile: UserProfile): Promise<void> {
  const config = await getSyncConfig(profile);
  if (!config.supabaseUrl || !config.supabaseAnonKey || !config.syncUserId) {
    throw new Error('Sync not configured.');
  }

  const backups = await listCloudBackups(profile);
  if (backups.length === 0) {
    throw new Error('No backups found.');
  }

  const latest = backups[0];
  const response = await fetch(
    `${config.supabaseUrl}/storage/v1/object/chess-academy-backups/${config.syncUserId}/${latest.name}`,
    {
      headers: {
        Authorization: `Bearer ${config.supabaseAnonKey}`,
        apikey: config.supabaseAnonKey,
      },
      signal: AbortSignal.timeout(20000),
    },
  );

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const text = await response.text();
  await importUserData(text);
}

export async function importUserData(json: string): Promise<void> {
  const data = JSON.parse(json) as ImportData;

  if (data.profiles) {
    await db.profiles.bulkPut(data.profiles);
  }
  if (data.sessions) {
    await db.sessions.bulkPut(data.sessions);
  }
  if (data.openings) {
    await db.openings.bulkPut(data.openings);
  }
  if (data.flashcards) {
    await db.flashcards.bulkPut(data.flashcards);
  }
  if (data.puzzles) {
    await db.puzzles.bulkPut(data.puzzles);
  }
  if (data.games) {
    await db.games.bulkPut(data.games);
  }
  if (data.mistakePuzzles) {
    await db.mistakePuzzles.bulkPut(data.mistakePuzzles);
  }
  if (data.classifiedTactics) {
    await db.classifiedTactics.bulkPut(data.classifiedTactics);
  }
  if (data.setupPuzzles) {
    await db.setupPuzzles.bulkPut(data.setupPuzzles);
  }
  if (data.openingWeakSpots) {
    await db.openingWeakSpots.bulkPut(data.openingWeakSpots);
  }
  if (data.meta) {
    // bulkPut by key — same shape as how the in-app writers persist.
    // Note: the in-memory coachMemoryStore won't see the new blob
    // until its next hydrate() call (typically next app boot), so the
    // import lands but the live store keeps its current state until
    // reload. Acceptable for a manual import flow.
    await db.meta.bulkPut(data.meta as { key: string; value: unknown }[]);
  }
}
