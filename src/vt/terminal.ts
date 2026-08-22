// A terminal instance backed by libghostty-vt.
//
// This owns the VT state machine, the render snapshot, and the key/mouse
// encoders. It knows nothing about the DOM — everything it produces is bytes
// or plain data, which makes the whole layer testable under plain Node.

import { GhosttyModule, check, GHOSTTY_SUCCESS, GHOSTTY_NO_VALUE } from "./wasm";
import { keyForCode } from "./keys";

/** GhosttyTerminalOption values we set. */
const OPT_USERDATA = 0;
const OPT_WRITE_PTY = 1;
const OPT_BELL = 2;
const OPT_TITLE_CHANGED = 5;
const OPT_COLOR_FOREGROUND = 11;
const OPT_COLOR_BACKGROUND = 12;
const OPT_COLOR_CURSOR = 13;
const OPT_COLOR_PALETTE = 14;
const OPT_SELECTION = 21;
const OPT_SCROLLBACK_MAX_LINES = 28;

/** GhosttyTerminalData values we read. */
const DATA_COLS = 1;
const DATA_ROWS = 2;
const DATA_MOUSE_TRACKING = 11;
const DATA_TITLE = 12;
const DATA_SELECTION = 31;
const DATA_VIEWPORT_ACTIVE = 32;
const DATA_MODE = 37;

/**
 * A packed GhosttyMode: the mode number in the low 15 bits, with the top bit
 * set for ANSI modes and clear for DEC private modes.
 */
const ghosttyMode = (value: number, ansi = false) => (value & 0x7fff) | ((ansi ? 1 : 0) << 15);
const MODE_BRACKETED_PASTE = ghosttyMode(2004);

/** GhosttyTerminalScrollViewportTag values. */
const SCROLL_TOP = 0;
const SCROLL_BOTTOM = 1;
const SCROLL_DELTA = 2;

/** GhosttyRenderStateData values. */
const RS_COLS = 1;
const RS_ROWS = 2;
const RS_DIRTY = 3;
const RS_ROW_ITERATOR = 4;
const RS_CURSOR = 18;
const RS_COLORS = 19;

/** GhosttyRenderStateRowData values. */
const ROW_CELLS = 3;
const ROW_SELECTION = 4;

/** GhosttyRenderStateRowCellsData values. */
const CELL_STYLE = 2;
const CELL_BG_COLOR = 5;
const CELL_FG_COLOR = 6;
const CELL_HAS_STYLING = 8;
const CELL_GRAPHEMES_UTF8 = 9;

/** GhosttyKeyAction values. Release is 0, not press — see key/event.h. */
export const KEY_ACTION_RELEASE = 0;
export const KEY_ACTION_PRESS = 1;
export const KEY_ACTION_REPEAT = 2;

/** GhosttyMouseAction values. */
export const MOUSE_ACTION_PRESS = 0;
export const MOUSE_ACTION_RELEASE = 1;
export const MOUSE_ACTION_MOTION = 2;

/** GhosttyMods bitflags. */
export const MOD_SHIFT = 1 << 0;
export const MOD_CTRL = 1 << 1;
export const MOD_ALT = 1 << 2;
export const MOD_SUPER = 1 << 3;
export const MOD_CAPS_LOCK = 1 << 4;
export const MOD_NUM_LOCK = 1 << 5;

/** GhosttyRenderStateCursorVisualStyle values. */
export type CursorShape = "bar" | "block" | "underline" | "block_hollow";
const CURSOR_SHAPES: CursorShape[] = ["bar", "block", "underline", "block_hollow"];

/** GhosttyRenderStateDirty values. */
export type DirtyState = "clean" | "partial" | "full";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** One rendered cell of a row snapshot. */
export interface CellSnapshot {
  /** Column index. Wide characters occupy this column and leave the next empty. */
  x: number;
  /** The full grapheme cluster, or "" for an empty cell. */
  text: string;
  fg: Rgb | null;
  bg: Rgb | null;
  bold: boolean;
  italic: boolean;
  faint: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
  /** GhosttySgrUnderline: 0 none, 1 single, 2 double, 3 curly, 4 dotted, 5 dashed. */
  underline: number;
  underlineColor: Rgb | null;
}

export interface RowSnapshot {
  y: number;
  cells: CellSnapshot[];
  /** Inclusive column range covered by the selection, if this row intersects it. */
  selection: { startX: number; endX: number } | null;
}

export interface CursorSnapshot {
  x: number;
  y: number;
  /** False when the cursor has scrolled out of the viewport. */
  onScreen: boolean;
  visible: boolean;
  blinking: boolean;
  shape: CursorShape;
}

export interface FrameSnapshot {
  cols: number;
  rows: number;
  dirty: DirtyState;
  background: Rgb;
  foreground: Rgb;
  cursorColor: Rgb | null;
  cursor: CursorSnapshot;
  /** Only rows needing a redraw, in ascending viewport order. */
  dirtyRows: RowSnapshot[];
}

export interface TerminalCallbacks {
  /** Query responses libghostty wants written back to the pty. */
  onWritePty?(data: Uint8Array): void;
  onBell?(): void;
  onTitleChange?(title: string): void;
}

