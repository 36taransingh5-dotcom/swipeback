import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  EXPENSE_MACHINE,
  IllegalTransitionError,
  REIMBURSEMENT_MACHINE,
  STATE_MACHINES,
  type StateMachine,
} from '@swipeback/domain';

function reachable<S extends string>(m: StateMachine<S>, from: S, without: readonly S[] = []): Set<S> {
  const seen = new Set<S>([from]);
  const queue: S[] = [from];
  while (queue.length) {
    const s = queue.shift()!;
    for (const [f, t] of m.transitions) {
      if (f === s && !without.includes(t) && !seen.has(t)) {
        seen.add(t);
        queue.push(t);
      }
    }
  }
  return seen;
}

describe.each(STATE_MACHINES.map((m) => [m.name, m] as const))('%s state machine', (_name, machine) => {
  const m = machine as StateMachine<string>;

  it('every (from, to) pair is either tabled or rejected — exhaustively', () => {
    const tabled = new Set(m.transitions.map(([f, t]) => `${f}>${t}`));
    for (const from of m.states) {
      for (const to of m.states) {
        const legal = tabled.has(`${from}>${to}`);
        expect(canTransition(m, from, to), `${from} -> ${to}`).toBe(legal);
        if (legal) expect(() => assertTransition(m, from, to)).not.toThrow();
        else expect(() => assertTransition(m, from, to)).toThrow(IllegalTransitionError);
      }
    }
  });

  it('has no duplicate or self transitions and only known states', () => {
    const keys = m.transitions.map(([f, t]) => `${f}>${t}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [f, t] of m.transitions) {
      expect(f).not.toBe(t);
      expect(m.states).toContain(f);
      expect(m.states).toContain(t);
    }
  });

  it('every state is reachable from the initial state; terminal states have no exits', () => {
    expect([...reachable(m, m.initial)].sort()).toEqual([...m.states].sort());
    for (const t of m.terminal) expect(m.transitions.filter(([f]) => f === t)).toEqual([]);
  });
});

describe('safety properties of the transition graphs', () => {
  it('an expense cannot be auto-cleared without passing POLICY_CHECK', () => {
    expect(reachable(EXPENSE_MACHINE, 'RECEIVED', ['POLICY_CHECK']).has('AUTO_CLEARED')).toBe(false);
  });

  it('nothing is cleared or exported without either the policy engine or a human reviewer', () => {
    const neither = reachable(EXPENSE_MACHINE, 'RECEIVED', ['POLICY_CHECK', 'REVIEW_REQUIRED']);
    for (const s of ['AUTO_CLEARED', 'APPROVED', 'EXPORTED'] as const) expect(neither.has(s), s).toBe(false);
  });

  it('APPROVED is reachable only through REVIEW_REQUIRED (a human decision)', () => {
    expect(reachable(EXPENSE_MACHINE, 'RECEIVED', ['REVIEW_REQUIRED']).has('APPROVED')).toBe(false);
    expect(EXPENSE_MACHINE.transitions.filter(([, t]) => t === 'APPROVED')).toEqual([['REVIEW_REQUIRED', 'APPROVED']]);
  });

  it('a reimbursement cannot be paid without passing ELIGIBILITY_CHECK, AUTHORIZED and PAYOUT_QUEUED', () => {
    for (const gate of ['ELIGIBILITY_CHECK', 'AUTHORIZED', 'PAYOUT_QUEUED'] as const) {
      expect(reachable(REIMBURSEMENT_MACHINE, 'DRAFT', [gate]).has('SIMULATED_PAID'), gate).toBe(false);
    }
    expect(canTransition(REIMBURSEMENT_MACHINE, 'DRAFT', 'SIMULATED_PAID')).toBe(false);
    expect(canTransition(EXPENSE_MACHINE, 'RECEIVED', 'AUTO_CLEARED')).toBe(false);
  });

  it('a paid reimbursement can never move again (no double pay via re-queue)', () => {
    expect(REIMBURSEMENT_MACHINE.transitions.filter(([f]) => f === 'SIMULATED_PAID')).toEqual([]);
  });
});
