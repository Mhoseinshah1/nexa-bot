import { describe, expect, it } from 'vitest';
import { providerReconciles } from '../../apps/api/src/modules/platform/legacy-importer/application/final-report';

// P3: the import never attempted a write against a panel, and it read the panels — unless no
// panel had anything to be asked (Codex: a backup with no live invoice of an importable owner
// sends no request at all, and that is no discrepancy).
describe('providerReconciles (P3)', () => {
  const base = { refusedWrites: 0, inventoriesComplete: true };
  it('reads and no refused write: holds', () => {
    expect(providerReconciles({ ...base, reads: 12 })).toBe(true);
  });
  it('zero reads where reads were needed (or not stated): does not hold', () => {
    expect(providerReconciles({ ...base, reads: 0 })).toBe(false);
    expect(providerReconciles({ ...base, reads: 0, readsNeeded: true })).toBe(false);
  });
  it('zero reads where no panel had anything to be asked: holds', () => {
    expect(providerReconciles({ ...base, reads: 0, readsNeeded: false })).toBe(true);
  });
  it('a refused write never holds', () => {
    expect(providerReconciles({ ...base, reads: 5, refusedWrites: 1 })).toBe(false);
    expect(providerReconciles({ ...base, reads: 0, refusedWrites: 1, readsNeeded: false })).toBe(
      false,
    );
  });
});
