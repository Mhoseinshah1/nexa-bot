import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { installProcessBackstop } from '../../apps/api/src/infrastructure/lifecycle/process-backstop';

/**
 * The process-level backstop every `main*.ts` installs (v0.8.2 hotfix): a rejection
 * nobody handled is logged and survived — before it, Node 22 exited the whole role on one —
 * and an uncaught exception is logged and still exits, because the state it interrupted
 * may be half-changed.
 */

function recordingLogger() {
  const errors: { context: Record<string, unknown>; message: string }[] = [];
  return {
    errors,
    error(context: Record<string, unknown>, message: string) {
      errors.push({ context, message });
    },
  };
}

describe('the process backstop', () => {
  function harness(logger = recordingLogger()) {
    const target = new EventEmitter();
    const exits: number[] = [];
    const backstop = installProcessBackstop({
      role: 'worker',
      logger,
      exit: (code) => exits.push(code),
      target: target as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
    });
    return { target, exits, logger, backstop };
  }

  it('an unhandled rejection is logged and the process keeps running', () => {
    const { target, exits, logger, backstop } = harness();
    target.emit('unhandledRejection', new Error('dropped'), Promise.resolve());
    expect(exits).toEqual([]);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.context).toMatchObject({ role: 'worker', unhandledRejections: 1 });
    expect(backstop.unhandledRejections()).toBe(1);
  });

  it('a logger that throws inside the rejection handler does not throw out of it', () => {
    const broken = {
      errors: [],
      error: () => {
        throw new Error('logger broken');
      },
    };
    const { target, exits } = harness(broken as never);
    expect(() => target.emit('unhandledRejection', new Error('dropped'))).not.toThrow();
    expect(exits).toEqual([]);
  });

  it('an uncaught exception is logged and the process exits with 1', () => {
    const { target, exits, logger } = harness();
    target.emit('uncaughtException', new Error('sync crash'), 'uncaughtException');
    expect(logger.errors[0]?.message).toContain('uncaught exception');
    expect(exits).toEqual([1]);
  });

  it('uninstall removes both listeners', () => {
    const { target, backstop } = harness();
    backstop.uninstall();
    expect(target.listenerCount('unhandledRejection')).toBe(0);
    expect(target.listenerCount('uncaughtException')).toBe(0);
  });
});
