import { describe, expect, it } from 'vitest';
import { assembleParts } from '../../apps/web/src/backup-parts';

/** E4: the parts of one backup, joined in order in the browser, or refused by name. */
describe('assembleParts (E4)', () => {
  const part = (name: string, body: string) => new File([body], name);

  it('joins the parts in numeric order whatever order they were picked in', async () => {
    const result = assembleParts([
      part('nexa-backup.7z.003', 'CC'),
      part('nexa-backup.7z.001', 'AA'),
      part('nexa-backup.7z.002', 'BB'),
    ]);
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') throw new Error('unreachable');
    expect(result.parts).toBe(3);
    expect(result.file.name).toBe('nexa-backup.7z');
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(result.file);
    });
    expect(text).toBe('AABBCC');
  });

  it('refuses a set with a missing part', () => {
    expect(assembleParts([part('b.7z.001', 'A'), part('b.7z.003', 'C')]).kind).toBe('INVALID');
  });

  it('refuses a set that does not start at .001', () => {
    expect(assembleParts([part('b.7z.002', 'B'), part('b.7z.003', 'C')]).kind).toBe('INVALID');
  });

  it('refuses parts of two different backups', () => {
    expect(assembleParts([part('a.7z.001', 'A'), part('b.7z.002', 'B')]).kind).toBe('INVALID');
  });

  it('refuses several files that are not numbered parts', () => {
    expect(assembleParts([part('a.nxb', 'A'), part('b.nxb', 'B')]).kind).toBe('INVALID');
  });

  it('passes a single file through untouched', () => {
    const only = part('archive.nxb', 'X');
    const result = assembleParts([only]);
    expect(result).toEqual({ kind: 'OK', file: only, parts: 1 });
    expect(assembleParts([]).kind).toBe('NONE');
  });
});
