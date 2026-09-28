import { beforeEach, describe, expect, it } from 'vitest';
import { TEMPLATES, getByPath, type Preset } from '@launch-sim/engine';
import { buildShareUrl, decodeScenario, defaultScenario, useAppStore } from './store';

const preset: Preset = {
  format: 'launch-sim-preset/v1',
  name: 'Internal',
  overrides: { 'launch.originLimitRps': { value: 4321 }, 'cms.cda.limitRps': { value: 999 } },
};

beforeEach(() => {
  useAppStore.getState().clearPrivatePreset();
  useAppStore.getState().setScenario(defaultScenario());
});

describe('store', () => {
  it('setParam accepts valid values and recomputes steady state', () => {
    const before = useAppStore.getState().steady;
    useAppStore.getState().setParam('traffic.baseEdgeRps', 5000);
    const st = useAppStore.getState();
    expect(st.scenario.traffic.baseEdgeRps).toBe(5000);
    expect(st.steady).not.toBe(before);
    expect(st.paramError).toBeNull();
  });

  it('setParam rejects invalid values', () => {
    const before = useAppStore.getState().scenario;
    useAppStore.getState().setParam('traffic.bots.share', 5);
    const st = useAppStore.getState();
    expect(st.scenario).toBe(before);
    expect(st.paramError?.path).toBe('traffic.bots.share');
  });

  it('loads templates', () => {
    const t = TEMPLATES[1]!;
    useAppStore.getState().loadTemplate(t.id);
    expect(useAppStore.getState().scenario.name).toBe(t.name);
  });

  it('applies and clears a private preset', () => {
    const st = useAppStore.getState();
    st.loadPrivatePreset(preset);
    expect(useAppStore.getState().scenario.launch.originLimitRps).toBe(4321);
    expect(useAppStore.getState().privatePaths).toContain('cms.cda.limitRps');
    useAppStore.getState().clearPrivatePreset();
    const after = useAppStore.getState();
    expect(after.privatePaths).toEqual([]);
    expect(after.scenario.launch.originLimitRps).toBe(getByPath(defaultScenario(), 'launch.originLimitRps'));
  });

  it('share URL round-trips and strips private values', () => {
    useAppStore.getState().loadPrivatePreset(preset);
    useAppStore.getState().setParam('traffic.baseEdgeRps', 1234);
    const stripped = decodeScenario(buildShareUrl(true).split('#s=')[1]!)!;
    expect(stripped.traffic.baseEdgeRps).toBe(1234);
    expect(stripped.launch.originLimitRps).toBe(defaultScenario().launch.originLimitRps);
    const full = decodeScenario(buildShareUrl(false).split('#s=')[1]!)!;
    expect(full.launch.originLimitRps).toBe(4321);
  });
});
