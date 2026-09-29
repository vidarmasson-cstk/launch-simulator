#!/usr/bin/env node
/**
 * Records a captioned walkthrough of the web app with Playwright.
 *
 *   npm run demo:record                      # build, serve, record → demo/launch-simulator-demo.{webm,mp4}
 *   DEMO_URL=http://localhost:5173 npm run demo:record   # record an already-running app (skips build/serve)
 *
 * Captions quote numbers read from the page during the run, so they stay correct when the model or
 * templates change. The MP4 is only written if `ffmpeg` is on PATH (or FFMPEG points to one);
 * otherwise the WebM is kept. Needs a Chromium for Playwright (`npx playwright install chromium`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = resolve(process.env.DEMO_OUT ?? join(ROOT, 'demo'));
const PORT = Number(process.env.DEMO_PORT ?? 4174);
const W = 1440;
const H = 900;

// ---------- app server ----------

async function waitForHttp(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`App did not come up at ${url}`);
}

async function startApp() {
  if (process.env.DEMO_URL) return { url: process.env.DEMO_URL, stop: () => {} };
  const build = spawnSync('npm', ['run', 'build', '-w', '@launch-sim/web'], { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) throw new Error('Web build failed');
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: join(ROOT, 'apps/web'),
    stdio: 'ignore',
    detached: true,
  });
  const url = `http://localhost:${PORT}/`;
  await waitForHttp(url);
  return { url, stop: () => process.kill(-server.pid) };
}

// ---------- overlay: captions + a visible cursor (headless video has none) ----------

function installOverlay() {
  window.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = `
      #demo-cap{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99999;max-width:980px;
        background:rgba(15,23,42,.92);color:#fff;font:500 20px/1.4 system-ui,sans-serif;padding:14px 22px;
        border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);opacity:0;transition:opacity .35s;
        text-align:center;pointer-events:none}
      #demo-cap b{color:#a5b4fc}
      #demo-cur{position:fixed;z-index:100000;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
        background:rgba(99,102,241,.35);border:2px solid #4f46e5;pointer-events:none;transition:transform .12s}
      #demo-cur.down{transform:scale(.7);background:rgba(99,102,241,.7)}
      .demo-hl{outline:3px solid #f59e0b !important;outline-offset:3px;border-radius:10px;transition:outline .2s}`;
    document.head.appendChild(style);
    const cap = document.createElement('div');
    cap.id = 'demo-cap';
    document.body.appendChild(cap);
    const cur = document.createElement('div');
    cur.id = 'demo-cur';
    cur.style.left = '720px';
    cur.style.top = '450px';
    document.body.appendChild(cur);
    const move = (e) => {
      cur.style.left = `${e.clientX}px`;
      cur.style.top = `${e.clientY}px`;
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mousedown', () => cur.classList.add('down'), true);
    window.addEventListener('mouseup', () => cur.classList.remove('down'), true);
  });
}

// ---------- page helpers ----------

function helpers(page) {
  const wait = (ms) => page.waitForTimeout(ms);

  async function caption(html, ms = 3500) {
    await page.evaluate((h) => {
      const c = document.getElementById('demo-cap');
      c.innerHTML = h;
      c.style.opacity = h ? '1' : '0';
    }, html);
    if (ms) await wait(ms);
  }

  async function moveTo(loc, click = true) {
    await loc.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    await wait(500);
    const b = await loc.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 30 });
    await wait(250);
    if (click) {
      await page.mouse.down();
      await wait(90);
      await page.mouse.up();
    }
  }

  async function highlight(loc, ms = 2500) {
    await loc.evaluate((el) => el.classList.add('demo-hl'));
    await wait(ms);
    await loc.evaluate((el) => el.classList.remove('demo-hl'));
  }

  /** Headline (or, with sub, the sub-line) of a KPI tile in the active results panel. */
  async function kpi(label, sub = false) {
    return page.evaluate(
      ([label, sub]) => {
        const el = [...document.querySelectorAll('main [role=tabpanel] *')].find(
          (e) => e.children.length === 0 && e.textContent.trim() === label,
        );
        if (!el) return '?';
        const kids = [...el.parentElement.children];
        return (kids[kids.indexOf(el) + (sub ? 2 : 1)]?.textContent || '?').trim();
      },
      [label, sub],
    );
  }

  /** Values of a Compare table row, e.g. ['11K', '0']. */
  async function compareRow(label) {
    return page.evaluate((label) => {
      const cell = [...document.querySelectorAll('main td, main th')].find((e) => e.textContent.trim() === label);
      if (!cell) return [];
      return [...cell.parentElement.children].slice(1).map((c) => c.textContent.replace(/[▲▼].*$/, '').trim());
    }, label);
  }

  async function scrollMain(y) {
    await page.locator('main').evaluate((el, y) => el.scrollTo({ top: y, behavior: 'smooth' }), y);
    await wait(1200);
  }

  async function scrollMainTo(text) {
    await page
      .locator('main')
      .getByText(text, { exact: true })
      .first()
      .evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    await wait(1300);
  }

  return { wait, caption, moveTo, highlight, kpi, compareRow, scrollMain, scrollMainTo };
}

// ---------- the walkthrough ----------

