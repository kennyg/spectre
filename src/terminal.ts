// The DOM-facing terminal: a canvas, the event listeners that feed it, and
// the frame loop between libghostty-vt and the renderer.
//
// Everything terminal-semantic (key encoding, selection, paste bracketing,
// colors) lives in libghostty. This file is glue: DOM events in, bytes out.

import type { GhosttyModule } from "./vt/wasm";
import {
  VtTerminal,
  KEY_ACTION_PRESS,
  KEY_ACTION_RELEASE,
  KEY_ACTION_REPEAT,
  MOUSE_ACTION_MOTION,
  MOUSE_ACTION_PRESS,
  MOUSE_ACTION_RELEASE,
  modsFromEvent,
} from "./vt/terminal";
import { CanvasRenderer } from "./renderer";
import { buildPalette, parseColor, type ITheme } from "./theme";

export interface Disposable {
  dispose(): void;
}

export interface TerminalOptions {
  ghostty: GhosttyModule;
  fontSize?: number;
  fontFamily?: string;
  cursorBlink?: boolean;
  scrollback?: number;
  theme?: ITheme;
}

/** GhosttyMouseButton values for the buttons a browser reports. */
const MOUSE_BUTTONS: Record<number, number> = { 0: 1 /* left */, 1: 3 /* middle */, 2: 2 /* right */ };
/** Wheel up/down are reported as buttons four and five. */
const MOUSE_WHEEL_UP = 4;
const MOUSE_WHEEL_DOWN = 5;

/** Rows scrolled per wheel notch when the application is not tracking. */
const WHEEL_SCROLL_ROWS = 3;

class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  on(listener: (value: T) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }

  clear(): void {
    this.listeners.clear();
  }
}

export class Terminal {
  private readonly vt: VtTerminal;
  private readonly options: Required<Omit<TerminalOptions, "ghostty" | "theme">> & { theme?: ITheme };

  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private renderer: CanvasRenderer | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private readonly dataEmitter = new Emitter<Uint8Array>();
  private readonly resizeEmitter = new Emitter<{ cols: number; rows: number }>();
  private readonly titleEmitter = new Emitter<string>();
  private readonly bellEmitter = new Emitter<void>();

  private frameHandle: number | null = null;
  private pendingFullRedraw = false;
  private disposed = false;

  private cols = 80;
  private rows = 24;

  /** Anchor cell of an in-progress selection drag, if any. */
  private dragAnchor: { x: number; y: number } | null = null;
  private customKeyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  private composing = false;
  /** code -> unshifted character for the active layout, when the browser exposes it. */
  private layout: { get(code: string): string | undefined } | null = null;
  private readonly teardown: (() => void)[] = [];

  constructor(options: TerminalOptions) {
    this.options = {
      fontSize: options.fontSize ?? 14,
      fontFamily: options.fontFamily ?? 'Menlo, Monaco, "Courier New", monospace',
      cursorBlink: options.cursorBlink ?? true,
      scrollback: options.scrollback ?? 10000,
      theme: options.theme,
    };

    this.vt = new VtTerminal(
      options.ghostty,
      { cols: this.cols, rows: this.rows, scrollback: this.options.scrollback },
      {
        onWritePty: (data) => this.dataEmitter.fire(data),
        onTitleChange: (title) => this.titleEmitter.fire(title),
        onBell: () => this.bellEmitter.fire(),
      },
    );

    if (this.options.theme) this.setTheme(this.options.theme);
  }

  // ---- lifecycle -------------------------------------------------------

