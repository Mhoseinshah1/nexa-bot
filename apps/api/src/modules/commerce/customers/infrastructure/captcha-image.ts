import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import type { CaptchaImageRenderer } from '../application/start-captcha-ports.js';

/**
 * The `IMAGE_NUMBER` captcha's picture, drawn in pure JavaScript: our own stroke font and
 * rasteriser into an RGBA buffer, encoded by `pngjs` (no native module: production is
 * aarch64). Nothing here touches the disk or the network, and the same `(digits, seed)`
 * always draws the same bytes, so the picture a customer sees can be drawn again from the
 * stored answer and the question's id and is never itself stored.
 *
 * Made hard for OCR and easy for a person: every digit rotated up to ±20° and varied in size
 * and offset, each in its own dark colour, three curved lines and a scatter of light dots
 * drawn OVER the digits, on a soft two-colour diagonal background.
 */
export const CAPTCHA_IMAGE_WIDTH = 320;
export const CAPTCHA_IMAGE_HEIGHT = 120;

type Point = readonly [number, number];
type Rgb = readonly [number, number, number];

/** A small, fast, seedable generator (mulberry32). Not for secrets: the answer is chosen elsewhere. */
function seededRandom(seed: string): () => number {
  const digest = createHash('sha256').update(seed).digest();
  let state = digest.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points on an ellipse arc, angles in degrees, y pointing down (270° is the top). */
function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Point[] {
  const steps = Math.max(8, Math.ceil(Math.abs(to - from) / 12));
  const points: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    points.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
  }
  return points;
}

const SIX: Point[][] = [
  [
    [0.5, 0.0],
    [0.34, 0.1],
    [0.18, 0.28],
    [0.07, 0.5],
    [0.03, 0.7],
  ],
  arc(0.3, 0.72, 0.27, 0.28, 0, 360),
];

/**
 * The digits as strokes in a box 0.6 wide and 1 tall (y down). Each digit is a list of
 * polylines. Plain shapes a person reads at a glance; nothing a font file ships.
 */
const DIGIT_STROKES: Record<string, Point[][]> = {
  '0': [arc(0.3, 0.5, 0.27, 0.5, 0, 360)],
  '1': [
    [
      [0.08, 0.24],
      [0.32, 0.0],
      [0.32, 1.0],
    ],
  ],
  '2': [[...arc(0.3, 0.27, 0.26, 0.27, 190, 400), [0.03, 1.0], [0.58, 1.0]]],
  '3': [arc(0.3, 0.26, 0.25, 0.26, 200, 450), arc(0.3, 0.75, 0.29, 0.25, 270, 520)],
  '4': [
    [
      [0.45, 1.0],
      [0.45, 0.0],
      [0.0, 0.68],
      [0.6, 0.68],
    ],
  ],
  '5': [[[0.54, 0.0], [0.1, 0.0], [0.07, 0.46], ...arc(0.3, 0.72, 0.28, 0.28, 235, 485)]],
  '6': SIX,
  '7': [
    [
      [0.02, 0.02],
      [0.58, 0.02],
      [0.22, 1.0],
    ],
  ],
  '8': [arc(0.3, 0.26, 0.24, 0.24, 0, 360), arc(0.3, 0.74, 0.28, 0.26, 0, 360)],
  // A nine is a six turned half a circle about the middle of its box.
  '9': SIX.map((line) => line.map(([x, y]): Point => [0.6 - x, 1 - y])),
};

const BACKGROUNDS: readonly (readonly [Rgb, Rgb])[] = [
  [
    [232, 240, 250],
    [250, 236, 226],
  ],
  [
    [236, 247, 238],
    [244, 238, 250],
  ],
  [
    [250, 244, 226],
    [226, 240, 248],
  ],
  [
    [244, 232, 240],
    [228, 246, 242],
  ],
];

/** Draws onto an RGBA buffer by coverage: a stroke is a thick segment with round caps. */
class Canvas {
  readonly data: Buffer;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = Buffer.alloc(width * height * 4);
  }

  fillGradient(from: Rgb, to: Rgb): void {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const t = (x / this.width + y / this.height) / 2;
        const at = (y * this.width + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          this.data[at + c] = Math.round((from[c] as number) * (1 - t) + (to[c] as number) * t);
        }
        this.data[at + 3] = 255;
      }
    }
  }

  private blend(x: number, y: number, color: Rgb, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || alpha <= 0) return;
    const at = (y * this.width + x) * 4;
    for (let c = 0; c < 3; c += 1) {
      const below = this.data[at + c] as number;
      this.data[at + c] = Math.round(below + ((color[c] as number) - below) * alpha);
    }
  }

  segment(a: Point, b: Point, halfWidth: number, color: Rgb, opacity: number): void {
    const reach = halfWidth + 1;
    const x0 = Math.floor(Math.min(a[0], b[0]) - reach);
    const x1 = Math.ceil(Math.max(a[0], b[0]) + reach);
    const y0 = Math.floor(Math.min(a[1], b[1]) - reach);
    const y1 = Math.ceil(Math.max(a[1], b[1]) + reach);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const px = x + 0.5 - a[0];
        const py = y + 0.5 - a[1];
        const t =
          lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared));
        const distance = Math.hypot(px - t * dx, py - t * dy);
        const coverage = Math.max(0, Math.min(1, halfWidth + 0.5 - distance));
        this.blend(x, y, color, coverage * opacity);
      }
    }
  }

  polyline(points: readonly Point[], halfWidth: number, color: Rgb, opacity: number): void {
    for (let i = 1; i < points.length; i += 1) {
      this.segment(points[i - 1] as Point, points[i] as Point, halfWidth, color, opacity);
    }
  }
}

