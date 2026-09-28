import { Header } from './components/layout/Header';
import { ParameterEditor } from './components/editor/ParameterEditor';
import { ResultsArea } from './components/results/ResultsArea';

/** Layout: header, parameter editor (left), results (main). */
export function App() {
  return (
    <div className="flex h-screen flex-col">
      <Header />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="w-full shrink-0 overflow-y-auto border-slate-200 lg:w-[380px] lg:border-r dark:border-slate-800">
          <ParameterEditor />
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <ResultsArea />
        </main>
      </div>
    </div>
  );
}
