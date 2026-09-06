#!/usr/bin/env node
// Publishes the Web Admin bundle into the shared asset volume that Caddy
// serves, ATOMICALLY.
//
// This replaces a two-command shell one-shot that did:
//
//     find /srv/web -mindepth 1 -maxdepth 1 -exec rm -rf {} + ; cp -r /app/web/. /srv/web/
//
// against the directory Caddy was serving at that moment. Between those two
// commands the served root is EMPTY, and during the copy it is HALF WRITTEN.
// Every request arriving in that window gets a 404 for index.html, or an
// index.html naming hashed assets that have not been copied yet. It is a small
// window and it lands on every single update — which is exactly when an
// operator is watching.
//
// The fix is the standard one and it is not a shell script. A release is
// published into a directory named after the bundle's own content, complete,
// off to one side; activation is a single rename(2) of a symlink. rename(2)
// over an existing path is atomic, so `current` names one complete release
// before the call and a different complete release after it, and never
// anything in between. Caddy resolves `current` per request, so a request
// either lands entirely in the old release or entirely in the new one.
//
// The layout under the volume:
//
//     /srv/web/releases/<bundle-id>/     a complete published release
//     /srv/web/current -> releases/<id>  the one Caddy serves
//
// The bundle id is a hash of the bundle's own bytes, not of the image digest
// or the commit. Two consequences, both wanted. Publishing the same bundle
// twice is idempotent and copies nothing — which is what a ROLLBACK is, and it
// means the release the operator is returning to is already on disk, complete.
// And two different bundles can never collide on a directory name, which is
// what makes "the tree Caddy serves is coherent" a property of the layout
// rather than of the ordering.
//
// The previous release is retained deliberately: a request that resolved
// `current` just before the swap may still be reading a file out of it. It is
// pruned by the publication AFTER the next one, by which point nothing can
// still be inside it.
//
// One swap is not enough on its own, and the test that says so is
// `an index.html served just before a swap can still load its assets`.
// Loading the Web Admin is not one request; it is index.html and then the
// hashed assets index.html names. A browser that fetched index.html a
// millisecond before the swap asks for those assets a millisecond after it,
// and under `current` alone they are gone — a blank page for exactly the
// operator watching the deployment. So `/assets/*` is served from a POOL:
//
//     /srv/web/releases/<bundle-id>/     a complete published release
//     /srv/web/current -> releases/<id>  the entry document Caddy serves
//     /srv/web/pool/assets/<file>        every retained release's assets
//
// The pool is additive and holds the union over the releases that are
// retained, so both the release being left and the release being entered can
// be loaded through the whole swap. An asset is removed from it only when the
// release that owned it is pruned, which is one publication after it stopped
// being current. Caddy's asset handler roots at the pool and its SPA handler
// at `current`; see deploy/caddy/routes.caddy.
//
// What this does NOT hold, stated rather than glossed: a browser that fetched
// index.html and then waits out TWO publications before asking for an asset
// gets a 404. index.html is served `no-store`, so a reload resolves it, and
// nothing shorter than two deployments is affected.

import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASES = 'releases';
const CURRENT = 'current';
const POOL = 'pool';
const ASSETS = 'assets';
// Both are hidden and both are prefixes rather than fixed names, so a crashed
// publication of one bundle cannot be mistaken for, or collide with, the
// in-flight publication of another.
const STAGING_PREFIX = '.staging-';
const LINK_PREFIX = '.activating-';
const LOCK = '.publish.lock';

/**
 * How long a held lock is believed without evidence that its holder is alive.
 *
 * Two orders of magnitude above a publication, which copies a few megabytes of
 * small files, and the holder refreshes the lock between phases so the figure
 * bounds ONE phase rather than the whole run.
 *
 * It is the second recovery route, not the first: a holder in this container
 * is checked for liveness directly and taken over at once. Only a holder in a
 * different container — which is what compose recreating the one-shot service
 * produces, and whose pid namespace makes its pid meaningless here — has to be
 * waited out. That wait is the cost of a publisher killed by a host that went
 * down mid-copy, so it is minutes rather than the ten it started at.
 */
const LOCK_STALE_MS = 2 * 60 * 1000;
/** How long to wait for a lock somebody else legitimately holds. */
const LOCK_WAIT_MS = 5 * 60 * 1000;
const LOCK_POLL_MS = 25;

/** A synchronous sleep. The publisher is synchronous by design; so is this. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether a process on THIS host is still running. */
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else.
    return error.code !== 'ESRCH';
  }
}

/**
 * Says the holder is still working, between phases of the publication.
 *
 * Without this `LOCK_STALE_MS` would have to bound a whole publication on the
 * slowest disk anybody runs this on, and a figure chosen that way is one
 * nobody can defend. With it the figure bounds one phase.
 */
