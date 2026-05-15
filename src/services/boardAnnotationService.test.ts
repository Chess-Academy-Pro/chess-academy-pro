 
import { describe, it, expect } from 'vitest';
import { parseBoardTags } from './boardAnnotationService';

describe('boardAnnotationService', () => {
  describe('parseBoardTags', () => {
    it('returns empty commands for text with no tags', () => {
      const result = parseBoardTags('Just regular text here');
      expect(result.cleanText).toBe('Just regular text here');
      expect(result.commands).toEqual([]);
    });

    it('parses a single arrow tag', () => {
      const result = parseBoardTags('Look at this line [BOARD: arrow:e2-e4:green] nice move!');
      expect(result.cleanText).toBe('Look at this line  nice move!');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toEqual({
        type: 'arrow',
        arrows: [{ startSquare: 'e2', endSquare: 'e4', color: 'rgba(34, 197, 94, 0.8)' }],
      });
    });

    it('parses multiple arrows in one tag', () => {
      const result = parseBoardTags('[BOARD: arrow:d1-h5:red,e1-g1:blue]');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].arrows).toHaveLength(2);
      expect(result.commands[0].arrows![0]).toEqual({
        startSquare: 'd1', endSquare: 'h5', color: 'rgba(239, 68, 68, 0.8)',
      });
      expect(result.commands[0].arrows![1]).toEqual({
        startSquare: 'e1', endSquare: 'g1', color: 'rgba(59, 130, 246, 0.8)',
      });
    });

    it('parses highlight tags', () => {
      const result = parseBoardTags('[BOARD: highlight:e4:green,d5:yellow,c6:red]');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toEqual({
        type: 'highlight',
        highlights: [
          { square: 'e4', color: 'rgba(34, 197, 94, 0.8)' },
          { square: 'd5', color: 'rgba(234, 179, 8, 0.8)' },
          { square: 'c6', color: 'rgba(239, 68, 68, 0.8)' },
        ],
      });
    });

    it('parses position tag with FEN and label', () => {
      const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
      const result = parseBoardTags(`[BOARD: position:${fen}:After 1.e4]`);
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toEqual({
        type: 'show_position',
        fen,
        label: 'After 1.e4',
      });
    });

    it('parses position tag without label', () => {
      const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
      const result = parseBoardTags(`[BOARD: position:${fen}]`);
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].type).toBe('show_position');
      expect(result.commands[0].fen).toBe(fen);
      expect(result.commands[0].label).toBe('Analysis position');
    });

    it('parses clear tag', () => {
      const result = parseBoardTags('[BOARD: clear]');
      expect(result.commands).toEqual([{ type: 'clear' }]);
      expect(result.cleanText).toBe('');
    });

    it('handles case-insensitive tag types', () => {
      const result = parseBoardTags('[BOARD: ARROW:e2-e4:green]');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].type).toBe('arrow');
    });

    it('handles case-insensitive color names', () => {
      const result = parseBoardTags('[BOARD: arrow:e2-e4:GREEN]');
      expect(result.commands[0].arrows![0].color).toBe('rgba(34, 197, 94, 0.8)');
    });

    it('defaults to green for unknown colors', () => {
      const result = parseBoardTags('[BOARD: arrow:e2-e4:purple]');
      expect(result.commands[0].arrows![0].color).toBe('rgba(34, 197, 94, 0.8)');
    });

    it('filters out invalid squares in arrows', () => {
      const result = parseBoardTags('[BOARD: arrow:z9-e4:green,a1-h8:red]');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].arrows).toHaveLength(1);
      expect(result.commands[0].arrows![0].startSquare).toBe('a1');
    });

    it('filters out invalid squares in highlights', () => {
      const result = parseBoardTags('[BOARD: highlight:z9:green,e4:red]');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].highlights).toHaveLength(1);
      expect(result.commands[0].highlights![0].square).toBe('e4');
    });

    it('ignores malformed arrow data', () => {
      const result = parseBoardTags('[BOARD: arrow:]');
      expect(result.commands).toEqual([]);
    });

    it('ignores position tags with invalid FEN', () => {
      const result = parseBoardTags('[BOARD: position:not-a-fen:Label]');
      expect(result.commands).toEqual([]);
    });

    it('parses multiple tags in one message', () => {
      const text = 'Check this [BOARD: arrow:e2-e4:green] and these squares [BOARD: highlight:d5:yellow] are key.';
      const result = parseBoardTags(text);
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].type).toBe('arrow');
      expect(result.commands[1].type).toBe('highlight');
      expect(result.cleanText).toBe('Check this  and these squares  are key.');
    });

    it('defaults arrow color to green when not specified', () => {
      const result = parseBoardTags('[BOARD: arrow:e2-e4]');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].arrows![0].color).toBe('rgba(34, 197, 94, 0.8)');
    });

    it('defaults highlight color to green when not specified', () => {
      const result = parseBoardTags('[BOARD: highlight:e4]');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].highlights![0].color).toBe('rgba(34, 197, 94, 0.8)');
    });

    it('parses practice tag with FEN and label', () => {
      const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
      const result = parseBoardTags(`[BOARD: practice:${fen}:Find the fork]`);
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toEqual({
        type: 'practice',
        fen,
        label: 'Find the fork',
      });
    });

    it('parses practice tag without label', () => {
      const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
      const result = parseBoardTags(`[BOARD: practice:${fen}]`);
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].type).toBe('practice');
      expect(result.commands[0].fen).toBe(fen);
      expect(result.commands[0].label).toBe('Practice position');
    });

    it('ignores practice tags with invalid FEN', () => {
      const result = parseBoardTags('[BOARD: practice:not-a-fen:Label]');
      expect(result.commands).toEqual([]);
    });

    it('strips practice tag from clean text', () => {
      const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
      const result = parseBoardTags(`Try this! [BOARD: practice:${fen}:Find the best move]`);
      expect(result.cleanText).toBe('Try this!');
    });

    it('resolves all defined color names to distinct values', () => {
      const expected: Record<string, string> = {
        green: 'rgba(34, 197, 94, 0.8)',
        red: 'rgba(239, 68, 68, 0.8)',
        blue: 'rgba(59, 130, 246, 0.8)',
        yellow: 'rgba(234, 179, 8, 0.8)',
        orange: 'rgba(249, 115, 22, 0.8)',
      };
      for (const [name, rgba] of Object.entries(expected)) {
        const result = parseBoardTags(`[BOARD: arrow:a1-h8:${name}]`);
        expect(result.commands[0].arrows![0].color).toBe(rgba);
      }
    });
  });
});
