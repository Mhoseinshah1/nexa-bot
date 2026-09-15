import { describe, expect, it } from 'vitest';
import {
  ADD_CLIENT_PATH,
  CLIENT_TRAFFICS_PATH,
  STATUS_PATH,
} from '../../apps/api/src/modules/platform/providers/infrastructure/sanaei.adapter';
import {
  SYSTEM_PATH,
  TOKEN_PATH,
  USER_PATH,
} from '../../apps/api/src/modules/platform/providers/infrastructure/marzban.adapter';

/**
 * Every path an adapter dials, against a table transcribed from the panel's own router.
 *
 * ## Why this exists
 *
 * Phase 4D shipped a Sanaei adapter that sent `panel/api/inbounds/addClient` and
 * `panel/api/inbounds/getClientTraffics/<email>` — the v2.x paths, which v3.7.0 does
 * not register. Every test passed, because `tests/support/fake-3xui.ts` implemented the
 * same two wrong paths. The adapter and the fake agreed with each other and neither
 * agreed with the panel.
 *
 * That is not a gap a bigger fake fixes. A fake is written from the same reading of the
 * upstream that the adapter is written from, so it can only ever confirm that reading.
 * The circularity is the defect.
 *
 * ## What this checks, and what it does NOT
 *
 * It checks that the path constants have not drifted from a table a HUMAN transcribed
 * from the upstream router, with the commit pinned below. It cannot check that the
 * table matches upstream — nothing in CI can, because CI has no network and pinning a
 * vendored copy of two panels is not proportionate.
 *
 * So the honest claim is narrow: this makes the transcription the ONE place a route is
 * verified, and makes an adapter unable to disagree with it silently. Changing a path
 * now means changing this table, in the same commit, with the source line that justifies
 * it — which is the review moment that did not exist before.
 *
 * The other half of the answer is `docs/vps-acceptance.md`, which has never been run. No
 * amount of offline testing catches the next one of these; first contact with a real
 * panel does.
 */
describe('the routes each provider adapter dials', () => {
  /*
   * MHSanaei/3x-ui, tag `v3.7.0` = commit f727d04f6522bb94a8fb52e8352fdcafb51c11e1,
   * which is the commit `docs/providers/sanaei-3xui.md` pins.
   *
   *   internal/web/controller/server.go  -> GET  /panel/api/server/status
   *   internal/web/controller/client.go  -> POST /panel/api/clients/add          (create)
   *   internal/web/controller/client.go  -> GET  /panel/api/clients/traffic/:email
   *
   * `internal/web/controller/inbound.go` registers NO client routes. A grep of the tree
   * at that tag finds `addClient` only as a UI translation string and
   * `getClientTraffics` nowhere.
   */
  it('dials only paths v3.7.0 of 3X-UI actually registers', () => {
    expect(STATUS_PATH).toBe('panel/api/server/status');
    expect(ADD_CLIENT_PATH).toBe('panel/api/clients/add');
    // The `:email` segment is appended by the caller, so the constant is the prefix.
    expect(CLIENT_TRAFFICS_PATH).toBe('panel/api/clients/traffic');
  });

  it('dials no 3X-UI path that belongs to the v2.x API', () => {
    /*
     * Named, not inferred. A complement computed from the constants would pass whichever
     * side a path moved to, and these two specific strings are the ones this codebase
     * shipped against a release that does not have them.
     */
    for (const path of [STATUS_PATH, ADD_CLIENT_PATH, CLIENT_TRAFFICS_PATH]) {
      expect(path, `${path} is a v2.x inbounds-scoped client route`).not.toContain(
        'inbounds/addClient',
      );
      expect(path, `${path} is a v2.x inbounds-scoped client route`).not.toContain(
        'inbounds/getClientTraffics',
      );
    }
  });

  /*
   * Gozargah/Marzban, tag `v0.8.4` = commit 7f396db3e703d71a28060bc9ce4a532ec64cb1f4,
   * which is the commit `docs/providers/marzban.md` pins.
   *
   *   app/routers/admin.py  -> POST   /api/admin/token       (prefix="/api")
   *   app/routers/system.py -> GET    /api/system            (prefix="/api")
   *   app/routers/user.py   -> POST   /api/user              (prefix="/api")
   *   app/routers/user.py   -> GET    /api/user/{username}
   *   app/routers/user.py   -> PUT    /api/user/{username}   (disable AND re-enable)
   *   app/routers/user.py   -> DELETE /api/user/{username}
   *
   * Checked because Phase 4D's Sanaei paths were wrong and Marzban's had never been
   * verified against any pinned upstream at all. These are correct, and unlike the
   * 3X-UI half above they have since been RUN against a panel built from the commit.
   *
   * Only three constants for six calls, because the last four all address the same
   * `/api/user/{username}` and differ by method. That is the shape of the router, not a
   * shortcut: there is no dedicated disable route and no dedicated enable route, so a
   * reader looking for one will not find it and must not invent it.
   */
  it('dials only paths Marzban actually registers', () => {
    expect(TOKEN_PATH).toBe('api/admin/token');
    expect(SYSTEM_PATH).toBe('api/system');
    // `/{username}` is appended by the caller for read, modify and delete alike.
    expect(USER_PATH).toBe('api/user');
  });
});
