import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The Web Admin bundle is published into a volume that a RUNNING Caddy is
 * serving out of. The publisher that shipped before this suite deleted that
 * directory and then copied into it, so on every update there was a window
 * where the served root was empty and then half written.
 *
 * These tests run the real script — the one `deploy/compose.yml` invokes, by
 * path, as a subprocess, with the same environment contract — against a
 * temporary directory. That matters more than it usually would: the Ubuntu
 * job is the only place a container can be started, so a suite that exercised
 * a re-typed copy of the logic would prove nothing about what is deployed.
 *
 * The property under test is per REQUEST: whatever `current` resolves to at
 * the moment a file is opened is a complete release. The concurrency test
 * below is the one that can actually fail if the activation stops being a
 * single rename(2).
 */

const publisher = join(__dirname, '../../deploy/bin/publish-web-assets.mjs');

/**
 * Acquire, prove nobody else holds it, release. Run eight at a time.
 *
 * The marker is written INSIDE the critical section and removed at the end of
 * it, so a second holder finds it and exits non-zero. `wx` is the check: it is
 * one atomic create that fails if the file is there.
 */
const CONTEND_FOR_LOCK = `
  const { acquireLock, releaseLock } = await import(process.env.NEXA_PUBLISHER);
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = process.env.NEXA_ROOT, id = process.env.NEXA_ID;
  const token = 'contender-' + id;
  const lockDir = acquireLock(root, token);
  const inside = path.join(root, 'inside');
  try {
    fs.writeFileSync(inside, id, { flag: 'wx' });
  } catch (error) {
    process.stderr.write('two holders at once: ' + String(error) + String.fromCharCode(10));
    process.exit(1);
  }
  fs.mkdirSync(path.join(root, 'held'), { recursive: true });
  fs.writeFileSync(path.join(root, 'held', id), '');
  fs.rmSync(inside);
  releaseLock(lockDir, token);
`;

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'nexa-web-assets-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * A bundle shaped like the real one: an index.html naming hashed assets, and
 * those assets. Every file carries the release token, so a tree assembled out
 * of two releases is detectable by reading any two files from it.
 */
