import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { QR_TEMPLATE_REGION_MIN } from '@nexa/contracts';
import { t } from '../i18n/web.fa';

/**
 * «جای QR روی پس‌زمینه» — the placement square drawn on a large preview of the background:
 * drag it to move, drag the corner handle to resize, or focus it and use the arrow keys.
 *
 * The square is an SVG rect over the background's own pixel grid (`viewBox`), so every number
 * is in image pixels and the page needs no inline style. It never leaves the image: every
 * move and resize is clamped by `moveSquare` / `resizeSquare`, the same bounds the contract's
 * `qrTemplatePlacementProblem` enforces. The x / y / side fields beside it are the same
 * numbers; this component only produces them.
 */

export interface Square {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export interface Bounds {
  readonly width: number;
  readonly height: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), Math.max(low, high));

/** The square moved by (dx, dy), kept wholly inside the image. */
export function moveSquare(square: Square, dx: number, dy: number, bounds: Bounds): Square {
  return {
    size: square.size,
    x: Math.round(clamp(square.x + dx, 0, bounds.width - square.size)),
    y: Math.round(clamp(square.y + dy, 0, bounds.height - square.size)),
  };
}

/** The square's side changed by `delta` from its top-left corner, kept inside the image. */
export function resizeSquare(square: Square, delta: number, bounds: Bounds): Square {
  const most = Math.min(bounds.width - square.x, bounds.height - square.y);
  return {
    x: square.x,
    y: square.y,
    size: Math.round(clamp(square.size + delta, QR_TEMPLATE_REGION_MIN, most)),
  };
}

type Gesture =
  | { readonly kind: 'move'; readonly from: Square; readonly px: number; readonly py: number }
  | { readonly kind: 'resize'; readonly from: Square; readonly px: number; readonly py: number };

export function QrPlacementStage({
  bounds,
  square,
  backdrop,
  disabled,
  invalid,
  onChange,
}: {
  bounds: Bounds;
  /** The draft's square, or null while its numbers are not valid whole numbers. */
  square: Square | null;
  /** The server's rendering, drawn behind the square when it shows the background. */
  backdrop: string | null;
  disabled: boolean;
  /** The draft is outside the image or too small: the square is drawn in the danger colour. */
  invalid: boolean;
  onChange: (next: Square) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);

  /** Image pixels per screen pixel — jsdom lays nothing out, so 1 there. */
  const scale = (): number => {
    const width = svg.current?.getBoundingClientRect().width ?? 0;
    return width > 0 ? bounds.width / width : 1;
  };

  const begin = (event: ReactPointerEvent<SVGElement>, kind: Gesture['kind']) => {
    if (disabled || square === null || event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setGesture({ kind, from: square, px: event.clientX, py: event.clientY });
  };
  const track = (event: ReactPointerEvent<SVGElement>) => {
    if (gesture === null) return;
    const k = scale();
    const dx = (event.clientX - gesture.px) * k;
    const dy = (event.clientY - gesture.py) * k;
    onChange(
      gesture.kind === 'move'
        ? moveSquare(gesture.from, dx, dy, bounds)
        : resizeSquare(gesture.from, Math.max(dx, dy), bounds),
    );
  };
  const end = () => setGesture(null);

  const onKey = (event: KeyboardEvent<SVGElement>) => {
    if (disabled || square === null) return;
    const step = event.shiftKey ? 10 : 1;
    const arrows: Readonly<Record<string, readonly [number, number]>> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const arrow = arrows[event.key];
    if (arrow !== undefined) {
      event.preventDefault();
      onChange(
        event.altKey
          ? resizeSquare(square, arrow[0] + arrow[1], bounds)
          : moveSquare(square, arrow[0], arrow[1], bounds),
      );
    } else if (event.key === '+' || event.key === '-') {
      event.preventDefault();
      onChange(resizeSquare(square, event.key === '+' ? step : -step, bounds));
    }
  };

  const handle = Math.max(10, Math.round(bounds.width * 0.02));
  const tone = invalid ? 'bad' : 'ok';
  return (
    <div className="qrt-stage" data-testid="qrt-stage">
      <svg
        ref={svg}
        className="qrt-stage-svg"
        viewBox={`0 0 ${String(bounds.width)} ${String(bounds.height)}`}
        role="group"
        aria-label={t('web.qrt_stage_label')}
        onPointerMove={track}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <rect className="qrt-stage-bg" x={0} y={0} width={bounds.width} height={bounds.height} />
        {backdrop !== null && (
          <image href={backdrop} x={0} y={0} width={bounds.width} height={bounds.height} />
        )}
        {square !== null && (
          <g className={`qrt-square ${tone}${disabled ? ' off' : ''}`} data-testid="qrt-square">
            <rect
              className="qrt-square-box"
              x={square.x}
              y={square.y}
              width={square.size}
              height={square.size}
              tabIndex={disabled ? -1 : 0}
              role="application"
              aria-label={t('web.qrt_square_label')}
              aria-roledescription={t('web.qrt_square_role')}
              aria-describedby="qrt-stage-hint"
              onPointerDown={(event) => begin(event, 'move')}
              onKeyDown={onKey}
            />
            {!disabled && (
              <rect
                className="qrt-square-handle"
                data-testid="qrt-handle"
                x={square.x + square.size - handle}
                y={square.y + square.size - handle}
                width={handle}
                height={handle}
                aria-label={t('web.qrt_handle_label')}
                onPointerDown={(event) => begin(event, 'resize')}
              />
            )}
          </g>
        )}
      </svg>
      <p id="qrt-stage-hint" className="muted small">
        {t('web.qrt_stage_hint')}
      </p>
    </div>
  );
}
