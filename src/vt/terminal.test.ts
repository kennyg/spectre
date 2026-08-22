import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { GhosttyModule } from "./wasm";
import {
  VtTerminal,
  KEY_ACTION_PRESS,
  KEY_ACTION_RELEASE,
  MOUSE_ACTION_PRESS,
  MOD_CTRL,
  MOD_SHIFT,
  modsFromEvent,
} from "./terminal";
import { keyForCode, GHOSTTY_KEY, KEY_UNIDENTIFIED } from "./keys";

const root = join(import.meta.dirname, "..", "..");
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const solid = (r: number, g: number, b: number) => ({ r, g, b });

/** Render a frame to plain text lines, for asserting on screen contents. */
function screen(term: VtTerminal, cols: number, rows: number): string[] {
  const frame = term.snapshot(true);
  assert.ok(frame, "forced snapshot should never be null");
  const lines = Array.from<string>({ length: rows }).fill("");
  for (const row of frame.dirtyRows) {
    const chars = Array.from<string>({ length: cols }).fill(" ");
    for (const cell of row.cells) if (cell.text) chars[cell.x] = cell.text;
    lines[row.y] = chars.join("").trimEnd();
  }
  return lines;
}

describe("GhosttyModule", () => {
  let module: GhosttyModule;

  before(async () => {
    const buf = readFileSync(join(root, "ghostty-vt.wasm"));
    module = await GhosttyModule.instantiate(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    );
  });

  it("instantiates the pinned artifact with no imports", () => {
    assert.ok(module.exports.memory instanceof WebAssembly.Memory);
    assert.ok(module.exports.__indirect_function_table instanceof WebAssembly.Table);
  });

  it("is the optimized, SIMD-enabled build the pin asks for", () => {
    // ghostty-vt.wasm is the ReleaseFast variant; ghostty-vt-small.wasm is
    // ReleaseSmall. Checking this catches a pin that points at the wrong
    // artifact even though its checksum is internally consistent.
    assert.equal(module.buildInfo.optimize, "ReleaseFast");
    assert.match(module.buildInfo.version, /^\d+\.\d+\.\d+/);
  });

  it("exposes struct layouts the bindings depend on", () => {
    // If a future artifact reshapes these, every sized-struct read breaks, so
    // fail here with a clear message rather than silently reading garbage.
    for (const struct of [
      "GhosttyRenderStateColors",
      "GhosttyRenderStateCursor",
      "GhosttyRenderStateRowSelection",
      "GhosttyStyle",
      "GhosttyBuffer",
      "GhosttyString",
      "GhosttyMouseEncoderSize",
      "GhosttyTerminalScrollViewport",
    ]) {
      assert.ok(module.sizeOf(struct) > 0, `${struct} should have a size`);
      assert.equal(module.offsetOf(struct, Object.keys(module.layout[struct].fields)[0]), 0);
    }
  });

  it("keeps memory views valid across a wasm memory grow", () => {
    // A grow can extend the same ArrayBuffer rather than replacing it, which
    // leaves cached views covering less than the live memory. Allocate far
    // past the initial size and confirm reads and writes still land.
    const initialBytes = module.exports.memory.buffer.byteLength;
    const size = 8 * 1024 * 1024;
    const ptr = module.allocBytes(size);
    try {
      assert.ok(
        module.exports.memory.buffer.byteLength > initialBytes,
        "allocation should have grown wasm memory",
      );
      const payload = new TextEncoder().encode("spectre");
      module.writeBytes(ptr + size - payload.length, payload);
      assert.equal(module.readString(ptr + size - payload.length, payload.length), "spectre");
    } finally {
      module.freeBytes(ptr, size);
    }
  });

  it("throws a useful error for an unknown struct or field", () => {
    assert.throws(() => module.sizeOf("GhosttyNope"), /unknown struct GhosttyNope/);
    assert.throws(() => module.offsetOf("GhosttyStyle", "nope"), /has no field nope/);
  });
});

