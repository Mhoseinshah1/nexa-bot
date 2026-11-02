import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { FilePicker, formatFileSize } from '../../apps/web/src/ui/file-picker';
import { Field } from '../../apps/web/src/ui/kit';
import { t } from '../../apps/web/src/i18n/web.fa';

/** W1.2 — the Persian drop box over a real, hidden native input. */

const file = (name: string, size: number, type = '') =>
  new File([new Uint8Array(size)], name, { type });

function Harness({
  onFiles,
  accept,
  multiple = false,
  disabled = false,
  clearable = true,
}: {
  onFiles: (files: readonly File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  clearable?: boolean;
}) {
  const [held, setHeld] = useState<File | null>(null);
  return (
    <Field label="بکاپ" htmlFor="f">
      <FilePicker
        id="f"
        kind="backup"
        extensions={['.nxb', '.nxpkg']}
        multiple={multiple}
        disabled={disabled}
        selected={held}
        onFiles={(files) => {
          setHeld(files[0] ?? null);
          onFiles(files);
        }}
        {...(accept === undefined ? {} : { accept })}
        {...(clearable ? { onClear: () => setHeld(null) } : {})}
      />
    </Field>
  );
}

function drop(target: Element, files: File[]) {
  const event = createEvent.drop(target);
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  fireEvent(target, event);
}

describe('the file picker', () => {
  it('keeps a real file input, found by its label, that hands the page the same File', () => {
    const seen: File[][] = [];
    render(<Harness onFiles={(files) => seen.push([...files])} accept=".nxb,.nxpkg" />);
    const input = screen.getByLabelText('بکاپ') as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.accept).toBe('.nxb,.nxpkg');
    const chosen = file('nexa-2026.nxb', 249_856);
    fireEvent.change(input, { target: { files: [chosen] } });
    expect(seen).toEqual([[chosen]]);
  });

  it('says what it takes, then shows the name and the size in Persian with change and remove', () => {
    render(<Harness onFiles={() => undefined} />);
    expect(screen.getByText(t('web.file_drop'))).toBeInTheDocument();
    expect(
      screen.getByText(t('web.file_only').replace('{list}', '.nxb، .nxpkg')),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('بکاپ'), {
      target: { files: [file('nexa-2026.nxb', 249_856)] },
    });
    expect(screen.getByText('nexa-2026.nxb')).toBeInTheDocument();
    expect(screen.getByText(formatFileSize(249_856))).toBeInTheDocument();
    expect(screen.getByText(t('web.file_change'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('web.file_remove_label') }));
    expect(screen.queryByText('nexa-2026.nxb')).toBeNull();
    expect(screen.getByText(t('web.file_drop'))).toBeInTheDocument();
  });

  it('ties a page hint to the native input as its description', () => {
    render(
      <>
        <FilePicker
          label="backup"
          kind="backup"
          describedBy="kind-hint"
          onFiles={() => undefined}
        />
        <p id="kind-hint">only .nxb</p>
      </>,
    );
    expect(screen.getByLabelText('backup')).toHaveAccessibleDescription('only .nxb');
  });

  it('writes sizes in Latin digits and units', () => {
    expect(formatFileSize(812)).toBe(t('web.file_bytes').replace('{n}', '812'));
    expect(formatFileSize(249_856)).toBe(t('web.file_kb').replace('{n}', '244'));
    expect(formatFileSize(3_355_443)).toBe(t('web.file_mb').replace('{n}', '3.2'));
  });

  it('draws no remove button when the page cannot clear', () => {
    render(<Harness onFiles={() => undefined} clearable={false} />);
    fireEvent.change(screen.getByLabelText('بکاپ'), { target: { files: [file('a.nxb', 10)] } });
    expect(screen.queryByRole('button', { name: t('web.file_remove_label') })).toBeNull();
  });

  it('takes a dropped file, one unless multiple, and refuses a type accept does not list', () => {
    const seen: string[][] = [];
    render(<Harness onFiles={(files) => seen.push(files.map((one) => one.name))} accept=".nxb" />);
    const box = screen.getByText(t('web.file_drop')).closest('.file-picker') as Element;
    drop(box, [file('photo.png', 10, 'image/png')]);
    expect(seen).toEqual([]);
    expect(screen.getByRole('alert')).toHaveTextContent(t('web.file_wrong_type'));
    drop(box, [file('one.nxb', 10), file('two.nxb', 10)]);
    expect(seen).toEqual([['one.nxb']]);
  });

  it('ignores a drop while disabled, and disables the native input', () => {
    const seen: File[][] = [];
    render(<Harness onFiles={(files) => seen.push([...files])} disabled />);
    expect(screen.getByLabelText('بکاپ')).toBeDisabled();
    const box = screen.getByText(t('web.file_drop')).closest('.file-picker') as Element;
    drop(box, [file('one.nxb', 10)]);
    expect(seen).toEqual([]);
  });
});
