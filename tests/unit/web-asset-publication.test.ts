import { execFileSync, spawn } from 'node:child_process';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('re-copies after a publication is killed mid-copy, rather than activating what it left', async () => {
    const rootDir = root();
    run(source('one'), rootDir);
    const good = activeId(rootDir);

    const incoming = source('two', 200, 512);
    const settled = new Set(releases(rootDir));
    const child = spawn(process.execPath, [publisher], {
      env: { ...process.env, NEXA_WEB_SOURCE_DIR: incoming, NEXA_WEB_ASSET_ROOT: rootDir },
      stdio: 'ignore',
    });
    const died = new Promise<void>((resolveExit) => child.on('exit', () => resolveExit()));

    // Kill it PART WAY THROUGH the copy, not merely at some point during the
    // run: a kill that lands after the copy finished proves nothing, and a
    // test that cannot tell the difference would pass under a publisher that
    // wrote straight into the directory it activates.
    let caught = -1;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      caught = partiallyWritten(rootDir, 200, settled);
      if (caught > 0) break;
      await new Promise((r) => setImmediate(r));
    }
    child.kill('SIGKILL');
    await died;
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
      expect(readFileSync(join(activated, 'assets', asset))).toEqual(
        readFileSync(join(incoming, 'assets', asset)),
      );
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

  it('replaces a pool asset whose name repeats with different bytes', () => {
    const rootDir = root();
    // The build hashes asset filenames by content, so a name that repeats
    // across releases normally repeats byte for byte and the pool leaves it
    // alone. A build configured to stop hashing breaks that assumption, and
    // the failure it produces is the worst kind: the outgoing release's code
    // served under the incoming release's name, with a 200 and an `immutable`
    // cache header on it.
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
    expect(readServedTokens(rootDir)).toEqual(new Set(['one']));
    run(second, rootDir);
    expect(readServedTokens(rootDir)).toEqual(new Set(['two']));
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
