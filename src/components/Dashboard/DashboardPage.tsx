import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../../stores/appStore';
import { updateStreak } from '../../services/sessionGenerator';
import { seedDatabase } from '../../services/dataLoader';
import { BookOpen, GraduationCap, Target, AlertTriangle, Upload } from 'lucide-react';
import { SmartSearchBar } from '../Search/SmartSearchBar';
import { useSettings } from '../../hooks/useSettings';
import { scaledShadow } from '../../utils/neonColors';

interface SectionItem {
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  route: string;
  color: string;
  bgColor: string;
  rgb: string;
}

const SECTIONS: SectionItem[] = [
  {
    label: 'Openings',
    icon: BookOpen,
    route: '/openings',
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/10',
    rgb: '6, 182, 212',
  },
  {
    label: 'Coach',
    icon: GraduationCap,
    route: '/coach/home',
    color: 'text-rose-400',
    bgColor: 'bg-rose-500/10',
    rgb: '251, 113, 133',
  },
  {
    label: 'Tactics',
    icon: Target,
    route: '/tactics',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/10',
    rgb: '52, 211, 153',
  },
  {
    label: 'Weaknesses',
    icon: AlertTriangle,
    route: '/weaknesses',
    color: 'text-violet-400',
    bgColor: 'bg-violet-500/10',
    rgb: '139, 92, 246',
  },
];

export function DashboardPage(): JSX.Element {
  const activeProfile = useAppStore((s) => s.activeProfile);
  const setActiveProfile = useAppStore((s) => s.setActiveProfile);
  const navigate = useNavigate();
  const { settings } = useSettings();
  const gB = settings.glowBrightness;
  const gS = gB / 100;

  useEffect(() => {
    void seedDatabase();

    if (activeProfile) {
      void updateStreak(activeProfile).then(({ currentStreak, longestStreak }) => {
        if (currentStreak !== activeProfile.currentStreak || longestStreak !== activeProfile.longestStreak) {
          setActiveProfile({ ...activeProfile, currentStreak, longestStreak });
        }
      });
    }
  }, [activeProfile, setActiveProfile]);

  if (!activeProfile) return <></>;

  return (
    <div
      className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6"
      style={{ color: 'var(--color-text)' }}
      data-testid="dashboard"
    >
      <h1 className="text-xl font-bold text-center mt-2">
        Chess Academy Pro
      </h1>

      {/* Import Games */}
      <div className="max-w-lg mx-auto w-full">
        <button
          onClick={() => void navigate('/games/import')}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-amber-500/10 hover:opacity-80 transition-all duration-200"
          style={{
            borderTop: `1px solid rgba(245, 158, 11, ${Math.min(1, 0.1 * gS)})`,
            borderRight: `1px solid rgba(245, 158, 11, ${Math.min(1, 0.1 * gS)})`,
            borderLeft: `2px solid rgba(245, 158, 11, ${Math.min(1, 0.6 * gS)})`,
            borderBottom: `2px solid rgba(245, 158, 11, ${Math.min(1, 0.6 * gS)})`,
            boxShadow: scaledShadow('245, 158, 11', gB),
          }}
          data-testid="import-games-btn"
        >
          <Upload size={18} className="text-amber-400" />
          <span className="text-sm font-semibold text-amber-400">Import Games</span>
        </button>
      </div>

      {/* Smart Search */}
      <div className="max-w-lg mx-auto w-full">
        <SmartSearchBar />
      </div>

      {/* Section grid — uniform cards, order matches sidebar */}
      <div className="grid grid-cols-2 gap-3 flex-1 content-center max-w-lg mx-auto w-full">
        {SECTIONS.map((section) => {
          const Icon = section.icon;
          const shadow = scaledShadow(section.rgb, gB);
          const shadowHover = scaledShadow(section.rgb, Math.min(200, gB * 1.4));
          return (
            <button
              key={section.route}
              onClick={() => void navigate(section.route)}
              className={`${section.bgColor} rounded-2xl flex flex-col items-center justify-center gap-3 transition-all duration-200 aspect-square`}
              style={{
                borderTop: `1px solid rgba(${section.rgb}, ${Math.min(1, 0.1 * gS)})`,
                borderRight: `1px solid rgba(${section.rgb}, ${Math.min(1, 0.1 * gS)})`,
                borderLeft: `2px solid rgba(${section.rgb}, ${Math.min(1, 0.6 * gS)})`,
                borderBottom: `2px solid rgba(${section.rgb}, ${Math.min(1, 0.6 * gS)})`,
                boxShadow: shadow,
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget;
                el.style.borderLeft = `2px solid rgba(${section.rgb}, ${Math.min(1, 0.85 * gS)})`;
                el.style.borderBottom = `2px solid rgba(${section.rgb}, ${Math.min(1, 0.85 * gS)})`;
                el.style.borderTop = `1px solid rgba(${section.rgb}, ${Math.min(1, 0.2 * gS)})`;
                el.style.borderRight = `1px solid rgba(${section.rgb}, ${Math.min(1, 0.2 * gS)})`;
                el.style.boxShadow = shadowHover;
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget;
                el.style.borderLeft = `2px solid rgba(${section.rgb}, ${Math.min(1, 0.6 * gS)})`;
                el.style.borderBottom = `2px solid rgba(${section.rgb}, ${Math.min(1, 0.6 * gS)})`;
                el.style.borderTop = `1px solid rgba(${section.rgb}, ${Math.min(1, 0.1 * gS)})`;
                el.style.borderRight = `1px solid rgba(${section.rgb}, ${Math.min(1, 0.1 * gS)})`;
                el.style.boxShadow = shadow;
              }}
              data-testid={`section-${section.label.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <Icon size={40} className={section.color} />
              <span className="text-base font-bold" style={{ color: 'var(--color-text)' }}>{section.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
