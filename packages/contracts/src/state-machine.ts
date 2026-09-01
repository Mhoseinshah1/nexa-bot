/**
 * State machines as data.
 *
 * A state machine is declared here as a value, not as a switch statement in a
 * service. Two things follow: transition tests are generated from the
 * declaration rather than written by hand, and a static check can prove that no
 * state is unreachable and no non-terminal state is a dead end.
 *
 * The legacy system encodes one service status four different ways (`active`,
 * `فعال`, `🚫 پایان حجم`, `🔚 پایان زمان سرویس`) and mixes order lifecycle with
 * panel-sync failure in a single seven-value column. Declaring machines as data
 * with database CHECK constraints derived from them makes that impossible.
 *
 * Phase 0 ships the encoding and the checker. The Order, Payment and Service
 * machines land with their own phases.
 */

export interface TransitionDefinition<TState extends string, TEvent extends string> {
  readonly from: TState;
  readonly to: TState;
  readonly on: TEvent;
  /** Named guard, resolved by the owning module. Documentation here, code there. */
  readonly guard?: string;
}

export interface StateMachineDefinition<TState extends string, TEvent extends string> {
  readonly name: string;
  readonly initial: TState;
  readonly states: readonly TState[];
  readonly terminal: readonly TState[];
  readonly transitions: readonly TransitionDefinition<TState, TEvent>[];
}

export interface StateMachineProblem {
  readonly machine: string;
  readonly kind: 'UNREACHABLE_STATE' | 'DEAD_END_STATE' | 'UNKNOWN_STATE' | 'INITIAL_NOT_A_STATE';
  readonly state: string;
  readonly message: string;
}

/**
 * Validates a machine's graph. Run in CI over every declared machine.
 */
export function validateStateMachine<TState extends string, TEvent extends string>(
  machine: StateMachineDefinition<TState, TEvent>,
): StateMachineProblem[] {
  const problems: StateMachineProblem[] = [];
  const states = new Set<string>(machine.states);

  if (!states.has(machine.initial)) {
    problems.push({
      machine: machine.name,
      kind: 'INITIAL_NOT_A_STATE',
      state: machine.initial,
      message: `Initial state "${machine.initial}" is not in the state list.`,
    });
  }

  for (const transition of machine.transitions) {
    for (const state of [transition.from, transition.to]) {
      if (!states.has(state)) {
        problems.push({
          machine: machine.name,
          kind: 'UNKNOWN_STATE',
          state,
          message: `Transition on "${transition.on}" references unknown state "${state}".`,
        });
      }
    }
  }

  const reachable = new Set<string>([machine.initial]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const transition of machine.transitions) {
      if (reachable.has(transition.from) && !reachable.has(transition.to)) {
        reachable.add(transition.to);
        grew = true;
      }
    }
  }

  const terminal = new Set<string>(machine.terminal);
  for (const state of machine.states) {
    if (!reachable.has(state)) {
      problems.push({
        machine: machine.name,
        kind: 'UNREACHABLE_STATE',
        state,
        message: `State "${state}" cannot be reached from "${machine.initial}".`,
      });
    }
    if (!terminal.has(state) && !machine.transitions.some((t) => t.from === state)) {
      problems.push({
        machine: machine.name,
        kind: 'DEAD_END_STATE',
        state,
        message: `State "${state}" is not terminal but has no outgoing transition.`,
      });
    }
  }

  return problems;
}

export function canTransition<TState extends string, TEvent extends string>(
  machine: StateMachineDefinition<TState, TEvent>,
  from: TState,
  on: TEvent,
): boolean {
  return machine.transitions.some((t) => t.from === from && t.on === on);
}

export function nextState<TState extends string, TEvent extends string>(
  machine: StateMachineDefinition<TState, TEvent>,
  from: TState,
  on: TEvent,
): TState | null {
  return machine.transitions.find((t) => t.from === from && t.on === on)?.to ?? null;
}

/**
 * Every declared machine, so CI can validate them all. Phase 0 declares none —
 * the business machines arrive with their modules.
 */
export const STATE_MACHINES: readonly StateMachineDefinition<string, string>[] = [];
