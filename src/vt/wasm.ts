// Low-level bridge to the official libghostty-vt WebAssembly artifact.
//
// The artifact is built wasm32-freestanding and declares no imports, so
// instantiation needs no import object at all. Everything above this file
// talks to libghostty through the handles and helpers here rather than
// touching `exports` directly.

/** Result codes from <ghostty/vt/types.h>. */
export const GHOSTTY_SUCCESS = 0;
export const GHOSTTY_OUT_OF_MEMORY = -1;
export const GHOSTTY_INVALID_VALUE = -2;
export const GHOSTTY_OUT_OF_SPACE = -3;
export const GHOSTTY_NO_VALUE = -4;

const RESULT_NAMES: Record<number, string> = {
  [GHOSTTY_OUT_OF_MEMORY]: "OUT_OF_MEMORY",
  [GHOSTTY_INVALID_VALUE]: "INVALID_VALUE",
  [GHOSTTY_OUT_OF_SPACE]: "OUT_OF_SPACE",
  [GHOSTTY_NO_VALUE]: "NO_VALUE",
  [-5]: "IO_ERROR",
  [-6]: "LIMIT_EXCEEDED",
};

export class GhosttyError extends Error {
  constructor(
    readonly call: string,
    readonly code: number,
  ) {
    super(`${call} failed: ${RESULT_NAMES[code] ?? `code ${code}`}`);
    this.name = "GhosttyError";
  }
}

/** Throw unless `code` is GHOSTTY_SUCCESS. */
export function check(call: string, code: number): void {
  if (code !== GHOSTTY_SUCCESS) throw new GhosttyError(call, code);
}

/** One field of a C struct, as reported by ghostty_type_json(). */
interface FieldLayout {
  offset: number;
  size: number;
  type: string;
}

interface StructLayout {
  size: number;
  align: number;
  fields: Record<string, FieldLayout>;
}

/** The full C struct layout table for this build, keyed by struct name. */
export type TypeLayout = Record<string, StructLayout>;

/** The ghostty_type_json() schema revision these bindings are written against. */
const SUPPORTED_TYPE_SCHEMA = 1;

/** The document ghostty_type_json() returns. */
interface TypeDocument {
  schema: number;
  abi: {
    target: string;
    pointer_size: number;
    usize_size: number;
    max_alignment: number;
    endian: string;
  };
  library_version: string;
  commit: string | null;
  types: TypeLayout;
}

/** GhosttyBuildInfo query kinds. */
const BUILD_INFO_SIMD = 1;
const BUILD_INFO_OPTIMIZE = 4;
const BUILD_INFO_VERSION_STRING = 5;

/** GhosttyOptimizeMode names, indexed by enum value. */
const OPTIMIZE_MODES = ["Debug", "ReleaseSafe", "ReleaseSmall", "ReleaseFast"];

/** What the artifact reports about itself. */
export interface BuildInfo {
  /** e.g. "1.3.2-main+26df373". */
  version: string;
  optimize: string;
  simd: boolean;
}

const PLACEHOLDER_BUILD_INFO: BuildInfo = { version: "", optimize: "", simd: false };

/**
 * The subset of libghostty-vt exports this plugin calls.
 *
 * Everything is `(...args: number[]) => number` at the wasm boundary; the
 * meaningful types live in the wrappers above this file.
 */
type WasmFn = (...args: number[]) => number;

export interface GhosttyExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
  [name: string]: WebAssembly.ExportValue;
}

/** Prefix a wasm section body with its id and length. */
function wasmSection(id: number, body: number[]): number[] {
  return [id, body.length, ...body];
}

/**
 * Build a wasm module that forwards a call to a JS function.
 *
 * libghostty delivers query responses, bells and title changes through C
 * function pointers, which in wasm are indices into the module's indirect
 * function table. A table slot only accepts a wasm funcref, and a plain JS
 * function is not one — `WebAssembly.Function` would convert it but is not
 * available in Electron. So we hand-assemble a module whose single exported
 * function takes `paramCount` i32s and tail-calls an imported JS function.
 * That export *is* a funcref, and it is installable in libghostty's table.
 */
