/**
 * Step-cap counting fix: gate-kind partition in pi-coding-driver.
 *
 * Regression for the counting defect in onAllowedBash:
 *  - an executor call was counted in executorCalls and again in
 *    auxiliaryCalls (the else branch treated "not local" as auxiliary);
 *  - the wind-down (cap+1) call was dropped from local/auxiliary when it
 *    was local, but kept in executorCalls when it was executor, so the
 *    partition sum did not equal gateCalls and platformExecutorBypassed
 *    could be silently suppressed when the wind-down call was the round's
 *    only local call.
 *
 * The driver counts through recordAllowedBashCall and fires the wind-down
 * tracker as a side effect only, so this test drives the same two
 * production functions in sequence (small caps stand in for cap=50):
 * recordAllowedBashCall for the partition, createStepCapWindDown for the
 * once-only steer. It does not re-test the tracker in isolation.
 */
import { describe, expect, it } from 'vitest';
import type { GateInvocationKind } from './serve-gate';
import {
  platformExecutorBypassed,
  recordAllowedBashCall,
  type GateCallCounts,
} from './pi-coding-driver';
import { createStepCapWindDown } from './worker-step-cap';

const zero = (): GateCallCounts => ({
  gateCalls: 0,
  executorCalls: 0,
  localCalls: 0,
  auxiliaryCalls: 0,
});

function runSequence(kinds: GateInvocationKind[], cap: number): {
  counts: GateCallCounts;
  steers: number;
} {
  let counts = zero();
  let steers = 0;
  const fire = createStepCapWindDown(cap, () => {
    steers += 1;
  });
  for (const kind of kinds) {
    counts = recordAllowedBashCall(counts, kind);
    fire(counts.gateCalls);
  }
  return { counts, steers };
}

describe('recordAllowedBashCall partition', () => {
  it('counts exactly one sub-count per call', () => {
    expect(recordAllowedBashCall(zero(), 'executor')).toEqual({
      gateCalls: 1,
      executorCalls: 1,
      localCalls: 0,
      auxiliaryCalls: 0,
    });
    expect(recordAllowedBashCall(zero(), 'local')).toEqual({
      gateCalls: 1,
      executorCalls: 0,
      localCalls: 1,
      auxiliaryCalls: 0,
    });
    expect(recordAllowedBashCall(zero(), 'auxiliary')).toEqual({
      gateCalls: 1,
      executorCalls: 0,
      localCalls: 0,
      auxiliaryCalls: 1,
    });
  });

  it('wind-down local call is still counted, so a unique local still discloses', () => {
    // cap=2 stands in for cap=50: the 3rd call is the wind-down call.
    const { counts, steers } = runSequence(
      ['auxiliary', 'auxiliary', 'local'],
      2,
    );
    expect(steers).toBe(1);
    expect(counts).toEqual({
      gateCalls: 3,
      executorCalls: 0,
      localCalls: 1,
      auxiliaryCalls: 2,
    });
    expect(counts.executorCalls + counts.localCalls + counts.auxiliaryCalls).toBe(
      counts.gateCalls,
    );
    expect(
      platformExecutorBypassed({
        localCalls: counts.localCalls,
        executorCalls: counts.executorCalls,
        producedFiles: ['out.txt'],
      }),
    ).toBe(true);
  });

  it('executor calls are not double-counted into auxiliary', () => {
    const { counts, steers } = runSequence(
      ['executor', 'executor', 'local'],
      50,
    );
    expect(steers).toBe(0);
    expect(counts).toEqual({
      gateCalls: 3,
      executorCalls: 2,
      localCalls: 1,
      auxiliaryCalls: 0,
    });
    expect(counts.executorCalls + counts.localCalls + counts.auxiliaryCalls).toBe(
      counts.gateCalls,
    );
  });

  it('wind-down executor call is counted, steer fires once, counting continues', () => {
    const { counts, steers } = runSequence(
      ['auxiliary', 'local', 'executor', 'local'],
      2,
    );
    expect(steers).toBe(1);
    expect(counts).toEqual({
      gateCalls: 4,
      executorCalls: 1,
      localCalls: 2,
      auxiliaryCalls: 1,
    });
    expect(counts.executorCalls + counts.localCalls + counts.auxiliaryCalls).toBe(
      counts.gateCalls,
    );
  });
});
