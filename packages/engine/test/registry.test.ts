import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCENARIO,
  PARAMS,
  SOURCES,
  applyPreset,
  getByPath,
  provenanceFor,
  setByPath,
  PresetSchema,
  type Preset,
} from '../src';

function leaves(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

describe('PARAMS registry', () => {
  it('has unique paths that all resolve in the default scenario', () => {
    const paths = PARAMS.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(getByPath(DEFAULT_SCENARIO, p), p).not.toBeUndefined();
  });

  it('covers every numeric/enum leaf of the default scenario', () => {
    const skip = new Set(['schemaVersion', 'name', 'description', 'events']);
    const registered = new Set(PARAMS.map((p) => p.path));
    const missing = leaves(DEFAULT_SCENARIO)
      .filter((p) => !p.startsWith('site.frameworkOverrides') && !skip.has(p))
      .filter((p) => {
        const v = getByPath(DEFAULT_SCENARIO, p);
        return typeof v === 'number' || typeof v === 'string' || v === null;
      })
      .filter((p) => !registered.has(p));
    expect(missing).toEqual([]);
  });

  it('references only known sources', () => {
    for (const p of PARAMS) {
      for (const s of [...p.sources, ...(p.conflict ?? []).map((c) => c.sourceId)]) {
        expect(SOURCES[s], `${p.path} -> ${s}`).toBeDefined();
      }
    }
    for (const s of Object.values(SOURCES)) expect(s.url).toMatch(/^https:\/\//);
  });

  it('flags the CDA limit as conflicting with 80', () => {
    const cda = PARAMS.find((p) => p.path === 'cms.cda.limitRps');
    expect(cda?.provenance).toBe('conflicting');
    expect(cda?.conflict?.[0]?.value).toBe(80);
  });
});

describe('path helpers', () => {
  it('setByPath is immutable', () => {
    const next = setByPath(DEFAULT_SCENARIO, 'cms.cda.limitRps', 5);
    expect(next.cms.cda.limitRps).toBe(5);
    expect(DEFAULT_SCENARIO.cms.cda.limitRps).toBe(100);
  });
});

describe('private presets', () => {
  const preset: Preset = {
    format: 'launch-sim-preset/v1',
    name: 'test',
    overrides: {
      'cms.cda.limitRps': { value: 250, note: 'x' },
      'launch.compute.maxInstances': { value: 50 },
    },
  };

  it('overrides values and reports paths', () => {
    const { scenario, overriddenPaths } = applyPreset(DEFAULT_SCENARIO, PresetSchema.parse(preset));
    expect(scenario.cms.cda.limitRps).toBe(250);
    expect(scenario.launch.compute.maxInstances).toBe(50);
    expect(overriddenPaths).toEqual(['cms.cda.limitRps', 'launch.compute.maxInstances']);
    expect(provenanceFor('cms.cda.limitRps', overriddenPaths)).toBe('private');
    expect(provenanceFor('cms.graphql.limitRps', overriddenPaths)).toBe('documented');
  });

  it('rejects unknown paths', () => {
    const bad: Preset = { ...preset, overrides: { 'cms.nope': { value: 1 } } };
    expect(() => applyPreset(DEFAULT_SCENARIO, bad)).toThrow(/unknown parameter paths/);
  });

  it('rejects invalid values and wrong format', () => {
    const bad: Preset = { ...preset, overrides: { 'cms.cda.limitRps': { value: 'fast' } } };
    expect(() => applyPreset(DEFAULT_SCENARIO, bad)).toThrow();
    expect(() => PresetSchema.parse({ ...preset, format: 'v2' })).toThrow();
  });
});