describe("VtTerminal", () => {
  let module: GhosttyModule;
  const open = (
    cols = 40,
    rows = 6,
    callbacks: ConstructorParameters<typeof VtTerminal>[2] = {},
  ) => new VtTerminal(module, { cols, rows }, callbacks);

  before(async () => {
    const buf = readFileSync(join(root, "ghostty-vt.wasm"));
    module = await GhosttyModule.instantiate(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    );
  });

  it("renders written text into the viewport", () => {
    const term = open();
    try {
      term.write("hello\r\nworld");
      assert.deepEqual(screen(term, 40, 6).slice(0, 2), ["hello", "world"]);
    } finally {
      term.dispose();
    }
  });

  it("resolves SGR colors and attributes per cell", () => {
    const term = open();
    try {
      term.write("\x1b[1;31mR\x1b[0m\x1b[38;2;0;200;255mT\x1b[0m\x1b[4mU\x1b[0m");
      const frame = term.snapshot(true)!;
      const cells = frame.dirtyRows[0].cells;

      const bold = cells.find((c) => c.text === "R")!;
      assert.equal(bold.bold, true);
      assert.deepEqual(bold.fg, { r: 0xcc, g: 0x66, b: 0x66 }); // palette red

      const truecolor = cells.find((c) => c.text === "T")!;
      assert.deepEqual(truecolor.fg, { r: 0, g: 200, b: 255 });

      const underlined = cells.find((c) => c.text === "U")!;
      assert.equal(underlined.underline, 1);
    } finally {
      term.dispose();
    }
  });

  it("keeps grapheme clusters intact, including emoji and wide characters", () => {
    const term = open();
    try {
      term.write("👻日本");
      const cells = term.snapshot(true)!.dirtyRows[0].cells.filter((c) => c.text !== "");
      assert.deepEqual(cells.map((c) => c.text), ["👻", "日", "本"]);
      // Wide characters claim two columns and leave the tail cell empty.
      assert.deepEqual(cells.map((c) => c.x), [0, 2, 4]);
    } finally {
      term.dispose();
    }
  });

  it("tracks the cursor position and visibility", () => {
    const term = open();
    try {
      term.write("abc\r\n");
      let frame = term.snapshot(true)!;
      assert.deepEqual({ x: frame.cursor.x, y: frame.cursor.y }, { x: 0, y: 1 });
      assert.equal(frame.cursor.visible, true);

      term.write("\x1b[?25l"); // DECTCEM off
      frame = term.snapshot(true)!;
      assert.equal(frame.cursor.visible, false);
    } finally {
      term.dispose();
    }
  });

  it("returns null from snapshot when nothing changed", () => {
    const term = open();
    try {
      term.write("x");
      assert.ok(term.snapshot());
      term.markClean();
      assert.equal(term.snapshot(), null);

      term.write("y");
      assert.ok(term.snapshot());
    } finally {
      term.dispose();
    }
  });

  it("reports only dirty rows on a partial frame", () => {
    const term = open();
    try {
      term.write("a\r\nb\r\nc");
      term.snapshot();
      term.markClean();

      // Row 1 is overwritten; row 2 is dirty too because the cursor vacated
      // it. Untouched row 0 must stay out of the frame.
      term.write("\x1b[2;1HZ");
      const frame = term.snapshot()!;
      assert.deepEqual(frame.dirtyRows.map((r) => r.y), [1, 2]);
    } finally {
      term.dispose();
    }
  });

  it("routes query responses to the write_pty callback", () => {
    const replies: string[] = [];
    const term = open(40, 6, { onWritePty: (data) => replies.push(decode(data)) });
    try {
      term.write("\x1b[6n"); // DSR cursor position report
      term.write("\x1b[c"); // DA1
      assert.deepEqual(replies, ["\x1b[1;1R", "\x1b[?62;22c"]);
    } finally {
      term.dispose();
    }
  });

  it("reports the title set by OSC 2", () => {
    const titles: string[] = [];
    const term = open(40, 6, { onTitleChange: (t) => titles.push(t) });
    try {
      term.write("\x1b]2;spectre\x07");
      assert.deepEqual(titles, ["spectre"]);
      assert.equal(term.title(), "spectre");
    } finally {
      term.dispose();
    }
  });

  it("fires the bell callback on BEL", () => {
    let bells = 0;
    const term = open(40, 6, { onBell: () => bells++ });
    try {
      term.write("a\x07b");
      assert.equal(bells, 1);
    } finally {
      term.dispose();
    }
  });

  it("scrolls into and back out of scrollback", () => {
    const term = open(20, 4);
    try {
      for (let i = 1; i <= 12; i++) term.write(`line-${i}\r\n`);
      assert.equal(term.viewportAtBottom(), true);

      term.scrollBy(-5);
      assert.equal(term.viewportAtBottom(), false);
      assert.deepEqual(screen(term, 20, 4), ["line-5", "line-6", "line-7", "line-8"]);

      term.scrollToBottom();
      assert.equal(term.viewportAtBottom(), true);
      assert.deepEqual(screen(term, 20, 4)[0], "line-10");
    } finally {
      term.dispose();
    }
  });

  it("reflows on resize", () => {
    const term = open(40, 6);
    try {
      term.write("hello");
      term.resize(10, 3);
      assert.deepEqual(term.dimensions, { cols: 10, rows: 3 });
      assert.equal(screen(term, 10, 3)[0], "hello");
    } finally {
      term.dispose();
    }
  });

  describe("theming", () => {
    it("resolves cell colors against the theme pushed into libghostty", () => {
      const term = open();
      try {
        const palette = Array.from({ length: 256 }, () => solid(0, 0, 0));
        palette[1] = solid(0xde, 0x38, 0x3f); // ANSI red
        term.setTheme({
          background: solid(0x28, 0x2c, 0x34),
          foreground: solid(0xab, 0xb2, 0xbf),
          cursor: solid(0x61, 0xaf, 0xef),
          palette,
        });

        term.write("\x1b[31mred\x1b[0m");
        const frame = term.snapshot(true)!;
        assert.deepEqual(frame.background, solid(0x28, 0x2c, 0x34));
        assert.deepEqual(frame.foreground, solid(0xab, 0xb2, 0xbf));
        assert.deepEqual(frame.cursorColor, solid(0x61, 0xaf, 0xef));
        assert.deepEqual(frame.dirtyRows[0].cells[0].fg, solid(0xde, 0x38, 0x3f));
      } finally {
        term.dispose();
      }
    });

    it("rejects a palette that is not 256 entries", () => {
      const term = open();
      try {
        assert.throws(
          () => term.setTheme({
            background: solid(0, 0, 0), foreground: solid(0, 0, 0), cursor: null,
            palette: [solid(1, 2, 3)],
          }),
          /palette must have 256 entries/,
        );
      } finally {
        term.dispose();
      }
    });
  });

  describe("selection", () => {
    it("selects a cell range and reads it back as text", () => {
      const term = open(20, 4);
      try {
        term.write("hello world");
        assert.equal(term.hasSelection(), false);

        assert.equal(term.selectCells({ x: 0, y: 0 }, { x: 4, y: 0 }), true);
        assert.equal(term.hasSelection(), true);
        assert.equal(term.selectionText(), "hello");

        term.clearSelection();
        assert.equal(term.hasSelection(), false);
        assert.equal(term.selectionText(), "");
      } finally {
        term.dispose();
      }
    });

    it("marks the selected range on the rows it covers", () => {
      const term = open(20, 4);
      try {
        term.write("abcdef");
        term.selectCells({ x: 1, y: 0 }, { x: 3, y: 0 });
        const frame = term.snapshot(true)!;
        assert.deepEqual(frame.dirtyRows[0].selection, { startX: 1, endX: 3 });
        assert.equal(frame.dirtyRows[1].selection, null);
      } finally {
        term.dispose();
      }
    });

    it("spans multiple rows", () => {
      const term = open(20, 4);
      try {
        term.write("one\r\ntwo\r\nthree");
        term.selectCells({ x: 0, y: 0 }, { x: 2, y: 1 });
        assert.equal(term.selectionText(), "one\ntwo");
      } finally {
        term.dispose();
      }
    });
  });

  describe("paste", () => {
    it("passes text through unwrapped by default", () => {
      const term = open();
      try {
        assert.equal(decode(term.encodePaste("ls\r")), "ls\r");
      } finally {
        term.dispose();
      }
    });

    it("brackets the paste once the application enables mode 2004", () => {
      const term = open();
      try {
        term.write("\x1b[?2004h");
        assert.equal(decode(term.encodePaste("ls")), "\x1b[200~ls\x1b[201~");
      } finally {
        term.dispose();
      }
    });

    it("flags pastes containing a newline as unsafe", () => {
      const term = open();
      try {
        assert.equal(term.pasteIsSafe("harmless"), true);
        assert.equal(term.pasteIsSafe("rm -rf /\n"), false);
      } finally {
        term.dispose();
      }
    });
  });

  describe("key encoding", () => {
    it("encodes plain text and control characters", () => {
      const term = open();
      try {
        const press = (code: string, mods = 0, text?: string) =>
          decode(term.encodeKey({ code, action: KEY_ACTION_PRESS, mods, text }));

        assert.equal(press("Enter", 0, "\r"), "\r");
        assert.equal(press("Tab", 0, "\t"), "\t");
        assert.equal(press("Escape"), "\x1b");
        assert.equal(press("Backspace"), "\x7f");
        assert.equal(press("KeyC", MOD_CTRL), "\x03");
        assert.equal(press("KeyA", 0, "a"), "a");
      } finally {
        term.dispose();
      }
    });

    it("follows the terminal's application cursor mode", () => {
      const term = open();
      try {
        const up = () => decode(term.encodeKey({ code: "ArrowUp", action: KEY_ACTION_PRESS, mods: 0 }));
        assert.equal(up(), "\x1b[A");

        term.write("\x1b[?1h"); // DECCKM on
        assert.equal(up(), "\x1bOA");
      } finally {
        term.dispose();
      }
    });

    it("switches to the Kitty protocol when the application enables it", () => {
      const term = open();
      try {
        term.write("\x1b[>1u"); // push Kitty flags: disambiguate
        const encoded = decode(term.encodeKey({ code: "Escape", action: KEY_ACTION_PRESS, mods: 0 }));
        assert.equal(encoded, "\x1b[27u");
      } finally {
        term.dispose();
      }
    });

    describe("Kitty keyboard protocol", () => {
      // The unshifted codepoint is the key's identity in CSI-u. Without it
      // libghostty encodes nothing once an application turns the protocol on,
      // so every one of these would silently produce zero bytes.
      const press = (term: VtTerminal, code: string, mods: number, text: string, cp: number) =>
        decode(term.encodeKey({
          code, action: KEY_ACTION_PRESS, mods, text, unshiftedCodepoint: cp,
        }));

      it("encodes Ctrl+C as CSI-u instead of dropping it", () => {
        const term = open();
        try {
          assert.equal(decode(term.encodeKey({ code: "KeyC", action: KEY_ACTION_PRESS, mods: MOD_CTRL })), "\x03");

          term.write("\x1b[>1u");
          assert.equal(press(term, "KeyC", MOD_CTRL, "", 99), "\x1b[99;5u");
          // The regression this guards: no codepoint, no output at all.
          assert.equal(decode(term.encodeKey({ code: "KeyC", action: KEY_ACTION_PRESS, mods: MOD_CTRL })), "");
        } finally {
          term.dispose();
        }
      });

      it("reports press, release and shifted keys under the full flag set", () => {
        const term = open();
        try {
          term.write("\x1b[>31u");
          assert.equal(press(term, "KeyA", 0, "a", 97), "\x1b[97;;97u");
          assert.equal(press(term, "KeyA", MOD_SHIFT, "A", 97), "\x1b[97:65;2;65u");
          assert.equal(
            decode(term.encodeKey({
              code: "KeyA", action: KEY_ACTION_RELEASE, mods: 0, text: "a", unshiftedCodepoint: 97,
            })),
            "\x1b[97;1:3u",
          );
          // Bare modifiers are reported too once report-all is on.
          assert.equal(
            decode(term.encodeKey({ code: "ShiftLeft", action: KEY_ACTION_PRESS, mods: MOD_SHIFT })),
            "\x1b[57441;2u",
          );
        } finally {
          term.dispose();
        }
      });

      it("stays silent on release until the application asks for events", () => {
        const term = open();
        try {
          const release = () => decode(term.encodeKey({
            code: "KeyA", action: KEY_ACTION_RELEASE, mods: 0, text: "a", unshiftedCodepoint: 97,
          }));
          assert.equal(release(), "");
          term.write("\x1b[>3u");
          assert.equal(release(), "\x1b[97;1:3u");
        } finally {
          term.dispose();
        }
      });

      it("answers the flag query and restores legacy encoding on pop", () => {
        const replies: string[] = [];
        const term = open(40, 6, { onWritePty: (d) => replies.push(decode(d)) });
        try {
          term.write("\x1b[>31u");
          term.write("\x1b[?u");
          assert.deepEqual(replies, ["\x1b[?31u"]);

          replies.length = 0;
          term.write("\x1b[<u"); // pop
          term.write("\x1b[?u");
          assert.deepEqual(replies, ["\x1b[?0u"]);
          assert.equal(decode(term.encodeKey({ code: "Escape", action: KEY_ACTION_PRESS, mods: 0 })), "\x1b");
        } finally {
          term.dispose();
        }
      });
    });

    it("produces nothing for a bare modifier press", () => {
      const term = open();
      try {
        const bytes = term.encodeKey({ code: "ShiftLeft", action: KEY_ACTION_PRESS, mods: MOD_SHIFT });
        assert.equal(bytes.length, 0);
      } finally {
        term.dispose();
      }
    });
  });

  describe("mouse encoding", () => {
    const geometry = {
      cellWidth: 8,
      cellHeight: 16,
      screenWidth: 320,
      screenHeight: 96,
      anyButtonPressed: false,
    };

    it("stays silent until the application enables tracking", () => {
      const term = open();
      try {
        assert.equal(term.mouseTrackingEnabled(), false);
        const bytes = term.encodeMouse({
          action: MOUSE_ACTION_PRESS, button: 1, mods: 0, x: 8, y: 16, ...geometry,
        });
        assert.equal(bytes.length, 0);
      } finally {
        term.dispose();
      }
    });

    it("encodes SGR mouse reports once tracking is on", () => {
      const term = open();
      try {
        term.write("\x1b[?1000h\x1b[?1006h"); // normal tracking + SGR format
        assert.equal(term.mouseTrackingEnabled(), true);

        const bytes = term.encodeMouse({
          action: MOUSE_ACTION_PRESS, button: 1, mods: 0, x: 8, y: 16, ...geometry,
        });
        assert.equal(decode(bytes), "\x1b[<0;2;2M");
      } finally {
        term.dispose();
      }
    });
  });
});