function makeTrampoline(paramCount: number, fn: (...args: number[]) => void): Function {
  const params = Array.from<number>({ length: paramCount }).fill(0x7f); // i32

  const types = [0x01, 0x60, params.length, ...params, 0x00];
  const imports = [0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00]; // "e"."f", func, type 0
  const functions = [0x01, 0x00];
  const exports = [0x01, 0x01, 0x66, 0x00, 0x01]; // "f" -> func 1
  const gets: number[] = [];
  for (let i = 0; i < paramCount; i++) gets.push(0x20, i); // local.get i
  const body = [0x00, ...gets, 0x10, 0x00, 0x0b]; // no locals; call 0; end
  const code = [0x01, body.length, ...body];

  const bytes = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...wasmSection(1, types),
    ...wasmSection(2, imports),
    ...wasmSection(3, functions),
    ...wasmSection(7, exports),
    ...wasmSection(10, code),
  ]);

  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    e: { f: fn },
  });
  return instance.exports.f as Function;
}

/**
 * An instantiated libghostty-vt module: memory access, allocation, struct
 * layout lookups, and JS callback installation.
 */
export class GhosttyModule {
  private readonly fns = new Map<string, WasmFn>();
  private cachedBuffer: ArrayBuffer;
  private cachedLength: number;
  private cachedU8: Uint8Array;
  private cachedView: DataView;

  private constructor(
    readonly exports: GhosttyExports,
    readonly layout: TypeLayout,
    readonly buildInfo: BuildInfo,
  ) {
    this.cachedBuffer = exports.memory.buffer;
    this.cachedLength = this.cachedBuffer.byteLength;
    this.cachedU8 = new Uint8Array(this.cachedBuffer);
    this.cachedView = new DataView(this.cachedBuffer);
  }

  static async instantiate(bytes: BufferSource): Promise<GhosttyModule> {
    // No import object: the official artifact is freestanding.
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const exports = instance.exports as GhosttyExports;

    // Read the struct layout table before anything else — every sized-struct
    // call below depends on it, and a build whose layouts we cannot read is
    // one we have no business driving.
    const memory = exports.memory;
    const jsonPtr = (exports.ghostty_type_json as WasmFn)();
    const document = JSON.parse(readCString(new Uint8Array(memory.buffer), jsonPtr)) as TypeDocument;

    if (document.schema !== SUPPORTED_TYPE_SCHEMA) {
      throw new Error(
        `libghostty-vt type schema ${document.schema} is not supported ` +
          `(this build of Spectre understands ${SUPPORTED_TYPE_SCHEMA})`,
      );
    }
    // The wasm32 assumptions baked into these bindings: 4-byte pointers and
    // size_t, little-endian. Assert them rather than corrupt memory quietly
    // if ghostty ever ships a wasm64 artifact under the same name.
    const { abi } = document;
    if (abi.pointer_size !== 4 || abi.usize_size !== 4 || abi.endian !== "little") {
      throw new Error(
        `unsupported libghostty-vt ABI: ${abi.target} ` +
          `(pointer ${abi.pointer_size}B, usize ${abi.usize_size}B, ${abi.endian}-endian)`,
      );
    }

    const layout = document.types;
    const module = new GhosttyModule(exports, layout, PLACEHOLDER_BUILD_INFO);
    return new GhosttyModule(exports, layout, module.readBuildInfo());
  }

  /**
   * Query the artifact's self-reported build metadata.
   *
   * Worth asserting on: it is the only runtime evidence that the .wasm on
   * disk is the one ghostty-vt.pin.json claims.
   */
  private readBuildInfo(): BuildInfo {
    const build = this.fn("ghostty_build_info");
    const str = this.allocBytes(this.sizeOf("GhosttyString"));
    const scalar = this.allocBytes(8);
    try {
      check("ghostty_build_info(VERSION_STRING)", build(BUILD_INFO_VERSION_STRING, str));
      const version = this.readString(
        this.view.getUint32(str + this.offsetOf("GhosttyString", "ptr"), true),
        this.view.getUint32(str + this.offsetOf("GhosttyString", "len"), true),
      );

      check("ghostty_build_info(OPTIMIZE)", build(BUILD_INFO_OPTIMIZE, scalar));
      const optimize = OPTIMIZE_MODES[this.view.getUint32(scalar, true)] ?? "unknown";

      check("ghostty_build_info(SIMD)", build(BUILD_INFO_SIMD, scalar));
      const simd = this.u8[scalar] !== 0;

      return { version, optimize, simd };
    } finally {
      this.freeBytes(scalar, 8);
      this.freeBytes(str, this.sizeOf("GhosttyString"));
    }
  }

  /** Look up an export, memoised, throwing if the build does not have it. */
  fn(name: string): WasmFn {
    let f = this.fns.get(name);
    if (!f) {
      const exported = this.exports[name];
      if (typeof exported !== "function") {
        throw new Error(`libghostty-vt build does not export ${name}`);
      }
      f = exported as WasmFn;
      this.fns.set(name, f);
    }
    return f;
  }

