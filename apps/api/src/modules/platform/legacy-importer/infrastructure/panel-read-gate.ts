import { Client } from 'pg';
import { abortableSleep } from './rickpanel-read-session.js';

/**
 * One migration read of a panel at a time — in the whole installation, not in a process
 * (owner requirement on PR #281; CLAUDE.md: "nothing about a probe is decided in a
 * process"). Two dry runs, a dry run and an import, the CLI and the Web Admin, two worker
 * replicas: whichever comes second waits, and its wait ends on the step's signal.
 *
 * Keyed by the panel's ORIGIN, not its row: two panel rows (two tenants) can point at one
 * machine, and it is the machine that is being protected.
 */
export interface PanelReadLease {
  /** True once the claim is gone for any reason but our own release. */
  isLost(): boolean;
  release(): Promise<void>;
}

export interface PanelReadGate {
  acquire(key: string, signal?: AbortSignal): Promise<PanelReadLease>;
}

/** The key a panel's reads queue on: its scheme, host and port. */
export function panelReadKey(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin.toLowerCase();
  } catch {
    return baseUrl.trim().toLowerCase();
  }
}

/**
 * The same rule inside one process: reads of one key run one after another. What a source
 * built outside the container (a unit test, a tool) gets; the container wires the
 * PostgreSQL gate below, which also orders reads in different processes.
 */
export class InProcessPanelReadGate implements PanelReadGate {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string, signal?: AbortSignal): Promise<PanelReadLease> {
    signal?.throwIfAborted();
    const previous = this.tails.get(key) ?? Promise.resolve();
    let open!: () => void;
    const mine = new Promise<void>((resolve) => {
      open = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          reject(signal?.reason as Error);
        };
        signal?.addEventListener('abort', abort, { once: true });
        void previous.then(() => {
          signal?.removeEventListener('abort', abort);
          resolve();
        });
      });
    } catch (error) {
      // Gave up waiting: our turn passes straight on, so nobody behind waits for us.
      open();
      if (this.tails.get(key) === tail) this.tails.delete(key);
      throw error;
    }
    let released = false;
    return {
      isLost: () => false,
      release: async () => {
        if (released) return;
        released = true;
        open();
        if (this.tails.get(key) === tail) this.tails.delete(key);
      },
    };
  }
}

/** The process-local gate every source shares unless it is given another. */
export const PROCESS_PANEL_READ_GATE: PanelReadGate = new InProcessPanelReadGate();

/** `pg_try_advisory_lock` class of a migration's panel read ('RI'). */
export const PANEL_READ_LOCK_CLASS = 0x5249;
/** How often a waiting read asks again. */
export const PANEL_READ_LOCK_POLL_MS = 2_000;

/**
 * The installation-wide gate: a SESSION advisory lock on a connection of its own, held for
 * the whole read (as `PgLegacyImportProcessLock` holds the importer's claim — never a
 * pooled connection held for minutes). A waiter polls `pg_try_advisory_lock` rather than
 * blocking in `pg_advisory_lock`, so its wait ends on the step's signal. A holder that dies
 * loses the lock with its session, and the next waiter proceeds.
 */
export class PgPanelReadGate implements PanelReadGate {
  constructor(
    private readonly databaseUrl: string,
    private readonly options: {
      readonly pollMs?: number;
      readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    } = {},
  ) {}

  async acquire(key: string, signal?: AbortSignal): Promise<PanelReadLease> {
    signal?.throwIfAborted();
    const client = new Client({ connectionString: this.databaseUrl, keepAlive: true });
    let lost = false;
    let released = false;
    const markLost = () => {
      if (!released) lost = true;
    };
    client.on('error', markLost);
    client.on('end', markLost);
    await client.connect();
    const sleep = this.options.sleep ?? abortableSleep;
    try {
      for (;;) {
        const result = await client.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock($1::int, hashtext($2::text)) AS ok',
          [PANEL_READ_LOCK_CLASS, key],
        );
        if (result.rows[0]?.ok === true) break;
        await sleep(this.options.pollMs ?? PANEL_READ_LOCK_POLL_MS, signal);
      }
    } catch (error) {
      released = true;
      await client.end().catch(() => undefined);
      throw error;
    }
    return {
      isLost: () => lost,
      release: async () => {
        if (released) return;
        released = true;
        await client
          .query('SELECT pg_advisory_unlock($1::int, hashtext($2::text))', [
            PANEL_READ_LOCK_CLASS,
            key,
          ])
          .catch(() => undefined);
        await client.end().catch(() => undefined);
      },
    };
  }
}
