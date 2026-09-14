import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Who may run the COMPILED Telegram bootstrap.
 *
 * `BotBootstrapService` cannot make `setWebhook` atomic with the row that
 * records it — the call has to happen outside that transaction — so two
 * reconciliations using different origins can commit the external and the local
 * effect in opposite orders and leave a row claiming `ready` for a URL Telegram
 * is not using. Nothing in the application prevents that. The ordering is held
 * by the deployment lock, which `install.sh` and `botctl telegram register` take
 * before they run the CLI.
 *
 * That argument is only true while those are the only callers, and it was not:
 * `apps/api/package.json` exposed `bot:bootstrap`, running the compiled CLI on a
 * host that has the production database and secrets, taking no lock at all. The
 * service's comment said "there is no third caller" throughout.
 *
 * `check-boundaries.sh` is what fails the build. This is what makes the rule
 * citable and mutable, and it reads the allow list OUT of that script rather
 * than restating it — so it catches a new unlocked caller AND an allow list
 * quietly widened to admit one.
 */
describe('the compiled bot bootstrap has only locked callers', () => {
  const root = join(__dirname, '../..');
  const check = readFileSync(join(root, 'scripts/check-boundaries.sh'), 'utf8');

  /** The `-e '<path>'` entries of the check's own `grep -vxF` allow list. */
  const allowed = (): string[] => {
    const block = /BOOTSTRAP_CALLERS=\$\([\s\S]*?\|\| true\)/.exec(check)?.[0];
    expect(block, 'check-boundaries.sh no longer defines BOOTSTRAP_CALLERS').toBeTruthy();
    return [...(block ?? '').matchAll(/-e '([^']+)'/g)].map((m) => m[1] as string);
  };

  /*
   * Split so that THIS FILE is not itself a match.
   *
   * The alternative is an allow-list entry for it, and an allow list that grows
   * an entry for every file that merely mentions the path is one nobody reads.
   * The trick is deliberate; undoing it means adding this file to the list in
   * `check-boundaries.sh` and to both expectations below.
   */
  const COMPILED_CLI = `dist/bootstrap-bot${'.cli.js'}`;

  const callers = (): string[] =>
    execFileSync('git', ['grep', '-l', '--', COMPILED_CLI], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line !== '')
      .sort();

  it('is named by exactly the two locked callers and the files that check them', () => {
    expect(callers()).toEqual(
      [
        // The two that take the deployment lock. These are the rule.
        'deploy/bin/botctl',
        'deploy/install.sh',
        // And the files that ASSERT things about it. None runs on an
        // operator's host: two checks, one smoke test, one shell suite.
        'scripts/check-boundaries.sh',
        'scripts/check-runtime-cli.sh',
        'scripts/deployment-smoke.sh',
        'tests/deploy/botctl.test.sh',
      ].sort(),
    );
  });

  it('agrees with the allow list the build actually enforces', () => {
    // Two statements of one rule drift, and the one that drifts is the one
    // nobody reruns. This fails if the check's list is widened without the
    // expectation above moving too — which is how a third caller would be
    // admitted quietly.
    expect(allowed().sort()).toEqual(callers());
  });

  it('does not expose the compiled CLI as a package script', () => {
    /*
     * The defect itself. `bot:bootstrap:dev` is deliberately still allowed: it
     * runs from source under `tsx` and needs devDependencies the release image
     * does not ship, so it cannot be a caller on a production host.
     */
    for (const manifest of ['package.json', 'apps/api/package.json']) {
      const scripts = JSON.parse(readFileSync(join(root, manifest), 'utf8')).scripts ?? {};
      expect(Object.keys(scripts), `${manifest} exposes the compiled bot bootstrap`).not.toContain(
        'bot:bootstrap',
      );
    }
  });
});
