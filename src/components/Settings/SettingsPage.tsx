// TODO: WO-SECURITY — Before launch, audit all settings that affect game integrity
// (autoPromoteQueen, moveMethod, etc.) and lock down structural settings.
// Users should only see user-facing preferences. Core settings that could break
// the app experience must be hidden or admin-only.

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { db } from '../../db/schema';
import { exportUserData } from '../../services/dbService';
import { ThemePickerPanel } from '../ui/ThemePickerPanel';
import { SyncSettingsPanel } from './SyncSettingsPanel';
import { VoiceSettingsPanel } from './VoiceSettingsPanel';
import { PieceSoundPanel } from './PieceSoundPanel';
import { FeedbackForm } from '../Feedback/FeedbackForm';
import { encryptApiKey } from '../../services/cryptoService';
import { Link } from 'react-router-dom';

import { BoardGlowButton, BoardGlowSettings } from './BoardGlowSettings';
import { NarrationAuditPanel } from './NarrationAuditPanel';
import { APP_VERSION, BETA_MODE } from '../../utils/constants';
import { hardRefresh } from '../../utils/hardRefresh';
import type { UserProfile, PieceAnimationSpeed, CoachNarration, MoveMethod } from '../../types';
import { resolveCoachNarration } from '../../utils/coachNarration';

type SettingsTab = 'profile' | 'board' | 'coach' | 'appearance' | 'about';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'board', label: 'Board' },
  { id: 'coach', label: 'Coach' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'about', label: 'About' },
];

