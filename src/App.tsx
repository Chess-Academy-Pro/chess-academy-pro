import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAppStore } from './stores/appStore';
import { getOrCreateMainProfile } from './services/dbService';
import { getThemeById, applyTheme } from './services/themeService';
import { seedDatabase } from './services/dataLoader';
import { seedPuzzles } from './services/puzzleService';
import { runAutoImportIfDue } from './services/autoImportScheduler';
import { getSharedAudioContext } from './services/audioContextManager';
import { speechService } from './services/speechService';
import { voiceService } from './services/voiceService';
import { db } from './db/schema';
import { installGlobalErrorHooks, installConsoleBackdoor, logAppAudit, loadAuditStreamConfig } from './services/appAuditor';
import { emitAppBootAudit } from './services/appBootAudit';
import { AppLayout } from './components/ui/AppLayout';
import { LoadingScreen } from './components/ui/LoadingScreen';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { BuildVersionWidget } from './components/Debug/BuildVersionWidget';

// Page-level imports
import { DashboardPage } from './components/Dashboard/DashboardPage';
import { OpeningExplorerPage } from './components/Openings/OpeningExplorerPage';
import { OpeningDetailPage } from './components/Openings/OpeningDetailPage';
import { PuzzleTrainerPage } from './components/Puzzles/PuzzleTrainerPage';
import { AdaptivePuzzlePage } from './components/Puzzles/AdaptivePuzzlePage';
import { MyMistakesPage } from './components/Puzzles/MyMistakesPage';
import { LichessDashboardPage } from './components/Puzzles/LichessDashboardPage';
import { WeaknessPuzzlePage } from './components/Puzzles/WeaknessPuzzlePage';
import { WeaknessThemesPage } from './components/Puzzles/WeaknessThemesPage';
// PuzzlesHubPage removed — Puzzles tab merged into Tactics
import { CoachGamePage } from './components/Coach/CoachGamePage';
import { CoachChatPage } from './components/Coach/CoachChatPage';
import { CoachSessionPage } from './components/Coach/CoachSessionPage';
import { CoachAnalysePage } from './components/Coach/CoachAnalysePage';
import { CoachSessionPlanPage } from './components/Coach/CoachSessionPlanPage';
import { GameInsightsPage } from './components/Insights/GameInsightsPage';
import { CoachTrainPage } from './components/Coach/CoachTrainPage';
import { CoachTeachPage } from './components/Coach/CoachTeachPage';
import { CoachEndgamePage } from './components/Coach/CoachEndgamePage';
import { CoachReviewListPage } from './components/Coach/CoachReviewListPage';
import { CoachReviewSessionPage } from './components/Coach/CoachReviewSessionPage';
import { CoachPage } from './components/Coach/CoachPage';
import { TacticsPage } from './components/Tactics/TacticsPage';
import { TacticalProfilePage } from './components/Tactics/TacticalProfilePage';
import { TacticDrillPage } from './components/Tactics/TacticDrillPage';
import { TacticSetupPage } from './components/Tactics/TacticSetupPage';
import { TacticCreatePage } from './components/Tactics/TacticCreatePage';
import { SettingsPage } from './components/Settings/SettingsPage';
import { OnboardingPage } from './components/Settings/OnboardingPage';
import { GameDatabasePage } from './components/Games/GameDatabasePage';
import { ImportPage } from './components/Games/ImportPage';
import { ProPlayerPage } from './components/Openings/ProPlayerPage';
import { KidLayout } from './components/Kid/KidLayout';
import { KidModePage } from './components/Kid/KidModePage';
import { KidPiecePage } from './components/Kid/KidPiecePage';
import { JourneyMapPage } from './components/Kid/JourneyMapPage';
import { JourneyChapterPage } from './components/Kid/JourneyChapterPage';
import { FairyTaleMapPage } from './components/Kid/FairyTaleMapPage';
import { FairyTaleChapterPage } from './components/Kid/FairyTaleChapterPage';
import { RookGamesPage } from './components/Kid/RookGamesPage';
import { RookMazePage } from './components/Kid/RookMazePage';
import { RowClearerPage } from './components/Kid/RowClearerPage';
import { MiniGameHubPage } from './components/Kid/MiniGameHubPage';
import { MiniGamePage } from './components/Kid/MiniGamePage';
import { KingEscapeGame } from './components/Kid/KingEscapeGame';
import { KingMarchGame } from './components/Kid/KingMarchGame';
import { KnightGamesPage } from './components/Kid/KnightGamesPage';
import { LeapFrogGame } from './components/Kid/LeapFrogGame';
import { KnightSweepGame } from './components/Kid/KnightSweepGame';
import { QueenGamesHub } from './components/Kid/QueenGamesHub';
import { KidPuzzlePage } from './components/Kid/KidPuzzlePage';
import { GuidedGameHubPage } from './components/Kid/GuidedGameHubPage';
import { GuidedGamePage } from './components/Kid/GuidedGamePage';
import { NeonBoardMock } from './components/Board/NeonBoardMock';
import { DebugAuditPage } from './components/Debug/DebugAuditPage';
import { OpeningBlundersPage } from './components/Debug/OpeningBlundersPage';