  open(container: HTMLElement): void {
    if (this.canvas) throw new Error("terminal is already open");

    this.container = container;
    const canvas = container.ownerDocument.createElement("canvas");
    canvas.className = "spectre-terminal-canvas";
    // A canvas is not focusable by default, and this terminal must take keys.
    canvas.tabIndex = 0;
    canvas.style.outline = "none";
    container.appendChild(canvas);
    this.canvas = canvas;

    this.renderer = new CanvasRenderer(canvas, {
      fontSize: this.options.fontSize,
      fontFamily: this.options.fontFamily,
      cursorBlink: this.options.cursorBlink,
      selectionBackground: this.options.theme?.selectionBackground,
    });

    this.attachListeners(canvas);
    this.loadKeyboardLayout();
    this.fit();
    this.scheduleFrame(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;

    for (const off of this.teardown) off();
    this.teardown.length = 0;

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.dataEmitter.clear();
    this.resizeEmitter.clear();
    this.titleEmitter.clear();
    this.bellEmitter.clear();

    this.renderer?.dispose();
    this.renderer = null;
    this.canvas?.remove();
    this.canvas = null;
    this.container = null;

    this.vt.dispose();
  }

  // ---- data flow -------------------------------------------------------

  /** Feed pty output into the terminal. */
  write(data: string | Uint8Array): void {
    this.vt.write(data);
    this.scheduleFrame();
  }

  /** Bytes the terminal wants written to the pty: keystrokes and query replies. */
  onData(listener: (data: Uint8Array) => void): Disposable {
    return this.dataEmitter.on(listener);
  }

  onResize(listener: (size: { cols: number; rows: number }) => void): Disposable {
    return this.resizeEmitter.on(listener);
  }

  onTitleChange(listener: (title: string) => void): Disposable {
    return this.titleEmitter.on(listener);
  }

  onBell(listener: () => void): Disposable {
    return this.bellEmitter.on(listener);
  }

  private send(bytes: Uint8Array): void {
    if (bytes.length > 0) this.dataEmitter.fire(bytes);
  }

  // ---- sizing ----------------------------------------------------------

  get dimensions(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  /** Resize the grid to fill the container, and tell the pty about it. */
  fit(): void {
    if (!this.container || !this.renderer) return;

    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const { cols, rows } = this.renderer.proposeDimensions(rect.width, rect.height);
    if (cols === this.cols && rows === this.rows) {
      // Still let the renderer react to a device-pixel-ratio change.
      if (this.renderer.resize(cols, rows)) this.scheduleFrame(true);
      return;
    }

    this.cols = cols;
    this.rows = rows;
    const { width, height } = this.renderer.cellMetrics;
    this.vt.resize(cols, rows, Math.round(width), Math.round(height));
    this.renderer.resize(cols, rows);
    this.resizeEmitter.fire({ cols, rows });
    this.scheduleFrame(true);
  }

  /** Refit whenever the container changes size. */
  observeResize(): void {
    if (!this.container || this.resizeObserver) return;
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.container);
  }

  // ---- appearance ------------------------------------------------------

  setTheme(theme: ITheme): void {
    this.options.theme = theme;
    const fallback = { r: 0, g: 0, b: 0 };
    this.vt.setTheme({
      background: parseColor(theme.background) ?? { r: 0x1e, g: 0x1e, b: 0x1e },
      foreground: parseColor(theme.foreground) ?? { r: 0xd4, g: 0xd4, b: 0xd4 },
      cursor: parseColor(theme.cursor),
      palette: buildPalette(theme, fallback),
    });
    this.renderer?.setOptions({ selectionBackground: theme.selectionBackground });
    this.scheduleFrame(true);
  }

  setFont(fontSize: number, fontFamily?: string): void {
    this.options.fontSize = fontSize;
    if (fontFamily) this.options.fontFamily = fontFamily;
    this.renderer?.setOptions({ fontSize, fontFamily: this.options.fontFamily });
    this.fit();
  }

  focus(): void {
    this.canvas?.focus();
  }

  /**
   * Intercept key events before the terminal encodes them.
   *
   * Returning true means the handler consumed the event and the terminal
   * should not encode it — matching the convention the previous renderer
   * used, so existing callers keep working.
   */
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.customKeyHandler = handler;
  }

  // ---- rendering -------------------------------------------------------