export interface VtTerminalOptions {
  cols: number;
  rows: number;
  scrollback?: number;
}

/**
 * A libghostty-vt terminal plus its render state and input encoders.
 *
 * All the wasm handles are created once and reused; the per-frame path
 * allocates nothing in wasm memory.
 */
export class VtTerminal {
  private readonly g: GhosttyModule;
  private readonly handle: number;
  private readonly renderState: number;
  private readonly rowIterSlot: number;
  private readonly rowIter: number;
  private readonly cellsSlot: number;
  private readonly keyEncoder: number;
  private readonly keyEvent: number;
  private readonly mouseEncoder: number;
  private readonly mouseEvent: number;

  // Reusable scratch buffers, sized once at construction.
  private readonly scratch: number;
  private readonly scratchLen = 64;
  private readonly graphemeBuf: number;
  private readonly graphemeCap = 128;
  private readonly bufferStruct: number;
  private readonly colorsStruct: number;
  private readonly cursorStruct: number;
  private readonly styleStruct: number;
  private readonly rowSelStruct: number;
  private readonly scrollStruct: number;
  private readonly encodeBuf: number;
  private readonly encodeCap = 256;
  private readonly u16Out: number;

  private disposed = false;
  private cols: number;
  private rows: number;

  constructor(
    module: GhosttyModule,
    options: VtTerminalOptions,
    private readonly callbacks: TerminalCallbacks = {},
  ) {
    this.g = module;
    this.cols = options.cols;
    this.rows = options.rows;

    this.handle = this.g.withSlot((slot) => {
      check("ghostty_terminal_new", this.g.fn("ghostty_terminal_new")(0, slot, options.cols, options.rows));
    });

    this.renderState = this.g.withSlot((slot) => {
      check("ghostty_render_state_new", this.g.fn("ghostty_render_state_new")(0, slot));
    });

    // The row iterator and cells container are rebound to the current frame
    // on every update, so they are allocated once and kept, along with the
    // slots holding them — `get` writes through the slot, not the handle.
    this.rowIterSlot = this.g.allocSlot();
    check(
      "ghostty_render_state_row_iterator_new",
      this.g.fn("ghostty_render_state_row_iterator_new")(0, this.rowIterSlot),
    );
    this.rowIter = this.g.deref(this.rowIterSlot);

    this.cellsSlot = this.g.allocSlot();
    check(
      "ghostty_render_state_row_cells_new",
      this.g.fn("ghostty_render_state_row_cells_new")(0, this.cellsSlot),
    );

    this.keyEncoder = this.g.withSlot((slot) => {
      check("ghostty_key_encoder_new", this.g.fn("ghostty_key_encoder_new")(0, slot));
    });
    this.keyEvent = this.g.withSlot((slot) => {
      check("ghostty_key_event_new", this.g.fn("ghostty_key_event_new")(0, slot));
    });
    this.mouseEncoder = this.g.withSlot((slot) => {
      check("ghostty_mouse_encoder_new", this.g.fn("ghostty_mouse_encoder_new")(0, slot));
    });
    this.mouseEvent = this.g.withSlot((slot) => {
      check("ghostty_mouse_event_new", this.g.fn("ghostty_mouse_event_new")(0, slot));
    });

    this.scratch = this.g.allocBytes(this.scratchLen);
    this.graphemeBuf = this.g.allocBytes(this.graphemeCap);
    this.encodeBuf = this.g.allocBytes(this.encodeCap);
    this.u16Out = this.g.allocBytes(2);
    this.bufferStruct = this.g.allocBytes(this.g.sizeOf("GhosttyBuffer"));
    this.colorsStruct = this.g.allocSized("GhosttyRenderStateColors");
    this.cursorStruct = this.g.allocSized("GhosttyRenderStateCursor");
    this.styleStruct = this.g.allocSized("GhosttyStyle");
    this.rowSelStruct = this.g.allocSized("GhosttyRenderStateRowSelection");
    this.scrollStruct = this.g.allocBytes(this.g.sizeOf("GhosttyTerminalScrollViewport"));

    if (options.scrollback !== undefined) {
      this.g.view.setUint32(this.scratch, options.scrollback, true);
      this.g.fn("ghostty_terminal_set")(this.handle, OPT_SCROLLBACK_MAX_LINES, this.scratch);
    }

    this.installCallbacks();
  }

  /**
   * Wire libghostty's C function pointers to JS.
   *
   * Userdata stays 0: each VtTerminal closes over itself, so there is nothing
   * to route through the opaque pointer.
   */
  private installCallbacks(): void {
    const set = this.g.fn("ghostty_terminal_set");

    // void (*)(GhosttyTerminal, void* userdata, const uint8_t* data, size_t len)
    const writePty = this.g.installCallback(4, (_terminal, _userdata, ptr, len) => {
      if (len > 0) this.callbacks.onWritePty?.(this.g.readBytes(ptr, len));
    });
    set(this.handle, OPT_WRITE_PTY, writePty);

    if (this.callbacks.onBell) {
      // void (*)(GhosttyTerminal, void* userdata)
      const bell = this.g.installCallback(2, () => this.callbacks.onBell?.());
      set(this.handle, OPT_BELL, bell);
    }

    if (this.callbacks.onTitleChange) {
      // void (*)(GhosttyTerminal, void* userdata) — read the title back out.
      const titleChanged = this.g.installCallback(2, () => {
        this.callbacks.onTitleChange?.(this.title());
      });
      set(this.handle, OPT_TITLE_CHANGED, titleChanged);
    }

    set(this.handle, OPT_USERDATA, 0);
  }