export function SettingsPage(): JSX.Element {
  const activeProfile = useAppStore((s) => s.activeProfile);
  const setActiveProfile = useAppStore((s) => s.setActiveProfile);
  const [tab, setTab] = useState<SettingsTab>('profile');

  if (!activeProfile) return <></>;

  return (
    <div
      className="flex flex-col gap-6 p-6 flex-1 overflow-y-auto pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="settings-page"
    >
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Tab bar */}
      <div className="flex gap-1 rounded-lg p-1" style={{ background: 'var(--color-bg-secondary)' }}>
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="flex-1 flex items-center justify-center px-3 py-2 rounded-md text-sm font-medium transition-colors"
            style={{
              background: tab === id ? 'var(--color-surface)' : 'transparent',
              color: tab === id ? 'var(--color-text)' : 'var(--color-text-muted)',
            }}
            data-testid={`tab-${id}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div
        className="rounded-xl p-5 border"
        style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      >
        {tab === 'profile' && (
          <ProfileTab profile={activeProfile} setProfile={setActiveProfile} />
        )}
        {tab === 'board' && (
          <BoardGameplayTab profile={activeProfile} setProfile={setActiveProfile} />
        )}
        {tab === 'coach' && (
          <CoachTab profile={activeProfile} setProfile={setActiveProfile} />
        )}
        {tab === 'appearance' && <AppearanceTab />}
        {tab === 'about' && <AboutTab />}
      </div>
    </div>
  );
}

// ─── Shared UI helpers ──────────────────────────────────────────────────────

interface ToggleRowProps {
  label: string;
  tooltip: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
  disabled?: boolean;
}

function ToggleRow({ label, tooltip, checked, onChange, testId, disabled }: ToggleRowProps): JSX.Element {
  return (
    <div className="flex items-center justify-between py-1.5" title={tooltip}>
      <div className="flex flex-col">
        <span className="text-sm">{label}</span>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{tooltip}</span>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="w-4 h-4 accent-current"
        data-testid={testId}
      />
    </div>
  );
}

interface SelectRowProps {
  label: string;
  tooltip: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  testId: string;
  disabled?: boolean;
}

function SelectRow({ label, tooltip, value, options, onChange, testId, disabled }: SelectRowProps): JSX.Element {
  return (
    <div className="flex items-center justify-between py-1.5" title={tooltip}>
      <div className="flex flex-col">
        <span className="text-sm">{label}</span>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{tooltip}</span>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="px-2 py-1 rounded-lg border text-sm"
        style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
        data-testid={testId}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

function SectionHeader({ title }: { title: string }): JSX.Element {
  return (
    <h3
      className="text-xs font-semibold uppercase tracking-wider pt-3 pb-1 border-t"
      style={{ color: 'var(--color-text-muted)', borderColor: 'var(--color-border)' }}
    >
      {title}
    </h3>
  );
}

/** Generic row+modal pattern (matches the PersonalityPanel UI). The
 *  caller renders a single tappable row showing `label` + `summary`;
 *  tapping opens a centered modal with `title` and the children. Used
 *  to consolidate dense Settings sections without dropping detail. */
function SettingsModalRow({
  label,
  summary,
  title,
  children,
  testId,
}: {
  label: string;
  summary: string;
  title: string;
  children: React.ReactNode;
  testId: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center justify-between py-2 px-3 w-full rounded-lg border hover:bg-theme-surface transition-colors"
        style={{ borderColor: 'var(--color-border)' }}
        data-testid={testId}
      >
        <div className="flex flex-col items-start text-left">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {summary}
          </span>
        </div>
        <span style={{ color: 'var(--color-text-muted)' }}>›</span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0, 0, 0, 0.6)' }}
          onClick={() => setOpen(false)}
          data-testid={`${testId}-backdrop`}
        >
          <div
            className="w-full max-w-2xl max-h-[90dvh] overflow-y-auto rounded-2xl border-2 p-4"
            style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }}
            onClick={(e) => e.stopPropagation()}
            data-testid={`${testId}-modal`}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold">{title}</h2>
              <button
                onClick={() => setOpen(false)}
                className="px-2 py-1 rounded-lg hover:bg-theme-surface text-sm"
                aria-label="Close"
                data-testid={`${testId}-close`}
              >
                ✕
              </button>
            </div>
            {children}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Tab Props ────────────────────────────────────────────────────────────────

interface TabProps {
  profile: UserProfile;
  setProfile: (p: UserProfile) => void;
}

// ─── Board & Gameplay Tab ────────────────────────────────────────────────────

function BoardGameplayTab({ profile, setProfile }: TabProps): JSX.Element {
  const prefs = profile.preferences;

  const [highlightLastMove, setHighlightLastMove] = useState(prefs.highlightLastMove);
  const [showLegalMoves, setShowLegalMoves] = useState(prefs.showLegalMoves);
  const [showCoordinates, setShowCoordinates] = useState(prefs.showCoordinates);
  const [pieceAnimationSpeed, setPieceAnimationSpeed] = useState<PieceAnimationSpeed>(prefs.pieceAnimationSpeed);
  const [boardOrientation, setBoardOrientation] = useState(prefs.boardOrientation);

  const [boardColor, setBoardColor] = useState(prefs.boardColor);
  const [pieceSet, setPieceSet] = useState(prefs.pieceSet);

  const [soundEnabled, setSoundEnabled] = useState(prefs.soundEnabled);

  const [showEvalBar, setShowEvalBar] = useState(prefs.showEvalBar);
  const [showEngineLines, setShowEngineLines] = useState(prefs.showEngineLines);

  const [moveQualityFlash, setMoveQualityFlash] = useState(prefs.moveQualityFlash);
  const [showHints, setShowHints] = useState(prefs.showHints);
  const [voiceEnabled, setVoiceEnabled] = useState(prefs.voiceEnabled);

  const [moveMethod, setMoveMethod] = useState<MoveMethod>(prefs.moveMethod);
  const [moveConfirmation, setMoveConfirmation] = useState(prefs.moveConfirmation);
  const [autoPromoteQueen, setAutoPromoteQueen] = useState(prefs.autoPromoteQueen);

  const [masterAllOff, setMasterAllOff] = useState(prefs.masterAllOff);
  const [boardSaveStatus, setBoardSaveStatus] = useState<string | null>(null);
  const [showGlowPanel, setShowGlowPanel] = useState(false);

  const handleToggleMasterOff = (): void => {
    const next = !masterAllOff;
    setMasterAllOff(next);
    if (next) {
      setVoiceEnabled(false);
      setShowHints(false);
      setMoveQualityFlash(false);
      setHighlightLastMove(false);
      setShowLegalMoves(false);
      setPieceAnimationSpeed('none');
    } else {
      // Restore all features when turning Master Off off
      setVoiceEnabled(true);
      setShowHints(true);
      setHighlightLastMove(true);
      setShowLegalMoves(true);
      setPieceAnimationSpeed('medium');
    }
  };

  // Auto-save: persist on every change, debounced 300ms. WO-AUTOSAVE-01:
  // user explicitly asked to drop the Save button — "If user selected
  // it, then save it." The skipFirstSaveRef guard keeps the initial
  // mount (where local state mirrors the loaded prefs) from triggering
  // a phantom write.
  const skipFirstSaveRef = useRef(true);
  useEffect(() => {
    if (skipFirstSaveRef.current) {
      skipFirstSaveRef.current = false;
      return;
    }
    const handle = setTimeout(() => {
      const updatedPrefs = {
        ...profile.preferences,
        highlightLastMove,
        showLegalMoves,
        showCoordinates,
        pieceAnimationSpeed,
        boardOrientation,
        boardColor,
        pieceSet,
        soundEnabled,
        showEvalBar,
        showEngineLines,
        moveQualityFlash,
        showHints,
        voiceEnabled,
        moveMethod,
        moveConfirmation,
        autoPromoteQueen,
        masterAllOff,
      };
      void db.profiles.update(profile.id, { preferences: updatedPrefs }).then(() => {
        setProfile({ ...profile, preferences: updatedPrefs });
        setBoardSaveStatus('Saved ✓');
        setTimeout(() => setBoardSaveStatus(null), 1500);
      });
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    highlightLastMove, showLegalMoves, showCoordinates, pieceAnimationSpeed,
    boardOrientation, boardColor, pieceSet, soundEnabled, showEvalBar,
    showEngineLines, moveQualityFlash, showHints, voiceEnabled, moveMethod,
    moveConfirmation, autoPromoteQueen, masterAllOff,
  ]);

  const affectedByMaster = masterAllOff;

  return (
    <div className="space-y-2" data-testid="board-tab">
      {/* Master All Off */}
      <button
        onClick={handleToggleMasterOff}
        className="w-full py-3 rounded-lg text-sm font-bold transition-colors"
        style={{
          background: masterAllOff ? 'var(--color-error)' : 'var(--color-bg)',
          color: masterAllOff ? '#fff' : 'var(--color-text)',
          border: masterAllOff ? 'none' : '1px solid var(--color-border)',
        }}
        data-testid="master-all-off-toggle"
      >
        {masterAllOff ? 'Master Off — All Features Disabled' : 'Master All Off'}
      </button>
      {masterAllOff && (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Voice, hints, move flash, highlights, legal moves, and animations are disabled.
          Sound and theme are unaffected. Turning Master Off back to normal restores
          your previous values for each affected setting (not the defaults).
        </p>
      )}

      {/* Board Display */}
      <SectionHeader title="Board Display" />
      <ToggleRow
        label="Highlight Last Move"
        tooltip="Show yellow highlight on the last move's from/to squares"
        checked={highlightLastMove}
        onChange={setHighlightLastMove}
        testId="highlight-last-move-toggle"
        disabled={affectedByMaster}
      />
      <ToggleRow
        label="Show Legal Moves"
        tooltip="Show dots on valid squares when a piece is selected"
        checked={showLegalMoves}
        onChange={setShowLegalMoves}
        testId="show-legal-moves-toggle"
        disabled={affectedByMaster}
      />
      <ToggleRow
        label="Show Coordinates"
        tooltip="Display a-h and 1-8 rank/file labels on the board"
        checked={showCoordinates}
        onChange={setShowCoordinates}
        testId="show-coordinates-toggle"
      />
      <SelectRow
        label="Piece Animation"
        tooltip="Speed of piece movement animation"
        value={pieceAnimationSpeed}
        options={[
          { value: 'none', label: 'None — Instant moves' },
          { value: 'fast', label: 'Fast — Quick slide' },
          { value: 'medium', label: 'Medium — Balanced' },
          { value: 'slow', label: 'Slow — Easy to follow' },
        ]}
        onChange={(v) => setPieceAnimationSpeed(v as PieceAnimationSpeed)}
        testId="animation-speed-select"
        disabled={affectedByMaster}
      />
      {/* "White on Bottom" toggle removed — board orientation is
          already correctly driven per-game by the active opening's
          studentSide (Black-defender openings flip the board, etc.).
          The field stays on UserPreferences for migration; no UI. */}

      {/* Board Appearance */}
      <SectionHeader title="Board Appearance" />
      <SelectRow
        label="Board Color"
        tooltip="Color scheme for the board squares"
        value={boardColor}
        options={[
          { value: 'classic', label: 'Classic' },
          { value: 'tournament', label: 'Tournament' },
          { value: 'green', label: 'Green' },
          { value: 'blue', label: 'Blue' },
          { value: 'purple', label: 'Purple' },
          { value: 'wood', label: 'Wood' },
          { value: 'ice', label: 'Ice' },
          { value: 'coral', label: 'Coral' },
          { value: 'neon', label: 'Neon' },
        ]}
        onChange={setBoardColor}
        testId="board-color-select"
      />
      <SelectRow
        label="Piece Set"
        tooltip="Visual style of chess pieces"
        value={pieceSet}
        options={[
          { value: 'staunton', label: 'Staunton' },
          { value: 'neo', label: 'Neo' },
          { value: 'alpha', label: 'Alpha' },
          { value: 'merida', label: 'Merida' },
          { value: 'california', label: 'California' },
          { value: 'cardinal', label: 'Cardinal' },
          { value: 'tatiana', label: 'Tatiana' },
          { value: 'pixel', label: 'Pixel' },
          { value: 'horsey', label: 'Horsey' },
          { value: 'letter', label: 'Letter' },
        ]}
        onChange={setPieceSet}
        testId="piece-set-select"
      />

      {/* Board Glow */}
      <SectionHeader title="Neon Glow" />
      {!showGlowPanel ? (
        <BoardGlowButton onClick={() => setShowGlowPanel(true)} />
      ) : (
        <div className="space-y-3">
          <BoardGlowSettings />
          <button
            onClick={() => setShowGlowPanel(false)}
            className="w-full py-1.5 text-xs font-medium rounded-lg transition-colors hover:opacity-80"
            style={{ color: 'var(--color-text-muted)' }}
            data-testid="collapse-glow-btn"
          >
            Collapse
          </button>
        </div>
      )}

      {/* Audio */}
      <SectionHeader title="Audio" />
      <ToggleRow
        label="Sound Effects"
        tooltip="Play sounds on piece moves, captures, and checks"
        checked={soundEnabled}
        onChange={setSoundEnabled}
        testId="sound-toggle"
      />

      {/* Engine */}
      <SectionHeader title="Engine" />
      <ToggleRow
        label="Eval Bar"
        tooltip="Show the Stockfish evaluation bar alongside the board"
        checked={showEvalBar}
        onChange={setShowEvalBar}
        testId="eval-bar-toggle"
      />
      <ToggleRow
        label="Engine Lines"
        tooltip="Display computer analysis lines during play"
        checked={showEngineLines}
        onChange={setShowEngineLines}
        testId="engine-lines-toggle"
      />

      {/* Piece Sound — WO-COACH-PIECE-SOUND-CUSTOM */}
      <div className="pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
        <PieceSoundPanel />
      </div>

      {/* Feedback & Coaching */}
      <SectionHeader title="Feedback & Coaching" />
      <ToggleRow
        label="Move Quality Flash"
        tooltip="Board border flashes green/yellow/red based on move quality"
        checked={moveQualityFlash}
        onChange={setMoveQualityFlash}
        testId="move-quality-flash-toggle"
        disabled={affectedByMaster}
      />
      <ToggleRow
        label="Show Hints"
        tooltip="Allow hint button to appear during play and drills"
        checked={showHints}
        onChange={setShowHints}
        testId="show-hints-toggle"
        disabled={affectedByMaster}
      />
      <ToggleRow
        label="All audio voice"
        tooltip="Master gate for ALL spoken voice in the app. Coach voice can be silenced separately on the Coach tab — this controls every voice surface (opening walkthroughs, phase narration, etc.)."
        checked={voiceEnabled}
        onChange={setVoiceEnabled}
        testId="voice-narration-toggle"
        disabled={affectedByMaster}
      />

      {/* Game Behavior */}
      <SectionHeader title="Game Behavior" />
      <SelectRow
        label="Move Method"
        tooltip="How to move pieces: drag, click, or both"
        value={moveMethod}
        options={[
          { value: 'drag', label: 'Drag Only' },
          { value: 'click', label: 'Click Only' },
          { value: 'both', label: 'Both' },
        ]}
        onChange={(v) => setMoveMethod(v as MoveMethod)}
        testId="move-method-select"
      />
      {/* "Move Confirmation" and "Auto-Promote to Queen" toggles
          removed pending feature work:
            - Move Confirmation needs a confirm/cancel overlay flow
              wired through useChessGame (delay commit until confirm).
            - Auto-Promote to Queen needs a promotion picker UI (modal
              with N/B/R/Q choices). Today every promotion is queen.
          Fields stay on UserPreferences for migration. Re-expose the
          toggles when the supporting UI ships. */}

      {boardSaveStatus && (
        <p className="text-sm font-medium mt-2" style={{ color: 'var(--color-accent)' }} data-testid="board-save-status">
          {boardSaveStatus}
        </p>
      )}
    </div>
  );
}

// ─── Profile Tab ─────────────────────────────────────────────────────────────

function ProfileTab({ profile, setProfile }: TabProps): JSX.Element {
  const [name, setName] = useState(profile.name);
  const [elo, setElo] = useState(profile.currentRating);
  const [dailyMin, setDailyMin] = useState(profile.preferences.dailySessionMinutes);
  const [profileSaveStatus, setProfileSaveStatus] = useState<string | null>(null);

  // Auto-save profile on change, debounced 400ms (slightly longer than
  // Board because the name/elo inputs fire on every keystroke). The
  // skipFirstSaveProfileRef gates the initial mount.
  const skipFirstSaveProfileRef = useRef(true);
  useEffect(() => {
    if (skipFirstSaveProfileRef.current) {
      skipFirstSaveProfileRef.current = false;
      return;
    }
    const handle = setTimeout(() => {
      const updated = {
        ...profile,
        name,
        currentRating: elo,
        preferences: { ...profile.preferences, dailySessionMinutes: dailyMin },
      };
      void db.profiles.update(profile.id, {
        name,
        currentRating: elo,
        preferences: updated.preferences,
      }).then(() => {
        setProfile(updated);
        setProfileSaveStatus('Saved ✓');
        setTimeout(() => setProfileSaveStatus(null), 1500);
      });
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, elo, dailyMin]);

  const handleExport = async (): Promise<void> => {
    const data = await exportUserData();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chess-academy-backup.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4" data-testid="profile-tab">
      <div>
        <label className="text-xs font-medium block mb-1" style={{ color: 'var(--color-text-muted)' }}>Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border text-sm"
          style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          data-testid="name-input"
        />
      </div>
      <div>
        <label className="text-xs font-medium block mb-1" style={{ color: 'var(--color-text-muted)' }}>ELO Rating</label>
        <input
          type="number"
          value={elo}
          onChange={(e) => setElo(Number(e.target.value))}
          className="w-full px-3 py-2 rounded-lg border text-sm"
          style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          data-testid="elo-input"
        />
      </div>
      <div>
        <label className="text-xs font-medium block mb-1" style={{ color: 'var(--color-text-muted)' }}>Daily Session (min)</label>
        <select
          value={dailyMin}
          onChange={(e) => setDailyMin(Number(e.target.value))}
          className="w-full px-3 py-2 rounded-lg border text-sm"
          style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          data-testid="daily-min-select"
        >
          {[15, 30, 45, 60, 90].map((m) => (
            <option key={m} value={m}>{m} minutes</option>
          ))}
        </select>
      </div>
      {profileSaveStatus && (
        <p className="text-sm font-medium" style={{ color: 'var(--color-accent)' }} data-testid="profile-save-status">
          {profileSaveStatus}
        </p>
      )}
      <button
        onClick={() => void handleExport()}
        className="w-full py-2 rounded-lg text-sm font-medium border"
        style={{ borderColor: 'var(--color-border)' }}
        data-testid="export-data-btn"
      >
        Export Data
      </button>

      <div className="pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
        <SyncSettingsPanel />
      </div>

      <div className="pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
        <LichessTokenPanel profile={profile} setProfile={setProfile} />
      </div>
    </div>
  );
}

// ─── Coach Tab ───────────────────────────────────────────────────────────────

function CoachTab({ profile, setProfile }: TabProps): JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [provider, setProvider] = useState<'deepseek' | 'anthropic'>(profile.preferences.aiProvider);
  const [budgetCap, setBudgetCap] = useState<number | null>(profile.preferences.monthlyBudgetCap);
  const [commentaryModel, setCommentaryModel] = useState(profile.preferences.preferredModel.commentary);
  const [analysisModel, setAnalysisModel] = useState(profile.preferences.preferredModel.analysis);
  const [reportsModel, setReportsModel] = useState(profile.preferences.preferredModel.reports);
  const [status, setStatus] = useState<string | null>(null);
  const [keySaved, setKeySaved] = useState(false);

  const isAnthropic = provider === 'anthropic';
  const hasExistingKey = isAnthropic
    ? Boolean(profile.preferences.anthropicApiKeyEncrypted)
    : Boolean(profile.preferences.apiKeyEncrypted);

  const modelOptions = isAnthropic
    ? [
        { value: 'claude-haiku-4-5-20251001', label: 'Haiku (fastest)' },
        { value: 'claude-sonnet-4-6', label: 'Sonnet (balanced)' },
        { value: 'claude-opus-4-6', label: 'Opus (best)' },
      ]
    : [
        { value: 'deepseek-chat', label: 'DeepSeek V3 (fast)' },
        { value: 'deepseek-reasoner', label: 'DeepSeek R1 (reasoning)' },
      ];

  const handleProviderChange = async (newProvider: 'deepseek' | 'anthropic'): Promise<void> => {
    setProvider(newProvider);
    const updatedPrefs = { ...profile.preferences, aiProvider: newProvider };
    await db.profiles.update(profile.id, { preferences: updatedPrefs });
    setProfile({ ...profile, preferences: updatedPrefs });
    // R7 (audit): do NOT clear the input on provider switch. The
    // encrypted key for each provider is stored independently
    // (`apiKey{Encrypted,Iv}` for DeepSeek, `anthropicApiKey{...}` for
    // Anthropic), so nothing is lost — and silently clearing the input
    // hid that fact. The label below already shows "(saved)" when a
    // key is present for the active provider; the placeholder shows
    // "••••••••" so the user can tell at a glance. If they want to
    // replace the key, typing into the input still does the right
    // thing.
    setShowKey(false);
  };

  const handleSaveApiKey = async (): Promise<void> => {
    if (!apiKey.trim()) return;
    try {
      const { encrypted, iv } = await encryptApiKey(apiKey.trim());
      // Always write aiProvider atomically with the key so the coach never reads
      // a mismatched provider/key pair after a rapid toggle-then-save sequence.
      const updatedPrefs = isAnthropic
        ? { ...profile.preferences, aiProvider: 'anthropic' as const, anthropicApiKeyEncrypted: encrypted, anthropicApiKeyIv: iv }
        : { ...profile.preferences, aiProvider: 'deepseek' as const, apiKeyEncrypted: encrypted, apiKeyIv: iv };
      await db.profiles.update(profile.id, { preferences: updatedPrefs });
      setProfile({ ...profile, preferences: updatedPrefs });
      setApiKey('');
      setKeySaved(true);
      setStatus('API key saved ✓');
      setTimeout(() => setKeySaved(false), 4000);
    } catch (err) {
      console.error('[Settings] Failed to save API key:', err);
      setStatus('Error saving key');
    }
    setTimeout(() => setStatus(null), 4000);
  };

  // Auto-save coach budget + model selections, debounced 300ms. The
  // API key path stays explicit (encrypted, requires non-empty input)
  // — only the dropdowns / number inputs auto-save.
  const skipFirstSaveCoachRef = useRef(true);
  useEffect(() => {
    if (skipFirstSaveCoachRef.current) {
      skipFirstSaveCoachRef.current = false;
      return;
    }
    const handle = setTimeout(() => {
      const updatedPrefs = {
        ...profile.preferences,
        monthlyBudgetCap: budgetCap,
        preferredModel: {
          commentary: commentaryModel,
          analysis: analysisModel,
          reports: reportsModel,
        },
      };
      void db.profiles.update(profile.id, { preferences: updatedPrefs }).then(() => {
        setProfile({ ...profile, preferences: updatedPrefs });
        setStatus('Saved ✓');
        setTimeout(() => setStatus(null), 1500);
      });
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgetCap, commentaryModel, analysisModel, reportsModel]);

  // WO-SETTINGS-CLEANUP — collapse the dense Coach tab into three top-
  // level rows (each opens a modal containing the original block) plus
  // the Voice & Personality panel. Nothing about the underlying
  // controls / handlers / persistence changed; this is purely a UI
  // re-arrangement.
  // Live summaries on each modal row so the user sees the actual
  // current selection without having to open the modal. WO-AUTOSAVE-01.
  const aiSummary = `${isAnthropic ? 'Anthropic' : 'DeepSeek'}${hasExistingKey ? ' · key saved' : ''}`;
  const coachNarrationLabels: Record<string, string> = {
    silent: 'Silent',
    brief: 'Brief',
    full: 'Full',
  };
  const narrationValue = resolveCoachNarration(profile.preferences);
  const tacticAlerts = profile.preferences.coachTacticAlerts !== false ? 'Tactic alerts on' : 'Tactic alerts off';
  const gameplaySummary = `${coachNarrationLabels[narrationValue]} narration · ${tacticAlerts}`;

  return (
    <div className="space-y-3" data-testid="coach-tab">
      {/* Row 1: AI Provider & Models — modal */}
      <SettingsModalRow
        label="AI Provider & Models"
        summary={aiSummary}
        title="AI Provider & Models"
        testId="ai-provider-row"
      >
        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--color-text-muted)' }}>
              AI Provider
            </label>
            <div className="flex rounded-lg border overflow-hidden" style={{ borderColor: 'var(--color-border)' }} data-testid="provider-toggle">
              {(['deepseek', 'anthropic'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => void handleProviderChange(p)}
                  className="flex-1 px-4 py-2 text-sm font-medium transition-colors"
                  style={{
                    background: provider === p ? 'var(--color-accent)' : 'var(--color-bg)',
                    color: provider === p ? 'var(--color-bg)' : 'var(--color-text)',
                  }}
                  data-testid={`provider-${p}`}
                >
                  {p === 'deepseek' ? 'DeepSeek' : 'Anthropic'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--color-text-muted)' }}>
              {isAnthropic ? 'Anthropic' : 'DeepSeek'} API Key {hasExistingKey && '(saved)'}
            </label>
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={hasExistingKey ? '••••••••' : (isAnthropic ? 'sk-ant-...' : 'sk-...')}
                className="flex-1 px-3 py-2 rounded-lg border text-sm"
                style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                data-testid="api-key-input"
              />
              <button onClick={() => setShowKey((s) => !s)} className="px-3 py-2 rounded-lg border text-xs" style={{ borderColor: 'var(--color-border)' }}>
                {showKey ? 'Hide' : 'Show'}
              </button>
              <button
                onClick={() => void handleSaveApiKey()}
                className="px-4 py-2 rounded-lg text-sm font-medium"
                style={{
                  background: keySaved ? '#16a34a' : 'var(--color-accent)',
                  color: 'var(--color-bg)',
                  transition: 'background 0.3s',
                }}
                data-testid="save-api-key-btn"
              >
                {keySaved ? 'Saved ✓' : 'Save'}
              </button>
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              {isAnthropic ? 'Get a key at console.anthropic.com' : 'Get a key at platform.deepseek.com'}
            </p>
          </div>

          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--color-text-muted)' }}>Monthly Budget Cap ($)</label>
            <input
              type="number"
              value={budgetCap ?? ''}
              onChange={(e) => setBudgetCap(e.target.value ? Number(e.target.value) : null)}
              placeholder="No limit"
              className="w-full px-3 py-2 rounded-lg border text-sm"
              style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
              data-testid="budget-input"
            />
          </div>
          <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Estimated spend this month: ${profile.preferences.estimatedSpend.toFixed(2)}
          </div>

          {[
            { label: 'Commentary Model', value: commentaryModel, setter: setCommentaryModel, testId: 'model-commentary' },
            { label: 'Analysis Model', value: analysisModel, setter: setAnalysisModel, testId: 'model-analysis' },
            { label: 'Reports Model', value: reportsModel, setter: setReportsModel, testId: 'model-reports' },
          ].map(({ label, value, setter, testId }) => (
            <div key={testId}>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--color-text-muted)' }}>{label}</label>
              <select
                value={value}
                onChange={(e) => setter(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm"
                style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                data-testid={testId}
              >
                {modelOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          ))}

          {status && <p className="text-sm font-medium" style={{ color: 'var(--color-accent)' }}>{status}</p>}
        </div>
      </SettingsModalRow>

      {/* Row 2: Gameplay Coaching — modal containing CoachGameplaySection */}
      <SettingsModalRow
        label="Gameplay Coaching"
        summary={gameplaySummary}
        title="Gameplay Coaching"
        testId="gameplay-coaching-row"
      >
        <CoachGameplaySection profile={profile} setProfile={setProfile} />
      </SettingsModalRow>

      {/* Row 3 (inline): Voice & Personality. PersonalityPanel is now
       *  rendered INSIDE VoiceSettingsPanel between the Coach Voice
       *  toggle and the Cloud Voice section, per WO-SETTINGS-CLEANUP. */}
      <div className="pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
        <VoiceSettingsPanel />
      </div>
    </div>
  );
}

// ─── Coach Gameplay Section ──────────────────────────────────────────────────

function CoachGameplaySection({ profile, setProfile }: TabProps): JSX.Element {
  const handleToggle = async (key: 'coachBlunderAlerts' | 'coachTacticAlerts' | 'coachPositionalTips' | 'coachMissedTacticTakeback' | 'coachReviewVoice', value: boolean): Promise<void> => {
    const updatedPrefs = { ...profile.preferences, [key]: value };
    await db.profiles.update(profile.id, { preferences: updatedPrefs });
    setProfile({ ...profile, preferences: updatedPrefs });
  };

  const handleCoachNarrationChange = async (value: CoachNarration): Promise<void> => {
    const updatedPrefs = { ...profile.preferences, coachNarration: value };
    await db.profiles.update(profile.id, { preferences: updatedPrefs });
    setProfile({ ...profile, preferences: updatedPrefs });
  };

  return (
    <div className="pt-4 border-t space-y-1" style={{ borderColor: 'var(--color-border)' }}>
      <SectionHeader title="Gameplay Coaching" />
      <SelectRow
        label="Coach Narration"
        tooltip="One setting for how much the coach speaks across every surface — per-move during play, phase transitions, Learn-with-Coach walkthroughs, and tactic alerts. Silent: no spoken narration anywhere. Brief: short narration only (key moments + first-sentence summaries on walkthroughs). Full: legacy behavior — coach talks freely."
        value={resolveCoachNarration(profile.preferences)}
        options={[
          { value: 'silent', label: 'Silent — No spoken narration anywhere' },
          { value: 'brief', label: 'Brief — Short narration only' },
          { value: 'full', label: 'Full — Coach talks freely (default)' },
        ]}
        onChange={(v) => void handleCoachNarrationChange(v as CoachNarration)}
        testId="coach-narration-select"
      />
      {/* Legacy coachVerbosity + coachCommentaryVerbosity UIs removed.
          The fields stay on UserPreferences and are read by
          resolveCoachNarration() and resolveVerbosity() as a migration
          fallback for profiles that predate the unified setting. */}
      <ToggleRow
        label="Blunder Alerts"
        tooltip="Coach alerts you when your opponent makes a big mistake"
        checked={profile.preferences.coachBlunderAlerts ?? true}
        onChange={(v) => void handleToggle('coachBlunderAlerts', v)}
        testId="coach-blunder-alerts-toggle"
      />
      <ToggleRow
        label="Tactic Alerts"
        tooltip="Coach points out available tactics during play"
        checked={profile.preferences.coachTacticAlerts ?? true}
        onChange={(v) => void handleToggle('coachTacticAlerts', v)}
        testId="coach-tactic-alerts-toggle"
      />
      <ToggleRow
        label="Positional Tips"
        tooltip="Development reminders, center tension, endgame tips"
        checked={profile.preferences.coachPositionalTips ?? true}
        onChange={(v) => void handleToggle('coachPositionalTips', v)}
        testId="coach-positional-tips-toggle"
      />
      <ToggleRow
        label="Missed Tactic Takeback"
        tooltip="Coach suggests taking back when you miss a tactic"
        checked={profile.preferences.coachMissedTacticTakeback ?? true}
        onChange={(v) => void handleToggle('coachMissedTacticTakeback', v)}
        testId="coach-missed-tactic-toggle"
      />
      <ToggleRow
        label="Review Voice Narration"
        tooltip="Speak coach commentary aloud during game review"
        checked={profile.preferences.coachReviewVoice ?? true}
        onChange={(v) => void handleToggle('coachReviewVoice', v)}
        testId="coach-review-voice-toggle"
      />
    </div>
  );
}

// ─── Appearance Tab ──────────────────────────────────────────────────────────

function AppearanceTab(): JSX.Element {
  return (
    <div className="space-y-4" data-testid="appearance-tab">
      <ThemePickerPanel />
    </div>
  );
}

// ─── Lichess Token Panel ──────────────────────────────────────────────────────

function LichessTokenPanel({ profile, setProfile }: TabProps): JSX.Element {
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const hasToken = Boolean(profile.preferences.lichessTokenEncrypted);

  const handleSave = async (): Promise<void> => {
    if (!token.trim()) return;
    try {
      const { encryptApiKey } = await import('../../services/cryptoService');
      const { encrypted, iv } = await encryptApiKey(token.trim());
      const updatedPrefs = {
        ...profile.preferences,
        lichessTokenEncrypted: encrypted,
        lichessTokenIv: iv,
      };
      await db.profiles.update(profile.id, { preferences: updatedPrefs });
      setProfile({ ...profile, preferences: updatedPrefs });
      setToken('');
      setStatus('Token saved ✓');
    } catch {
      setStatus('Error saving token');
    }
    setTimeout(() => setStatus(null), 3000);
  };

  const handleClear = async (): Promise<void> => {
    const updatedPrefs = {
      ...profile.preferences,
      lichessTokenEncrypted: null,
      lichessTokenIv: null,
    };
    await db.profiles.update(profile.id, { preferences: updatedPrefs });
    setProfile({ ...profile, preferences: updatedPrefs });
    setStatus('Token removed');
    setTimeout(() => setStatus(null), 2000);
  };

  return (
    <div className="space-y-3" data-testid="lichess-token-panel">
      <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
        Lichess Integration
      </h3>
      <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
        Optional personal API token for puzzle dashboard and activity sync.{' '}
        <a
          href="https://lichess.org/account/oauth/token/create?scopes[]=puzzle:read&description=Chess+Academy+Pro"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Create token at lichess.org
        </a>
      </p>
      <div className="flex gap-2">
        <input
          type={showToken ? 'text' : 'password'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={hasToken ? 'Token saved (••••••••)' : 'lip_...'}
          className="flex-1 px-3 py-2 rounded-lg border text-sm"
          style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          data-testid="lichess-token-input"
        />
        <button
          onClick={() => setShowToken((s) => !s)}
          className="px-3 py-2 rounded-lg border text-xs"
          style={{ borderColor: 'var(--color-border)' }}
        >
          {showToken ? 'Hide' : 'Show'}
        </button>
        <button
          onClick={() => void handleSave()}
          disabled={!token.trim()}
          className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
          style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
          data-testid="save-lichess-token-btn"
        >
          Save
        </button>
      </div>
      {hasToken && (
        <div className="flex items-center justify-between">
          <Link
            to="/tactics/lichess"
            className="text-xs underline"
            style={{ color: 'var(--color-accent)' }}
          >
            View Puzzle Dashboard →
          </Link>
          <button
            onClick={() => void handleClear()}
            className="text-xs"
            style={{ color: 'var(--color-text-muted)' }}
            data-testid="clear-lichess-token-btn"
          >
            Remove token
          </button>
        </div>
      )}
      {status && (
        <p className="text-xs font-medium" style={{ color: 'var(--color-accent)' }} data-testid="lichess-token-status">
          {status}
        </p>
      )}
    </div>
  );
}

// ─── About Tab ───────────────────────────────────────────────────────────────

function AboutTab(): JSX.Element {
  const [confirmReset, setConfirmReset] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const handleReset = async (): Promise<void> => {
    await db.delete();
    window.location.reload();
  };

  const handleHardRefresh = async (): Promise<void> => {
    setRefreshing(true);
    await hardRefresh();
  };

  return (
    <div className="space-y-4" data-testid="about-tab">
      <div>
        <div className="text-lg font-bold">Chess Academy Pro</div>
        <div className="flex items-center gap-2">
          <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>v{APP_VERSION}</div>
          {BETA_MODE && (
            <span className="px-1.5 py-0.5 rounded text-xs font-bold"
              style={{ background: 'var(--color-warning)', color: '#000' }}>
              BETA
            </span>
          )}
        </div>
      </div>
      <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
        Built with React, TypeScript, Vite, Tailwind CSS, chess.js, Stockfish WASM, Dexie.js, Zustand, and Claude API.
      </div>
      <div className="pt-4 border-t space-y-3" style={{ borderColor: 'var(--color-border)' }}>
        {/* Feedback button — primary post-launch signal. Placed at top
            of the action list so users see it immediately when they
            open Settings → About. */}
        {!feedbackOpen ? (
          <div>
            <button
              onClick={() => setFeedbackOpen(true)}
              className="w-full py-2 rounded-lg text-sm font-medium border"
              style={{
                background: 'var(--color-surface)',
                color: 'var(--color-text)',
                borderColor: 'var(--color-accent)',
              }}
              data-testid="open-feedback-btn"
            >
              Send Feedback
            </button>
            <p className="text-xs mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
              Bug report, feature request, or a note — opens your mail app
              with a pre-filled message.
            </p>
          </div>
        ) : (
          <div
            className="rounded-lg border overflow-hidden"
            style={{
              background: 'var(--color-bg)',
              borderColor: 'var(--color-border)',
            }}
          >
            <FeedbackForm onClose={() => setFeedbackOpen(false)} />
          </div>
        )}
        <div>
          <button
            onClick={() => void handleHardRefresh()}
            disabled={refreshing}
            className="w-full py-2 rounded-lg text-sm font-medium disabled:opacity-60"
            style={{ background: 'var(--color-accent)', color: '#fff' }}
            data-testid="hard-refresh-btn"
          >
            {refreshing ? 'Refreshing…' : 'Check for Updates'}
          </button>
          <p className="text-xs mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
            Clears cached assets and reloads to pull the latest version. Your data is kept.
          </p>
        </div>
        {!confirmReset ? (
          <button
            onClick={() => setConfirmReset(true)}
            className="w-full py-2 rounded-lg text-sm font-medium"
            style={{ background: 'var(--color-error)', color: '#fff' }}
            data-testid="reset-btn"
          >
            Reset All Data
          </button>
        ) : (
          <button
            onClick={() => void handleReset()}
            className="w-full py-2 rounded-lg text-sm font-medium"
            style={{ background: 'var(--color-error)', color: '#fff' }}
            data-testid="confirm-reset-btn"
          >
            Are you sure? This cannot be undone.
          </button>
        )}
      </div>

      {/* Diagnostics & audit log — the one-stop diagnostic panel for
          the whole app (WO-COACH-UNIFY-01). Surfaces:
            - The unified audit log (narration / runtime / subsystem /
              app + virtual 'spine' filter for unified-coach activity)
            - Lichess health probe button
            - Live voice diagnostic snapshot (Polly tier, audio
              context state, last error)
            - Audit-stream toggle (POST every audit to
              /api/audit-stream so Claude can watch in near-real time)
            - "Copy for Claude" — markdown export of the visible
              findings for pasting into a Claude Code session. */}
      <div className="pt-4 border-t space-y-2" style={{ borderColor: 'var(--color-border)' }}>
        <div className="text-sm font-medium">Diagnostics &amp; audit log</div>
        <NarrationAuditPanel />
      </div>
    </div>
  );
}