function writeBundle(dir: string, token: string, assetCount = 2, repeats = 64): void {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  const names = Array.from({ length: assetCount }, (_, i) => `app-${token}-${i}.js`);
  for (const name of names) {
    writeFileSync(join(dir, 'assets', name), `// release ${token}\n`.repeat(repeats));
  }
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html><meta name="release" content="${token}">` +
      names.map((n) => `<script src="/assets/${n}"></script>`).join('') +
      '\n',
  );
}

function source(token: string, assetCount = 2, repeats = 64): string {
  const dir = join(workspace, `src-${token}`);
  writeBundle(dir, token, assetCount, repeats);
  return dir;
}

function root(): string {
  const dir = join(workspace, 'srv-web');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(sourceDir: string, rootDir: string): string {
  return execFileSync(process.execPath, [publisher], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NEXA_WEB_SOURCE_DIR: sourceDir,
      NEXA_WEB_ASSET_ROOT: rootDir,
    },
  });
}

/** The release id `current` names, read the way Caddy resolves it. */
function activeId(rootDir: string): string {
  const target = readlinkSync(join(rootDir, 'current'));
  expect(target).toMatch(/^releases\/[0-9a-f]{32}$/);
  return target.slice('releases/'.length);
}

function releases(rootDir: string): string[] {
  return readdirSync(join(rootDir, 'releases')).sort();
}

/** The entry document Caddy would serve: `root * /srv/web/current`. */
function readIndex(rootDir: string): string {
  return readFileSync(join(rootDir, 'current', 'index.html'), 'utf8');
}

/** The release an entry document belongs to. */
function declaredRelease(html: string): string {
  const declared = /name="release" content="([^"]+)"/.exec(html);
  if (declared === null) throw new Error(`index.html declares no release: ${html.slice(0, 80)}`);
  return declared[1]!;
}

/**
 * Load a document's assets the way Caddy does: `/assets/*` is rooted at the
 * POOL, not at the activated release. Throws if one is missing, and returns
 * the set of release tokens the files actually carry.
 *
 * The FIRST and the LAST asset, not every one. A publisher that copied into a
 * served directory writes in some order, so a new index.html beside an
 * unwritten last asset is exactly the mixed state; reading all forty would
 * find the same thing and would make one "request" forty times slower than
 * the publication it is racing.
 */
function loadAssets(rootDir: string, html: string): Set<string> {
  const named = [...html.matchAll(/src="\/assets\/([^"]+)"/g)].map((match) => match[1]!);
  if (named.length === 0) throw new Error('index.html names no assets');
  const tokens = new Set<string>();
  for (const asset of [named[0]!, named[named.length - 1]!]) {
    const body = readFileSync(join(rootDir, 'pool', 'assets', asset), 'utf8');
    const from = /release (\S+)/.exec(body);
    if (from === null) throw new Error(`asset ${asset} names no release`);
    tokens.add(from[1]!);
  }
  return tokens;
}

/**
 * One page load: the entry document, then its assets. Returns every release
 * token it touched — more than one means the page was assembled out of two
 * releases.
 */
function readServedTokens(rootDir: string): Set<string> {
  const html = readIndex(rootDir);
  const tokens = loadAssets(rootDir, html);
  tokens.add(declaredRelease(html));
  return tokens;
}

/**
 * How many assets the directory the publisher is currently writing holds, if
 * it holds SOME but not all of them — 0 when there is no such directory.
 *
 * `settled` names the releases that were already published when the run being
 * watched started, and it is load-bearing rather than tidy: without it this
 * matches the ACTIVATED release, which has fewer assets than the incoming
 * bundle and is complete. That made the caller kill the publisher before it
 * had copied anything, and a test that killed a run at its very start passed
 * against every publisher there is.
 *
 * Deliberately blind to WHICH directory it finds otherwise. A publisher that
 * stages off to one side is caught by its staging directory; one that copies
 * into the release directory it will activate is caught by that. Both are the
 * half-written tree this exists to find.
 */
function partiallyWritten(rootDir: string, expected: number, settled: Set<string>): number {
  const candidates = [
    ...readdirSync(rootDir)
      .filter((entry) => entry.startsWith('.staging-'))
      .map((entry) => join(rootDir, entry)),
    ...releases(rootDir)
      .filter((entry) => !settled.has(entry))
      .map((entry) => join(rootDir, 'releases', entry)),
  ];
  for (const candidate of candidates) {
    const assets = join(candidate, 'assets');
    if (!existsSync(assets)) continue;
    const count = readdirSync(assets).length;
    if (count > 0 && count < expected) return count;
  }
  return 0;
}

/**
 * Spawns a publication and stops it PART WAY THROUGH the copy.
 *
 * The subject of the test below is what the publisher does with what a killed
 * run left behind. "Killed mid-copy" is FIXTURE, and the fixture is a race:
 * the child starts copying about 70ms in and the staging tree exists for
 * 20-90ms, so a parent that is not scheduled inside that window sees nothing
 * and `caught` stays 0 — which fails the test's own precondition rather than
 * its subject. That happened once, in a full gate.
 *
 * Two wrong fixes, both measured, both recorded rather than deleted:
 *
 * A SYNCHRONOUS SPIN. The argument was that `await setImmediate` "made the
 * detection depend on being scheduled" and that spinning "keeps the parent
 * on-CPU". Both false. A `setImmediate` loop never blocks on epoll — it is
 * already a busy loop — and over the same 8s it polled MORE often, 81 374
 * iterations against 74 606. It did not remove the miss either: the original
 * failure reproduced under 32 spinners on 4 cores, because a user-space loop
 * cannot keep a process on-CPU when the run queue is oversubscribed. And it
 * made the failure WORSE — blocking the event loop means the 10s
 * `testTimeout` cannot fire, so an overrun was reported at 26-40s with no
 * diagnostic instead of at 10s with one.
 *
 * A BIGGER BUNDLE, to widen the window. Abandoned on a cause that was never
 * measured — "the publisher failed before staging anything" — which is false:
 * at 3 000 assets it publishes in 862ms and a partial tree is caught in
 * ~150ms. What took 43 seconds was the per-asset byte comparison at the end
 * of the test, unrelated to the race.
 *
 * WRONG FIX THREE, which was the first version of the retry below: six
 * attempts of a fixed 2s deadline each. `6 x 2s` is 12s against a 10s
 * `testTimeout`, so on the all-miss path the anchor was never reached and the
 * failure was `Test timed out in 10000ms` with no diagnostic — the exact
 * outcome the revert above was performed to avoid, reintroduced by the fix
 * for it. Worse, vitest's timeout rejects the test promise WITHOUT cancelling
 * the async function, so the loop kept spawning publishers and rebuilding
 * fixtures after teardown: it wrote through the module-level `workspace` into
 * the NEXT test's directory, leaked one temp tree per timeout, and starved an
 * unrelated sibling into failing. Measured: 3/3 timeouts under 12 spinners on
 * 4 cores, 8 leaked workspaces, and `never publishes a pool asset half
 * written` failing in 2 of 7 runs for no reason of its own.
 *
 * So the budget is what makes the anchor reachable, and it is bounded twice:
 *
 *   - Polling stops when the CHILD EXITS, not at a fixed deadline. Once the
 *     run is over the staging tree is gone and no further looking can find it,
 *     so a miss costs the child's own lifetime — about 250ms — instead of two
 *     seconds of pointless spinning. This one is an OPTIMISATION and no test
 *     kills it: removing `!exited` leaves the whole unit project green. Said
 *     plainly rather than left to look like a rule with no test, because it
 *     is not a rule — correctness here is the budget below. (An earlier
 *     version of this line also cited "2.6s instead of 0.8s". A reviewer
 *     could not reproduce it and measured the mutant as no slower or faster;
 *     the figure only holds on a run where the kill misses the copy, and it
 *     is withdrawn rather than left as a number with nothing behind it.)
 *   - The whole arrangement gets ONE wall-clock budget, checked before each
 *     attempt and inside each poll. It cannot overrun whatever is left for the
 *     assertions, so `caught` reaches the anchor and the anchor reports.
 *
 * The baseline source directory is passed IN rather than rebuilt from
 * `source()`, so a retry cannot write into the NEXT test's directory. That
 * closes the cross-test half. The leak itself was `mkdirSync` re-creating a
 * torn-down workspace, and it is closed by the `existsSync` check below —
 * stated separately because an earlier version of this paragraph claimed one
 * change had closed both, and it had not.
 *
 * `missFirst` forces the first attempt to look after the copy has finished,
 * which is what makes the retry path itself testable rather than a branch
 * that only runs on an unlucky machine.
 */
async function killMidCopy(
  rootDir: string,
  baseline: string,
  incoming: string,
  expected: number,
  options: { missFirst?: boolean } = {},
): Promise<{ caught: number; good: string; died: Promise<void> }> {
  let good = activeId(rootDir);
  let settled = new Set(releases(rootDir));
  let caught = 0;
  let died: Promise<void> = Promise.resolve();
  /*
   * The budget starts when the RETRYING starts, not when the helper is
   * entered, and that is the whole point of the second assignment below.
   *
   * The first version put a single 2.5s budget around everything, including
   * `missFirst`'s mandatory full publication — so the budget was consumed by
   * the work it exists to permit. Measured at 24 spinners: the successful
   * attempt finished with 2057, 882, 1554, 616, 484 and 31 ms left, and at 32
   * spinners the forced-miss test failed 3 of 4 runs with
   * `a missed first attempt was not recovered`. That is a SPURIOUS failure
   * wearing the anchor's message — a message that names a publisher
   * regression — which is worse than the timeout it replaced, because a
   * timeout at least does not accuse anything.
   *
   * ~2.5s of RETRIES, measured against the assertions that follow: one
   * 200-asset publication is about 250ms idle, and the whole tail after this
   * helper is about 260ms. The budget is roughly ten times that, and a
   * quarter of the unit `testTimeout` — so the caller always gets its answer
   * and the answer is about the publisher.
   */
  let budgetEndsAt = Date.now() + 2_500;

  for (let attempt = 0; attempt < 4 && caught === 0 && Date.now() < budgetEndsAt; attempt += 1) {
    if (attempt > 0) {
      /*
       * The workspace is gone when this test has already been torn down —
       * which happens when something ELSE times out and vitest leaves this
       * async function running. Rebuilding into it then RE-CREATES a tree
       * `afterEach` has deleted, one per timeout, and that is the leak: it was
       * `mkdirSync` all along, not the `source()` call that an earlier round
       * claimed to have closed it by removing. Passing `baseline` in closed
       * the cross-test contamination and not this half, and the docblock
       * claimed both.
       *
       * The guard is on `rootDir`, not `workspace`, and that is the whole
       * fix. `workspace` is a module-level `let` that `beforeEach` REASSIGNS,
       * so by the time an orphan resumes it names the NEXT test's directory —
       * which exists. Two rounds guarded the wrong variable, in the check
       * written to close this.
       *
       * It HELPS and does not close it, and the earlier claim here that "it
       * leaks none" was wrong: over forced timeouts, 6 of 6 runs leaked under
       * `existsSync(workspace)`, 5 of 6 under this one, and 2 of 6 with the
       * retry block removed ALTOGETHER. The residue is the still-live
       * publisher child, which recreates its asset root after teardown — no
       * `existsSync` on any variable can stop that. (Corrected in the record
       * one round ago and left standing here, which is where the next reader
       * looks.)
       *
       * The block stays even though removing it leaks less, and that is a
       * trade rather than an oversight: the leak is temp directories, and what
       * the retry prevents is a spurious anchor failure that ACCUSES the
       * publisher on a loaded machine. A wrong red is worse than a stray
       * directory.
       */
      if (!existsSync(rootDir)) return { caught, good, died };
      rmSync(rootDir, { recursive: true, force: true });
      mkdirSync(rootDir, { recursive: true });
      run(baseline, rootDir);
      good = activeId(rootDir);
      settled = new Set(releases(rootDir));
    }
    const child = spawn(process.execPath, [publisher], {
      env: { ...process.env, NEXA_WEB_SOURCE_DIR: incoming, NEXA_WEB_ASSET_ROOT: rootDir },
      stdio: 'ignore',
    });
    let exited = false;
    died = new Promise<void>((resolveExit) => {
      child.on('exit', () => {
        exited = true;
        resolveExit();
      });
    });

    if (options.missFirst === true && attempt === 0) {
      // Look only once the run is over: the staging tree is gone, so this
      // attempt cannot catch anything and the retry must.
      await died;
      caught = partiallyWritten(rootDir, expected, settled);
      // And give the retries their full budget back. This attempt is a
      // deliberate, mandatory miss; charging it to the budget is what made
      // the forced-miss test fail on a loaded machine for a reason that had
      // nothing to do with the publisher.
      budgetEndsAt = Date.now() + 2_500;
      continue;
    }

    // Until it lands, until the child is gone, or until the budget is spent —
    // whichever comes first. `exited` is what makes a miss cheap: nothing can
    // be caught after the run has finished.
    while (!exited && Date.now() < budgetEndsAt) {
      caught = partiallyWritten(rootDir, expected, settled);
      if (caught > 0) break;
      await new Promise((r) => setImmediate(r));
    }
    child.kill('SIGKILL');
    await died;
  }
  return { caught, good, died };
}

describe('publishing the Web Admin bundle', () => {
  it('activates a complete release, named after the bundle it published', () => {
    const rootDir = root();
    const output = run(source('one'), rootDir);

    const id = activeId(rootDir);
    expect(output).toContain(id);
    expect(releases(rootDir)).toEqual([id]);
    expect(readServedTokens(rootDir)).toEqual(new Set(['one']));
    // The activated path is a SYMLINK. A directory named `current` would serve
    // the same bytes and could not be swapped atomically.
    expect(lstatSync(join(rootDir, 'current')).isSymbolicLink()).toBe(true);
  });

  it('gives a different bundle a different release, and keeps the one it replaced', () => {
    const rootDir = root();
    run(source('one'), rootDir);
    const first = activeId(rootDir);

    run(source('two'), rootDir);
    const second = activeId(rootDir);

    expect(second).not.toBe(first);
    expect(readServedTokens(rootDir)).toEqual(new Set(['two']));
    // The replaced release is retained ON PURPOSE: a request that resolved
    // `current` just before the swap may still be reading a file out of it.
    expect(releases(rootDir).sort()).toEqual([first, second].sort());
    expect(readFileSync(join(rootDir, 'releases', first, 'index.html'), 'utf8')).toContain('one');
  });

  it('retains exactly the current release and the one before it', () => {
    const rootDir = root();
    run(source('one'), rootDir);
    const first = activeId(rootDir);
    run(source('two'), rootDir);
    const second = activeId(rootDir);
    run(source('three'), rootDir);
    const third = activeId(rootDir);

    expect(releases(rootDir).sort()).toEqual([second, third].sort());
    expect(existsSync(join(rootDir, 'releases', first))).toBe(false);
  });

  it('names a release after its content, so republishing one is a swap and not a copy', () => {
    const rootDir = root();
    // The rollback shape. `botctl rollback` starts the previous release's
    // image, whose bundle is byte-identical to the one it published before —
    // and it is still on disk, complete, under the same content-derived name.
    run(source('one'), rootDir);
    const first = activeId(rootDir);
    run(source('two'), rootDir);
    expect(activeId(rootDir)).not.toBe(first);

    const output = run(source('one'), rootDir);
    expect(activeId(rootDir)).toBe(first);
    expect(output).toContain('already published');
    expect(readServedTokens(rootDir)).toEqual(new Set(['one']));
  });

  it('leaves the activated release activated when the copy fails', () => {
    const rootDir = root();
    run(source('one'), rootDir);
    const good = activeId(rootDir);

    // A source tree that cannot be copied: a dangling symlink, which the
    // publisher dereferences and so fails on. Anything that makes cpSync throw
    // exercises the same path — the point is that it throws AFTER the previous
    // release is activated and BEFORE anything of it is touched.
    const broken = source('broken');
    symlinkSync(join(broken, 'nowhere.js'), join(broken, 'assets', 'dangling.js'));

    expect(() => run(broken, rootDir)).toThrow();
    expect(activeId(rootDir)).toBe(good);
    expect(readServedTokens(rootDir)).toEqual(new Set(['one']));
  });

  it('refuses a bundle with no index.html without touching the volume', () => {
    const rootDir = root();
    run(source('one'), rootDir);
    const good = activeId(rootDir);

    const empty = join(workspace, 'src-empty');
    mkdirSync(join(empty, 'assets'), { recursive: true });
    writeFileSync(join(empty, 'assets', 'orphan.js'), '// nothing points here\n');

    expect(() => run(empty, rootDir)).toThrow();
    expect(activeId(rootDir)).toBe(good);
    expect(releases(rootDir)).toEqual([good]);
  });

  it('does not trust a staging directory a crashed publication left behind', () => {
    const rootDir = root();
    const src = source('one');
    // What a run killed mid-copy leaves: the right name, the wrong contents.
    // It must not be renamed into place, and it must not survive.
    const probe = join(workspace, 'probe-root');
    mkdirSync(probe, { recursive: true });
    run(src, probe);
    const id = activeId(probe);
    mkdirSync(join(rootDir, `.staging-${id}`), { recursive: true });
    writeFileSync(join(rootDir, `.staging-${id}`, 'index.html'), 'truncated');

    run(src, rootDir);
    expect(activeId(rootDir)).toBe(id);
    expect(readServedTokens(rootDir)).toEqual(new Set(['one']));
    expect(readdirSync(rootDir).filter((e) => e.startsWith('.staging-'))).toEqual([]);
  });

  it('recovers the arrangement when the first attempt looks after the copy is over', async () => {
    /*
     * The RETRY path, forced.
     *
     * Without this the retry is a branch that runs only on an unlucky machine,
     * and the whole reason it exists is that unlucky machines are where this
     * test failed. `missFirst` makes the first attempt wait for the child to
     * exit before it looks — the staging tree is gone by then, so that attempt
     * catches nothing and a later one has to.
     *
     * The anchor is the same as the real test's: if the retry did not work,
     * `caught` would be 0 here, which is exactly the failure it was written to
     * remove.
     */
    const rootDir = root();
    const baseline = source('one');
    run(baseline, rootDir);
    const incoming = source('two', 200, 512);

    const { caught, good } = await killMidCopy(rootDir, baseline, incoming, 200, {
      missFirst: true,
    });
    expect(caught, 'a missed first attempt was not recovered').toBeGreaterThan(0);
    // And the recovered arrangement is the same state the real test asserts
    // against: the previous release still current, nothing half-written
    // activated.
    expect(activeId(rootDir)).toBe(good);
    expect(readServedTokens(rootDir)).toEqual(new Set(['one']));
  });

  it('re-copies after a publication is killed mid-copy, rather than activating what it left', async () => {
    const rootDir = root();
    const baseline = source('one');
    run(baseline, rootDir);
    const incoming = source('two', 200, 512);

    // Kill it PART WAY THROUGH the copy, not merely at some point during the
    // run: a kill that lands after the copy finished proves nothing, and a
    // test that cannot tell the difference would pass under a publisher that
    // wrote straight into the directory it activates.
    const { caught, good } = await killMidCopy(rootDir, baseline, incoming, 200);
    expect(caught, 'the kill never landed inside the copy').toBeGreaterThan(0);

    // Nothing the killed run left may be activated, and the release that was
    // current stayed current throughout.
    expect(activeId(rootDir)).toBe(good);
    expect(readServedTokens(rootDir)).toEqual(new Set(['one']));

    run(incoming, rootDir);
    expect(readServedTokens(rootDir)).toEqual(new Set(['two']));
    // Every asset, not the two the served-tree reader samples: this is the
    // one place a truncated tree could be activated, so it is counted.
    const activated = join(rootDir, 'releases', activeId(rootDir));
    expect(readdirSync(join(activated, 'assets')).sort()).toEqual(
      readdirSync(join(incoming, 'assets')).sort(),
    );
    for (const asset of readdirSync(join(activated, 'assets'))) {
      // `Buffer.equals`, NOT `expect(a).toEqual(b)` on two Buffers. The
      // matcher walks them element by element through deep equality: 200
      // assets of ~7KB is 1.4M comparisons, which is milliseconds of I/O and
      // TENS OF SECONDS of matcher on a loaded machine — measured at 34s
      // under 12 spinners, which is what timed this test out at 10s and made
      // its diagnostic disappear. The assertion is identical; only its cost
      // changed.
      const mismatch = `${asset} was not activated byte-for-byte`;
      expect(
        readFileSync(join(activated, 'assets', asset)).equals(
          readFileSync(join(incoming, 'assets', asset)),
        ),
        mismatch,
      ).toBe(true);
    }
  });

  it('leaves a pre-layout flat tree alone on the first publication and removes it on the next', () => {
    const rootDir = root();
    // What a release older than this layout published: the bundle, flat, at
    // the root — which the Caddy of that release is STILL SERVING while this
    // runs, because compose recreates the edge after this job completes.
    writeBundle(rootDir, 'old');

    run(source('one'), rootDir);
    expect(readFileSync(join(rootDir, 'index.html'), 'utf8')).toContain('old');
    expect(readServedTokens(rootDir)).toEqual(new Set(['one']));

    run(source('two'), rootDir);
    expect(existsSync(join(rootDir, 'index.html'))).toBe(false);
    expect(readdirSync(rootDir).sort()).toEqual(['current', 'pool', 'releases']);
  });

  it('serves an index.html fetched just before a swap all of its assets after it', async () => {
    const rootDir = root();
    run(source('one'), rootDir);

    // A browser mid-load: it has the document and has not asked for the
    // scripts yet. This is not a rare interleaving — it is what every page
    // load open at the moment of a deployment looks like.
    const inFlight = readIndex(rootDir);
    expect(declaredRelease(inFlight)).toBe('one');

    run(source('two'), rootDir);
    expect(readServedTokens(rootDir)).toEqual(new Set(['two']));

    // Now it asks. Rooted at the activated release these are 404s and the
    // operator watching their own deployment gets a blank page.
    expect(loadAssets(rootDir, inFlight)).toEqual(new Set(['one']));

    // One more publication and the release is no longer retained, which is
    // stated rather than glossed: nothing shorter than two deployments is
    // affected, and index.html is served `no-store` so a reload resolves it.
    run(source('three'), rootDir);
    expect(() => loadAssets(rootDir, inFlight)).toThrow();
  });

  it('refuses a bundle that reuses a retained asset name for different bytes', () => {
    // The build hashes asset filenames by content, so a name that repeats
    // across releases normally repeats byte for byte. A build configured to
    // stop hashing breaks that, and REPLACING the pool entry — which is what
    // this used to do — is unserveable in both directions.
    //
    // The pool is filled BEFORE activation, so during publication a browser
    // fetching the still-current index.html gets the INCOMING release's script
    // under the outgoing release's name. And `/assets/*` is served `immutable`
    // for a year, so a browser that cached that URL keeps the OUTGOING bytes
    // long after activation. One URL cannot stand for two different files.
    const rootDir = root();
    const first = join(workspace, 'src-stable-a');
    mkdirSync(join(first, 'assets'), { recursive: true });
    writeFileSync(join(first, 'assets', 'app.js'), '// release one\n');
    writeFileSync(
      join(first, 'index.html'),
      '<!doctype html><meta name="release" content="one"><script src="/assets/app.js"></script>',
    );
    const second = join(workspace, 'src-stable-b');
    mkdirSync(join(second, 'assets'), { recursive: true });
    writeFileSync(join(second, 'assets', 'app.js'), '// release two\n');
    writeFileSync(
      join(second, 'index.html'),
      '<!doctype html><meta name="release" content="two"><script src="/assets/app.js"></script>',
    );

    run(first, rootDir);
    const good = activeId(rootDir);
    expect(readServedTokens(rootDir)).toEqual(new Set(['one']));

    expect(() => run(second, rootDir)).toThrow(/app\.js/);
    // Refused BEFORE the volume was touched: the released bundle is still
    // activated, its bytes are still its own, and no second release was staged.
    expect(activeId(rootDir)).toBe(good);
    expect(releases(rootDir)).toEqual([good]);
    expect(readServedTokens(rootDir)).toEqual(new Set(['one']));
    expect(readFileSync(join(rootDir, 'pool', 'assets', 'app.js'), 'utf8')).toContain(
      'release one',
    );
    expect(
      readdirSync(rootDir).filter((entry) => entry.startsWith('.staging-')),
      'a staging directory survived the refusal',
    ).toEqual([]);
  });

  it('republishes an identical bundle even though every asset name repeats', () => {
    // The refusal must not catch the ordinary case it looks exactly like: a
    // rollback republishes a bundle whose every asset name is already in the
    // pool, byte for byte.
    const rootDir = root();
    run(source('one'), rootDir);
    const first = activeId(rootDir);
    run(source('two'), rootDir);
    const output = run(source('one'), rootDir);
    expect(activeId(rootDir)).toBe(first);
    expect(output).toContain('already published');
    expect(readServedTokens(rootDir)).toEqual(new Set(['one']));
  });

  it('never publishes a pool asset half written', async () => {
    const rootDir = root();
    run(source('one'), rootDir);

    // ONE asset, large enough that a write into its final name is observable
    // while it is still growing. Small files are copied in a single syscall,
    // so a test built on those would pass against a publisher that wrote
    // straight to the served name.
    const incoming = join(workspace, 'src-big');
    mkdirSync(join(incoming, 'assets'), { recursive: true });
    const line = '// release two\n';
    const body = line.repeat(600_000);
    writeFileSync(join(incoming, 'assets', 'app-big.js'), body);
    writeFileSync(
      join(incoming, 'index.html'),
      '<!doctype html><meta name="release" content="two"><script src="/assets/app-big.js"></script>',
    );

    const child = spawn(process.execPath, [publisher], {
      env: { ...process.env, NEXA_WEB_SOURCE_DIR: incoming, NEXA_WEB_ASSET_ROOT: rootDir },
      stdio: 'ignore',
    });
    const finished = new Promise<number>((resolveExit) => {
      child.on('exit', (code) => resolveExit(code ?? -1));
      child.on('error', () => resolveExit(-1));
    });
    let running = true;
    void finished.then(() => {
      running = false;
    });

    const served = join(rootDir, 'pool', 'assets', 'app-big.js');
    let sightings = 0;
    let reads = 0;
    while (running) {
      // Whenever the name resolves at all it must resolve to the WHOLE file.
      // A browser given a truncated script gets a 200 and a syntax error.
      if (existsSync(served)) {
        expect(readFileSync(served).byteLength).toBe(Buffer.byteLength(body));
        sightings += 1;
      }
      reads += 1;
      await new Promise((r) => setImmediate(r));
    }
    expect(await finished).toBe(0);
    expect(reads).toBeGreaterThan(20);
    expect(existsSync(served)).toBe(true);
    void sightings;
  });

  describe('two publishers running at once', () => {
    /** Starts a publisher without waiting for it. Resolves to its exit code. */
    function start(sourceDir: string, rootDir: string): { exit: Promise<number> } {
      const child = spawn(process.execPath, [publisher], {
        env: { ...process.env, NEXA_WEB_SOURCE_DIR: sourceDir, NEXA_WEB_ASSET_ROOT: rootDir },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      return {
        exit: new Promise<number>((resolveExit) => {
          child.on('exit', (code) => resolveExit(code ?? -1));
          child.on('error', () => resolveExit(-1));
        }).then((code) => {
          if (code !== 0) throw new Error(`publisher exited ${code}: ${stderr}`);
          return code;
        }),
      };
    }

    /**
     * Everything a served tree must satisfy at rest, checked against the
     * filesystem rather than against what any one publisher reported.
     *
     * `current` naming a directory that is not there is the failure this is
     * mostly here for: it is not a stale page, it is a 404 for the whole Web
     * Admin, and it is what a publisher pruning another publisher's release
     * leaves behind.
     */
    function assertCoherent(rootDir: string): void {
      const active = activeId(rootDir);
      expect(existsSync(join(rootDir, 'releases', active))).toBe(true);
      // Every retained release is complete and every asset any of them names
      // is in the pool, so any document that can still be resolved can still
      // be loaded.
      for (const id of releases(rootDir)) {
        const dir = join(rootDir, 'releases', id);
        expect(existsSync(join(dir, 'index.html'))).toBe(true);
        for (const asset of readdirSync(join(dir, 'assets'))) {
          expect(existsSync(join(rootDir, 'pool', 'assets', asset))).toBe(true);
        }
      }
      // And nothing half-published is left lying around.
      expect(
        readdirSync(rootDir).filter(
          (entry) => entry.startsWith('.staging-') || entry.startsWith('.activating-'),
        ),
      ).toEqual([]);
      expect(existsSync(join(rootDir, '.publish.lock'))).toBe(false);
      expect(readServedTokens(rootDir).size).toBe(1);
    }

    /** Reads the served tree until `done`, failing on any incoherent state. */
    async function readWhile(rootDir: string, done: Promise<unknown>): Promise<number> {
      let running = true;
      void done.then(
        () => {
          running = false;
        },
        () => {
          running = false;
        },
      );
      let reads = 0;
      const observed: Array<Set<string>> = [];
      while (running) {
        // A request: resolve `current`, read the document, load its assets.
        // Under a dangling `current` or a pruned release this throws.
        observed.push(readServedTokens(rootDir));
        reads += 1;
        await new Promise((r) => setImmediate(r));
      }
      for (const tokens of observed) expect(tokens.size).toBe(1);
      return reads;
    }

    it('publishes two different bundles without either pruning the other', async () => {
      // The interleaving that produced the bug: both publishers read the same
      // `current`, so both compute the same "previous release" to retain, and
      // the one that activates FIRST is not in the second one's retained set.
      // Its prune then deletes the release `current` names.
      const rootDir = root();
      run(source('base', 200, 512), rootDir);
      const baseId = activeId(rootDir);

      const a = start(source('two', 200, 512), rootDir);
      const b = start(source('three', 200, 512), rootDir);
      const both = Promise.all([a.exit, b.exit]);
      const reads = await readWhile(rootDir, both);
      await expect(both).resolves.toEqual([0, 0]);

      // A positive control: a loop that ran twice would pass whatever the
      // publishers did to each other.
      expect(reads).toBeGreaterThan(20);
      assertCoherent(rootDir);
      // Two publications past `base`, so exactly one of the two new releases
      // is current and `base` is gone.
      expect(activeId(rootDir)).not.toBe(baseId);
      expect(releases(rootDir)).toHaveLength(2);
      expect(releases(rootDir)).toContain(activeId(rootDir));
    });

    it('publishes the SAME bundle twice at once without the two runs colliding', async () => {
      // Identical bundles collide on every derived name: the release
      // directory, the staging directory, and the activation link. Two runs
      // sharing them had one remove the other's staging directory mid-copy and
      // one rename away the other's activation link before it could be used.
      const rootDir = root();
      run(source('base', 200, 512), rootDir);

      const incoming = source('same', 200, 512);
      const a = start(incoming, rootDir);
      const b = start(incoming, rootDir);
      const both = Promise.all([a.exit, b.exit]);
      const reads = await readWhile(rootDir, both);
      await expect(both).resolves.toEqual([0, 0]);

      expect(reads).toBeGreaterThan(20);
      assertCoherent(rootDir);
      expect(readServedTokens(rootDir)).toEqual(new Set(['same']));
      // One bundle, one release directory, however many publishers there were.
      const ids = releases(rootDir);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('lets a publisher that fails leave the other publisher activated', async () => {
      // One good bundle and one that cannot be copied, started together. The
      // failing run must not take the successful one down with it: it holds
      // the same lock and walks the same prune.
      const rootDir = root();
      run(source('base', 200, 512), rootDir);

      const broken = source('broken', 200, 512);
      symlinkSync(join(broken, 'nowhere.js'), join(broken, 'assets', 'dangling.js'));
      const good = start(source('good', 200, 512), rootDir);
      const bad = start(broken, rootDir);
      const settled = Promise.allSettled([good.exit, bad.exit]);
      const reads = await readWhile(rootDir, settled);
      const outcomes = await settled;

      expect(reads).toBeGreaterThan(20);
      expect(outcomes[0]!.status).toBe('fulfilled');
      expect(outcomes[1]!.status).toBe('rejected');
      assertCoherent(rootDir);
      expect(readServedTokens(rootDir)).toEqual(new Set(['good']));
    });

    it('never removes a lock that is not its own', async () => {
      // A path is not a lock. The release was `rmSync(<the path>)`, so a
      // publisher whose first phase — hashing the bundle, comparing the pool,
      // copying the tree — outran the stale window would be taken over,
      // finish, and then delete the lock of the process that took it over,
      // letting a third publisher in while the second was mid-publication.
      // The real module, by the same path `deploy/compose.yml` invokes.
      const { acquireLock, releaseLock } = (await import(pathToFileURL(publisher).href)) as {
        acquireLock: (rootDir: string, token: string) => string;
        releaseLock: (lockDir: string, token: string) => void;
      };
      const rootDir = root();
      const lockDir = join(rootDir, '.publish.lock');

      acquireLock(rootDir, 'mine');
      // What a takeover leaves at that path: somebody else's lock.
      writeFileSync(
        join(lockDir, 'holder'),
        `${JSON.stringify({ token: 'theirs', pid: process.pid, host: hostname(), at: Date.now() })}\n`,
      );

      releaseLock(lockDir, 'mine');
      expect(existsSync(lockDir), "another run's lock was removed").toBe(true);
      expect(JSON.parse(readFileSync(join(lockDir, 'holder'), 'utf8')).token).toBe('theirs');

      // And it does release its own.
      releaseLock(lockDir, 'theirs');
      expect(existsSync(lockDir)).toBe(false);
    });

    it('admits exactly one of many processes racing for an abandoned lock', async () => {
      // Both waiters see the same dead holder and both enter the takeover: the
      // first renames it away and acquires, and the second then renames away
      // the FRESH lock the first is holding and acquires too. Two publishers
      // inside the critical section is what dangles `current`.
      //
      // Asserted as mutual exclusion rather than as a simulated interleaving:
      // every process writes a marker while it holds the lock and fails if one
      // is already there, so an overlap of any shape is caught.
      const rootDir = root();
      const lockDir = join(rootDir, '.publish.lock');
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, 'holder'),
        `${JSON.stringify({ token: 'dead', pid: 2 ** 22 - 1, host: hostname(), at: Date.now() })}\n`,
      );

      // CONCURRENTLY. The first version used `spawnSync` in a loop, which
      // blocks — eight processes that never overlapped, and a race test that
      // could not observe a race.
      const contenders = await Promise.all(
        Array.from({ length: 8 }, (_, i) => {
          const child = spawn(process.execPath, ['-e', CONTEND_FOR_LOCK], {
            env: {
              ...process.env,
              NEXA_PUBLISHER: publisher,
              NEXA_ROOT: rootDir,
              NEXA_ID: String(i),
            },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          let stderr = '';
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          return new Promise<{ code: number; stderr: string }>((resolveExit) => {
            child.on('exit', (code) => resolveExit({ code: code ?? -1, stderr }));
            child.on('error', (error) => resolveExit({ code: -1, stderr: String(error) }));
          });
        }),
      );
      for (const [i, contender] of contenders.entries()) {
        expect(contender.code, `contender ${i}: ${contender.stderr}`).toBe(0);
      }
      // Every one of them held it, one at a time, and the last one out left
      // nothing behind.
      expect(readdirSync(join(rootDir, 'held')).sort()).toEqual(
        Array.from({ length: 8 }, (_, i) => String(i)).sort(),
      );
      expect(existsSync(lockDir)).toBe(false);
    });

    it('loses the race rather than dying when the holder write loses its directory', () => {
      // OBSERVED, in CI, on the case above: a contender whose `mkdirSync` had just
      // succeeded was killed by an uncaught ENOENT from the holder write —
      //
      //   Error: ENOENT: no such file or directory,
      //     open '/tmp/nexa-web-assets-VsxBI5/srv-web/.publish.lock/holder'
      //     at acquireLock (deploy/bin/publish-web-assets.mjs:206:7)
      //
      // — because another waiter, which had judged the PREVIOUS lock stale, renamed
      // whatever was at that path away, and what it found was that brand-new empty
      // lock. The function already handles losing the lock between the mkdir and the
      // write — that is what the token read-back is for — but only when the holder
      // file was REPLACED, not when the directory was taken. So a publisher that
      // simply did not win the race exited non-zero.
      //
      // The case above reproduces it only when eight processes interleave exactly
      // that way, which is why this assertion is on the SOURCE: the rule is that the
      // ENOENT is tolerated and the loop retries, and an assertion that waits for the
      // interleaving is a test that passes for the wrong reason most of the time.
      const source = readFileSync(publisher, 'utf8').replace(/\s+/g, ' ');
      expect(source, 'the holder write no longer has its own ENOENT catch').toContain(
        "try { writeFileSync( join(lockDir, 'holder'), " +
          '`${JSON.stringify({ token, pid: process.pid, host: hostname(), at: Date.now() })}' +
          "\\n`, ); } catch (error) { if (error.code !== 'ENOENT') throw error; continue; }",
      );
    });

    it('takes over a lock whose holder died and refuses one whose holder lives', () => {
      const rootDir = root();
      run(source('one'), rootDir);

      // A lock left by a process that is gone. Waiting this out would turn a
      // publisher killed mid-copy into an installation that can never publish
      // again — and a publisher IS killed mid-copy, one test above.
      const lockDir = join(rootDir, '.publish.lock');
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, 'holder'),
        `${JSON.stringify({ pid: 2 ** 22 - 1, host: hostname(), at: Date.now() })}\n`,
      );
      run(source('two'), rootDir);
      expect(readServedTokens(rootDir)).toEqual(new Set(['two']));
      expect(existsSync(lockDir)).toBe(false);

      // A lock held by a process that is alive is honoured, and honoured with
      // a refusal rather than a silent overwrite. This test process is the
      // living holder.
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, 'holder'),
        `${JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() })}\n`,
      );
      const child = spawnSync(process.execPath, [publisher], {
        encoding: 'utf8',
        timeout: 4_000,
        env: {
          ...process.env,
          NEXA_WEB_SOURCE_DIR: source('three'),
          NEXA_WEB_ASSET_ROOT: rootDir,
        },
      });
      // It is still waiting when the timeout kills it: it never published.
      expect(child.signal).toBe('SIGTERM');
      expect(readServedTokens(rootDir)).toEqual(new Set(['two']));
      rmSync(lockDir, { recursive: true, force: true });
    });
  });

  it('never lets a reader observe an empty or mixed tree while a bundle publishes', async () => {
    const rootDir = root();
    // Two hundred assets. The window this design exists to close IS the copy,
    // so a bundle that copies in a microsecond would make this test vacuous
    // whatever the publisher did — and a bundle of many small files spends
    // that window in syscalls, which is what a real one does too.
    run(source('one', 200, 512), rootDir);
    const incoming = source('two', 200, 512);

    const child = spawn(process.execPath, [publisher], {
      env: { ...process.env, NEXA_WEB_SOURCE_DIR: incoming, NEXA_WEB_ASSET_ROOT: rootDir },
      stdio: 'ignore',
    });
    const finished = new Promise<number>((resolveExit) => {
      child.on('exit', (code) => resolveExit(code ?? -1));
      child.on('error', () => resolveExit(-1));
    });

    const observations: Array<Set<string>> = [];
    let reads = 0;
    let running = true;
    void finished.then(() => {
      running = false;
    });
    while (running) {
      // Each iteration is one "request": resolve `current`, read the document,
      // then read every asset it names. If activation were an unlink followed
      // by a symlink, or a copy into the served directory, this throws.
      observations.push(readServedTokens(rootDir));
      reads += 1;
      await new Promise((r) => setImmediate(r));
    }
    expect(await finished).toBe(0);

    // A positive control: a loop that ran twice would pass whatever the
    // publisher did.
    expect(reads).toBeGreaterThan(50);
    for (const tokens of observations) {
      expect(tokens.size).toBe(1);
      expect(['one', 'two']).toContain([...tokens][0]);
    }
    // And it did in fact change under the reader, so the reads were not all
    // taken before the swap.
    expect(readServedTokens(rootDir)).toEqual(new Set(['two']));
  });
});
