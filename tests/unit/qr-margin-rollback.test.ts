import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type * as Contracts from '@nexa/contracts';
import type { OperationalEventInput, QrTemplate, TenantContext } from '@nexa/contracts';

/**
 * FIX-06, review of PR #250 (CX1): what a release from BEFORE FIX-06 does with a template
 * this release stored with a quiet zone of 0 — during a rolling update (an old replica
 * reads it) and after `botctl rollback` (the old release reads it).
 *
 * The old `qrTemplateSchema` (origin/main eb139bef, `packages/contracts/src/delivery-qr.ts`)
 * is a STRICT object with a quiet-zone minimum of 4; `oldSchemaFrom` below reproduces it.
 * Strict is why an old-readable representation (a clamped `quietZoneModules` plus an extra exact key)
 * is not available — the extra key fails the old parse exactly as 0 does — and this file
 * pins both facts. What it then proves is the degradation is fail-safe: the old release's
 * resolver does not throw, reports the row as invalid with an operational event, and the
 * delivery lane sends the plain QR — a valid, scannable code of the exact link.
 */

/**
 * The old schema, built from this release's (strict, whole numbers, 0..16 — everything else
 * identical to eb139bef) plus the old minimum. A refinement keeps `.strict()`: an unknown key
 * still fails it. The test package has no direct `zod` dependency to rebuild it from scratch.
 */
const OLD_QR_TEMPLATE_QUIET_ZONE_MIN = 4;
function oldSchemaFrom(contracts: typeof Contracts) {
  return contracts.qrTemplateSchema
    .refine((value) => value.quietZoneModules >= OLD_QR_TEMPLATE_QUIET_ZONE_MIN)
    .nullable();
}

// The old release's registry entry: this release's, with the old schema in it.
vi.mock('@nexa/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof Contracts>();
  return {
    ...actual,
    settingDefinition: (key: string) => {
      const definition = actual.settingDefinition(key as never);
      return key === 'delivery.qr_template'
        ? { ...definition, schema: oldSchemaFrom(actual) }
        : definition;
    },
  };
});

const { SettingsResolver } =
  await import('../../apps/api/src/modules/control/settings/application/settings-resolver');
const { PngDeliveryQrRenderer } = await import('../../apps/api/src/infrastructure/qr/qr-template');
const { encodeQrPng } = await import('../../apps/api/src/infrastructure/qr/qr-png');
const contracts = await import('@nexa/contracts');
const { qrTemplateSettingSchema } = contracts;
const oldQrTemplateSettingSchema = oldSchemaFrom(contracts);
const { gradientBackground } = await import('../support/png-build');
const { decodeQrPng } = await import('../support/qr-decode');

const A: TenantContext = { tenantId: 'tenant-a' as never, botInstanceId: null };
const URL = 'https://panel.example.com:2096/sub/cm9sbGJhY2stcmVhZC1vZi1hLXplcm8tbWFyZ2lu';
const ZERO: QrTemplate = { x: 100, y: 100, size: 41 * 9, quietZoneModules: 0 };

function oldRelease(stored: unknown) {
  const events: OperationalEventInput[] = [];
  const resolver = new SettingsResolver(
    {
      findAll: async () => [],
      find: async (_scope: unknown, key: string) =>
        key === 'delivery.qr_template'
          ? {
              key: 'delivery.qr_template' as never,
              value: stored,
              version: 3,
              updatedAt: new Date('2026-10-09T08:00:00.000Z'),
              updatedByAdminId: null,
            }
          : null,
      upsert: async () => null,
    } as never,
    {
      record: async (_scope: unknown, event: OperationalEventInput) => {
        events.push(event);
        return {} as never;
      },
    },
  );
  const background = gradientBackground(800, 700);
  const renderer = new PngDeliveryQrRenderer({
    // Exactly how the container wires it: `settingsResolver.valueOf(scope, key)`.
    template: (scope) => resolver.valueOf<QrTemplate | null>(scope, 'delivery.qr_template'),
    backgroundDigest: async () => createHash('sha256').update(background).digest('hex'),
    background: async () => ({ bytes: background }),
  });
  return { resolver, renderer, events };
}

describe('FIX-06 (CX1): a release before FIX-06 reading a quiet zone of 0', () => {
  it('cannot be given an old-readable form: the old schema is strict and its minimum is 4', () => {
    expect(qrTemplateSettingSchema.safeParse(ZERO).success).toBe(true);
    expect(oldQrTemplateSettingSchema.safeParse(ZERO).success).toBe(false);
    // A clamped value with the exact one beside it fails the old parse too: strict.
    expect(
      oldQrTemplateSettingSchema.safeParse({
        ...ZERO,
        quietZoneModules: 4,
        quietZoneModulesExact: 0,
      }).success,
    ).toBe(false);
    // Every value the old release could have stored still reads in both.
    for (const quietZoneModules of [4, 16]) {
      expect(oldQrTemplateSettingSchema.safeParse({ ...ZERO, quietZoneModules }).success).toBe(
        true,
      );
      expect(qrTemplateSettingSchema.safeParse({ ...ZERO, quietZoneModules }).success).toBe(true);
    }
  });

  it('falls back to the default (null), keeps the row’s version and says so — never throws', async () => {
    const { resolver, events } = oldRelease(ZERO);
    const resolved = await resolver.resolve(A, 'delivery.qr_template' as never);
    expect(resolved).toMatchObject({
      value: null,
      source: 'DEFAULT',
      version: 3,
      storedValueInvalid: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      code: 'settings.stored_value_invalid',
      severity: 'WARN',
      dedupeKey: 'settings.stored_value_invalid:delivery.qr_template',
    });
  });

  it('delivers the plain QR — byte for byte, decoding to the exact link — not an error', async () => {
    const { renderer } = oldRelease(ZERO);
    const image = await renderer.render(A, { kind: 'PAYLOAD', text: URL });
    expect(image).toMatchObject({ origin: 'NEXA_GENERATED', templated: false });
    expect(Buffer.from(image.bytes).equals(Buffer.from(encodeQrPng(URL)))).toBe(true);
    expect(decodeQrPng(image.bytes)).toBe(URL);
  });

  it('draws a template it can read exactly as before: only a 0..3 margin degrades', async () => {
    const { renderer, events } = oldRelease({ ...ZERO, quietZoneModules: 4 });
    const image = await renderer.render(A, { kind: 'PAYLOAD', text: URL });
    expect(image.templated).toBe(true);
    expect(events).toHaveLength(0);
  });
});
