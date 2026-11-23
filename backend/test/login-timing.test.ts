import { describe, expect, it } from 'vitest';
import { FailureTiming } from '../src/auth/auth.controller';

/** Rule 6: unknown domains must not answer measurably faster than wrong passwords. */
describe('login failure timing', () => {
  it('learns how long real password rejections take and pads other failures to it', () => {
    const t = new FailureTiming(1200, 15_000);
    expect(t.target()).toBeGreaterThanOrEqual(1200);
    for (let i = 0; i < 30; i++) t.observe(10_700);
    const samples = Array.from({ length: 50 }, () => t.target());
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(10_000);
    expect(Math.max(...samples)).toBeLessThanOrEqual(10_700 + 0.2 * 10_700 + 1);
  });

  it('stays between the floor and the cap', () => {
    const t = new FailureTiming(1200, 15_000);
    for (let i = 0; i < 50; i++) t.observe(5);
    expect(t.target()).toBeGreaterThanOrEqual(1200);
    for (let i = 0; i < 50; i++) t.observe(120_000);
    expect(t.target()).toBeLessThanOrEqual(15_000 + 3000);
  });
});
