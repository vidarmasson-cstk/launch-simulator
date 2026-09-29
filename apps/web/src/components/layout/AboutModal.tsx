import { Modal } from '../ui';
import { ProvenanceMark } from '../editor/ProvenanceBadge';

export function AboutModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="About Launch Simulator" onClose={onClose} wide>
      <div className="space-y-4 text-sm text-slate-700 dark:text-slate-300">
        <section>
          <h3 className="mb-1 font-semibold text-slate-900 dark:text-slate-100">What it models</h3>
          <p>
            The request path from the visitor to Contentstack: edge, Launch CDN, the Launch origin rate limiter,
            server compute, the CMS CDN, the CMS rate limiter and SDK retries. It shows whether a site stays inside
            Launch and Contentstack CMS API limits under steady peak traffic and under events such as publishes,
            deploys, go-lives, crawler surges and load tests. The steady-state view is analytic and instant. The
            timeline is a per-tick simulation that runs in a web worker.
          </p>
        </section>
        <section>
          <h3 className="mb-1 font-semibold text-slate-900 dark:text-slate-100">Provenance legend</h3>
          <ul className="space-y-1">
            {(
              [
                ['documented', 'Documented', 'stated in public Contentstack docs.'],
                ['conflicting', 'Sources disagree', 'public pages give different values; the newest is the default and all are listed.'],
                ['observed', 'Observed', 'taken from public SDK source or observed behaviour.'],
                ['assumption', 'Assumption / input', 'not public, or a workload input you choose. Edit freely.'],
                ['private', 'Private', 'set by a private preset loaded in this browser.'],
              ] as const
            ).map(([k, t, d]) => (
              <li key={k} className="flex items-start gap-2">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  <ProvenanceMark kind={k} />
                </span>
                <span>
                  <b>{t}</b>: {d}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="mb-1 font-semibold text-slate-900 dark:text-slate-100">Key approximations</h3>
          <ul className="list-disc space-y-0.5 pl-5">
            <li>The fluid state uses expected values.</li>
            <li>Render latency uses same-tick CMS conditions.</li>
            <li>The Zipf ranks are static.</li>
            <li>There is no CDN capacity eviction.</li>
            <li>Instance-level variance is ignored.</li>
          </ul>
        </section>
        <section>
          <h3 className="mb-1 font-semibold text-slate-900 dark:text-slate-100">Data and privacy</h3>
          <p>
            Defaults are values from public documentation only. Private presets stay in this browser (local storage)
            and are never sent anywhere. Share links and exports warn you when a private preset is active and can
            strip its values.
          </p>
        </section>
      </div>
    </Modal>
  );
}