export function App(): JSX.Element {
  const { isLoading, setLoading, setActiveProfile, setActiveTheme, activeProfile } =
    useAppStore();
  const [onboardingSkipped, setOnboardingSkipped] = useState(true);

  // Unlock Web Speech API on first user gesture (required on iOS/WKWebView)
  useEffect(() => {
    const unlock = (): void => {
      speechService.warmupInGestureContext();
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('click', unlock);
    };
    document.addEventListener('touchstart', unlock, { once: true });
    document.addEventListener('click', unlock, { once: true });
    return () => {
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('click', unlock);
    };
  }, []);

  // Install window.onerror + unhandledrejection hooks so any runtime
  // failure flows into the same audit log as narration findings and
  // subsystem errors. One place to look post-launch.
  useEffect(() => {
    const uninstall = installGlobalErrorHooks();
    // Register the __AUDIT__ DevTools back-door alongside. Also
    // available via the /debug/audit route.
    installConsoleBackdoor();
    // WO-DEEP-DIAGNOSTICS — capture install / runtime context once
    // per tab session so production reports name the build, the
    // standalone mode, the SW state, and the network status at boot.
    emitAppBootAudit();

    // Audit-tool: periodic memory pressure snapshot. Chrome exposes
    // `performance.memory` (non-standard but widely available). When
    // a tab crashes, the audit log usually has nothing in the last
    // seconds before the crash because nothing happened to log. A
    // 30 s heartbeat with heap stats means the next crash-report
    // dump CAN show the memory ramp leading up to the crash, not
    // just the silence right before it. ~120 rows per hour of use,
    // negligible IndexedDB load.
    const memInterval = window.setInterval(() => {
      const perf = performance as Performance & {
        memory?: {
          jsHeapSizeLimit: number;
          totalJSHeapSize: number;
          usedJSHeapSize: number;
        };
      };
      const mem = perf.memory;
      if (!mem) return;
      const usedMb = Math.round(mem.usedJSHeapSize / (1024 * 1024));
      const totalMb = Math.round(mem.totalJSHeapSize / (1024 * 1024));
      const limitMb = Math.round(mem.jsHeapSizeLimit / (1024 * 1024));
      void logAppAudit({
        kind: 'memory-snapshot',
        category: 'subsystem',
        source: 'App.memoryAuditInterval',
        summary: `heap used=${usedMb}MB total=${totalMb}MB limit=${limitMb}MB (${Math.round((usedMb / limitMb) * 100)}% of cap)`,
      });
    }, 30_000);

    return () => {
      window.clearInterval(memInterval);
      uninstall();
    };
  }, []);

  useEffect(() => {
    async function init(): Promise<void> {
      // Create the shared AudioContext immediately so its touchstart unlock
      // listener is attached before the user's first tap. On iOS Safari the
      // context starts suspended; the listener resumes it on first touch.
      getSharedAudioContext();

      try {
        const profile = await getOrCreateMainProfile();
        const theme = getThemeById(profile.preferences.theme);
        applyTheme(theme);
        setActiveTheme(theme);
        setActiveProfile(profile);

        // Hydrate the audit-stream config cache from Dexie (with
        // one-time localStorage migration if any pre-Dexie values
        // are still present). `appAuditor.streamAuditEntry` reads
        // the cache synchronously on every audit log — until this
        // resolves, streaming is a no-op (same as default-off state).
        void loadAuditStreamConfig();

        // Restore saved voice preferences so they're applied from the first speak() call
        if (profile.preferences.systemVoiceURI) {
          speechService.setVoice(profile.preferences.systemVoiceURI);
        }
        if (profile.preferences.voiceSpeed) {
          speechService.setRate(profile.preferences.voiceSpeed);
        }

        // Warm up the voice pipeline early so the first narration has no cold-start delay
        void voiceService.warmup();

        const skippedMeta = await db.meta.get('onboarding_skipped');
        if (skippedMeta?.value !== 'true') {
          // Auto-skip onboarding — API keys can be added from Settings
          await db.meta.put({ key: 'onboarding_skipped', value: 'true' });
        }
        setOnboardingSkipped(true);

        // Seed data in background (no-op if already seeded)
        void seedDatabase();
        void seedPuzzles();

        // Biweekly chess.com / lichess auto-import. Fire-and-forget,
        // deferred 30s after boot so it never competes with the user's
        // first action (especially the /coach/teach kickoff which
        // wants the engine free for stockfish_eval tool calls).
        // Skips post-import puzzle/analysis runs — those happen on
        // explicit Game Insights navigation instead.
        setTimeout(() => {
          void runAutoImportIfDue(profile, {
            onProfileUpdated: (next) => setActiveProfile(next),
          });
        }, 30_000);

      } catch (error) {
        console.error('App initialization failed:', error);
        void logAppAudit({
          kind: 'uncaught-error',
          category: 'app',
          source: 'App.init',
          summary: error instanceof Error ? error.message : 'App initialization failed',
          details: error instanceof Error ? error.stack : String(error),
        });
      } finally {
        setLoading(false);
      }
    }

    void init();
  }, [setLoading, setActiveProfile, setActiveTheme]);

  if (isLoading) {
    return <LoadingScreen />;
  }

  // First-run: redirect to onboarding if no API key and user hasn't completed/skipped it
  const hasApiKey = Boolean(activeProfile?.preferences.apiKeyEncrypted) ||
    Boolean(activeProfile?.preferences.anthropicApiKeyEncrypted);

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<ErrorBoundary><DashboardPage /></ErrorBoundary>} />
          {/* Openings */}
          <Route path="/openings" element={<ErrorBoundary><OpeningExplorerPage /></ErrorBoundary>} />
          <Route path="/openings/pro/:playerId" element={<ErrorBoundary><ProPlayerPage /></ErrorBoundary>} />
          <Route path="/openings/pro/:playerId/:id" element={<ErrorBoundary><OpeningDetailPage /></ErrorBoundary>} />
          <Route path="/openings/:id" element={<ErrorBoundary><OpeningDetailPage /></ErrorBoundary>} />
          {/* Coach — /coach redirects to the live play-with-coach
              board so "tap Coach in the nav" always lands the student
              on a playable game instead of a card hub. The old hub
              (CoachHomePage / CoachPage) is still reachable at
              /coach/home for anyone who wants the action grid. */}
          <Route path="/coach" element={<Navigate to="/coach/home" replace />} />
          <Route path="/coach/home" element={<ErrorBoundary><CoachPage /></ErrorBoundary>} />
          <Route path="/coach/play" element={<ErrorBoundary><CoachGamePage /></ErrorBoundary>} />
          <Route path="/coach/chat" element={<ErrorBoundary><CoachChatPage /></ErrorBoundary>} />
          <Route path="/coach/session/:kind" element={<ErrorBoundary><CoachSessionPage /></ErrorBoundary>} />
          <Route path="/coach/analyse" element={<ErrorBoundary><CoachAnalysePage /></ErrorBoundary>} />
          <Route path="/coach/plan" element={<ErrorBoundary><CoachSessionPlanPage /></ErrorBoundary>} />
          {/* /coach/report is a legacy alias — redirect lives below in the redirects block */}
          <Route path="/coach/train" element={<ErrorBoundary><CoachTrainPage /></ErrorBoundary>} />
          <Route path="/coach/teach" element={<ErrorBoundary><CoachTeachPage /></ErrorBoundary>} />
          <Route path="/coach/endgame" element={<ErrorBoundary><CoachEndgamePage /></ErrorBoundary>} />
          <Route path="/coach/review" element={<ErrorBoundary><CoachReviewListPage /></ErrorBoundary>} />
          <Route path="/coach/review/:gameId" element={<ErrorBoundary><CoachReviewSessionPage /></ErrorBoundary>} />
          {/* Tactics (absorbs former Puzzles tab) */}
          <Route path="/tactics" element={<ErrorBoundary><TacticsPage /></ErrorBoundary>} />
          <Route path="/tactics/profile" element={<ErrorBoundary><TacticalProfilePage /></ErrorBoundary>} />
          <Route path="/tactics/drill" element={<ErrorBoundary><TacticDrillPage /></ErrorBoundary>} />
          <Route path="/tactics/setup" element={<ErrorBoundary><TacticSetupPage /></ErrorBoundary>} />
          <Route path="/tactics/create" element={<ErrorBoundary><TacticCreatePage /></ErrorBoundary>} />
          <Route path="/tactics/mistakes" element={<ErrorBoundary><MyMistakesPage /></ErrorBoundary>} />
          <Route path="/tactics/adaptive" element={<ErrorBoundary><AdaptivePuzzlePage /></ErrorBoundary>} />
          <Route path="/tactics/classic" element={<ErrorBoundary><PuzzleTrainerPage /></ErrorBoundary>} />
          <Route path="/tactics/weakness" element={<ErrorBoundary><WeaknessPuzzlePage /></ErrorBoundary>} />
          <Route path="/tactics/weakness-themes" element={<ErrorBoundary><WeaknessThemesPage /></ErrorBoundary>} />
          <Route path="/tactics/lichess" element={<ErrorBoundary><LichessDashboardPage /></ErrorBoundary>} />
          {/* Backward-compat redirects */}
          <Route path="/puzzles" element={<Navigate to="/tactics" replace />} />
          <Route path="/puzzles/classic" element={<Navigate to="/tactics/classic" replace />} />
          <Route path="/puzzles/adaptive" element={<Navigate to="/tactics/adaptive" replace />} />
          <Route path="/puzzles/mistakes" element={<Navigate to="/tactics/mistakes" replace />} />
          <Route path="/puzzles/weakness" element={<Navigate to="/tactics/weakness" replace />} />
          <Route path="/puzzles/lichess-dashboard" element={<Navigate to="/tactics/lichess" replace />} />
          <Route path="/weaknesses" element={<ErrorBoundary><GameInsightsPage /></ErrorBoundary>} />
          <Route path="/coach/report" element={<Navigate to="/weaknesses" replace />} />
          <Route path="/weaknesses/puzzles" element={<Navigate to="/tactics/weakness" replace />} />
          <Route path="/weaknesses/adaptive" element={<Navigate to="/tactics/adaptive" replace />} />
          <Route path="/weaknesses/classic" element={<Navigate to="/tactics/classic" replace />} />
          <Route path="/weaknesses/mistakes" element={<Navigate to="/tactics/mistakes" replace />} />
          <Route path="/weaknesses/lichess-dashboard" element={<Navigate to="/tactics/lichess" replace />} />
          {/* Games (accessible from weakness report) */}
          <Route path="/games" element={<ErrorBoundary><GameDatabasePage /></ErrorBoundary>} />
          <Route path="/games/import" element={<ErrorBoundary><ImportPage /></ErrorBoundary>} />
          {/* Settings */}
          <Route
            path="/settings"
            element={
              <ErrorBoundary>
                {hasApiKey || onboardingSkipped
                  ? <SettingsPage />
                  : <Navigate to="/settings/onboarding" replace />}
              </ErrorBoundary>
            }
          />
          <Route path="/settings/onboarding" element={<ErrorBoundary><OnboardingPage /></ErrorBoundary>} />
          <Route path="/neon-mock" element={<NeonBoardMock />} />
          {/* Audit back-door — not linked from UI; deep-link only. */}
          <Route path="/debug/audit" element={<ErrorBoundary><DebugAuditPage /></ErrorBoundary>} />
          {/* Opening Traps — wired up from the Tactics page tile and
              also kept as a /debug deep-link alias for older preview
              URLs we've shared. */}
          <Route path="/tactics/opening-traps" element={<ErrorBoundary><OpeningBlundersPage /></ErrorBoundary>} />
          <Route path="/debug/opening-blunders" element={<Navigate to="/tactics/opening-traps" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
        <Route element={<KidLayout />}>
          <Route path="/kid" element={<ErrorBoundary><KidModePage /></ErrorBoundary>} />
          <Route path="/kid/journey" element={<ErrorBoundary><JourneyMapPage /></ErrorBoundary>} />
          <Route path="/kid/queen-games" element={<ErrorBoundary><QueenGamesHub /></ErrorBoundary>} />
          <Route path="/kid/journey/:chapterId" element={<ErrorBoundary><JourneyChapterPage /></ErrorBoundary>} />
          <Route path="/kid/fairy-tale" element={<ErrorBoundary><FairyTaleMapPage /></ErrorBoundary>} />
          <Route path="/kid/fairy-tale/:chapterId" element={<ErrorBoundary><FairyTaleChapterPage /></ErrorBoundary>} />
          <Route path="/kid/rook-games" element={<ErrorBoundary><RookGamesPage /></ErrorBoundary>} />
          <Route path="/kid/rook-maze/:level" element={<ErrorBoundary><RookMazePage /></ErrorBoundary>} />
          <Route path="/kid/row-clearer/:level" element={<ErrorBoundary><RowClearerPage /></ErrorBoundary>} />
          <Route path="/kid/mini-games" element={<ErrorBoundary><MiniGameHubPage /></ErrorBoundary>} />
          <Route path="/kid/mini-games/pawn-wars/:level" element={<ErrorBoundary><MiniGamePage gameId="pawn-wars" /></ErrorBoundary>} />
          <Route path="/kid/mini-games/blocker/:level" element={<ErrorBoundary><MiniGamePage gameId="blocker" /></ErrorBoundary>} />
          <Route path="/kid/king-escape" element={<ErrorBoundary><KingEscapeGame /></ErrorBoundary>} />
          <Route path="/kid/king-march" element={<ErrorBoundary><KingMarchGame /></ErrorBoundary>} />
          <Route path="/kid/knight-games" element={<ErrorBoundary><KnightGamesPage /></ErrorBoundary>} />
          <Route path="/kid/knight-games/leap-frog" element={<ErrorBoundary><LeapFrogGame /></ErrorBoundary>} />
          <Route path="/kid/knight-games/knight-sweep" element={<ErrorBoundary><KnightSweepGame /></ErrorBoundary>} />
          <Route path="/kid/play-games" element={<ErrorBoundary><GuidedGameHubPage /></ErrorBoundary>} />
          <Route path="/kid/play-games/:gameId" element={<ErrorBoundary><GuidedGamePage /></ErrorBoundary>} />
          <Route path="/kid/puzzles" element={<ErrorBoundary><KidPuzzlePage /></ErrorBoundary>} />
          <Route path="/kid/:piece" element={<ErrorBoundary><KidPiecePage /></ErrorBoundary>} />
        </Route>
      </Routes>
      <BuildVersionWidget />
    </BrowserRouter>
  );
}