/** A cubic Bézier, sampled. */
function bezier(p0: Point, p1: Point, p2: Point, p3: Point, steps: number): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    points.push([
      w[0]! * p0[0] + w[1]! * p1[0] + w[2]! * p2[0] + w[3]! * p3[0],
      w[0]! * p0[1] + w[1]! * p1[1] + w[2]! * p2[1] + w[3]! * p3[1],
    ]);
  }
  return points;
}

/**
 * Draws `digits` (the characters 0-9) as a PNG of `CAPTCHA_IMAGE_WIDTH` x
 * `CAPTCHA_IMAGE_HEIGHT`. Pure over its arguments.
 */
export function renderCaptchaPng(digits: string, seed: string): Uint8Array {
  const random = seededRandom(seed);
  const between = (low: number, high: number): number => low + random() * (high - low);
  const canvas = new Canvas(CAPTCHA_IMAGE_WIDTH, CAPTCHA_IMAGE_HEIGHT);
  const [from, to] = BACKGROUNDS[Math.floor(random() * BACKGROUNDS.length)] as readonly [Rgb, Rgb];
  canvas.fillGradient(random() < 0.5 ? from : to, random() < 0.5 ? to : from);

  const cell = CAPTCHA_IMAGE_WIDTH / (digits.length + 0.4);
  [...digits].forEach((digit, index) => {
    const strokes = DIGIT_STROKES[digit];
    if (strokes === undefined) return;
    const height = between(58, 76);
    const scale = height;
    const angle = (between(-20, 20) * Math.PI) / 180;
    const centreX = cell * (index + 0.7) + between(-7, 7);
    const centreY = CAPTCHA_IMAGE_HEIGHT / 2 + between(-11, 11);
    const color: Rgb = [
      Math.round(between(15, 105)),
      Math.round(between(15, 105)),
      Math.round(between(15, 105)),
    ];
    const halfWidth = height * between(0.05, 0.065);
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    for (const line of strokes) {
      const placed = line.map(([x, y]): Point => {
        const lx = (x - 0.3) * scale;
        const ly = (y - 0.5) * scale;
        return [centreX + lx * cos - ly * sin, centreY + lx * sin + ly * cos];
      });
      canvas.polyline(placed, halfWidth, color, 1);
    }
  });

  // Curved lines across the digits, drawn over them.
  const lines = 2 + Math.floor(random() * 2);
  for (let i = 0; i < lines; i += 1) {
    const side = (): number => between(8, CAPTCHA_IMAGE_HEIGHT - 8);
    const curve = bezier(
      [between(-5, 15), side()],
      [between(70, 130), between(-30, 150)],
      [between(190, 250), between(-30, 150)],
      [between(305, 325), side()],
      48,
    );
    const color: Rgb = [
      Math.round(between(30, 120)),
      Math.round(between(30, 120)),
      Math.round(between(30, 120)),
    ];
    canvas.polyline(curve, between(0.8, 1.25), color, 0.85);
  }

  // A light scatter of dots.
  for (let i = 0; i < 170; i += 1) {
    const shade = Math.round(between(120, 215));
    const x = between(0, CAPTCHA_IMAGE_WIDTH);
    const y = between(0, CAPTCHA_IMAGE_HEIGHT);
    canvas.segment(
      [x, y],
      [x + between(-1.5, 1.5), y + between(-1.5, 1.5)],
      0.6,
      [shade, shade, shade],
      0.6,
    );
  }

  const png = new PNG({ width: CAPTCHA_IMAGE_WIDTH, height: CAPTCHA_IMAGE_HEIGHT });
  canvas.data.copy(png.data);
  return new Uint8Array(PNG.sync.write(png));
}

/** The port's implementation. */
export const PNG_CAPTCHA_IMAGE_RENDERER: CaptchaImageRenderer = { render: renderCaptchaPng };
