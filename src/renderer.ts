// Canvas renderer for a libghostty-vt frame snapshot.
//
// libghostty resolves colors, styles, selection ranges and grapheme clusters,
// so this file is only concerned with turning a FrameSnapshot into pixels:
// measure a cell, paint dirty rows, draw the cursor.

import type { CellSnapshot, CursorSnapshot, FrameSnapshot, RowSnapshot, Rgb } from "./vt/terminal";
import { rgbToCss } from "./theme";

export interface RendererOptions {
  fontSize: number;
  fontFamily: string;
  /** Multiplier on the measured line height. */
  lineHeight?: number;
  cursorBlink?: boolean;
  selectionBackground?: string;
}

export interface CellMetrics {
  width: number;
  height: number;
  baseline: number;
}

/** Blink half-period, matching the usual terminal cadence. */
const CURSOR_BLINK_MS = 530;

export class CanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private metrics: CellMetrics = { width: 8, height: 16, baseline: 12 };
  private dpr = 1;
  private cols = 0;
  private rows = 0;

  /** Last frame drawn, kept so a blink tick or resize can repaint. */
  private lastFrame: FrameSnapshot | null = null;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private blinkOn = true;
  private focused = true;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private options: RendererOptions,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("could not acquire a 2d canvas context");
    this.ctx = ctx;
    this.remeasure();
    this.setCursorBlink(options.cursorBlink ?? true);
  }

  // ---- configuration ---------------------------------------------------

  setOptions(options: Partial<RendererOptions>): void {
    const fontChanged =
      (options.fontSize !== undefined && options.fontSize !== this.options.fontSize) ||
      (options.fontFamily !== undefined && options.fontFamily !== this.options.fontFamily) ||
      (options.lineHeight !== undefined && options.lineHeight !== this.options.lineHeight);

    this.options = { ...this.options, ...options };
    if (options.cursorBlink !== undefined) this.setCursorBlink(options.cursorBlink);
    if (fontChanged) {
      this.remeasure();
      this.repaint();
    }
  }

  get cellMetrics(): CellMetrics {
    return this.metrics;
  }

  /**
   * Measure the cell box for the current font.
   *
   * Width comes from a wide run of a fixed-advance character rather than a
   * single one, so rounding error does not accumulate across a long row.
   */
  private remeasure(): void {
    const { fontSize, fontFamily, lineHeight = 1.2 } = this.options;
    this.ctx.font = `${fontSize}px ${fontFamily}`;

    const sample = "W".repeat(32);
    const measured = this.ctx.measureText(sample);
    const width = measured.width / sample.length;

    const ascent = measured.actualBoundingBoxAscent || fontSize * 0.8;
    const descent = measured.actualBoundingBoxDescent || fontSize * 0.2;
    const height = Math.ceil((ascent + descent) * lineHeight);

    this.metrics = {
      width: width > 0 ? width : fontSize * 0.6,
      height: height > 0 ? height : Math.ceil(fontSize * 1.2),
      baseline: Math.round((height + ascent - descent) / 2),
    };
  }

  /** How many whole cells fit in a container of this pixel size. */
  proposeDimensions(pixelWidth: number, pixelHeight: number): { cols: number; rows: number } {
    return {
      cols: Math.max(1, Math.floor(pixelWidth / this.metrics.width)),
      rows: Math.max(1, Math.floor(pixelHeight / this.metrics.height)),
    };
  }

  /**
   * Resize the backing store to `cols`×`rows` at the current device pixel
   * ratio. Returns true when anything actually changed.
   */
  resize(cols: number, rows: number): boolean {
    const dpr = globalThis.devicePixelRatio || 1;
    if (cols === this.cols && rows === this.rows && dpr === this.dpr) return false;

    this.cols = cols;
    this.rows = rows;
    this.dpr = dpr;

    const cssWidth = Math.ceil(cols * this.metrics.width);
    const cssHeight = Math.ceil(rows * this.metrics.height);
    this.canvas.width = Math.ceil(cssWidth * dpr);
    this.canvas.height = Math.ceil(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // A resize resets the context state, so the transform and font go back on.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.textBaseline = "alphabetic";
    return true;
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.blinkOn = true;
    this.repaintCursor();
  }

  private setCursorBlink(enabled: boolean): void {
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    this.blinkOn = true;
    if (!enabled) return;
    this.blinkTimer = setInterval(() => {
      this.blinkOn = !this.blinkOn;
      this.repaintCursor();
    }, CURSOR_BLINK_MS);
  }

  // ---- drawing ---------------------------------------------------------

  /** Draw a frame. Only the rows the snapshot carries are repainted. */
  render(frame: FrameSnapshot): void {
    this.lastFrame = frame;
    const { width, height } = this.metrics;

    if (frame.dirty === "full") {
      this.ctx.fillStyle = rgbToCss(frame.background);
      this.ctx.fillRect(0, 0, this.cols * width, this.rows * height);
    }

    for (const row of frame.dirtyRows) {
      this.drawRow(row, frame);
    }

    this.drawCursor(frame);
  }

  /** Redraw the last frame in full, e.g. after a font or theme change. */
  repaint(): void {
    if (!this.lastFrame) return;
    this.render({ ...this.lastFrame, dirty: "full" });
  }

  /**
   * Repaint just the cursor's row, for a blink tick.
   *
   * Cheaper than a full repaint and avoids the flicker of clearing the whole
   * canvas twice a second.
   */
  private repaintCursor(): void {
    const frame = this.lastFrame;
    if (!frame || !frame.cursor.onScreen) return;
    const row = frame.dirtyRows.find((r) => r.y === frame.cursor.y);
    if (row) {
      this.drawRow(row, frame);
    } else {
      const { width, height } = this.metrics;
      this.ctx.fillStyle = rgbToCss(frame.background);
      this.ctx.fillRect(0, frame.cursor.y * height, this.cols * width, height);
    }
    this.drawCursor(frame);
  }

  private drawRow(row: RowSnapshot, frame: FrameSnapshot): void {
    const { width, height, baseline } = this.metrics;
    const ctx = this.ctx;
    const top = row.y * height;

    // Clear the row: on a partial frame nothing else has cleared it.
    ctx.fillStyle = rgbToCss(frame.background);
    ctx.fillRect(0, top, this.cols * width, height);

    // Backgrounds first, coalesced into runs of the same color so a solid
    // band costs one fillRect rather than one per column. Cells are sparse —
    // a snapshot omits blank unstyled cells — so a gap in x ends a run too.
    let runStart = -1;
    let runEnd = -1;
    let runColor = "";
    const flushRun = () => {
      if (runStart < 0) return;
      ctx.fillStyle = runColor;
      ctx.fillRect(runStart * width, top, (runEnd - runStart + 1) * width, height);
      runStart = -1;
    };
    for (const cell of row.cells) {
      const bg = this.backgroundOf(cell, frame);
      if (bg === null) {
        flushRun();
        continue;
      }
      const css = rgbToCss(bg);
      if (runStart >= 0 && css === runColor && cell.x === runEnd + 1) {
        runEnd = cell.x;
        continue;
      }
      flushRun();
      runStart = cell.x;
      runEnd = cell.x;
      runColor = css;
    }
    flushRun();

    // Selection tint over the backgrounds, under the text.
    if (row.selection && this.options.selectionBackground) {
      const { startX, endX } = row.selection;
      ctx.fillStyle = this.options.selectionBackground;
      ctx.fillRect(startX * width, top, (endX - startX + 1) * width, height);
    }

    // Glyphs.
    for (const cell of row.cells) {
      if (cell.text === "" || cell.invisible) continue;

      const fg = this.foregroundOf(cell, frame);
      ctx.fillStyle = rgbToCss(fg);
      ctx.globalAlpha = cell.faint ? 0.6 : 1;
      ctx.font = this.fontFor(cell);
      ctx.fillText(cell.text, cell.x * width, top + baseline);
      ctx.globalAlpha = 1;

      if (cell.underline !== 0) this.drawUnderline(cell, fg, top);
      if (cell.strikethrough) {
        ctx.fillStyle = rgbToCss(fg);
        ctx.fillRect(cell.x * width, top + Math.round(height * 0.55), width, 1);
      }
      if (cell.overline) {
        ctx.fillStyle = rgbToCss(fg);
        ctx.fillRect(cell.x * width, top, width, 1);
      }
    }
  }

  private drawUnderline(cell: CellSnapshot, fg: Rgb, top: number): void {
    const ctx = this.ctx;
    const { width, height } = this.metrics;
    const y = top + height - 2;
    ctx.fillStyle = rgbToCss(cell.underlineColor ?? fg);

    switch (cell.underline) {
      case 2: // double
        ctx.fillRect(cell.x * width, y - 2, width, 1);
        ctx.fillRect(cell.x * width, y, width, 1);
        break;
      case 3: { // curly
        ctx.strokeStyle = rgbToCss(cell.underlineColor ?? fg);
        ctx.lineWidth = 1;
        ctx.beginPath();
        const amplitude = 1.5;
        for (let i = 0; i <= width; i++) {
          const px = cell.x * width + i;
          const py = y - amplitude * Math.sin((i / width) * Math.PI * 2);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        break;
      }
      case 4: // dotted
      case 5: // dashed
        for (let i = 0; i < width; i += cell.underline === 4 ? 2 : 4) {
          ctx.fillRect(cell.x * width + i, y, cell.underline === 4 ? 1 : 2, 1);
        }
        break;
      default: // single
        ctx.fillRect(cell.x * width, y, width, 1);
    }
  }

  private drawCursor(frame: FrameSnapshot): void {
    const cursor = frame.cursor;
    if (!cursor.onScreen || !cursor.visible) return;
    if (cursor.blinking && !this.blinkOn && this.focused) return;

    const { width, height } = this.metrics;
    const ctx = this.ctx;
    const x = cursor.x * width;
    const y = cursor.y * height;
    const color = frame.cursorColor ?? frame.foreground;
    ctx.fillStyle = rgbToCss(color);

    // An unfocused terminal shows a hollow box whatever the requested shape,
    // which is the convention every terminal follows.
    const shape: CursorSnapshot["shape"] = this.focused ? cursor.shape : "block_hollow";
    switch (shape) {
      case "bar":
        ctx.fillRect(x, y, 2, height);
        break;
      case "underline":
        ctx.fillRect(x, y + height - 2, width, 2);
        break;
      case "block_hollow":
        ctx.strokeStyle = rgbToCss(color);
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
        break;
      default: {
        ctx.fillRect(x, y, width, height);
        // Repaint the covered glyph in the background color so it stays legible.
        const cell = frame.dirtyRows
          .find((r) => r.y === cursor.y)
          ?.cells.find((c) => c.x === cursor.x);
        if (cell?.text) {
          ctx.fillStyle = rgbToCss(frame.background);
          ctx.font = this.fontFor(cell);
          ctx.fillText(cell.text, x, y + this.metrics.baseline);
        }
      }
    }
  }

  private fontFor(cell: CellSnapshot): string {
    const { fontSize, fontFamily } = this.options;
    const style = cell.italic ? "italic " : "";
    const weight = cell.bold ? "bold " : "";
    return `${style}${weight}${fontSize}px ${fontFamily}`;
  }

  private foregroundOf(cell: CellSnapshot, frame: FrameSnapshot): Rgb {
    const fg = cell.fg ?? frame.foreground;
    const bg = cell.bg ?? frame.background;
    return cell.inverse ? bg : fg;
  }

  private backgroundOf(cell: CellSnapshot, frame: FrameSnapshot): Rgb | null {
    if (cell.inverse) return cell.fg ?? frame.foreground;
    return cell.bg;
  }

  dispose(): void {
    if (this.blinkTimer) clearInterval(this.blinkTimer);
    this.blinkTimer = null;
    this.lastFrame = null;
  }
}
