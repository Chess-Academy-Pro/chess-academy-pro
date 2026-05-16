import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../db/schema';
import { buildOpeningRecord } from '../../../test/factories';
import { favoriteOpeningTool } from './favoriteOpening';

describe('favoriteOpeningTool', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.openings.bulkAdd([
      buildOpeningRecord({
        id: 'italian',
        name: 'Italian Game',
        eco: 'C50',
        isFavorite: false,
      }),
      buildOpeningRecord({
        id: 'sicilian',
        name: 'Sicilian Defense',
        eco: 'B20',
        isFavorite: false,
      }),
      buildOpeningRecord({
        id: 'caro-kann',
        name: 'Caro-Kann Defense',
        eco: 'B10',
        isFavorite: true, // already favorited — for idempotency tests
      }),
    ]);
  });

  describe('schema', () => {
    it('exports name, category, kind, description', () => {
      expect(favoriteOpeningTool.name).toBe('favorite_opening');
      expect(favoriteOpeningTool.category).toBe('cerebrum');
      expect(favoriteOpeningTool.kind).toBe('write');
      expect(favoriteOpeningTool.description).toMatch(/favorite/i);
    });

    it('declares both name and ecoCode parameters as optional', () => {
      // Tool's `required` array is empty — execute() validates at
      // runtime that at least one is provided.
      expect(favoriteOpeningTool.parameters.required).toEqual([]);
      expect(favoriteOpeningTool.parameters.properties.name).toBeDefined();
      expect(favoriteOpeningTool.parameters.properties.ecoCode).toBeDefined();
    });
  });

  describe('resolution by name', () => {
    it('flips isFavorite to true and returns the resolved opening', async () => {
      const result = await favoriteOpeningTool.execute({ name: 'Italian Game' });
      expect(result.ok).toBe(true);
      const opening = await db.openings.get('italian');
      expect(opening?.isFavorite).toBe(true);
      const payload = result.result as { id: string; name: string; isFavorite: boolean; alreadyFavorited: boolean };
      expect(payload.id).toBe('italian');
      expect(payload.name).toBe('Italian Game');
      expect(payload.isFavorite).toBe(true);
      expect(payload.alreadyFavorited).toBe(false);
    });

    it('fuzzy-matches partial names via searchOpenings', async () => {
      const result = await favoriteOpeningTool.execute({ name: 'italian' });
      expect(result.ok).toBe(true);
      const opening = await db.openings.get('italian');
      expect(opening?.isFavorite).toBe(true);
    });

    it('trims whitespace from the input name', async () => {
      const result = await favoriteOpeningTool.execute({ name: '  Sicilian Defense  ' });
      expect(result.ok).toBe(true);
      const opening = await db.openings.get('sicilian');
      expect(opening?.isFavorite).toBe(true);
    });
  });

  describe('resolution by ecoCode (name absent)', () => {
    it('resolves the opening by ECO code', async () => {
      const result = await favoriteOpeningTool.execute({ ecoCode: 'B20' });
      expect(result.ok).toBe(true);
      const opening = await db.openings.get('sicilian');
      expect(opening?.isFavorite).toBe(true);
      const payload = result.result as { name: string };
      expect(payload.name).toBe('Sicilian Defense');
    });

    it('name wins when both name and ecoCode are provided', async () => {
      // name=Italian (C50), ecoCode=B20 (Sicilian) — name should
      // dominate, Italian gets favorited not Sicilian.
      const result = await favoriteOpeningTool.execute({ name: 'Italian Game', ecoCode: 'B20' });
      expect(result.ok).toBe(true);
      const italian = await db.openings.get('italian');
      const sicilian = await db.openings.get('sicilian');
      expect(italian?.isFavorite).toBe(true);
      expect(sicilian?.isFavorite).toBe(false);
    });
  });

  describe('idempotency', () => {
    it('returns alreadyFavorited=true when the opening is already favorited (and does NOT toggle off)', async () => {
      // Caro-Kann is seeded with isFavorite=true.
      const result = await favoriteOpeningTool.execute({ name: 'Caro-Kann Defense' });
      expect(result.ok).toBe(true);
      const opening = await db.openings.get('caro-kann');
      // Critical: stays favorited. A naive toggleFavorite() call
      // would flip it back to false on this second call.
      expect(opening?.isFavorite).toBe(true);
      const payload = result.result as { alreadyFavorited: boolean };
      expect(payload.alreadyFavorited).toBe(true);
    });

    it('two consecutive calls leave the opening favorited (idempotent in series)', async () => {
      await favoriteOpeningTool.execute({ name: 'Italian Game' });
      const result2 = await favoriteOpeningTool.execute({ name: 'Italian Game' });
      expect(result2.ok).toBe(true);
      const opening = await db.openings.get('italian');
      expect(opening?.isFavorite).toBe(true);
      const payload = result2.result as { alreadyFavorited: boolean };
      expect(payload.alreadyFavorited).toBe(true);
    });
  });

  describe('error paths', () => {
    it('returns ok:false when neither name nor ecoCode is provided', async () => {
      const result = await favoriteOpeningTool.execute({});
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/name.*ecoCode|ecoCode.*name/i);
    });

    it('returns ok:false when neither name nor ecoCode resolves', async () => {
      const result = await favoriteOpeningTool.execute({
        name: 'Nonexistent Opening Variation',
        ecoCode: 'Z99',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no opening matched/i);
    });

    it('treats whitespace-only name as missing', async () => {
      const result = await favoriteOpeningTool.execute({ name: '   ', ecoCode: '' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/name.*ecoCode|required/i);
    });
  });
});
