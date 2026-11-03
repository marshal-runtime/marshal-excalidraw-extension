// Imported before Excalidraw. The card runs in an allow-scripts-only sandbox (opaque origin) under a
// CSP with no network: storage access throws and font URLs on esm.sh are blocked.
import fonts from "virtual:excalidraw-fonts";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  try {
    void window[name].length;
  } catch {
    Object.defineProperty(window, name, { value: memoryStorage(), configurable: true });
  }
}

const NativeFontFace = window.FontFace;
const FONT_FILE = /fonts\/[^/]+\/([^/)\s'"]+\.woff2)/;
const decoded = new Map<string, ArrayBuffer>();

function fontBytes(file: string): ArrayBuffer | undefined {
  const data = fonts[file];
  if (!data) return undefined;
  let bytes = decoded.get(file);
  if (!bytes) {
    const binary = atob(data);
    const view = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) view[index] = binary.charCodeAt(index);
    bytes = view.buffer;
    decoded.set(file, bytes);
  }
  return bytes;
}

// Byte sources, not data: URLs: the card iframe inherits Marshal's window CSP (font-src 'self'),
// which blocks data: fonts, while FontFace built from bytes is never fetched and so not CSP-checked.
function InlineFontFace(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors): FontFace {
  if (typeof source === "string") {
    const file = FONT_FILE.exec(source)?.[1];
    const bytes = file ? fontBytes(file) : undefined;
    if (bytes) return new NativeFontFace(family, bytes.slice(0), descriptors);
  }
  return new NativeFontFace(family, source, descriptors);
}
InlineFontFace.prototype = NativeFontFace.prototype;
window.FontFace = InlineFontFace as unknown as typeof FontFace;

const UI_FONT_WEIGHTS: Record<string, string> = { Regular: "400", Medium: "500", SemiBold: "600", Bold: "700" };
for (const [name, weight] of Object.entries(UI_FONT_WEIGHTS)) {
  const bytes = fontBytes(`Assistant-${name}.woff2`);
  if (bytes) document.fonts.add(new NativeFontFace("Assistant", bytes, { weight, style: "normal", display: "swap" }));
}
