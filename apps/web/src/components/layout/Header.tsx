import { useRef, useState } from 'react';
import { PresetSchema, ScenarioSchema, TEMPLATES, type TemplateCategory } from '@launch-sim/engine';
import { buildShareUrl, currentScenario, useAppStore } from '../../state/store';
import { applyTheme, getStoredTheme, type ThemeMode } from '../../state/theme';
import { Icon, Modal, focusRing, useDismiss, type IconName } from '../ui';
import { AboutModal } from './AboutModal';

const btn = `inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 ${focusRing}`;

const CATEGORY_LABEL: Record<TemplateCategory, string> = {
  baseline: 'Baseline',
  caching: 'Caching',
  publishing: 'Publishing & deploys',
  traffic: 'Traffic',
  limits: 'Limits & algorithms',
};

function Templates() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const loadTemplate = useAppStore((s) => s.loadTemplate);
  const groups = new Map<TemplateCategory, typeof TEMPLATES>();
  for (const t of TEMPLATES) groups.set(t.category, [...(groups.get(t.category) ?? []), t]);
  return (
    <div ref={ref} className="relative">
      <button type="button" className={btn} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="grid" /> Templates
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Scenario templates"
          className="absolute top-full left-0 z-40 mt-1 max-h-[70vh] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        >
          {[...groups.entries()].map(([cat, list]) => (
            <div key={cat} className="mb-2 last:mb-0">
              <div className="px-2 py-1 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
                {CATEGORY_LABEL[cat] ?? cat}
              </div>
              {list.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    loadTemplate(t.id);
                    setOpen(false);
                  }}
                  className={`block w-full rounded px-2 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800 ${focusRing}`}
                >
                  <div className="text-sm font-medium">{t.name}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{t.description}</div>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(getStoredTheme);
  const order: ThemeMode[] = ['system', 'light', 'dark'];
  const icon: Record<ThemeMode, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };
  return (
    <button
      type="button"
      className={btn}
      title={`Theme: ${mode} (click to change)`}
      aria-label={`Theme: ${mode}. Click to change`}
      onClick={() => {
        const next = order[(order.indexOf(mode) + 1) % order.length]!;
        setMode(next);
        applyTheme(next);
      }}
    >
      <Icon name={icon[mode]} />
    </button>
  );
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function Header() {
  const name = useAppStore((s) => s.scenario.name);
  const runStatus = useAppStore((s) => s.runStatus);
  const run = useAppStore((s) => s.run);
  const setTab = useAppStore((s) => s.setTab);
  const saveCurrent = useAppStore((s) => s.saveCurrent);
  const savedCount = useAppStore((s) => s.saved.length);
  const preset = useAppStore((s) => s.privatePreset);
  const privateCount = useAppStore((s) => s.privatePaths.length);
  const clearPrivatePreset = useAppStore((s) => s.clearPrivatePreset);
  const [about, setAbout] = useState(false);
  const [confirm, setConfirm] = useState<'share' | 'export' | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const flash = (text: string, error = false) => {
    setNotice({ text, error });
    if (!error) setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 2500);
  };

  const running = runStatus.state === 'running';
  const pct = running ? Math.round(runStatus.progress * 100) : 0;

  const doShare = async (strip: boolean) => {
    const url = buildShareUrl(strip);
    try {
      await navigator.clipboard.writeText(url);
      flash(strip && privateCount ? 'Link copied (private values stripped)' : 'Link copied');
    } catch {
      window.prompt('Copy this link', url);
    }
  };
  const doExport = (strip: boolean) => {
    const sc = currentScenario(strip);
    download(`${(sc.name || 'scenario').replace(/[^\w.-]+/g, '_')}.json`, JSON.stringify(sc, null, 2));
  };
  const withPrivacyCheck = (kind: 'share' | 'export') => {
    if (privateCount > 0) setConfirm(kind);
    else if (kind === 'share') void doShare(false);
    else doExport(false);
  };

  const onFile = async (file: File) => {
    try {
      const data: unknown = JSON.parse(await file.text());
      const st = useAppStore.getState();
      if ((data as { format?: string } | null)?.format === 'launch-sim-preset/v1') {
        const p = PresetSchema.safeParse(data);
        if (!p.success) throw new Error(`Invalid preset: ${p.error.issues[0]?.message}`);
        st.loadPrivatePreset(p.data);
        flash(`Private preset "${p.data.name}" loaded`);
      } else {
        const s = ScenarioSchema.safeParse(data);
        if (!s.success) throw new Error(`Invalid scenario: ${s.error.issues[0]?.path.join('.')} ${s.error.issues[0]?.message}`);
        st.setScenario(s.data);
        flash('Scenario imported');
      }
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Could not import file', true);
    }
  };

  return (
    <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <h1 className="mr-1 flex items-center gap-2 text-base font-semibold">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-indigo-600 text-white">
            <Icon name="rocket" className="h-3.5 w-3.5" />
          </span>
          Launch Simulator
        </h1>
        <span className="hidden max-w-[16rem] truncate text-sm text-slate-500 md:inline dark:text-slate-400" title={name}>
          {name}
        </span>
        <Templates />
        <button
          type="button"
          disabled={running}
          onClick={() => {
            setTab('timeline');
            run();
          }}
          className={`inline-flex min-w-28 items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-80 ${focusRing}`}
        >
          <Icon name="play" className="h-3.5 w-3.5" />
          {running ? `Running ${pct}%` : 'Run timeline'}
        </button>
        {runStatus.state === 'error' && (
          <span role="alert" className="text-xs text-red-600 dark:text-red-400">
            Run failed: {runStatus.message}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {preset && (
            <span className="inline-flex items-center gap-1 rounded-full border border-violet-300 bg-violet-50 py-0.5 pr-1 pl-2 text-xs text-violet-800 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-200">
              <Icon name="lock" className="h-3 w-3" />
              Private preset: {preset.name}
              <button
                type="button"
                aria-label="Clear private preset"
                title="Clear private preset (revert to public defaults)"
                onClick={clearPrivatePreset}
                className={`rounded-full p-0.5 hover:bg-violet-200 dark:hover:bg-violet-800 ${focusRing}`}
              >
                <Icon name="x" className="h-3 w-3" />
              </button>
            </span>
          )}
          <button type="button" className={btn} onClick={() => { saveCurrent(); flash('Scenario saved'); }} title="Save this scenario for comparison">
            <Icon name="save" /> <span className="hidden sm:inline">Save{savedCount ? ` (${savedCount})` : ''}</span>
          </button>
          <button type="button" className={btn} onClick={() => fileRef.current?.click()} title="Import a scenario or private preset JSON">
            <Icon name="upload" /> <span className="hidden sm:inline">Import</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Import scenario or preset JSON file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
              e.target.value = '';
            }}
          />
          <button type="button" className={btn} onClick={() => withPrivacyCheck('export')} title="Download scenario JSON">
            <Icon name="download" /> <span className="hidden sm:inline">Export</span>
          </button>
          <button type="button" className={btn} onClick={() => withPrivacyCheck('share')} title="Copy a share link">
            <Icon name="link" /> <span className="hidden sm:inline">Share</span>
          </button>
          <button type="button" className={btn} onClick={() => setAbout(true)} aria-label="About">
            <Icon name="info" /> <span className="hidden sm:inline">About</span>
          </button>
          <ThemeToggle />
        </div>
      </div>
      {notice && (
        <div
          role={notice.error ? 'alert' : 'status'}
          className={`flex items-center justify-between px-3 py-1 text-xs ${notice.error ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'}`}
        >
          {notice.text}
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className={focusRing}>
            <Icon name="x" className="h-3 w-3" />
          </button>
        </div>
      )}
      {about && <AboutModal onClose={() => setAbout(false)} />}
      {confirm && (
        <Modal title="Private preset is active" onClose={() => setConfirm(null)}>
          <p className="mb-4 text-sm text-slate-700 dark:text-slate-300">
            {privateCount} value{privateCount > 1 ? 's' : ''} come from your private preset. Strip them (revert to public
            defaults) before {confirm === 'share' ? 'sharing' : 'exporting'}?
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={btn} onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => {
                const c = confirm;
                setConfirm(null);
                if (c === 'share') void doShare(false);
                else doExport(false);
              }}
            >
              Include private values
            </button>
            <button
              type="button"
              className={`rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 ${focusRing}`}
              onClick={() => {
                const c = confirm;
                setConfirm(null);
                if (c === 'share') void doShare(true);
                else doExport(true);
              }}
            >
              Strip private values
            </button>
          </div>
        </Modal>
      )}
    </header>
  );
}
