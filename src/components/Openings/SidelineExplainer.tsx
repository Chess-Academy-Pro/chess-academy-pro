import { useState, useCallback } from 'react';
import { Sparkles, Loader2, X } from 'lucide-react';
import { generateSidelineExplanation } from '../../services/contentGenerationService';
import type { OpeningRecord, OpeningVariation } from '../../types';

interface SidelineExplainerProps {
  opening: OpeningRecord;
  variation: OpeningVariation;
  fen: string;
}

export function SidelineExplainer({
  opening,
  variation,
  fen,
}: SidelineExplainerProps): JSX.Element {
  const [explanation, setExplanation] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closeExplanation = useCallback((): void => {
    setExplanation(null);
  }, []);

  const handleExplain = useCallback(async (): Promise<void> => {
    if (explanation) {
      setExplanation(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await generateSidelineExplanation(
        opening,
        variation.pgn,
        variation.name,
        fen,
      );
      // Non-empty result — including the offline fallback string — is
      // a success. Showing "Try again later" when the service actually
      // returned fallback text was the root cause of the button
      // appearing broken.
      if (result && result.trim().length > 0) {
        setExplanation(result);
      } else {
        setError('AI coach is offline. Add an API key in Settings → Coach to enable explanations.');
      }
    } catch (err: unknown) {
      console.warn('[SidelineExplainer] failed:', err);
      setError('Could not generate explanation. Check Settings → Coach for API key status.');
    } finally {
      setLoading(false);
    }
  }, [opening, variation, fen, explanation]);

  return (
    <div className="inline-flex flex-col" data-testid="sideline-explainer">
      <button
        onClick={() => void handleExplain()}
        disabled={loading}
        className="p-1.5 transition-colors disabled:opacity-50"
        aria-label={explanation ? 'Close explanation' : `Explain ${variation.name}`}
        title={explanation ? 'Close' : 'AI Explain'}
        data-testid="sideline-explain-btn"
      >
        {loading ? (
          <Loader2 size={16} className="animate-spin text-purple-400 sideline-sparkle-glow" />
        ) : explanation ? (
          <X size={16} className="text-purple-400 sideline-sparkle-glow" />
        ) : (
          <Sparkles size={16} className="text-purple-400 sideline-sparkle-glow" />
        )}
      </button>
      {explanation && (
        <>
          {/* Backdrop — click anywhere outside the sheet to dismiss. */}
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={closeExplanation}
            data-testid="sideline-explanation-backdrop"
          />
          {/* Bottom sheet — escapes the narrow action-column by using
              fixed positioning so the explanation can span the full
              viewport width instead of inheriting the icon-button's
              column. Scrollable for long explanations; safe-area
              padding keeps content clear of the iOS home indicator. */}
          <div
            className="fixed bottom-0 left-0 right-0 z-50 max-h-[75vh] overflow-hidden flex flex-col rounded-t-2xl shadow-2xl"
            style={{
              background: 'var(--color-bg)',
              borderTop: '1px solid var(--color-border)',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }}
            data-testid="sideline-explanation"
            role="dialog"
            aria-modal="true"
            aria-label={`AI explanation: ${variation.name}`}
          >
            <div
              className="flex items-center gap-2 px-4 py-3 border-b"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <Sparkles size={16} className="text-purple-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-wider text-theme-text-muted">AI Coach</div>
                <div className="text-sm font-semibold truncate text-theme-text">{variation.name}</div>
              </div>
              <button
                onClick={closeExplanation}
                className="p-1.5 rounded-lg hover:bg-theme-surface text-theme-text-muted hover:text-theme-text transition-colors"
                aria-label="Close explanation"
                data-testid="sideline-explanation-close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="overflow-y-auto px-4 pt-4 pb-16 text-sm leading-relaxed whitespace-pre-wrap text-theme-text">
              {explanation}
            </div>
          </div>
        </>
      )}
      {error && (
        <p className="mt-1 text-xs text-red-400" data-testid="sideline-error">{error}</p>
      )}
    </div>
  );
}