  // ---- memory ----------------------------------------------------------
  //
  // Wasm memory grows on demand, which detaches every view onto the old
  // buffer. Views are therefore never stored by callers; they come from
  // these accessors, which rebuild after a grow.

  private refresh(): void {
    const buffer = this.exports.memory.buffer;
    // Identity alone is not enough: a grow may keep the same ArrayBuffer and
    // only extend it, which leaves cached views covering less than the live
    // memory. libghostty's wasm.h calls this out explicitly.
    if (buffer !== this.cachedBuffer || buffer.byteLength !== this.cachedLength) {
      this.cachedBuffer = buffer;
      this.cachedLength = buffer.byteLength;
      this.cachedU8 = new Uint8Array(buffer);
      this.cachedView = new DataView(buffer);
    }
  }

  get u8(): Uint8Array {
    this.refresh();
    return this.cachedU8;
  }

  get view(): DataView {
    this.refresh();
    return this.cachedView;
  }

  readBytes(ptr: number, len: number): Uint8Array {
    // Copy: the caller may hold this across a call that grows memory.
    return this.u8.slice(ptr, ptr + len);
  }

  readString(ptr: number, len: number): string {
    return new TextDecoder().decode(this.u8.subarray(ptr, ptr + len));
  }

  writeBytes(ptr: number, bytes: Uint8Array): void {
    this.u8.set(bytes, ptr);
  }

  zero(ptr: number, len: number): void {
    this.u8.fill(0, ptr, ptr + len);
  }

  // ---- struct layout ---------------------------------------------------

  sizeOf(struct: string): number {
    const s = this.layout[struct];
    if (!s) throw new Error(`unknown struct ${struct} in this libghostty-vt build`);
    return s.size;
  }

  offsetOf(struct: string, field: string): number {
    const s = this.layout[struct];
    if (!s) throw new Error(`unknown struct ${struct} in this libghostty-vt build`);
    const f = s.fields[field];
    if (!f) throw new Error(`struct ${struct} has no field ${field} in this build`);
    return f.offset;
  }

  /** Allocate a sized struct with its `size` field filled in, as the ABI requires. */
  allocSized(struct: string): number {
    const size = this.sizeOf(struct);
    const ptr = this.allocBytes(size);
    this.zero(ptr, size);
    this.view.setUint32(ptr + this.offsetOf(struct, "size"), size, true);
    return ptr;
  }

  // ---- allocation ------------------------------------------------------

  allocBytes(len: number): number {
    const ptr = this.fn("ghostty_wasm_alloc")(len);
    if (ptr === 0) throw new Error(`out of wasm memory allocating ${len} bytes`);
    return ptr;
  }

  freeBytes(ptr: number, len: number): void {
    this.fn("ghostty_wasm_free")(ptr, len);
  }

  /** Allocate a slot to receive an out-pointer (`T*` for an opaque `T`). */
  allocSlot(): number {
    const ptr = this.fn("ghostty_wasm_alloc_opaque")();
    if (ptr === 0) throw new Error("out of wasm memory allocating an out-pointer slot");
    return ptr;
  }

  freeSlot(ptr: number): void {
    this.fn("ghostty_wasm_free_opaque")(ptr);
  }

  /** Read the handle an out-pointer slot received. */
  deref(slot: number): number {
    return this.view.getUint32(slot, true);
  }

  /**
   * Run `body` with a freshly allocated out-pointer slot and return the
   * handle it received, freeing the slot either way.
   */
  withSlot(body: (slot: number) => void): number {
    const slot = this.allocSlot();
    try {
      body(slot);
      return this.deref(slot);
    } finally {
      this.freeSlot(slot);
    }
  }

  // ---- callbacks -------------------------------------------------------

  /**
   * Install a JS function in the module's indirect function table and return
   * the index, which is what libghostty takes as a C function pointer.
   *
   * Slots are never reclaimed: a terminal installs a fixed handful of
   * callbacks for its lifetime, and dropping a slot that libghostty still
   * holds a pointer to would be far worse than leaking a table entry.
   */
  installCallback(paramCount: number, fn: (...args: number[]) => void): number {
    const funcref = makeTrampoline(paramCount, fn);
    const table = this.exports.__indirect_function_table;
    const index = table.grow(1);
    table.set(index, funcref);
    return index;
  }
}

/** Decode a NUL-terminated string out of a wasm memory view. */
function readCString(u8: Uint8Array, ptr: number): string {
  let end = ptr;
  while (end < u8.length && u8[end] !== 0) end++;
  return new TextDecoder().decode(u8.subarray(ptr, end));
}
