import { describe, expect, it } from 'vitest';
import { CATALOGUE_FA } from '@nexa/i18n';
import { WEB_FA } from '../../apps/web/src/i18n/web.fa';

/**
 * WP15 H5 (`docs/wp15-provider-hardening-audit.md`, `OQ-RP-07`).
 *
 * A rotation is proven to MINT a new link; that the old one stops working has never been
 * observed on any panel — both links answered 504 from the owner's sub host. So no
 * sentence about a rotation may tell anybody that the old link, or someone else's
 * access, is cut. `bot.service.rotate_hint` did, on every service card that offered the
 * button, and this is the test that would have caught it.
 *
 * The phrases are the claim's own vocabulary: cutting access (قطع دسترسی), the old or
 * previous link (لینک قبلی / لینک قدیمی), invalidation (باطل / از کار می‌افتد /
 * غیرفعال می‌شود), and other people (دیگران).
 */
const CLAIMS = [
  /قطع\s*دسترسی/u,
  /لینک\s*(?:قبلی|قدیمی)/u,
  /باطل/u,
  /از\s*کار\s*(?:می‌افتد|افتاده|می\s*افتد)/u,
  /غیرفعال\s*می‌شود/u,
  /دیگران/u,
];

const rotationKeys = (catalogue: Readonly<Record<string, string>>) =>
  Object.entries(catalogue).filter(([key]) => /rotat/u.test(key));

describe('rotation wording claims nothing about the old link', () => {
  it('finds the rotation keys it guards, so an empty scan cannot pass', () => {
    expect(rotationKeys(CATALOGUE_FA).map(([key]) => key)).toEqual(
      expect.arrayContaining(['bot.service.rotate_hint', 'bot.service.rotate_ask']),
    );
    expect(rotationKeys(WEB_FA).length).toBeGreaterThan(0);
  });

  for (const [name, catalogue] of [
    ['bot', CATALOGUE_FA],
    ['web', WEB_FA],
  ] as const) {
    it(`no ${name} rotation sentence says the old link or anyone's access is cut`, () => {
      const offending = rotationKeys(catalogue).filter(([, text]) =>
        CLAIMS.some((claim) => claim.test(text)),
      );
      expect(offending).toEqual([]);
    });
  }
});
