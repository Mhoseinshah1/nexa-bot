import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  mainMenuButton,
  type ExplicitMainMenu,
  type MainMenuBuilderItem,
  type MainMenuButtonId,
  type MainMenuButtonStyle,
} from '@nexa/contracts';
import { t } from '../../i18n/web.fa';
import { templateCopy } from '../../template-copy';
import { Badge } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { type PointerDrag } from './dnd';
import {
  configOf,
  dropHintOf,
  hiddenNowByGate,
  hintedRow,
  lookOf,
  poolOf,
  rowLooksCramped,
  type DropHint,
} from './model';

/** The label a button shows now: the tenant's rendered text, else the template's Persian name. */
export function labelOf(id: MainMenuButtonId, item: MainMenuBuilderItem | undefined): string {
  if (item !== undefined && item.label !== '') return item.label;
  return templateCopy(mainMenuButton(id).label, '').name;
}

/** `{n}`-style substitution for the builder's sentences. */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return Object.entries(values).reduce(
    (out, [name, value]) => out.split(`{${name}}`).join(String(value)),
    text,
  );
}

const STYLE_CLASS: Readonly<Record<MainMenuButtonStyle, string>> = {
  default: 'bb-style-default',
  primary: 'bb-style-primary',
  success: 'bb-style-success',
  danger: 'bb-style-danger',
};

/** One key as a customer's keyboard draws it (read-only previews). Text and style only. */
export interface PreviewKey {
  readonly key: string;
  readonly label: string;
  readonly look: MainMenuButtonStyle;
}

