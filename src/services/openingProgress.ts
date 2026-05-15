/**
 * openingProgress
 * ---------------
 * Tracks which post-walkthrough stages the student has completed for
 * each opening. Stored as a single JSON blob in Dexie's `meta` table
 * (no schema bump needed — the meta table is generic key/value).
 *
 * Stages tracked:
 *   - 'walkthrough' — completed when student reaches any leaf
 *   - 'concepts'   — completed when all concept questions answered
 *   - 'findMove'   — completed when all find-the-move puzzles answered
 *   - 'drill'      — completed when at least one drill line played clean
 *   - 'punish'     — completed when all punish lessons answered
 *
 * The stage menu renders a checkmark next to each completed stage so
 * the student can see what they've already done. Per the user's
 * morning iteration: "I want an indicator on the different levels
 * identifying completion."
 */
import { db } from '../db/schema';

const META_KEY = 'openingProgress';

export type ProgressStage =
  | 'walkthrough'
  | 'concepts'
  | 'findMove'
  | 'drill'
  | 'punish';

interface ProgressBlob {
  [openingNameLowercase: string]: { [stage: string]: boolean };
}

async function read(): Promise<ProgressBlob> {
  try {
    const rec = await db.meta.get(META_KEY);
    if (rec) return JSON.parse(rec.value) as ProgressBlob;
  } catch {
    // ignore
  }
  return {};
}

async function write(p: ProgressBlob): Promise<void> {
  try {
    await db.meta.put({ key: META_KEY, value: JSON.stringify(p) });
  } catch {
    // ignore
  }
}

/** Mark a stage as completed for the given opening. Idempotent. */
export async function markStageComplete(
  openingName: string,
  stage: ProgressStage,
): Promise<void> {
  const p = await read();
  const key = openingName.toLowerCase();
  if (!p[key]) p[key] = {};
  p[key][stage] = true;
  await write(p);
}

/** Get the set of completed stages for the given opening. */
export async function getCompletedStages(
  openingName: string,
): Promise<Set<ProgressStage>> {
  const p = await read();
  const key = openingName.toLowerCase();
  const stages = p[key] ?? {};
  const set = new Set<ProgressStage>();
  for (const s of Object.keys(stages)) {
    if (stages[s]) set.add(s as ProgressStage);
  }
  return set;
}

/** Reset all progress for an opening — useful when the user wants to
 *  re-do a lesson from scratch. Currently unused but lives here for
 *  future "restart progress" UI. */
export async function resetOpeningProgress(openingName: string): Promise<void> {
  const p = await read();
  const key = openingName.toLowerCase();
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- legitimate dynamic key removal from a Record-typed progress map.
  delete p[key];
  await write(p);
}
