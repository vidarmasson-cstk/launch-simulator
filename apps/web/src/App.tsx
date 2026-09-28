import { Header } from './components/layout/Header';
import { ParameterEditor } from './components/editor/ParameterEditor';
import { ResultsArea } from './components/results/ResultsArea';

/**
 * Layout: header, parameter editor (left), results (main). On narrow screens the page scrolls as one
 * document with results first, then the editor.
 */
export function App() {
  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      <Header />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="order-2 w-full shrink-0 border-t border-slate-200 lg:order-1 lg:w-[380px] lg:overflow-y-auto lg:border-t-0 lg:border-r dark:border-slate-800">
          <ParameterEditor />
        </aside>
        <main className="order-1 min-w-0 flex-1 lg:order-2 lg:overflow-y-auto">
          <ResultsArea />
        </main>
      </div>
    </div>
  );
}
