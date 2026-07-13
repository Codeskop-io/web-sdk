import { describe, expect, it } from 'vitest';
import { ClientStateMachine, IllegalStateTransitionError, canTransition } from './state.js';

describe('canTransition', () => {
  it('allows uninitialized -> enabled, disabled, killed', () => {
    expect(canTransition('uninitialized', 'enabled')).toBe(true);
    expect(canTransition('uninitialized', 'disabled')).toBe(true);
    expect(canTransition('uninitialized', 'killed')).toBe(true);
  });

  it('allows enabled <-> disabled and enabled -> killed', () => {
    expect(canTransition('enabled', 'disabled')).toBe(true);
    expect(canTransition('disabled', 'enabled')).toBe(true);
    expect(canTransition('enabled', 'killed')).toBe(true);
    expect(canTransition('disabled', 'killed')).toBe(true);
  });

  it('disallows any transition out of killed', () => {
    expect(canTransition('killed', 'enabled')).toBe(false);
    expect(canTransition('killed', 'disabled')).toBe(false);
    expect(canTransition('killed', 'uninitialized')).toBe(false);
  });

  it('disallows re-entering uninitialized from any state', () => {
    expect(canTransition('enabled', 'uninitialized')).toBe(false);
    expect(canTransition('disabled', 'uninitialized')).toBe(false);
  });

  it('disallows a no-op self-transition', () => {
    expect(canTransition('enabled', 'enabled')).toBe(false);
  });
});

describe('ClientStateMachine', () => {
  it('starts uninitialized by default', () => {
    expect(new ClientStateMachine().state).toBe('uninitialized');
  });

  it('accepts an explicit initial state', () => {
    expect(new ClientStateMachine('enabled').state).toBe('enabled');
  });

  it('reports isEnabled/isKilled correctly per state', () => {
    const machine = new ClientStateMachine();
    expect(machine.isEnabled()).toBe(false);
    machine.transition('enabled');
    expect(machine.isEnabled()).toBe(true);
    expect(machine.isKilled()).toBe(false);
    machine.transition('killed');
    expect(machine.isEnabled()).toBe(false);
    expect(machine.isKilled()).toBe(true);
  });

  it('tryTransition applies a legal move and returns true', () => {
    const machine = new ClientStateMachine();
    expect(machine.tryTransition('enabled')).toBe(true);
    expect(machine.state).toBe('enabled');
  });

  it('tryTransition leaves state untouched and returns false on an illegal move', () => {
    const machine = new ClientStateMachine('killed');
    expect(machine.tryTransition('enabled')).toBe(false);
    expect(machine.state).toBe('killed');
  });

  it('transition throws IllegalStateTransitionError on an illegal move, with from/to attached', () => {
    const machine = new ClientStateMachine('killed');
    try {
      machine.transition('enabled');
      expect.unreachable('expected transition to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalStateTransitionError);
      const illegal = error as IllegalStateTransitionError;
      expect(illegal.from).toBe('killed');
      expect(illegal.to).toBe('enabled');
      expect(illegal.message).toContain('killed -> enabled');
    }
  });

  it('supports the full recoverable enable/disable cycle', () => {
    const machine = new ClientStateMachine();
    machine.transition('enabled');
    machine.transition('disabled');
    machine.transition('enabled');
    expect(machine.state).toBe('enabled');
  });
});
