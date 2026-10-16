import type { ChangeEvent } from 'react';
import { t } from '../i18n/web.fa';

/**
 * The Persian drop-box file picker (W1.2) — replaces every native `<input type=file>`
 * DISPLAY («Choose File / No file chosen»). A native input is still inside, visually hidden,
 * so the browser's own picker, `accept` and `multiple` work exactly as before and the same
 * `FileList` reaches the page's existing handler.
 *
 * PHASE-0 INTERFACE STUB — agent A builds the drop box, drag-and-drop, file name + Persian
 * size, «تغییر» and «حذف». Tests may keep using `fireEvent.change(input, { target: { files } })`
 * on the native input (found by its label) — that contract is permanent.
 */
export type FileKind = 'backup' | 'image' | 'pdf' | 'video' | 'any';

export interface FilePickerProps {
  id?: string;
  /** Passed to the native input unchanged. */
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  /**
   * Which Persian sentence describes the accepted types («فقط .nxb، .nxpkg» / «تصویر» / «PDF»).
   */
  kind?: FileKind;
  /** The accepted extensions shown when `kind` is `backup` or `any`, e.g. `['.nxb', '.nxpkg']`. */
  extensions?: readonly string[];
  /** The page's existing handler, given the same files the native input would give. */
  onFiles: (files: readonly File[]) => void;
  /**
   * The file currently held by the page, if any (drawn as name + size, with «تغییر»/«حذف»).
   */
  selected?: File | null;
  /**
   * «حذف»: the page clears its own state. Absent → no remove button.
   */
  onClear?: () => void;
  /** Accessible name when no `<label htmlFor>` points at `id`. */
  label?: string;
}

export function FilePicker({
  id,
  accept,
  multiple = false,
  disabled = false,
  onFiles,
  label,
}: FilePickerProps) {
  return (
    <div className="file-picker">
      <span className="muted small">{t('web.file_drop')}</span>
      <input
        type="file"
        {...(id === undefined ? {} : { id })}
        {...(accept === undefined ? {} : { accept })}
        multiple={multiple}
        disabled={disabled}
        {...(label === undefined ? {} : { 'aria-label': label })}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onFiles(Array.from(event.target.files ?? []))
        }
      />
    </div>
  );
}
