import { describe, expect, it } from 'vitest';
import {
  fmtBig,
  fmtClock,
  fmtMs,
  fmtNum,
  fmtPct,
  fmtProb,
  fmtRatio,
  fmtRps,
  fmtSecPerHour,
} from './format';

describe('format', () => {
  it('formats big numbers', () => {
    expect(fmtBig(0)).toBe('0');
    expect(fmtBig(8.24)).toBe('8.2');
    expect(fmtBig(143)).toBe('143');
    expect(fmtBig(999.7)).toBe('1K');
    expect(fmtBig(1234)).toBe('1.2K');
    expect(fmtBig(8200)).toBe('8.2K');
    expect(fmtBig(12_500)).toBe('13K');
    expect(fmtBig(999_900)).toBe('1M');
    expect(fmtBig(3_400_000)).toBe('3.4M');
    expect(fmtBig(2_100_000_000)).toBe('2.1B');
    expect(fmtBig(NaN)).toBe('–');
  });
  it('formats rps', () => {
    expect(fmtRps(0)).toBe('0');
    expect(fmtRps(0.25)).toBe('0.25');
    expect(fmtRps(1200)).toBe('1.2K');
  });
  it('formats percentages', () => {
    expect(fmtPct(143.2)).toBe('143%');
    expect(fmtPct(0.2)).toBe('<1%');
    expect(fmtPct(33.56, 1)).toBe('33.6%');
    expect(fmtRatio(0.923)).toBe('92%');
    expect(fmtRatio(0.9234, 1)).toBe('92.3%');
  });
  it('formats probabilities', () => {
    expect(fmtProb(0)).toBe('0%');
    expect(fmtProb(1e-6)).toBe('<0.01%');
    expect(fmtProb(0.005)).toBe('0.50%');
    expect(fmtProb(0.5)).toBe('50%');
  });
  it('formats durations', () => {
    expect(fmtMs(85)).toBe('85 ms');
    expect(fmtMs(1500)).toBe('1.5 s');
    expect(fmtMs(90_000)).toBe('1.5 min');
    expect(fmtClock(75)).toBe('01:15');
    expect(fmtClock(3725)).toBe('1:02:05');
  });
  it('formats misc', () => {
    expect(fmtNum(2.0)).toBe('2');
    expect(fmtNum(2.5)).toBe('2.5');
    expect(fmtSecPerHour(0.001)).toBe('~0');
    expect(fmtSecPerHour(3.14)).toBe('3.1');
    expect(fmtSecPerHour(1500)).toBe('1.5K');
  });
});
