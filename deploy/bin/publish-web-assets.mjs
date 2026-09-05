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

import { createHash } from 'node:crypto';
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
  symlinkSync,
} from 'node:fs';
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
 * repeats across releases repeats byte for byte. It is REPLACED when they do
 * not, rather than assumed identical — a build configured to stop hashing
 * would otherwise serve the outgoing release's code under the incoming
 * release's name, silently and for ever.
 */
function fillPool(rootDir, releaseDir) {
  const poolAssets = join(rootDir, POOL, ASSETS);
  mkdirSync(poolAssets, { recursive: true });
  for (const name of releaseAssets(releaseDir)) {
    const from = join(releaseDir, ASSETS, name);
    const to = join(poolAssets, name);
    if (existsSync(to) && readFileSync(to).equals(readFileSync(from))) continue;
    const incoming = join(poolAssets, `${STAGING_PREFIX}${name}`);
    rmSync(incoming, { force: true });
    cpSync(from, incoming, { dereference: true });
    renameSync(incoming, to);
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

  const releaseId = bundleId(sourceDir);
  const releaseDir = join(releasesDir, releaseId);
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
    const staging = join(rootDir, STAGING_PREFIX + releaseId);
    rmSync(staging, { recursive: true, force: true });
    cpSync(sourceDir, staging, { recursive: true, dereference: true });
    try {
      renameSync(staging, releaseDir);
      copied = true;
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      // Two monitor replicas are the normal case for a moment on every rolling
      // update, and so is a second publisher. Losing the race is not a failure
      // as long as the directory that won is there, complete, under the same
      // content-derived name.
      if (!existsSync(releaseDir)) throw error;
    }
  }

  // BEFORE the activation, never after. The moment `current` names this
  // release, a browser can ask for the assets its index.html names; they have
  // to already be servable. The pool is additive here, so this cannot make the
  // outgoing release unloadable.
  fillPool(rootDir, releaseDir);

  // THE activation. symlink() cannot replace an existing path, so the link is
  // made under a private name and rename(2)d over `current`. `ln -sfn` is NOT
  // this: it unlinks and re-creates, and a request arriving between the two
  // finds no `current` at all.
  const activating = join(rootDir, LINK_PREFIX + releaseId);
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
    // A staging directory or an activation link from a run that died. Neither
    // is ever reachable through `current`, so removing them changes nothing an
    // operator can observe — but leaving them accumulates a copy of the bundle
    // per crash.
    if (entry.startsWith(STAGING_PREFIX) || entry.startsWith(LINK_PREFIX)) {
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
