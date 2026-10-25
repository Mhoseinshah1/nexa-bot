import { describe, expect, it } from 'vitest';
import type { Logger } from '@nexa/contracts';
import { createLogger } from '../../apps/api/src/infrastructure/logging/logger';

/**
 * v0.8.2: the worker crash-looped every ~13 s on `TypeError: Cannot read properties of
 * undefined (reading 'emit')`, thrown by the LOG CALL itself. The FX loop called
 * `(logger.warn ?? logger.info)(…)` — a method read off its object and called with no
 * `this` — and the process logger's methods were prototype methods that call `this.emit`.
 *
 * Every test of that loop passed plain-object loggers whose methods were arrow functions,
 * so nothing ever ran the real logger detached. These do: each method, read off a real
 * `createLogger` logger and off a child, is called with no receiver and must write its line.
 */
describe('the process logger survives a detached method call', () => {
  const capture = () => {
    const lines: string[] = [];
    const logger = createLogger('trace', 'test', { write: (chunk: string) => lines.push(chunk) });
    return { lines, logger };
  };

  const levels = ['trace', 'debug', 'info', 'warn', 'error'] as const;

  for (const level of levels) {
    it(`logger.${level} works detached from its logger`, () => {
      const { lines, logger } = capture();
      const detached = logger[level];
      expect(() => detached({ probe: level }, `detached ${level}`)).not.toThrow();
      expect(lines).toHaveLength(1);
      const line = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      expect(line).toMatchObject({ level, probe: level, msg: `detached ${level}`, role: 'test' });
    });
  }

  it('the exact shape that crashed v0.8.2: (logger.warn ?? logger.info)(…)', () => {
    const { lines, logger } = capture();
    const loose: Partial<Pick<Logger, 'warn'>> & Pick<Logger, 'info'> = logger;
    expect(() =>
      (loose.warn ?? loose.info)({ outcome: 'FAILED' }, 'fx refresh failing; backing off'),
    ).not.toThrow();
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      level: 'warn',
      msg: 'fx refresh failing; backing off',
    });
  });

  it('a destructured child logger keeps its bindings and still redacts', () => {
    const { lines, logger } = capture();
    const { child } = logger;
    const { error } = child({ component: 'probe' });
    error({ botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi' }, 'detached child error');
    const line = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'error', component: 'probe', msg: 'detached child error' });
    expect(JSON.stringify(line)).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });
});
