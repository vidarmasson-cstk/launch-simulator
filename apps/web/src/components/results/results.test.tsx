import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScenarioSchema, computeSteadyState } from '@launch-sim/engine';
import { FlowDiagram } from './FlowDiagram';
import { SteadyStatePanel } from './SteadyStatePanel';
import { bestWorst } from './ComparePanel';
import { sortFindings } from './FindingsPanel';

const steady = computeSteadyState(ScenarioSchema.parse({}));

describe('results views', () => {
  it('renders the flow diagram with every hop', () => {
    render(<FlowDiagram hops={steady.hops} />);
    expect(screen.getByLabelText('Request flow diagram')).toBeTruthy();
    for (const h of steady.hops) {
      expect(screen.getAllByLabelText(new RegExp(`^${h.label.replace(/[()]/g, '\\$&')}:`)).length).toBeGreaterThan(0);
    }
  });

  it('renders the steady-state panel with a verdict and KPI tiles', () => {
    const { container } = render(<SteadyStatePanel steady={steady} />);
    expect(screen.getByText(/CMS origin at/)).toBeTruthy();
    expect(screen.getByText('Suggested CMS limit')).toBeTruthy();
    expect(container.querySelectorAll('[title], div.rounded-lg').length).toBeGreaterThan(8);
  });

  it('picks best and worst per row', () => {
    const r = bestWorst([5, 10, undefined], 'lower');
    expect([...r.best]).toEqual([0]);
    expect([...r.worst]).toEqual([1]);
    expect(bestWorst([3, 3], 'lower').best.size).toBe(0);
    expect(bestWorst([1, 2], undefined).best.size).toBe(0);
  });

  it('sorts findings by severity', () => {
    const f = sortFindings([
      { severity: 'info', title: 'a', detail: '' },
      { severity: 'critical', title: 'b', detail: '' },
      { severity: 'warning', title: 'c', detail: '' },
    ]);
    expect(f.map((x) => x.severity)).toEqual(['critical', 'warning', 'info']);
  });
});