function touchLock(lockDir) {
  const now = new Date();
  try {
    utimesSync(lockDir, now, now);
  } catch (error) {
    // Somebody took the lock over. The publication is still correct — the
    // names it writes to are unique to this run — and the next `readdir`
    // sweep removes what it leaves.
    if (error.code !== 'ENOENT') throw error;
  }
}

/** Who holds the lock, as they wrote it, or null if they had not written it yet. */
function lockHolder(lockDir) {
  try {
    return JSON.parse(readFileSync(join(lockDir, 'holder'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Serialises the whole root mutation. Every publisher, one at a time.
 *
 * Publication is not one atomic step and cannot be made into one: it reads
 * which release is current, stages, fills the pool, swaps the symlink, and
 * then prunes everything the two retained releases do not own. Two publishers
 * interleaving through that sequence can each read the same previous release
 * and then have the loser's prune delete the winner's just-activated release —
 * `current` left pointing at a directory that no longer exists, which is a 404
 * for the entire Web Admin rather than a stale page.
 *
 * `mkdir(2)` is the acquire: it is atomic and it fails with EEXIST when the
 * directory is already there, which is exactly a compare-and-swap on the
 * lock's existence. A process-local mutex would be no lock at all here — the
 * publishers are separate processes, usually separate containers.
 *
 * Deadlock after a crash is the failure this must not trade for. A holder that
 * was SIGKILLed mid-copy leaves the directory behind, and a lock that could
 * only be waited out would turn a survivable crash into an installation that
 * can never publish again. So the lock records its holder, and a holder on
 * this host that is no longer running is taken over immediately. A holder
 * elsewhere is waited out to `LOCK_STALE_MS` first.
 *
 * The takeover itself is a rename(2), so exactly one of several waiters can
 * perform it and the rest get ENOENT and re-enter the loop. What rename cannot
 * check is that the lock is still the one that was judged stale a moment
 * earlier; the staging and activation names are therefore unique per run, so
 * even in that window two publishers cannot write to each other's paths.
 */
function acquireLock(rootDir) {
  const lockDir = join(rootDir, LOCK);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, 'holder'),
        `${JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() })}\n`,
      );
      return lockDir;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    let heldSince;
    try {
      heldSince = statSync(lockDir).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const holder = lockHolder(lockDir);
    const abandoned =
      (holder !== null && holder.host === hostname() && !processIsAlive(holder.pid)) ||
      Date.now() - heldSince > LOCK_STALE_MS;

    if (abandoned) {
      const grave = join(rootDir, `${LOCK}.stale-${randomUUID()}`);
      try {
        renameSync(lockDir, grave);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        continue;
      }
      rmSync(grave, { recursive: true, force: true });
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `another publication has held ${lockDir} for longer than ${LOCK_WAIT_MS}ms; refusing to publish concurrently.`,
      );
    }
    sleepSync(LOCK_POLL_MS);
  }
}

/** Every file under `dir`, as paths relative to it, in a stable order. */
function bundleFiles(dir, prefix = '') {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const files = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...bundleFiles(join(dir, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

/**
 * The release identity: a hash over every path AND every byte.
 *
 * Paths are hashed too, and with a separator, so that renaming a file changes
 * the id even when the bytes are unchanged — a bundle whose index.html points
 * at a differently named chunk is a different release.
 */
function bundleId(sourceDir) {
  const hash = createHash('sha256');
  for (const relative of bundleFiles(sourceDir)) {
    hash.update(relative, 'utf8');
    hash.update('\0');
    hash.update(readFileSync(join(sourceDir, relative)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 32);
}

function pathExists(target) {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** The release `current` names, or null if it names nothing this recognises. */
function activeRelease(rootDir) {
  let target;
  try {
    target = readlinkSync(join(rootDir, CURRENT));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EINVAL') return null;
    throw error;
  }
  const parts = target.split('/');
  return parts.length === 2 && parts[0] === RELEASES && parts[1] !== '' ? parts[1] : null;
}

/** The hashed assets a published release owns, or none if it ships none. */
function releaseAssets(releaseDir) {
  const dir = join(releaseDir, ASSETS);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

/**
 * Adds a release's assets to the pool, atomically, one file at a time.
 *
 * Written under a private name and renamed into place, for the same reason
 * the release directory is: a request may open any of these at any moment, and
 * a half-written file is a corrupt script rather than a missing one — which is
 * worse, because the browser gets a 200.
 *
 * A name already in the pool is left alone when its bytes match, which is the
 * normal case: the build hashes asset filenames by content, so a name that
 * repeats across releases repeats byte for byte.
 *
 * A name that repeats with DIFFERENT bytes is refused, and this is the second
 * place it is refused — `assertPoolIsCompatible` catches it before the volume
 * is touched at all, and this catches it if that check is ever bypassed.
 * Replacing the entry, which is what this used to do, is unserveable in both
 * directions: the pool is filled BEFORE activation, so a browser fetching the
 * still-current index gets the incoming release's script under the outgoing
 * release's name; and `/assets/*` is served `immutable` for a year, so a
 * browser that cached the name keeps the outgoing bytes long after activation.
 * One URL cannot stand for two different files, and a bundle that asks it to
 * is a build that has stopped hashing its asset names.
 */
function fillPool(rootDir, releaseDir, nonce) {
  const poolAssets = join(rootDir, POOL, ASSETS);
  mkdirSync(poolAssets, { recursive: true });
  for (const name of releaseAssets(releaseDir)) {
    const from = join(releaseDir, ASSETS, name);
    const to = join(poolAssets, name);
    if (existsSync(to)) {
      if (readFileSync(to).equals(readFileSync(from))) continue;
      throw new Error(`${name} is already published with different content.`);
    }
    const incoming = join(poolAssets, `${STAGING_PREFIX}${nonce}-${name}`);
    rmSync(incoming, { force: true });
    cpSync(from, incoming, { dereference: true });
    renameSync(incoming, to);
  }
}

/**
 * Refuses a bundle that reuses a retained release's asset name for other bytes.
 *
 * BEFORE the volume is touched, for the same reason the missing-index.html
 * check is: a build that cannot be published coherently must leave whatever is
 * being served exactly as it is, rather than being discovered half way through.
 *
 * Reads the SOURCE, not the staged release, so it runs before anything is
 * copied. Republishing an identical bundle — which is what a rollback is —
 * finds every name already there with matching bytes and is unaffected.
 */
function assertPoolIsCompatible(rootDir, sourceDir) {
  const poolAssets = join(rootDir, POOL, ASSETS);
  if (!existsSync(poolAssets)) return;
  const conflicting = [];
  for (const name of releaseAssets(sourceDir)) {
    const published = join(poolAssets, name);
    if (!existsSync(published)) continue;
    if (readFileSync(published).equals(readFileSync(join(sourceDir, ASSETS, name)))) continue;
    conflicting.push(name);
  }
  if (conflicting.length > 0) {
    throw new Error(
      `${sourceDir} reuses ${conflicting.join(', ')} with content different from the retained ` +
        'releases. Asset names are content-addressed by the build; one URL cannot stand for two ' +
        'files. Refusing to publish it.',
    );
  }
}

export function publish({ sourceDir, rootDir }) {
  // A bundle with no entry document is not a bundle. Refusing here means a
  // build that produced nothing cannot become the activated release: the
  // volume is not touched at all, so whatever is being served stays served.
  if (!existsSync(join(sourceDir, 'index.html'))) {
    throw new Error(`${sourceDir} holds no index.html; refusing to publish it as a release.`);
  }

  const releasesDir = join(rootDir, RELEASES);
  mkdirSync(releasesDir, { recursive: true });

  // Everything that follows mutates the shared root, and none of it is one
  // atomic step. See `acquireLock`.
  const lockDir = acquireLock(rootDir);
  try {
    return publishLocked({ sourceDir, rootDir, releasesDir, lockDir });
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** The publication itself, with the root lock held for its whole duration. */
function publishLocked({ sourceDir, rootDir, releasesDir, lockDir }) {
  // Unique to this run. Two publishers are serialised by the lock, so this is
  // not what makes them safe — it is what keeps them from writing to each
  // other's paths in the one window the lock cannot close, a takeover of a lock
  // judged abandoned by a holder that then turns out to be alive.
  const nonce = randomUUID().replaceAll('-', '').slice(0, 16);

  const releaseId = bundleId(sourceDir);
  const releaseDir = join(releasesDir, releaseId);
  // Before anything is staged or copied. See `assertPoolIsCompatible`.
  assertPoolIsCompatible(rootDir, sourceDir);
  // Read BEFORE anything is activated: this is the release a request resolving
  // `current` right now would be served out of, and the one that must survive
  // this publication.
  const previousReleaseId = activeRelease(rootDir);
  // Whether anything has ever been published in this layout. It gates the
  // clean-up of the flat pre-<layout> tree below, and the reason is timing:
  // on the update that introduces this layout, the OLD Caddy is still serving
  // that flat tree while this runs.
  const hadCurrent = pathExists(join(rootDir, CURRENT));

  let copied = false;
  if (!existsSync(releaseDir)) {
    // Staged under a name Caddy's root never reaches, then renamed in. A
    // release directory therefore only ever appears complete: there is no
    // instant at which `releases/<id>` exists and is half written, which is
    // what makes activating it by name safe.
    const staging = join(rootDir, `${STAGING_PREFIX}${releaseId}-${nonce}`);
    rmSync(staging, { recursive: true, force: true });
    cpSync(sourceDir, staging, { recursive: true, dereference: true });
    try {
      renameSync(staging, releaseDir);
      copied = true;
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      // The lock makes a concurrent publisher the exceptional case rather than
      // the normal one, but losing to it is still not a failure: the directory
      // that won is there, complete, under the same content-derived name.
      if (!existsSync(releaseDir)) throw error;
    }
  }

  touchLock(lockDir);

  // BEFORE the activation, never after. The moment `current` names this
  // release, a browser can ask for the assets its index.html names; they have
  // to already be servable. The pool is additive here, so this cannot make the
  // outgoing release unloadable.
  fillPool(rootDir, releaseDir, nonce);

  touchLock(lockDir);

  // THE activation. symlink() cannot replace an existing path, so the link is
  // made under a private name and rename(2)d over `current`. `ln -sfn` is NOT
  // this: it unlinks and re-creates, and a request arriving between the two
  // finds no `current` at all.
  const activating = join(rootDir, `${LINK_PREFIX}${releaseId}-${nonce}`);
  rmSync(activating, { force: true });
  symlinkSync(`${RELEASES}/${releaseId}`, activating);
  renameSync(activating, join(rootDir, CURRENT));

  // Retained: the release just activated, and the one it replaced. Anything
  // older cannot have a reader — every request since the swap before last
  // resolved something newer.
  const keep = new Set([releaseId]);
  if (previousReleaseId !== null) keep.add(previousReleaseId);
  const pruned = [];
  for (const entry of readdirSync(releasesDir)) {
    if (keep.has(entry)) continue;
    rmSync(join(releasesDir, entry), { recursive: true, force: true });
    pruned.push(entry);
  }

  // The pool holds the union over the releases that are retained, so it
  // shrinks only when one is pruned — one publication after it stopped being
  // current, by which point nothing is still loading its index.html.
  const poolAssets = join(rootDir, POOL, ASSETS);
  const owned = new Set();
  for (const entry of readdirSync(releasesDir)) {
    for (const name of releaseAssets(join(releasesDir, entry))) owned.add(name);
  }
  if (existsSync(poolAssets)) {
    for (const name of readdirSync(poolAssets)) {
      if (!owned.has(name)) rmSync(join(poolAssets, name), { recursive: true, force: true });
    }
  }

  for (const entry of readdirSync(rootDir)) {
    if (entry === RELEASES || entry === CURRENT || entry === POOL) continue;
    // The lock this run is holding. Removing it here would release it while
    // the publication is still running.
    if (entry === LOCK) continue;
    // A staging directory or an activation link from a run that died. Neither
    // is ever reachable through `current`, so removing them changes nothing an
    // operator can observe — but leaving them accumulates a copy of the bundle
    // per crash.
    if (
      entry.startsWith(STAGING_PREFIX) ||
      entry.startsWith(LINK_PREFIX) ||
      entry.startsWith(`${LOCK}.stale-`)
    ) {
      rmSync(join(rootDir, entry), { recursive: true, force: true });
      continue;
    }
    // The flat tree published by releases before this layout existed. It is
    // removed on the SECOND publication into the new layout, never the first:
    // on the first, the Caddy that is still running is the previous release's
    // and is still serving out of it.
    if (hadCurrent) rmSync(join(rootDir, entry), { recursive: true, force: true });
  }

  return { releaseId, previousReleaseId, copied, pruned, prunedFlatTree: hadCurrent };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const sourceDir = process.env.NEXA_WEB_SOURCE_DIR ?? '/app/web';
  const rootDir = process.env.NEXA_WEB_ASSET_ROOT ?? '/srv/web';
  try {
    const result = publish({ sourceDir, rootDir });
    process.stdout.write(
      `web assets: ${result.releaseId} is current` +
        `${result.copied ? '' : ' (already published)'}` +
        `${result.previousReleaseId === null ? '' : `, replacing ${result.previousReleaseId}`}` +
        `${result.pruned.length === 0 ? '' : `, pruned ${result.pruned.join(' ')}`}\n`,
    );
  } catch (error) {
    // Loud and non-zero. Caddy depends on this service completing
    // successfully, so a failure here stops the edge from being started with
    // nothing to serve — and leaves whatever is already activated activated.
    process.stderr.write(`web assets: publication FAILED: ${error.message}\n`);
    process.exitCode = 1;
  }
}
