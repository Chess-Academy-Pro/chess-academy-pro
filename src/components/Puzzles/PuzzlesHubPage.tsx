import { useNavigate } from 'react-router-dom';
import { Trophy, Target, Zap } from 'lucide-react';
import { SmartSearchBar } from '../Search/SmartSearchBar';

interface PuzzleSection {
  label: string;
  route: string;
  icon: typeof Trophy;
  color: string;
  bgColor: string;
  borderColor: string;
  testId: string;
}

const SECTIONS: PuzzleSection[] = [
  {
    label: 'Daily Training',
    route: '/puzzles/classic',
    icon: Trophy,
    color: 'text-green-400',
    bgColor: 'bg-green-500/10',
    borderColor: 'border-green-500/30',
    testId: 'section-daily-training',
  },
  {
    label: 'Theme Practice',
    route: '/puzzles/adaptive',
    icon: Target,
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/30',
    testId: 'section-theme-practice',
  },
  {
    label: 'Puzzle Rush',
    route: '/puzzles/adaptive?mode=rush',
    icon: Zap,
    color: 'text-orange-400',
    bgColor: 'bg-orange-500/10',
    borderColor: 'border-orange-500/30',
    testId: 'section-puzzle-rush',
  },
];

export function PuzzlesHubPage(): JSX.Element {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))] md:pb-6">
      <h1 className="text-xl font-bold text-center mt-2">Puzzles</h1>
      <div className="max-w-lg mx-auto w-full">
        <SmartSearchBar />
      </div>
      <div className="grid grid-cols-2 gap-3 flex-1 content-center max-w-lg mx-auto w-full">
        {SECTIONS.map((section, i) => {
          const Icon = section.icon;
          const isFirst = i === 0;
          return (
            <button
              key={section.route}
              data-testid={section.testId}
              onClick={() => void navigate(section.route)}
              className={`${section.bgColor} ${section.borderColor} border-2 rounded-2xl flex flex-col items-center justify-center gap-3 hover:opacity-80 transition-opacity ${isFirst ? 'col-span-2 py-10' : 'aspect-square'}`}
            >
              <Icon size={isFirst ? 48 : 40} className={section.color} />
              <span className={`${isFirst ? 'text-lg' : 'text-base'} font-bold ${section.color}`}>{section.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
