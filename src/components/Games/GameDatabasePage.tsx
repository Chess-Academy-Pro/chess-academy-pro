import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { db } from '../../db/schema';
import { GameCard } from './GameCard';
import { GameViewer } from './GameViewer';
import { Upload, FileText, Download } from 'lucide-react';
import type { GameRecord } from '../../types';

export function GameDatabasePage(): JSX.Element {
  const navigate = useNavigate();
  const [games, setGames] = useState<GameRecord[]>([]);
  const [selectedGame, setSelectedGame] = useState<GameRecord | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [pastedPgn, setPastedPgn] = useState('');
  // Initialize filterEco from `?eco=<code>` query param so rolodex
  // deep-links land with the filter pre-applied (WO-ROLODEX-PLUMBING-01
  // item 3d). The filter UI shows the value as if the user typed it
  // and the existing filter pipeline at line 28 applies it visually.
  const [searchParams] = useSearchParams();
  const [filterEco, setFilterEco] = useState(() => (searchParams.get('eco') ?? '').trim());
  const [filterSource, setFilterSource] = useState<string>('all');

  useEffect(() => {
    void loadGames();
  }, []);

  const loadGames = async (): Promise<void> => {
    const all = await db.games.orderBy('date').reverse().toArray();
    setGames(all);
  };

  const filteredGames = games.filter((g) => {
    if (filterEco && g.eco && !g.eco.toLowerCase().includes(filterEco.toLowerCase())) return false;
    if (filterSource !== 'all' && g.source !== filterSource) return false;
    return true;
  });

  const handleFileImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    await importPgnText(text);
    void loadGames();
    e.target.value = '';
  }, []);

  const handlePasteImport = useCallback(async (): Promise<void> => {
    if (!pastedPgn.trim()) return;
    await importPgnText(pastedPgn);
    setPastedPgn('');
    setShowImport(false);
    void loadGames();
  }, [pastedPgn]);

  if (selectedGame) {
    return (
      <div className="flex flex-col gap-6 p-6 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6" style={{ color: 'var(--color-text)' }}>
        <GameViewer game={selectedGame} onClose={() => setSelectedGame(null)} />
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-6 p-6 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="game-database-page"
    >
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Games</h1>
        <div className="flex gap-2">
          <button
            onClick={() => void navigate('/games/import')}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium"
            style={{ background: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            data-testid="import-online-btn"
          >
            <Download size={14} />
            Import Games
          </button>
          <button
            onClick={() => setShowImport((s) => !s)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium"
            style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
            data-testid="import-toggle-btn"
          >
            <Upload size={14} />
            PGN
          </button>
        </div>
      </div>

      {/* Import panel */}
      {showImport && (
        <div
          className="rounded-xl p-5 border space-y-3"
          style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
          data-testid="import-panel"
        >
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--color-text-muted)' }}>
              Upload PGN file
            </label>
            <label
              className="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer hover:opacity-80"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <FileText size={14} />
              Choose file
              <input
                type="file"
                accept=".pgn"
                onChange={(e) => void handleFileImport(e)}
                className="hidden"
                data-testid="file-input"
              />
            </label>
          </div>
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--color-text-muted)' }}>
              Or paste PGN
            </label>
            <textarea
              value={pastedPgn}
              onChange={(e) => setPastedPgn(e.target.value)}
              placeholder="Paste PGN here..."
              className="w-full px-3 py-2 rounded-lg border text-sm h-32 resize-none"
              style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
              data-testid="pgn-textarea"
            />
            <button
              onClick={() => void handlePasteImport()}
              className="w-full mt-2 py-2 rounded-lg text-sm font-medium"
              style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
              data-testid="import-paste-btn"
            >
              Import PGN
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3">
        <input
          type="text"
          value={filterEco}
          onChange={(e) => setFilterEco(e.target.value)}
          placeholder="Filter by ECO..."
          className="flex-1 px-3 py-2 rounded-lg border text-sm"
          style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          data-testid="eco-filter"
        />
        <select
          value={filterSource}
          onChange={(e) => setFilterSource(e.target.value)}
          className="px-3 py-2 rounded-lg border text-sm"
          style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          data-testid="source-filter"
        >
          <option value="all">All Sources</option>
          <option value="lichess">Lichess</option>
          <option value="chesscom">Chess.com</option>
          <option value="import">Import</option>
          <option value="master">Master</option>
        </select>
      </div>

      {/* Game list */}
      {filteredGames.length === 0 ? (
        <div className="text-center py-12" style={{ color: 'var(--color-text-muted)' }}>
          <div className="text-4xl mb-4">♟</div>
          <p>No games yet. Import a PGN to get started.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredGames.map((game) => (
            <GameCard key={game.id} game={game} onClick={() => setSelectedGame(game)} />
          ))}
        </div>
      )}
    </div>
  );
}

async function importPgnText(text: string): Promise<void> {
  // Split multiple games by header pattern
  const gameTexts = text.split(/(?=\[Event\s)/).filter((t) => t.trim());

  for (const gameText of gameTexts) {
    const headers = extractHeaders(gameText);
    const id = `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const game: GameRecord = {
      id,
      pgn: gameText.trim(),
      white: headers.White ?? 'Unknown',
      black: headers.Black ?? 'Unknown',
      result: (headers.Result ?? '*') as import('../../types').GameResult,
      date: headers.Date ?? new Date().toISOString().split('T')[0],
      event: headers.Event ?? 'Imported',
      eco: headers.ECO ?? null,
      whiteElo: headers.WhiteElo ? parseInt(headers.WhiteElo) : null,
      blackElo: headers.BlackElo ? parseInt(headers.BlackElo) : null,
      source: 'import',
      annotations: null,
      coachAnalysis: null,
      isMasterGame: false,
      openingId: null,
    };

    await db.games.put(game);
  }
}

function extractHeaders(pgn: string): Partial<Record<string, string>> {
  const headers: Record<string, string> = {};
  const regex = /\[(\w+)\s+"([^"]*)"\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(pgn)) !== null) {
    headers[match[1]] = match[2];
  }
  return headers;
}
