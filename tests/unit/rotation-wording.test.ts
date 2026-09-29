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

/**
 * The ONE sentence allowed to say the previous link stops working: the success message
 * of a customer's link change, `bot.service.link_rotated`. The owner decided its meaning
 * in the v0.3.5 real-test brief (R3, item 9) — «لینک قبلی دیگر قابل استفاده نیست» — so it
 * is the product's statement, made only once the panel has minted and returned a new
 * link. Every OTHER rotation sentence (the hint on the card, the question before the
 * change, the operator's copy) still claims nothing, and this list may not grow without
 * the same kind of decision: `OQ-RP-07` records that no real panel has yet been observed
 * refusing the old link, and the acceptance that would prove it.
 */
const OWNER_DECIDED_OLD_LINK_SENTENCES = new Set(['bot.service.link_rotated']);

const rotationKeys = (catalogue: Readonly<Record<string, string>>) =>
  Object.entries(catalogue).filter(
    ([key]) => /rotat/u.test(key) && !OWNER_DECIDED_OLD_LINK_SENTENCES.has(key),
  );

describe('rotation wording claims nothing about the old link', () => {
  it('finds the rotation keys it guards, so an empty scan cannot pass', () => {
    expect(rotationKeys(CATALOGUE_FA).map(([key]) => key)).toEqual(
      expect.arrayContaining(['bot.service.rotate_hint', 'bot.service.rotate_ask']),
    );
    expect(rotationKeys(WEB_FA).length).toBeGreaterThan(0);
  });

  it('the owner-decided exemption is exactly the link-change success message', () => {
    expect([...OWNER_DECIDED_OLD_LINK_SENTENCES]).toEqual(['bot.service.link_rotated']);
    expect(CATALOGUE_FA['bot.service.link_rotated']).toMatch(/لینک\s*قبلی/u);
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