describe("modsFromEvent", () => {
  it("maps DOM modifier flags onto GhosttyMods bits", () => {
    const mods = modsFromEvent({
      shiftKey: true, ctrlKey: true, altKey: false, metaKey: false,
    });
    assert.equal(mods, MOD_SHIFT | MOD_CTRL);
  });
});

describe("keyForCode", () => {
  it("maps DOM codes onto GhosttyKey values", () => {
    assert.equal(keyForCode("KeyA"), GHOSTTY_KEY.A);
    assert.equal(keyForCode("Digit1"), GHOSTTY_KEY.DIGIT_1);
    assert.equal(keyForCode("ArrowLeft"), GHOSTTY_KEY.ARROW_LEFT);
    assert.equal(keyForCode("F1"), GHOSTTY_KEY.F1);
    assert.equal(keyForCode("MetaLeft"), GHOSTTY_KEY.META_LEFT);
    assert.equal(keyForCode("NumpadDecimal"), GHOSTTY_KEY.NUMPAD_DECIMAL);
    assert.equal(keyForCode("IntlBackslash"), GHOSTTY_KEY.INTL_BACKSLASH);
    assert.equal(keyForCode("LaunchApp1"), GHOSTTY_KEY.LAUNCH_APP_1);
  });

  it("falls back to UNIDENTIFIED for codes libghostty has no name for", () => {
    assert.equal(keyForCode("Nonsense"), KEY_UNIDENTIFIED);
    assert.equal(keyForCode(""), KEY_UNIDENTIFIED);
  });
});
