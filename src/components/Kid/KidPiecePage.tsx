import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Volume2, VolumeX } from 'lucide-react';
import { KidChessboard } from '../Chessboard/KidChessboard';
import { useChessGame } from '../../hooks/useChessGame';
import { useBoardContext } from '../../hooks/useBoardContext';
import { voiceService } from '../../services/voiceService';
import type { ChessPiece } from '../../types';

interface PieceConfig {
  title: string;
  symbol: string;
  description: string;
  fen: string;
}

const PIECE_CONFIG: Record<ChessPiece, PieceConfig> = {
  king: { title: 'The King', symbol: '\u2654', description: 'Moves one square in any direction', fen: '4k3/8/8/8/3K4/8/8/8 w - - 0 1' },
  queen: { title: 'The Queen', symbol: '\u2655', description: 'Moves any number of squares in any direction', fen: '4k3/8/8/8/3Q4/8/8/4K3 w - - 0 1' },
  rook: { title: 'The Rook', symbol: '\u2656', description: 'Moves in straight lines: up, down, left, right', fen: '4k3/8/8/8/3R4/8/8/4K3 w - - 0 1' },
  bishop: { title: 'The Bishop', symbol: '\u2657', description: 'Moves diagonally any number of squares', fen: '4k3/8/8/8/3B4/8/8/4K3 w - - 0 1' },
  knight: { title: 'The Knight', symbol: '\u2658', description: 'Moves in an L-shape: 2+1 squares', fen: '4k3/8/8/8/3N4/8/8/4K3 w - - 0 1' },
  pawn: { title: 'The Pawn', symbol: '\u2659', description: 'Moves forward one square, captures diagonally', fen: '4k3/8/8/3P4/8/8/8/4K3 w - - 0 1' },
};

const VALID_PIECES: ReadonlySet<string> = new Set(['king', 'queen', 'rook', 'bishop', 'knight', 'pawn']);

export function KidPiecePage(): JSX.Element {
  const { piece } = useParams<{ piece: string }>();
  const navigate = useNavigate();
  const [speaking, setSpeaking] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);

  const pieceFenForGame = piece && VALID_PIECES.has(piece) ? PIECE_CONFIG[piece as ChessPiece].fen : undefined;
  const game = useChessGame(pieceFenForGame, 'white', 'b');

  // Publish board context for global coach drawer
  const pieceFen = piece && VALID_PIECES.has(piece) ? PIECE_CONFIG[piece as ChessPiece].fen : '';
  useBoardContext(pieceFen, '', 0, 'white', 'w');

  const speakInstruction = useCallback((text: string): void => {
    if (!voiceOn) return;
    setSpeaking(true);
    void voiceService.speak(text).finally(() => setSpeaking(false));
  }, [voiceOn]);

  // Speak the instruction on mount
  useEffect(() => {
    if (!piece || !VALID_PIECES.has(piece)) return;
    const config = PIECE_CONFIG[piece as ChessPiece];
    const text = `${config.title}. ${config.description}. Try moving it around!`;
    const timer = setTimeout(() => speakInstruction(text), 500);
    return () => clearTimeout(timer);
  }, [piece, speakInstruction]);

  const handleToggleVoice = useCallback((): void => {
    if (speaking) {
      voiceService.stop();
      setSpeaking(false);
    }
    setVoiceOn((v) => !v);
  }, [speaking]);

  const handleSpeakerClick = useCallback((): void => {
    if (!piece || !VALID_PIECES.has(piece)) return;
    const config = PIECE_CONFIG[piece as ChessPiece];
    const text = `${config.title}. ${config.description}. Try moving it around!`;
    speakInstruction(text);
  }, [piece, speakInstruction]);

  if (!piece || !VALID_PIECES.has(piece)) {
    void navigate('/kid');
    return <></>;
  }

  const config = PIECE_CONFIG[piece as ChessPiece];

  return (
    <div
      className="flex flex-col gap-3 p-4 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid={`kid-piece-${piece}`}
    >
      {/* Header with back + speaker */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => void navigate('/kid')}
            className="p-2 rounded-lg hover:opacity-80"
            style={{ background: 'var(--color-surface)' }}
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-xl font-bold">{config.title}</h2>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleSpeakerClick}
            className="p-2 rounded-lg border transition-colors"
            style={{
              background: speaking ? 'var(--color-accent)' : 'var(--color-surface)',
              borderColor: 'var(--color-border)',
              color: speaking ? 'var(--color-bg)' : 'var(--color-text-muted)',
            }}
            aria-label="Read instructions aloud"
            data-testid="kid-speak-btn"
          >
            <Volume2 size={18} />
          </button>
          <button
            onClick={handleToggleVoice}
            className="p-2 rounded-lg border transition-colors"
            style={{
              background: voiceOn ? 'var(--color-accent)' : 'var(--color-surface)',
              borderColor: 'var(--color-border)',
              color: voiceOn ? 'var(--color-bg)' : 'var(--color-text-muted)',
            }}
            aria-label={voiceOn ? 'Mute voice' : 'Unmute voice'}
            data-testid="kid-voice-toggle"
          >
            {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
        </div>
      </div>

      {/* Large styled instruction box (WO-008) */}
      <div
        className="rounded-2xl p-6 border-2 text-center"
        style={{
          background: 'var(--color-surface)',
          borderColor: 'var(--color-accent)',
          boxShadow: '0 4px 24px rgba(0, 0, 0, 0.15)',
        }}
        data-testid="kid-instruction-box"
      >
        <span className="text-6xl block mb-3">{config.symbol}</span>
        <p className="text-xl font-bold leading-relaxed" data-testid="kid-instruction-text">
          {config.description}
        </p>
        <p className="text-lg mt-2 font-medium" style={{ color: 'var(--color-text-muted)' }}>
          Try moving it around!
        </p>
      </div>

      <div className="w-full md:max-w-[420px] mx-auto">
        <KidChessboard
          game={game}
          interactive
        />
      </div>

      <button
        onClick={() => void navigate('/kid')}
        className="w-full py-3 rounded-lg font-semibold text-lg"
        style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
        data-testid="got-it-btn"
      >
        I got it! ⭐
      </button>
    </div>
  );
}
