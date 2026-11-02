import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { t } from '../i18n/web.fa';
import { Icon } from './icons';

/**
 * The Persian drop-box file picker (W1.2) — replaces every native `<input type=file>`
 * DISPLAY («Choose File / No file chosen»). A native input is still inside, visually hidden
 * but focusable and named by the page's `<label htmlFor={id}>`, so the browser's own picker,
 * `accept` and `multiple` work exactly as before and the same `File`s reach the page's
 * existing handler — whether picked, or dropped on the box.
 *
 * After a choice the box shows the file's name and its size in Persian («۲۴۴ کیلوبایت»), with
 * «تغییر» and (when the page can clear its own state) «حذف». A dropped file the `accept` list
 * refuses is not handed over: the box says so instead. Size limits stay the page's own.
 *
 * Tests may keep using `fireEvent.change(input, { target: { files } })` on the native input
 * (found by its label) — that contract is permanent.
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
   * Absent (`undefined`) → the box shows what was last chosen in it.
   */
  selected?: File | null;
  /**
   * «حذف»: the page clears its own state. Absent → no remove button.
   */
  onClear?: () => void;
  /** Accessible name when no `<label htmlFor>` points at `id`. */
  label?: string;
  /** The id of a hint that describes the control (e.g. which kind of file is expected). */
  describedBy?: string;
}

const SIZE_ONE = new Intl.NumberFormat('fa-IR-u-nu-latn', { maximumFractionDigits: 1 });
const SIZE_WHOLE = new Intl.NumberFormat('fa-IR-u-nu-latn', { maximumFractionDigits: 0 });

/** A byte count in Persian digits and units (bytes, kilobytes, megabytes). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return t('web.file_bytes').replace('{n}', SIZE_WHOLE.format(bytes));
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return t('web.file_kb').replace('{n}', (kb < 10 ? SIZE_ONE : SIZE_WHOLE).format(kb));
  }
  return t('web.file_mb').replace('{n}', SIZE_ONE.format(bytes / (1024 * 1024)));
}

/** The accept list as a Persian sentence. */
export function acceptSentence(
  kind: FileKind | undefined,
  accept: string | undefined,
  extensions: readonly string[] | undefined,
): string {
  if (kind === 'image') return t('web.file_kind_image');
  if (kind === 'pdf') return t('web.file_kind_pdf');
  if (kind === 'video') return t('web.file_kind_video');
  const listed =
    extensions ??
    (accept ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('.'));
  if (listed.length === 0) return t('web.file_kind_any');
  return t('web.file_only').replace('{list}', listed.join(t('web.list_separator')));
}

/** Whether a file matches the native `accept` attribute (`.ext`, `type/*`, `type/sub`). */
export function acceptsFile(accept: string | undefined, file: File): boolean {
  if (accept === undefined || accept.trim() === '') return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '')
    .some((part) => {
      if (part.startsWith('.')) return name.endsWith(part);
      if (part.endsWith('/*')) return type.startsWith(part.slice(0, -1));
      return type === part;
    });
}

export function FilePicker({
  id,
  accept,
  multiple = false,
  disabled = false,
  kind,
  extensions,
  onFiles,
  selected,
  onClear,
  label,
  describedBy,
}: FilePickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const [own, setOwn] = useState<readonly File[]>([]);
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState(false);
  const shown: readonly File[] = selected === undefined ? own : selected === null ? [] : [selected];
  const first = shown[0];

  const hand = (files: readonly File[]) => {
    setRefused(false);
    setOwn(files);
    onFiles(files);
  };

  const pick = () => {
    if (!disabled) input.current?.click();
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    if (disabled) return;
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length === 0) return;
    const wanted = multiple ? dropped : dropped.slice(0, 1);
    if (!wanted.every((file) => acceptsFile(accept, file))) {
      setRefused(true);
      return;
    }
    hand(wanted);
  };

  const classes = ['file-picker', first !== undefined && 'has', over && 'over', disabled && 'dis']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      onClick={(event) => {
        // A click on a button inside does its own thing; anywhere else opens the picker.
        if ((event.target as HTMLElement).closest('button, input') === null) pick();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <input
        ref={input}
        type="file"
        className="file-picker-native"
        {...(id === undefined ? {} : { id })}
        {...(accept === undefined ? {} : { accept })}
        multiple={multiple}
        disabled={disabled}
        {...(label === undefined ? {} : { 'aria-label': label })}
        {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          hand(Array.from(event.target.files ?? []))
        }
      />
      <span className={`file-picker-ic${first === undefined ? '' : ' ok'}`} aria-hidden="true">
        <Icon name={first === undefined ? 'upload' : 'check'} size={18} />
      </span>
      <span className="file-picker-t">
        {first === undefined ? (
          <>
            <b>{t('web.file_drop')}</b>
            <small>{acceptSentence(kind, accept, extensions)}</small>
          </>
        ) : shown.length > 1 ? (
          <>
            <b>{t('web.file_count').replace('{n}', SIZE_WHOLE.format(shown.length))}</b>
            <small>{formatFileSize(shown.reduce((sum, file) => sum + file.size, 0))}</small>
          </>
        ) : (
          <>
            <b dir="auto" className="file-picker-name">
              {first.name}
            </b>
            <small>{formatFileSize(first.size)}</small>
          </>
        )}
        {refused && (
          <small className="danger" role="alert">
            {t('web.file_wrong_type')}
          </small>
        )}
      </span>
      <span className="file-picker-a">
        {/* The native input is the keyboard's tab stop; these repeat it for the pointer. */}
        <button
          type="button"
          className={`btn sm${first === undefined ? '' : ' ghost'}`}
          tabIndex={-1}
          aria-hidden="true"
          disabled={disabled}
          onClick={pick}
        >
          {first === undefined ? t('web.file_choose') : t('web.file_change')}
        </button>
        {first !== undefined && onClear !== undefined && (
          <button
            type="button"
            className="btn sm ghost danger"
            aria-label={t('web.file_remove_label')}
            disabled={disabled}
            onClick={() => {
              if (input.current !== null) input.current.value = '';
              setOwn([]);
              setRefused(false);
              onClear();
            }}
          >
            {t('web.file_remove')}
          </button>
        )}
      </span>
    </div>
  );
}
