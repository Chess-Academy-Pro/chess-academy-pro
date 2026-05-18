import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test/utils';
import { AnnotationCard } from './AnnotationCard';
import type { OpeningMoveAnnotation } from '../../types';

const fullAnnotation: OpeningMoveAnnotation = {
  san: 'e4',
  annotation: 'White opens with the king pawn, claiming the center.',
  pawnStructure: 'Single e4 pawn controls d5 and f5.',
  plans: ['Develop Nf3 and Bc4', 'Prepare d4 advance'],
  alternatives: ['1.d4 leads to closed positions'],
};

const minimalAnnotation: OpeningMoveAnnotation = {
  san: 'Nf6',
  annotation: 'Black develops the knight to attack e4.',
};

describe('AnnotationCard', () => {
  it('renders nothing when annotation is null', () => {
    render(
      <AnnotationCard annotation={null} moveNumber={1} isWhite={true} visible={true} />,
    );
    expect(screen.getByTestId('annotation-card-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-card')).not.toBeInTheDocument();
  });

  it('renders move label for white move', () => {
    render(
      <AnnotationCard annotation={fullAnnotation} moveNumber={1} isWhite={true} visible={true} />,
    );
    expect(screen.getByTestId('annotation-move-label')).toHaveTextContent('1. e4');
  });

  it('renders move label for black move', () => {
    render(
      <AnnotationCard annotation={fullAnnotation} moveNumber={3} isWhite={false} visible={true} />,
    );
    expect(screen.getByTestId('annotation-move-label')).toHaveTextContent('3...e4');
  });

  it('renders annotation text', () => {
    render(
      <AnnotationCard annotation={fullAnnotation} moveNumber={1} isWhite={true} visible={true} />,
    );
    expect(screen.getByTestId('annotation-text')).toHaveTextContent(
      'White opens with the king pawn, claiming the center.',
    );
  });

  it('prefers narration field over annotation when both present', () => {
    // 2026-05-17 regression: AnnotationCard was reading only
    // `annotation.annotation`, so when WalkthroughMode synthesised
    // bare-SAN stubs (annotation = "fxe4") and the LLM enricher
    // filled `narration`, the card displayed the filtered-out stub
    // (empty) while voice spoke the LLM narration correctly.
    const annWithNarration = {
      ...fullAnnotation,
      annotation: 'fxe4', // bare SAN — matches isGenericAnnotationText filter
      narration: 'White recaptures with the f-pawn, opening the f-file for the rook.',
    };
    render(
      <AnnotationCard annotation={annWithNarration} moveNumber={3} isWhite={true} visible={true} />,
    );
    expect(screen.getByTestId('annotation-text')).toHaveTextContent(
      'White recaptures with the f-pawn, opening the f-file for the rook.',
    );
  });

  it('falls back to annotation when narration is empty/whitespace', () => {
    const annWithoutNarration = {
      ...fullAnnotation,
      annotation: 'Solid teaching annotation here.',
      narration: '   ',
    };
    render(
      <AnnotationCard annotation={annWithoutNarration} moveNumber={1} isWhite={true} visible={true} />,
    );
    expect(screen.getByTestId('annotation-text')).toHaveTextContent(
      'Solid teaching annotation here.',
    );
  });

  it('renders pawn structure section when present', () => {
    render(
      <AnnotationCard annotation={fullAnnotation} moveNumber={1} isWhite={true} visible={true} />,
    );
    expect(screen.getByTestId('annotation-pawn-structure')).toBeInTheDocument();
    expect(screen.getByText('Pawn Structure')).toBeInTheDocument();
    expect(screen.getByText('Single e4 pawn controls d5 and f5.')).toBeInTheDocument();
  });

  it('renders plans section when present', () => {
    render(
      <AnnotationCard annotation={fullAnnotation} moveNumber={1} isWhite={true} visible={true} />,
    );
    expect(screen.getByTestId('annotation-plans')).toBeInTheDocument();
    expect(screen.getByText('Develop Nf3 and Bc4')).toBeInTheDocument();
    expect(screen.getByText('Prepare d4 advance')).toBeInTheDocument();
  });

  it('renders alternatives section with toggle when present', () => {
    render(
      <AnnotationCard annotation={fullAnnotation} moveNumber={1} isWhite={true} visible={true} />,
    );
    expect(screen.getByTestId('annotation-alternatives')).toBeInTheDocument();
    // Alternatives are collapsed by default — toggle button is present
    expect(screen.getByTestId('annotation-toggle')).toBeInTheDocument();
  });

  it('does not render optional sections when absent', () => {
    render(
      <AnnotationCard annotation={minimalAnnotation} moveNumber={2} isWhite={false} visible={true} />,
    );
    expect(screen.getByTestId('annotation-card')).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-pawn-structure')).not.toBeInTheDocument();
    expect(screen.queryByTestId('annotation-plans')).not.toBeInTheDocument();
    expect(screen.queryByTestId('annotation-alternatives')).not.toBeInTheDocument();
    expect(screen.queryByTestId('annotation-toggle')).not.toBeInTheDocument();
  });

  it('toggle button expands and collapses alternatives', async () => {
    const user = userEvent.setup();
    render(
      <AnnotationCard annotation={fullAnnotation} moveNumber={1} isWhite={true} visible={true} />,
    );

    // Alternatives collapsed by default — content not visible
    expect(screen.queryByText('1.d4 leads to closed positions')).not.toBeInTheDocument();

    // Click to expand
    await user.click(screen.getByTestId('annotation-toggle'));

    // Alternatives now visible
    await waitFor(() => {
      expect(screen.getByText('1.d4 leads to closed positions')).toBeInTheDocument();
    });

    // Click to collapse
    await user.click(screen.getByTestId('annotation-toggle'));

    // Alternatives hidden again
    await waitFor(() => {
      expect(screen.queryByText('1.d4 leads to closed positions')).not.toBeInTheDocument();
    });
  });

  it('renders move order note when present', () => {
    const annotationWithMoveOrder: OpeningMoveAnnotation = {
      san: 'Nf3',
      annotation: 'Develops the knight.',
      moveOrderNote: 'Playing Nf3 before d4 avoids the Budapest Gambit.',
    };
    render(
      <AnnotationCard annotation={annotationWithMoveOrder} moveNumber={2} isWhite={true} visible={true} />,
    );
    expect(screen.getByTestId('annotation-move-order')).toBeInTheDocument();
    expect(screen.getByText(/Playing Nf3 before d4/)).toBeInTheDocument();
  });

  it('does not render move order note when absent', () => {
    render(
      <AnnotationCard annotation={fullAnnotation} moveNumber={1} isWhite={true} visible={true} />,
    );
    expect(screen.queryByTestId('annotation-move-order')).not.toBeInTheDocument();
  });

  it('pawn structure and plans always visible without toggle', () => {
    render(
      <AnnotationCard
        annotation={{ san: 'e4', annotation: 'Test', pawnStructure: 'Open', plans: ['Plan A'] }}
        moveNumber={1}
        isWhite={true}
        visible={true}
      />,
    );
    // Pawn structure and plans are always visible (no toggle needed)
    expect(screen.getByTestId('annotation-pawn-structure')).toBeInTheDocument();
    expect(screen.getByTestId('annotation-plans')).toBeInTheDocument();
    // No toggle when there are no alternatives
    expect(screen.queryByTestId('annotation-toggle')).not.toBeInTheDocument();
  });
});