  // ---- input from the pty ---------------------------------------------

  /** Feed bytes from the pty through the VT parser. */
  write(data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.length === 0) return;

    // Chunk through a scratch allocation rather than allocating per write:
    // pty output arrives in many small bursts.
    const ptr = this.g.allocBytes(bytes.length);
    try {
      this.g.writeBytes(ptr, bytes);
      this.g.fn("ghostty_terminal_vt_write")(this.handle, ptr, bytes.length);
    } finally {
      this.g.freeBytes(ptr, bytes.length);
    }
  }

  resize(cols: number, rows: number, cellWidthPx = 0, cellHeightPx = 0): void {
    if (cols === this.cols && rows === this.rows) return;
    check(
      "ghostty_terminal_resize",
      this.g.fn("ghostty_terminal_resize")(this.handle, cols, rows, cellWidthPx, cellHeightPx),
    );
    this.cols = cols;
    this.rows = rows;
  }

  /** Scroll the viewport by `delta` rows; negative scrolls into scrollback. */
  scrollBy(delta: number): void {
    this.scroll(SCROLL_DELTA, delta);
  }

  scrollToBottom(): void {
    this.scroll(SCROLL_BOTTOM, 0);
  }

  scrollToTop(): void {
    this.scroll(SCROLL_TOP, 0);
  }

  private scroll(tag: number, value: number): void {
    const size = this.g.sizeOf("GhosttyTerminalScrollViewport");
    this.g.zero(this.scrollStruct, size);
    const view = this.g.view;
    view.setUint32(this.scrollStruct + this.g.offsetOf("GhosttyTerminalScrollViewport", "tag"), tag, true);
    // The value union is intptr_t-wide; a row delta never approaches 2^31.
    view.setInt32(
      this.scrollStruct + this.g.offsetOf("GhosttyTerminalScrollViewport", "value"),
      value,
      true,
    );
    // Structs this size are passed indirectly under the wasm32 C ABI.
    this.g.fn("ghostty_terminal_scroll_viewport")(this.handle, this.scrollStruct);
  }

  /**
   * Push a color theme down into libghostty rather than remapping colors in
   * the renderer.
   *
   * Doing it here means the terminal resolves palette indices against the
   * theme itself, so cell colors arrive already correct and OSC 10/11/4
   * colour queries from the running program report the truth.
   *
   * `palette` must hold 256 entries; the first 16 are the ANSI colors.
   */
  setTheme(theme: { background: Rgb; foreground: Rgb; cursor: Rgb | null; palette: Rgb[] }): void {
    if (theme.palette.length !== 256) {
      throw new Error(`palette must have 256 entries, got ${theme.palette.length}`);
    }
    const set = this.g.fn("ghostty_terminal_set");
    const rgbSize = this.g.sizeOf("GhosttyColorRgb");

    const single = this.g.allocBytes(rgbSize);
    const palette = this.g.allocBytes(rgbSize * 256);
    try {
      const writeRgb = (ptr: number, c: Rgb) => {
        const u8 = this.g.u8;
        u8[ptr] = c.r;
        u8[ptr + 1] = c.g;
        u8[ptr + 2] = c.b;
      };

      writeRgb(single, theme.background);
      set(this.handle, OPT_COLOR_BACKGROUND, single);
      writeRgb(single, theme.foreground);
      set(this.handle, OPT_COLOR_FOREGROUND, single);
      if (theme.cursor) {
        writeRgb(single, theme.cursor);
        set(this.handle, OPT_COLOR_CURSOR, single);
      }

      for (let i = 0; i < 256; i++) writeRgb(palette + i * rgbSize, theme.palette[i]);
      set(this.handle, OPT_COLOR_PALETTE, palette);
    } finally {
      this.g.freeBytes(palette, rgbSize * 256);
      this.g.freeBytes(single, rgbSize);
    }
  }

  // ---- terminal state --------------------------------------------------

  title(): string {
    const ptr = this.scratch;
    if (this.g.fn("ghostty_terminal_get")(this.handle, DATA_TITLE, ptr) !== GHOSTTY_SUCCESS) return "";
    const view = this.g.view;
    const strPtr = view.getUint32(ptr + this.g.offsetOf("GhosttyString", "ptr"), true);
    const strLen = view.getUint32(ptr + this.g.offsetOf("GhosttyString", "len"), true);
    return strLen === 0 ? "" : this.g.readString(strPtr, strLen);
  }

  /** True when a TUI has enabled any mouse tracking mode. */
  mouseTrackingEnabled(): boolean {
    if (this.g.fn("ghostty_terminal_get")(this.handle, DATA_MOUSE_TRACKING, this.scratch) !== GHOSTTY_SUCCESS) {
      return false;
    }
    return this.g.u8[this.scratch] !== 0;
  }

  /** True when the viewport is pinned to the active area rather than history. */
  viewportAtBottom(): boolean {
    if (this.g.fn("ghostty_terminal_get")(this.handle, DATA_VIEWPORT_ACTIVE, this.scratch) !== GHOSTTY_SUCCESS) {
      return true;
    }
    return this.g.u8[this.scratch] !== 0;
  }

  hasSelection(): boolean {
    const sel = this.g.allocSized("GhosttySelection");
    try {
      return this.g.fn("ghostty_terminal_get")(this.handle, DATA_SELECTION, sel) === GHOSTTY_SUCCESS;
    } finally {
      this.g.freeBytes(sel, this.g.sizeOf("GhosttySelection"));
    }
  }

  get dimensions(): { cols: number; rows: number } {
    const get = this.g.fn("ghostty_terminal_get");
    get(this.handle, DATA_COLS, this.scratch);
    const cols = this.g.view.getUint16(this.scratch, true);
    get(this.handle, DATA_ROWS, this.scratch);
    const rows = this.g.view.getUint16(this.scratch, true);
    return { cols, rows };
  }

  // ---- rendering -------------------------------------------------------

  /**
   * Refresh the render state from the terminal and snapshot every row that
   * needs a redraw.
   *
   * Returns null when nothing changed since the last call, which is the
   * common case between frames and lets the caller skip the frame entirely.
   */
  snapshot(force = false): FrameSnapshot | null {
    check("ghostty_render_state_update", this.g.fn("ghostty_render_state_update")(this.renderState, this.handle));

    const get = this.g.fn("ghostty_render_state_get");
    get(this.renderState, RS_DIRTY, this.scratch);
    const dirtyCode = this.g.view.getUint32(this.scratch, true);
    if (dirtyCode === 0 && !force) return null;

    get(this.renderState, RS_COLS, this.scratch);
    const cols = this.g.view.getUint32(this.scratch, true);
    get(this.renderState, RS_ROWS, this.scratch);
    const rows = this.g.view.getUint32(this.scratch, true);

    const frame: FrameSnapshot = {
      cols,
      rows,
      dirty: dirtyCode === 2 || force ? "full" : "partial",
      ...this.readColors(),
      cursor: this.readCursor(),
      dirtyRows: [],
    };

    // Rebind the row iterator to this frame, then walk it.
    check("ghostty_render_state_get(ROW_ITERATOR)", get(this.renderState, RS_ROW_ITERATOR, this.rowIterSlot));

    const nextRow = force
      ? this.g.fn("ghostty_render_state_row_iterator_next")
      : this.g.fn("ghostty_render_state_row_iterator_next_dirty");

    let y = 0;
    while (force ? nextRow(this.rowIter) : nextRow(this.rowIter, this.u16Out)) {
      const rowY = force ? y++ : this.g.view.getUint16(this.u16Out, true);
      frame.dirtyRows.push(this.readRow(rowY, cols));
    }

    return frame;
  }

  /** Clear both dirty layers. Call once a frame has actually been drawn. */
  markClean(): void {
    check("ghostty_render_state_clean", this.g.fn("ghostty_render_state_clean")(this.renderState));
  }

  private readColors(): Pick<FrameSnapshot, "background" | "foreground" | "cursorColor"> {
    const ptr = this.colorsStruct;
    const size = this.g.sizeOf("GhosttyRenderStateColors");
    this.g.zero(ptr, size);
    this.g.view.setUint32(ptr + this.g.offsetOf("GhosttyRenderStateColors", "size"), size, true);
    check(
      "ghostty_render_state_get(COLORS)",
      this.g.fn("ghostty_render_state_get")(this.renderState, RS_COLORS, ptr),
    );

    const at = (field: string) => this.readRgb(ptr + this.g.offsetOf("GhosttyRenderStateColors", field));
    const hasCursor = this.g.u8[ptr + this.g.offsetOf("GhosttyRenderStateColors", "cursor_has_value")] !== 0;
    return {
      background: at("background"),
      foreground: at("foreground"),
      cursorColor: hasCursor ? at("cursor") : null,
    };
  }

  private readCursor(): CursorSnapshot {
    const ptr = this.cursorStruct;
    const size = this.g.sizeOf("GhosttyRenderStateCursor");
    this.g.zero(ptr, size);
    this.g.view.setUint32(ptr + this.g.offsetOf("GhosttyRenderStateCursor", "size"), size, true);
    check(
      "ghostty_render_state_get(CURSOR)",
      this.g.fn("ghostty_render_state_get")(this.renderState, RS_CURSOR, ptr),
    );

    const u8 = this.g.u8;
    const view = this.g.view;
    const off = (f: string) => this.g.offsetOf("GhosttyRenderStateCursor", f);
    const onScreen = u8[ptr + off("viewport_has_value")] !== 0;
    return {
      // viewport_x/y are undefined when viewport_has_value is false.
      x: onScreen ? view.getUint16(ptr + off("viewport_x"), true) : 0,
      y: onScreen ? view.getUint16(ptr + off("viewport_y"), true) : 0,
      onScreen,
      visible: u8[ptr + off("visible")] !== 0,
      blinking: u8[ptr + off("blinking")] !== 0,
      shape: CURSOR_SHAPES[view.getUint32(ptr + off("visual_style"), true)] ?? "block",
    };
  }

  private readRow(y: number, cols: number): RowSnapshot {
    check(
      "ghostty_render_state_row_get(CELLS)",
      this.g.fn("ghostty_render_state_row_get")(this.rowIter, ROW_CELLS, this.cellsSlot),
    );
    const cells = this.g.deref(this.cellsSlot);

    const row: RowSnapshot = { y, cells: [], selection: this.readRowSelection() };

    const next = this.g.fn("ghostty_render_state_row_cells_next");
    const cellGet = this.g.fn("ghostty_render_state_row_cells_get");
    let x = -1;
    while (next(cells)) {
      x += 1;
      if (x >= cols) break;

      const text = this.readGrapheme(cells, cellGet);
      const styled = cellGet(cells, CELL_HAS_STYLING, this.scratch) === GHOSTTY_SUCCESS && this.g.u8[this.scratch] !== 0;
      const fg = cellGet(cells, CELL_FG_COLOR, this.scratch) === GHOSTTY_SUCCESS ? this.readRgb(this.scratch) : null;
      const bg = cellGet(cells, CELL_BG_COLOR, this.scratch) === GHOSTTY_SUCCESS ? this.readRgb(this.scratch) : null;

      // An unstyled cell is the overwhelming majority; skip the 72-byte
      // style read for those entirely.
      if (!styled) {
        if (text === "" && fg === null && bg === null) continue;
        row.cells.push({
          x, text, fg, bg,
          bold: false, italic: false, faint: false, inverse: false,
          invisible: false, strikethrough: false, overline: false,
          underline: 0, underlineColor: null,
        });
        continue;
      }

      row.cells.push({ x, text, fg, bg, ...this.readStyle(cells, cellGet) });
    }

    return row;
  }

  private readRowSelection(): { startX: number; endX: number } | null {
    const ptr = this.rowSelStruct;
    const size = this.g.sizeOf("GhosttyRenderStateRowSelection");
    this.g.zero(ptr, size);
    this.g.view.setUint32(ptr + this.g.offsetOf("GhosttyRenderStateRowSelection", "size"), size, true);
    const result = this.g.fn("ghostty_render_state_row_get")(this.rowIter, ROW_SELECTION, ptr);
    if (result === GHOSTTY_NO_VALUE || result !== GHOSTTY_SUCCESS) return null;
    return {
      startX: this.g.view.getUint16(ptr + this.g.offsetOf("GhosttyRenderStateRowSelection", "start_x"), true),
      endX: this.g.view.getUint16(ptr + this.g.offsetOf("GhosttyRenderStateRowSelection", "end_x"), true),
    };
  }

  private readGrapheme(cells: number, cellGet: (...args: number[]) => number): string {
    const view = this.g.view;
    const base = this.bufferStruct;
    view.setUint32(base + this.g.offsetOf("GhosttyBuffer", "ptr"), this.graphemeBuf, true);
    view.setUint32(base + this.g.offsetOf("GhosttyBuffer", "cap"), this.graphemeCap, true);
    view.setUint32(base + this.g.offsetOf("GhosttyBuffer", "len"), 0, true);
    if (cellGet(cells, CELL_GRAPHEMES_UTF8, base) !== GHOSTTY_SUCCESS) return "";
    const len = this.g.view.getUint32(base + this.g.offsetOf("GhosttyBuffer", "len"), true);
    return len === 0 ? "" : this.g.readString(this.graphemeBuf, len);
  }

  private readStyle(
    cells: number,
    cellGet: (...args: number[]) => number,
  ): Omit<CellSnapshot, "x" | "text" | "fg" | "bg"> {
    const ptr = this.styleStruct;
    const size = this.g.sizeOf("GhosttyStyle");
    this.g.zero(ptr, size);
    this.g.view.setUint32(ptr + this.g.offsetOf("GhosttyStyle", "size"), size, true);
    cellGet(cells, CELL_STYLE, ptr);

    const u8 = this.g.u8;
    const flag = (f: string) => u8[ptr + this.g.offsetOf("GhosttyStyle", f)] !== 0;
    return {
      bold: flag("bold"),
      italic: flag("italic"),
      faint: flag("faint"),
      inverse: flag("inverse"),
      invisible: flag("invisible"),
      strikethrough: flag("strikethrough"),
      overline: flag("overline"),
      underline: this.g.view.getInt32(ptr + this.g.offsetOf("GhosttyStyle", "underline"), true),
      underlineColor: this.readStyleColor(ptr + this.g.offsetOf("GhosttyStyle", "underline_color")),
    };
  }

  /** Read a GhosttyStyleColor, resolving only the direct-RGB case. */
  private readStyleColor(ptr: number): Rgb | null {
    const tag = this.g.view.getUint32(ptr + this.g.offsetOf("GhosttyStyleColor", "tag"), true);
    if (tag !== 2 /* GHOSTTY_STYLE_COLOR_RGB */) return null;
    return this.readRgb(ptr + this.g.offsetOf("GhosttyStyleColor", "value"));
  }

  private readRgb(ptr: number): Rgb {
    const u8 = this.g.u8;
    return { r: u8[ptr], g: u8[ptr + 1], b: u8[ptr + 2] };
  }

  // ---- selection -------------------------------------------------------

  /**
   * Select the inclusive range between two viewport cells.
   *
   * Cells are resolved to grid references first, which is what pins the
   * selection to the text rather than to screen coordinates — it survives
   * scrolling and new output the way a terminal selection should.
   */
  selectCells(start: { x: number; y: number }, end: { x: number; y: number }, rectangle = false): boolean {
    const selection = this.g.allocSized("GhosttySelection");
    try {
      const startOff = this.g.offsetOf("GhosttySelection", "start");
      const endOff = this.g.offsetOf("GhosttySelection", "end");
      if (!this.resolveGridRef(start, selection + startOff)) return false;
      if (!this.resolveGridRef(end, selection + endOff)) return false;
      this.g.u8[selection + this.g.offsetOf("GhosttySelection", "rectangle")] = rectangle ? 1 : 0;

      this.g.fn("ghostty_terminal_set")(this.handle, OPT_SELECTION, selection);
      return true;
    } finally {
      this.g.freeBytes(selection, this.g.sizeOf("GhosttySelection"));
    }
  }

  clearSelection(): void {
    this.g.fn("ghostty_terminal_set")(this.handle, OPT_SELECTION, 0);
  }

  /** Resolve a viewport cell into a GhosttyGridRef written at `outRef`. */
  private resolveGridRef(cell: { x: number; y: number }, outRef: number): boolean {
    const pointSize = this.g.sizeOf("GhosttyPoint");
    const point = this.g.allocBytes(pointSize);
    try {
      this.g.zero(point, pointSize);
      const view = this.g.view;
      view.setUint32(point + this.g.offsetOf("GhosttyPoint", "tag"), 1 /* VIEWPORT */, true);
      const coord = point + this.g.offsetOf("GhosttyPoint", "value");
      view.setUint16(coord + this.g.offsetOf("GhosttyPointCoordinate", "x"), cell.x, true);
      view.setUint32(coord + this.g.offsetOf("GhosttyPointCoordinate", "y"), cell.y, true);

      // GhosttyGridRef is a sized struct even as an out-parameter.
      this.g.zero(outRef, this.g.sizeOf("GhosttyGridRef"));
      view.setUint32(
        outRef + this.g.offsetOf("GhosttyGridRef", "size"),
        this.g.sizeOf("GhosttyGridRef"),
        true,
      );
      // GhosttyPoint is 24 bytes, so it is passed indirectly.
      return this.g.fn("ghostty_terminal_grid_ref")(this.handle, point, outRef) === GHOSTTY_SUCCESS;
    } finally {
      this.g.freeBytes(point, pointSize);
    }
  }

  /**
   * Read the current selection as plain text.
   *
   * `unwrap` rejoins rows that libghostty knows are one soft-wrapped logical
   * line, so copying a wrapped command does not paste back with newlines in
   * the middle of it.
   */
  selectionText(unwrap = true): string {
    const options = this.g.allocSized("GhosttyTerminalSelectionFormatOptions");
    const outPtr = this.g.allocSlot();
    const outLen = this.g.allocBytes(4);
    try {
      const name = "GhosttyTerminalSelectionFormatOptions";
      this.g.view.setUint32(options + this.g.offsetOf(name, "emit"), 0 /* PLAIN */, true);
      this.g.u8[options + this.g.offsetOf(name, "unwrap")] = unwrap ? 1 : 0;
      this.g.u8[options + this.g.offsetOf(name, "trim")] = 1;
      this.g.view.setUint32(options + this.g.offsetOf(name, "selection"), 0, true);

      const result = this.g.fn("ghostty_terminal_selection_format_alloc")(
        this.handle, 0, options, outPtr, outLen,
      );
      if (result !== GHOSTTY_SUCCESS) return "";

      const ptr = this.g.deref(outPtr);
      const len = this.g.view.getUint32(outLen, true);
      if (ptr === 0 || len === 0) return "";
      const text = this.g.readString(ptr, len);
      this.g.fn("ghostty_free")(0, ptr, len);
      return text;
    } finally {
      this.g.freeBytes(outLen, 4);
      this.g.freeSlot(outPtr);
      this.g.freeBytes(options, this.g.sizeOf("GhosttyTerminalSelectionFormatOptions"));
    }
  }

  /**
   * Encode text for pasting, applying bracketed-paste mode when the running
   * program has asked for it.
   */
  encodePaste(text: string): Uint8Array {
    const utf8 = new TextEncoder().encode(text);
    if (utf8.length === 0) return EMPTY;

    const bracketed = this.modeEnabled(MODE_BRACKETED_PASTE) ? 1 : 0;
    const input = this.g.allocBytes(utf8.length);
    const lenPtr = this.g.allocBytes(4);
    try {
      this.g.writeBytes(input, utf8);
      // Query the size first: bracketed paste adds a wrapper of unknown length.
      this.g.view.setUint32(lenPtr, 0, true);
      this.g.fn("ghostty_paste_encode")(input, utf8.length, bracketed, 0, 0, lenPtr);
      const needed = this.g.view.getUint32(lenPtr, true);
      if (needed === 0) return EMPTY;

      const out = this.g.allocBytes(needed);
      try {
        const result = this.g.fn("ghostty_paste_encode")(
          input, utf8.length, bracketed, out, needed, lenPtr,
        );
        if (result !== GHOSTTY_SUCCESS) return utf8;
        return this.g.readBytes(out, this.g.view.getUint32(lenPtr, true));
      } finally {
        this.g.freeBytes(out, needed);
      }
    } finally {
      this.g.freeBytes(lenPtr, 4);
      this.g.freeBytes(input, utf8.length);
    }
  }

  /** Read a DEC/ANSI mode's current value. `mode` is a packed GhosttyMode. */
  modeEnabled(mode: number): boolean {
    const cfg = this.g.allocBytes(this.g.sizeOf("GhosttyTerminalModeConfig"));
    try {
      this.g.zero(cfg, this.g.sizeOf("GhosttyTerminalModeConfig"));
      this.g.view.setUint16(cfg + this.g.offsetOf("GhosttyTerminalModeConfig", "mode"), mode, true);
      if (this.g.fn("ghostty_terminal_get")(this.handle, DATA_MODE, cfg) !== GHOSTTY_SUCCESS) return false;
      return this.g.u8[cfg + this.g.offsetOf("GhosttyTerminalModeConfig", "value")] !== 0;
    } finally {
      this.g.freeBytes(cfg, this.g.sizeOf("GhosttyTerminalModeConfig"));
    }
  }

  /** Whether pasting this text is free of embedded newlines and control bytes. */
  pasteIsSafe(text: string): boolean {
    const utf8 = new TextEncoder().encode(text);
    if (utf8.length === 0) return true;
    const ptr = this.g.allocBytes(utf8.length);
    try {
      this.g.writeBytes(ptr, utf8);
      return this.g.fn("ghostty_paste_is_safe")(ptr, utf8.length) !== 0;
    } finally {
      this.g.freeBytes(ptr, utf8.length);
    }
  }

  // ---- input encoding --------------------------------------------------

  /**
   * Encode a keyboard event into the bytes the pty should receive.
   *
   * Returns an empty array for events that produce no output (bare modifier
   * presses, for instance). Encoder options are synced from terminal state on
   * every call so application cursor mode, Kitty protocol flags and friends
   * always match what the running program asked for.
   */
  encodeKey(event: {
    code: string;
    action: number;
    mods: number;
    text?: string;
    unshiftedCodepoint?: number;
  }): Uint8Array {
    this.g.fn("ghostty_key_encoder_setopt_from_terminal")(this.keyEncoder, this.handle);

    const ev = this.keyEvent;
    this.g.fn("ghostty_key_event_set_action")(ev, event.action);
    this.g.fn("ghostty_key_event_set_key")(ev, keyForCode(event.code));
    this.g.fn("ghostty_key_event_set_mods")(ev, event.mods);
    this.g.fn("ghostty_key_event_set_consumed_mods")(ev, 0);
    this.g.fn("ghostty_key_event_set_composing")(ev, 0);
    this.g.fn("ghostty_key_event_set_unshifted_codepoint")(ev, event.unshiftedCodepoint ?? 0);

    const text = event.text ?? "";
    const utf8 = new TextEncoder().encode(text);
    let textPtr = 0;
    if (utf8.length > 0) {
      textPtr = this.g.allocBytes(utf8.length);
      this.g.writeBytes(textPtr, utf8);
    }
    this.g.fn("ghostty_key_event_set_utf8")(ev, textPtr, utf8.length);

    try {
      return this.encodeInto("ghostty_key_encoder_encode", this.keyEncoder, ev);
    } finally {
      // libghostty copies the text into the event, so this can go back now.
      if (textPtr !== 0) this.g.freeBytes(textPtr, utf8.length);
    }
  }

  /**
   * Encode a mouse event for a TUI that has enabled mouse tracking.
   *
   * Returns an empty array when the active tracking mode does not report
   * this event, which is the normal outcome for most motion.
   */
  encodeMouse(event: {
    action: number;
    button: number | null;
    mods: number;
    x: number;
    y: number;
    cellWidth: number;
    cellHeight: number;
    screenWidth: number;
    screenHeight: number;
    anyButtonPressed: boolean;
  }): Uint8Array {
    this.g.fn("ghostty_mouse_encoder_setopt_from_terminal")(this.mouseEncoder, this.handle);

    // GHOSTTY_MOUSE_ENCODER_OPT_SIZE — pixel geometry, needed by SGR-pixels.
    const sizePtr = this.g.allocSized("GhosttyMouseEncoderSize");
    const sizeBytes = this.g.sizeOf("GhosttyMouseEncoderSize");
    const put = (field: string, value: number) =>
      this.g.view.setUint32(sizePtr + this.g.offsetOf("GhosttyMouseEncoderSize", field), value, true);
    put("screen_width", event.screenWidth);
    put("screen_height", event.screenHeight);
    put("cell_width", event.cellWidth);
    put("cell_height", event.cellHeight);
    this.g.fn("ghostty_mouse_encoder_setopt")(this.mouseEncoder, 2 /* OPT_SIZE */, sizePtr);

    this.g.u8[this.scratch] = event.anyButtonPressed ? 1 : 0;
    this.g.fn("ghostty_mouse_encoder_setopt")(this.mouseEncoder, 3 /* OPT_ANY_BUTTON_PRESSED */, this.scratch);

    const ev = this.mouseEvent;
    this.g.fn("ghostty_mouse_event_set_action")(ev, event.action);
    if (event.button === null) {
      this.g.fn("ghostty_mouse_event_clear_button")(ev);
    } else {
      this.g.fn("ghostty_mouse_event_set_button")(ev, event.button);
    }
    this.g.fn("ghostty_mouse_event_set_mods")(ev, event.mods);
    // GhosttyMousePosition is two f32s, passed indirectly.
    const posPtr = this.g.allocBytes(this.g.sizeOf("GhosttyMousePosition"));
    this.g.view.setFloat32(posPtr + this.g.offsetOf("GhosttyMousePosition", "x"), event.x, true);
    this.g.view.setFloat32(posPtr + this.g.offsetOf("GhosttyMousePosition", "y"), event.y, true);
    this.g.fn("ghostty_mouse_event_set_position")(ev, posPtr);

    try {
      return this.encodeInto("ghostty_mouse_encoder_encode", this.mouseEncoder, ev);
    } finally {
      this.g.freeBytes(posPtr, this.g.sizeOf("GhosttyMousePosition"));
      this.g.freeBytes(sizePtr, sizeBytes);
    }
  }

  /** Shared encode-with-growth for the key and mouse encoders. */
  private encodeInto(fnName: string, encoder: number, event: number): Uint8Array {
    const encode = this.g.fn(fnName);
    const lenPtr = this.scratch;
    this.g.view.setUint32(lenPtr, 0, true);

    let result = encode(encoder, event, this.encodeBuf, this.encodeCap, lenPtr);
    if (result === GHOSTTY_SUCCESS) {
      const len = this.g.view.getUint32(lenPtr, true);
      return len === 0 ? EMPTY : this.g.readBytes(this.encodeBuf, len);
    }

    // OUT_OF_SPACE reports the size it needs; retry once at that size.
    const needed = this.g.view.getUint32(lenPtr, true);
    if (needed === 0) return EMPTY;
    const big = this.g.allocBytes(needed);
    try {
      result = encode(encoder, event, big, needed, lenPtr);
      check(fnName, result);
      return this.g.readBytes(big, this.g.view.getUint32(lenPtr, true));
    } finally {
      this.g.freeBytes(big, needed);
    }
  }

  // ---- teardown --------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.g.fn("ghostty_render_state_row_cells_free")(this.g.deref(this.cellsSlot));
    this.g.fn("ghostty_render_state_row_iterator_free")(this.rowIter);
    this.g.freeSlot(this.cellsSlot);
    this.g.freeSlot(this.rowIterSlot);
    this.g.fn("ghostty_render_state_free")(this.renderState);
    this.g.fn("ghostty_key_event_free")(this.keyEvent);
    this.g.fn("ghostty_key_encoder_free")(this.keyEncoder);
    this.g.fn("ghostty_mouse_event_free")(this.mouseEvent);
    this.g.fn("ghostty_mouse_encoder_free")(this.mouseEncoder);
    this.g.fn("ghostty_terminal_free")(this.handle);

    this.g.freeBytes(this.scratch, this.scratchLen);
    this.g.freeBytes(this.graphemeBuf, this.graphemeCap);
    this.g.freeBytes(this.encodeBuf, this.encodeCap);
    this.g.freeBytes(this.u16Out, 2);
    this.g.freeBytes(this.bufferStruct, this.g.sizeOf("GhosttyBuffer"));
    this.g.freeBytes(this.colorsStruct, this.g.sizeOf("GhosttyRenderStateColors"));
    this.g.freeBytes(this.cursorStruct, this.g.sizeOf("GhosttyRenderStateCursor"));
    this.g.freeBytes(this.styleStruct, this.g.sizeOf("GhosttyStyle"));
    this.g.freeBytes(this.rowSelStruct, this.g.sizeOf("GhosttyRenderStateRowSelection"));
    this.g.freeBytes(this.scrollStruct, this.g.sizeOf("GhosttyTerminalScrollViewport"));
  }
}

const EMPTY = new Uint8Array(0);

/** Translate a DOM KeyboardEvent's modifier state into GhosttyMods. */
export function modsFromEvent(event: {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  getModifierState?(key: string): boolean;
}): number {
  let mods = 0;
  if (event.shiftKey) mods |= MOD_SHIFT;
  if (event.ctrlKey) mods |= MOD_CTRL;
  if (event.altKey) mods |= MOD_ALT;
  if (event.metaKey) mods |= MOD_SUPER;
  if (event.getModifierState?.("CapsLock")) mods |= MOD_CAPS_LOCK;
  if (event.getModifierState?.("NumLock")) mods |= MOD_NUM_LOCK;
  return mods;
}