  private scheduleFrame(full = false): void {
    if (this.disposed || !this.renderer) return;
    if (full) this.pendingFullRedraw = true;
    if (this.frameHandle !== null) return;

    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = null;
      this.drawFrame();
    });
  }

  private drawFrame(): void {
    if (!this.renderer) return;
    const full = this.pendingFullRedraw;
    this.pendingFullRedraw = false;

    const frame = this.vt.snapshot(full);
    if (!frame) return;
    this.renderer.render(frame);
    this.vt.markClean();
  }

  // ---- input -----------------------------------------------------------

  private attachListeners(canvas: HTMLCanvasElement): void {
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      canvas.addEventListener(type, handler as EventListener, options);
      this.teardown.push(() => canvas.removeEventListener(type, handler as EventListener));
    };

    on("keydown", (event) => this.handleKeyDown(event));
    on("keyup", (event) => this.handleKeyUp(event));
    on("paste", (event) => this.handlePaste(event));
    on("copy", (event) => this.handleCopy(event));
    on("mousedown", (event) => this.handleMouseDown(event));
    on("mousemove", (event) => this.handleMouseMove(event));
    on("mouseup", (event) => this.handleMouseUp(event));
    on("wheel", (event) => this.handleWheel(event), { passive: false });
    on("contextmenu", (event) => event.preventDefault());
    on("focus", () => this.renderer?.setFocused(true));
    on("blur", () => this.renderer?.setFocused(false));

    // IME: suppress key encoding while a composition is in flight, then send
    // the composed text as one unit.
    on("compositionstart", () => {
      this.composing = true;
    });
    on("compositionend", (event) => {
      this.composing = false;
      const text = (event as CompositionEvent).data;
      if (text) this.send(new TextEncoder().encode(text));
    });
  }

  /**
   * Cache the keyboard layout map, which is what makes the unshifted codepoint
   * below correct on non-US layouts. Chromium-only, and Obsidian is Chromium;
   * elsewhere the fallback in unshiftedCodepoint() takes over.
   */
  private loadKeyboardLayout(): void {
    const keyboard = (navigator as unknown as {
      keyboard?: {
        getLayoutMap?(): Promise<{ get(code: string): string | undefined }>;
        addEventListener?(type: string, listener: () => void): void;
      };
    }).keyboard;
    if (!keyboard?.getLayoutMap) return;

    const refresh = () => {
      keyboard.getLayoutMap!()
        .then((map) => {
          this.layout = map;
        })
        .catch(() => {
          // A browser that refuses the map is no worse than one without it.
        });
    };
    refresh();
    keyboard.addEventListener?.("layoutchange", refresh);
  }

  /**
   * The codepoint the key would produce with no modifiers held.
   *
   * The Kitty keyboard protocol reports this as the key identity, and
   * libghostty encodes **nothing at all** without it once an application
   * enables the protocol — Ctrl+C would silently do nothing. `event.key`
   * cannot supply it while Shift is down, hence the layout map.
   */
  private unshiftedCodepoint(event: KeyboardEvent): number {
    const mapped = event.code ? this.layout?.get(event.code) : undefined;
    if (mapped && [...mapped].length === 1) return mapped.codePointAt(0) ?? 0;

    // Without Shift, event.key already is the unshifted character.
    if (!event.shiftKey && event.key.length === 1) return event.key.codePointAt(0) ?? 0;

    const letter = /^Key([A-Z])$/.exec(event.code);
    if (letter) return letter[1].toLowerCase().codePointAt(0) ?? 0;
    const digit = /^Digit([0-9])$/.exec(event.code);
    if (digit) return digit[1].codePointAt(0) ?? 0;
    return 0;
  }

  /**
   * Encode a key release.
   *
   * libghostty returns nothing unless the application turned on Kitty's
   * report-events flag, so this is inert for ordinary programs and correct
   * for the ones that asked.
   */
  private handleKeyUp(event: KeyboardEvent): void {
    if (this.composing || event.isComposing) return;
    const bytes = this.vt.encodeKey({
      code: event.code,
      action: KEY_ACTION_RELEASE,
      mods: modsFromEvent(event),
      text: event.key.length === 1 ? event.key : "",
      unshiftedCodepoint: this.unshiftedCodepoint(event),
    });
    if (bytes.length === 0) return;
    event.preventDefault();
    this.send(bytes);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (this.customKeyHandler?.(event)) return;
    if (this.composing || event.isComposing) return;

    // Let the platform clipboard shortcut reach the copy/paste handlers.
    const accel = event.metaKey || event.ctrlKey;
    if (accel && !event.altKey && (event.key === "c" || event.key === "v")) {
      if (event.key === "v") return;
      if (event.key === "c" && this.vt.hasSelection()) return;
    }

    // event.key holds the character for printable keys; anything longer is a
    // named key ("ArrowUp", "Enter") whose bytes libghostty derives itself.
    const text = event.key.length === 1 ? event.key : "";
    const bytes = this.vt.encodeKey({
      code: event.code,
      action: event.repeat ? KEY_ACTION_REPEAT : KEY_ACTION_PRESS,
      mods: modsFromEvent(event),
      text,
      unshiftedCodepoint: this.unshiftedCodepoint(event),
    });

    if (bytes.length === 0) return;
    event.preventDefault();
    // Typing should always snap the view back to the prompt.
    this.vt.scrollToBottom();
    this.send(bytes);
    this.scheduleFrame();
  }

  private handlePaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    this.vt.scrollToBottom();
    this.send(this.vt.encodePaste(text));
    this.scheduleFrame();
  }

  private handleCopy(event: ClipboardEvent): void {
    const text = this.vt.selectionText();
    if (!text) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
  }

  // ---- mouse -----------------------------------------------------------

  /** Which cell a pointer event landed on, clamped to the grid. */
  private cellAt(event: MouseEvent): { x: number; y: number } {
    const canvas = this.canvas!;
    const metrics = this.renderer!.cellMetrics;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / metrics.width);
    const y = Math.floor((event.clientY - rect.top) / metrics.height);
    return {
      x: Math.max(0, Math.min(this.cols - 1, x)),
      y: Math.max(0, Math.min(this.rows - 1, y)),
    };
  }

  /**
   * Whether this event should go to the running program rather than drive a
   * selection. Shift is the universal override for "let me select anyway".
   */
  private forwardsMouse(event: MouseEvent): boolean {
    return this.vt.mouseTrackingEnabled() && !event.shiftKey;
  }

  private mouseGeometry(event: MouseEvent) {
    const metrics = this.renderer!.cellMetrics;
    const rect = this.canvas!.getBoundingClientRect();
    return {
      mods: modsFromEvent(event),
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      cellWidth: Math.round(metrics.width),
      cellHeight: Math.round(metrics.height),
      screenWidth: Math.round(rect.width),
      screenHeight: Math.round(rect.height),
    };
  }

  private handleMouseDown(event: MouseEvent): void {
    if (!this.canvas || !this.renderer) return;
    this.canvas.focus();

    if (this.forwardsMouse(event)) {
      this.send(this.vt.encodeMouse({
        action: MOUSE_ACTION_PRESS,
        button: MOUSE_BUTTONS[event.button] ?? null,
        anyButtonPressed: true,
        ...this.mouseGeometry(event),
      }));
      return;
    }

    if (event.button !== 0) return;
    event.preventDefault();
    this.dragAnchor = this.cellAt(event);
    this.vt.clearSelection();
    this.scheduleFrame(true);
  }

  private handleMouseMove(event: MouseEvent): void {
    if (!this.canvas || !this.renderer) return;

    if (this.forwardsMouse(event)) {
      this.send(this.vt.encodeMouse({
        action: MOUSE_ACTION_MOTION,
        button: event.buttons === 0 ? null : MOUSE_BUTTONS[event.button] ?? 1,
        anyButtonPressed: event.buttons !== 0,
        ...this.mouseGeometry(event),
      }));
      return;
    }

    if (!this.dragAnchor) return;
    const head = this.cellAt(event);
    this.vt.selectCells(this.dragAnchor, head, event.altKey);
    this.scheduleFrame(true);
  }

  private handleMouseUp(event: MouseEvent): void {
    if (!this.canvas || !this.renderer) return;

    if (this.forwardsMouse(event)) {
      this.send(this.vt.encodeMouse({
        action: MOUSE_ACTION_RELEASE,
        button: MOUSE_BUTTONS[event.button] ?? null,
        anyButtonPressed: false,
        ...this.mouseGeometry(event),
      }));
      return;
    }

    this.dragAnchor = null;
  }

  private handleWheel(event: WheelEvent): void {
    if (!this.canvas || !this.renderer) return;

    if (this.forwardsMouse(event)) {
      event.preventDefault();
      this.send(this.vt.encodeMouse({
        action: MOUSE_ACTION_PRESS,
        button: event.deltaY < 0 ? MOUSE_WHEEL_UP : MOUSE_WHEEL_DOWN,
        anyButtonPressed: false,
        ...this.mouseGeometry(event),
      }));
      return;
    }

    event.preventDefault();
    const direction = event.deltaY < 0 ? -1 : 1;
    // deltaMode 1 is lines, 0 is pixels; normalise both to rows.
    const magnitude =
      event.deltaMode === 1
        ? Math.max(1, Math.abs(event.deltaY))
        : Math.max(1, Math.round(Math.abs(event.deltaY) / this.renderer.cellMetrics.height));
    this.vt.scrollBy(direction * Math.min(magnitude, WHEEL_SCROLL_ROWS * 4));
    this.scheduleFrame(true);
  }
}