async function walkthrough(page, url) {
  const { wait, caption, moveTo, highlight, kpi, compareRow, scrollMain, scrollMainTo } = helpers(page);

  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await wait(1200);

  // 1. The request path
  await caption('<b>Launch Simulator</b>: model Contentstack Launch + CMS rate limits <i>before</i> you build', 4000);
  const flow = page
    .getByText('Request path')
    .first()
    .locator('xpath=ancestor::section[1] | ancestor::div[contains(@class,"rounded")][1]')
    .first();
  await caption(
    'Every request path hop: edge → Launch CDN → Launch origin limit → compute → CMS CDN → CMS origin limit',
    0,
  );
  await highlight(flow, 4000);
  await caption('Only <b>cache misses</b> count against rate limits: the gauges show headroom against each limit', 3500);

  // 2. A template from real case patterns
  await caption('Start from a template built from real customer case patterns…', 0);
  await moveTo(page.getByRole('button', { name: /templates/i }));
  await wait(1400);
  await moveTo(page.getByText('Bulk publish at peak').first());
  await wait(800);
  await caption('<b>Bulk publish at peak</b>: 800 page views/s, then an editor publishes 500 entries at once', 3500);
  await caption(`Steady state looks healthy: CMS origin at <b>${await kpi('CMS origin')}</b>, well inside the org limit`, 3500);

  // 3. Timeline
  await caption('Run the timeline to see what the publish does, second by second…', 0);
  await moveTo(page.getByRole('button', { name: /run timeline/i }));
  await page.getByText('Total CMS 429s').first().waitFor({ timeout: 60000 });
  await wait(1500);
  await caption(
    `The publish purges CMS caches: <b>${await kpi('Total CMS 429s')} CMS 429s</b>, CMS origin peaks at <b>${await kpi('Peak CMS origin')}</b> of the org limit`,
    4500,
  );
  const suggested = await kpi('Suggested CMS limit');
  await scrollMainTo('CMS origin');
  await caption('CMS origin: cache misses + SDK retries spike far above the limit right after the publish', 4500);
  await scrollMainTo('Latency');
  await caption('Visitors feel it: p95 latency jumps to seconds while renders wait on the CMS', 3500);

  // 4. Findings → apply & compare
  await scrollMain(0);
  await caption('The simulator explains what went wrong and how to fix it…', 0);
  await moveTo(page.getByRole('tab', { name: /findings/i }));
  await wait(2500);
  await caption('Each finding has concrete numbers, and a one-click fix you can compare', 3000);
  const fix = page.locator('li', { hasText: 'CMS origin limit is exceeded' }).getByRole('button', { name: /apply & compare/i });
  await moveTo(fix, false);
  await wait(700);
  await caption(`Apply the suggested limit (<b>${suggested}</b>) as a new scenario and compare side by side`, 0);
  await moveTo(fix);
  await wait(1500);
  await moveTo(page.getByRole('button', { name: /run timeline/i }));
  await wait(3500);
  await moveTo(page.getByRole('tab', { name: /compare/i }));
  await wait(1500);
  await caption('Compare view: steady-state and timeline KPIs side by side, best and worst highlighted', 4000);
  await scrollMainTo('Total CMS 429s');
  const r429 = await compareRow('Total CMS 429s');
  const rErr = await compareRow('Visitor error rate');
  await caption(
    `With the suggested limit: CMS 429s <b>${r429[0]} → ${r429[1]}</b>, visitor error rate <b>${rErr[0]} → ${rErr[1]}</b>`,
    5000,
  );
  await scrollMainTo('CMS origin offered');
  await wait(2500);

  // 5. Instant what-if
  await scrollMain(0);
  await moveTo(page.getByRole('tab', { name: /steady state/i }));
  await caption('What-ifs are instant: turn off CDN caching for pages…', 0);
  const launchNow = async () => {
    const pct = ((await kpi('Launch origin', true)).match(/([\d.<]+%)/) || ['', '?'])[1];
    return `${await kpi('Launch origin')} (${pct} of limit)`;
  };
  const before = await launchNow();
  const toggle = page.getByRole('switch', { name: 'page: cacheable' });
  await toggle.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await wait(1200);
  const was = await toggle.getAttribute('aria-checked');
  await moveTo(toggle);
  if ((await toggle.getAttribute('aria-checked')) === was) await toggle.click();
  await wait(1500);
  await caption(`…every page view becomes an origin render. Launch origin: <b>${before}</b> → <b>${await launchNow()}</b>`, 5000);
  await moveTo(toggle);
  await wait(800);

  // 6. Outro
  await caption(
    'Every parameter shows where its value comes from: documented, conflicting sources, or an editable assumption',
    4500,
  );
  await caption('<b>Launch Simulator</b>: find the bottleneck before your customers do', 4000);
  await caption('', 500);
}

// ---------- main ----------

const app = await startApp();
mkdirSync(OUT_DIR, { recursive: true });
const rawDir = join(OUT_DIR, '.raw');
rmSync(rawDir, { recursive: true, force: true });

const browser = await chromium.launch();
const errors = [];
try {
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: rawDir, size: { width: W, height: H } },
    colorScheme: 'light',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installOverlay);
  await walkthrough(page, app.url);
  await context.close();
} finally {
  await browser.close();
  app.stop();
}

const raw = readdirSync(rawDir).find((f) => f.endsWith('.webm'));
const webm = join(OUT_DIR, 'launch-simulator-demo.webm');
renameSync(join(rawDir, raw), webm);
rmSync(rawDir, { recursive: true, force: true });
console.log(`WebM: ${webm}`);

const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const probe = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' });
if (probe.status === 0) {
  const mp4 = join(OUT_DIR, 'launch-simulator-demo.mp4');
  const args = ['-loglevel', 'error', '-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23'];
  const conv = spawnSync(ffmpeg, [...args, '-movflags', '+faststart', mp4], { stdio: 'inherit' });
  console.log(conv.status === 0 && existsSync(mp4) ? `MP4:  ${mp4}` : 'MP4 conversion failed; WebM kept.');
} else {
  console.log('ffmpeg not found (set FFMPEG=/path/to/ffmpeg for an MP4); WebM kept.');
}
if (errors.length) {
  console.error(`Page errors during recording:\n${errors.join('\n')}`);
  process.exitCode = 1;
}