/** A read-only keyboard: the customer preview, the live keyboard, a revision, a diff. */
export function PreviewKeyboard({
  rows,
  label,
  testId,
}: {
  rows: readonly (readonly PreviewKey[])[];
  label: string;
  testId?: string;
}) {
  return (
    <div
      className="menu-preview"
      aria-label={label}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      {rows.map((row, at) => (
        <div
          key={`${String(at)}:${row.map((one) => one.key).join(':')}`}
          className="menu-preview-row"
        >
          {row.map((one) => (
            <span
              key={one.key}
              className={`menu-preview-key ${STYLE_CLASS[one.look]}`}
              data-key={one.key}
              data-look={one.look}
            >
              {one.label}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

interface ChipContext {
  readonly layout: ExplicitMainMenu;
  readonly items: ReadonlyMap<MainMenuButtonId, MainMenuBuilderItem>;
  readonly selected: MainMenuButtonId | null;
  readonly editable: boolean;
  readonly drag: PointerDrag;
  readonly onSelect: (id: MainMenuButtonId) => void;
  readonly onKey: (id: MainMenuButtonId, event: KeyboardEvent<HTMLButtonElement>) => void;
}

/** The insertion placeholder the drag shows now, or null (no drag, or a drop that does nothing). */
function hintOf(context: ChipContext): DropHint | null {
  return dropHintOf(context.layout, context.drag.source, context.drag.over);
}

/**
 * A grip: what a drag starts from. A real `<button>` with a 34 × 44 px hit area, because
 * round-T QA-2 saw Chromium's touch adjustment move a finger off the old 18 px `span` grip
 * onto the nearest activatable element — the key's own button — so no drag started. It is
 * out of the tab order and hidden from assistive technology: the keyboard path is the key's
 * own shortcuts and the Inspector's move buttons, which do the same moves.
 */
function Grip({
  className,
  title,
  props,
}: {
  className: string;
  title: string;
  props: ReturnType<PointerDrag['gripProps']>;
}) {
  return (
    <button
      type="button"
      className={className}
      tabIndex={-1}
      aria-hidden="true"
      title={title}
      {...props}
    >
      <Icon name="menu" size={14} />
    </button>
  );
}

/** One button in the editor: a grip to drag it, and a button that selects it. */
function Chip({
  id,
  context,
  where,
  placed,
}: {
  id: MainMenuButtonId;
  context: ChipContext;
  /** The position sentence, or the pool's. */
  where: string;
  placed: boolean;
}) {
  const { layout, items, selected, editable, drag } = context;
  const item = items.get(id);
  const config = configOf(layout, id);
  const label = labelOf(id, item);
  const hidden = placed && config.enabled && hiddenNowByGate(item);
  const hint = hintOf(context);
  const states = [
    where,
    !config.enabled ? t('web.bb_state_off') : null,
    hidden ? t('web.bb_hidden_now') : null,
  ].filter((part): part is string => part !== null);
  const classes = [
    'bb-chip',
    STYLE_CLASS[lookOf(config)],
    !config.enabled && 'is-off',
    hidden && 'is-gated',
    selected === id && 'is-selected',
    drag.source?.kind === 'button' && drag.source.id === id && 'is-dragging',
    hint?.kind === 'before' && hint.id === id && 'is-insert-before',
  ].filter(Boolean);
  return (
    <div
      className={classes.join(' ')}
      {...(placed ? { 'data-drop': 'chip', 'data-id': id } : {})}
      data-chip={id}
    >
      {editable && (
        <Grip
          className="bb-grip"
          title={t('web.bb_drag_hint')}
          props={drag.gripProps({ kind: 'button', id })}
        />
      )}
      <button
        type="button"
        className="bb-chip-main"
        aria-pressed={selected === id}
        aria-label={`${label} — ${states.join(t('web.bb_sep'))}`}
        data-chip-button={id}
        onClick={() => context.onSelect(id)}
        onKeyDown={(event) => context.onKey(id, event)}
      >
        <span className="bb-chip-label">{label}</span>
        {!config.enabled && <Badge tone="neutral">{t('web.bb_state_off')}</Badge>}
        {hidden && <Badge tone="warn">{t('web.bb_hidden_now')}</Badge>}
      </button>
    </div>
  );
}

/**
 * The gap before row `at`: a NEW row is made there by a drop. Always laid out while the
 * keyboard is editable, so starting a drag changes no size; its placeholder (a line and a
 * note) is drawn over it by CSS only while a drop there would do something.
 */
function Gap({ at, context }: { at: number; context: ChipContext }) {
  const hint = hintOf(context);
  const active = hint?.kind === 'new-row' && hint.at === at;
  const dragging = context.drag.source !== null;
  return (
    <div
      className={`bb-gap${dragging ? ' is-armed' : ''}${active ? ' is-over' : ''}`}
      data-drop="gap"
      data-at={String(at)}
      aria-hidden="true"
    >
      {active && <span className="bb-gap-note">{t('web.bb_drop_new_row')}</span>}
    </div>
  );
}

/** The editable keyboard: explicit rows of chips, with drop zones between them. */
export function EditableKeyboard({ context }: { context: ChipContext }) {
  const { layout, items, editable, drag } = context;
  const wide = (id: MainMenuButtonId) => items.get(id)?.wide ?? mainMenuButton(id).wide;
  const rows = layout.rows;
  const hint = hintOf(context);
  const targetRow = hintedRow(hint);
  return (
    <div
      className={`bb-keyboard${drag.source !== null ? ' is-dragging' : ''}`}
      aria-label={t('web.bb_canvas_label')}
      role="group"
    >
      {rows.map((row, at) => {
        const draggingRow = drag.source?.kind === 'row' && drag.source.row === at;
        const rowName = fill(t('web.bb_row_n'), { n: at + 1 });
        const classes = [
          'bb-row',
          targetRow === at && 'is-target',
          hint?.kind === 'row-end' && hint.row === at && 'is-insert-end',
          draggingRow && 'is-dragging',
        ].filter(Boolean);
        return (
          <div key={`${String(at)}:${row.join(':')}`} className="bb-row-wrap">
            {editable && <Gap at={at} context={context} />}
            <div
              className={classes.join(' ')}
              data-drop="row"
              data-row={String(at)}
              data-testid={`bb-row-${String(at)}`}
              role="group"
              aria-label={rowName}
            >
              {editable && (
                <Grip
                  className="bb-row-grip"
                  title={t('web.bb_drag_row_hint')}
                  props={drag.gripProps({ kind: 'row', row: at })}
                />
              )}
              {row.map((id, index) => (
                <Chip
                  key={id}
                  id={id}
                  context={context}
                  where={fill(t('web.bb_position'), { row: at + 1, index: index + 1 })}
                  placed
                />
              ))}
              {rowLooksCramped(row, wide) && (
                <span className="bb-row-warn" title={t('web.bb_row_cramped')}>
                  <Icon name="alert" size={14} aria-hidden="true" />
                  <span className="visually-hidden">{t('web.bb_row_cramped')}</span>
                </span>
              )}
            </div>
          </div>
        );
      })}
      {editable && <Gap at={rows.length} context={context} />}
      {editable && rows.length === 0 && <p className="tg-phone-note">{t('web.bb_canvas_empty')}</p>}
      <DragGhost context={context} />
    </div>
  );
}

/**
 * The dragged key, following the pointer: an SVG layer over the page whose `<g>` the drag
 * hook moves through its `transform` ATTRIBUTE (no inline style exists under the production
 * CSP). It never takes the pointer, so hit-testing sees what is under it.
 */
function DragGhost({ context }: { context: ChipContext }) {
  const { drag, items, layout } = context;
  const box = useRef<SVGRectElement | null>(null);
  const text = useRef<SVGTextElement | null>(null);
  const source = drag.source;
  const label =
    source === null
      ? ''
      : source.kind === 'button'
        ? labelOf(source.id, items.get(source.id))
        : fill(t('web.bb_row_n'), { n: source.row + 1 });
  const look = source?.kind === 'button' ? lookOf(configOf(layout, source.id)) : 'default';
  // Fit the box to the label once it is drawn: measured, then written as attributes.
  useLayoutEffect(() => {
    const measured = text.current?.getComputedTextLength?.();
    const width = Math.max(64, Math.ceil((measured ?? label.length * 8) + 28));
    box.current?.setAttribute('width', String(width));
    box.current?.setAttribute('x', String(-width / 2));
  }, [label]);
  if (source === null || typeof document === 'undefined') return null;
  return createPortal(
    <svg className="bb-drag-layer" aria-hidden="true" data-testid="bb-drag-ghost">
      <g
        ref={drag.ghostRef}
        className={`bb-ghost ${STYLE_CLASS[look]}`}
        transform="translate(-9999 -9999)"
      >
        <rect ref={box} className="bb-ghost-box" x={-48} y={-36} width={96} height={36} rx={8} />
        <text
          ref={text}
          className="bb-ghost-text"
          x={0}
          y={-18}
          textAnchor="middle"
          dominantBaseline="central"
          direction="rtl"
        >
          {label}
        </text>
      </g>
    </svg>,
    document.body,
  );
}

/** The Available pool: every declared button in no row, with its configuration kept. */
export function Pool({ context, children }: { context: ChipContext; children?: ReactNode }) {
  const { layout, drag } = context;
  const pool = poolOf(layout);
  const over = hintOf(context)?.kind === 'pool';
  return (
    <section
      className={`bb-pool${over ? ' is-over' : ''}${drag.source !== null ? ' is-target' : ''}`}
      data-drop="pool"
      aria-labelledby="bb-pool-title"
      data-testid="bb-pool"
    >
      <h3 id="bb-pool-title" className="bb-pane-title">
        {t('web.bb_pool_title')}
      </h3>
      <p className="muted small">{t('web.bb_pool_hint')}</p>
      {pool.length === 0 ? (
        <p className="muted small">{t('web.bb_pool_empty')}</p>
      ) : (
        <div className="bb-pool-list">
          {pool.map((id) => (
            <Chip key={id} id={id} context={context} where={t('web.bb_in_pool')} placed={false} />
          ))}
        </div>
      )}
      {children}
    </section>
  );
}

export type { ChipContext };
