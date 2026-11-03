import { randomInt } from "node:crypto";

export type RawElement = Record<string, unknown> & { type: string; id?: string };

export const MAX_ELEMENTS_BYTES = 5 * 1024 * 1024;
const PSEUDO_TYPES = new Set(["cameraUpdate", "delete", "restoreCheckpoint"]);
const MAX_SCENES = 100;

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid_request" });
}

/** Accepts the MCP's JSON-array string or an already-parsed array, and returns both forms. */
export function parseElements(input: unknown): { json: string; elements: RawElement[] } {
  let elements: unknown = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input) > MAX_ELEMENTS_BYTES) throw invalid("elements exceeds the 5 MB limit; build the diagram in steps with restoreCheckpoint.");
    try {
      elements = JSON.parse(input);
    } catch (error) {
      throw invalid(`elements is not valid JSON (${error instanceof Error ? error.message : "parse error"}). No comments or trailing commas.`);
    }
  }
  if (!Array.isArray(elements) || elements.length === 0) throw invalid("elements must be a non-empty JSON array of Excalidraw elements.");
  for (const [index, element] of elements.entries()) {
    if (!element || typeof element !== "object" || Array.isArray(element) || typeof (element as RawElement).type !== "string") {
      throw invalid(`elements[${index}] needs a string "type".`);
    }
  }
  const json = JSON.stringify(elements);
  if (Buffer.byteLength(json) > MAX_ELEMENTS_BYTES) throw invalid("elements exceeds the 5 MB limit; build the diagram in steps with restoreCheckpoint.");
  return { json, elements: elements as RawElement[] };
}

export function hasRestore(elements: readonly RawElement[]): boolean {
  return elements.some((element) => element.type === "restoreCheckpoint");
}

export function drawnElementCount(elements: readonly RawElement[]): number {
  return finalElements(elements).length;
}

/** The final picture: pseudo-elements dropped and `delete` entries applied (including bound text). */
export function finalElements(elements: readonly RawElement[]): RawElement[] {
  const deleted = new Set<string>();
  for (const element of elements) {
    if (element.type !== "delete") continue;
    for (const id of String(element.ids ?? element.id ?? "").split(",")) if (id.trim()) deleted.add(id.trim());
  }
  return elements.filter(
    (element) =>
      !PSEUDO_TYPES.has(element.type) &&
      !deleted.has(String(element.id)) &&
      !deleted.has(String(element.containerId ?? "")),
  );
}

export interface Scene {
  readonly checkpointId: string;
  readonly title?: string;
  /** What the card renders: the agent's elements (or the server's restored set), pseudo-elements included. */
  readonly elements: RawElement[];
  /** Fully converted Excalidraw elements, as rendered (and possibly edited) by the card. */
  converted?: RawElement[];
  edited?: boolean;
  updatedAt: number;
}

export class SceneStore {
  private readonly scenes = new Map<string, Scene>();

  put(scene: Scene): Scene {
    this.scenes.delete(scene.checkpointId);
    this.scenes.set(scene.checkpointId, scene);
    while (this.scenes.size > MAX_SCENES) this.scenes.delete(this.scenes.keys().next().value as string);
    return scene;
  }

  get(checkpointId: string): Scene | undefined {
    return this.scenes.get(checkpointId);
  }

  clear(): void {
    this.scenes.clear();
  }
}

export function excalidrawFile(elements: readonly RawElement[]): Record<string, unknown> {
  return {
    type: "excalidraw",
    version: 2,
    source: "https://github.com/excalidraw/excalidraw-mcp",
    elements,
    appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
    files: {},
  };
}

const base = (): Record<string, unknown> => ({
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: randomInt(1, 2 ** 31 - 1),
  version: 1,
  versionNonce: randomInt(1, 2 ** 31 - 1),
  isDeleted: false,
  boundElements: [],
  updated: Date.now(),
  link: null,
  locked: false,
});

const EXCALIFONT = 5;
const LINE_HEIGHT = 1.25;

function textBox(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split("\n");
  return {
    width: Math.max(...lines.map((line) => line.length)) * fontSize * 0.55,
    height: lines.length * fontSize * LINE_HEIGHT,
  };
}

/**
 * Best-effort skeleton → Excalidraw conversion for exports made before any card rendered the scene.
 * Labels become bound text and `start`/`end` become bindings; excalidraw.com's restore() fills the rest.
 */
export function skeletonToExcalidraw(elements: readonly RawElement[]): RawElement[] {
  const drawn = finalElements(elements);
  const ids = new Set(drawn.map((element) => String(element.id ?? "")));
  const uniqueId = (wanted: string) => {
    let id = wanted;
    for (let suffix = 2; ids.has(id); suffix++) id = `${wanted}-${suffix}`;
    ids.add(id);
    return id;
  };
  const out: RawElement[] = [];
  const byId = new Map<string, RawElement>();
  const bind = (target: unknown, ref: { type: string; id: string }) => {
    const element = typeof target === "string" ? byId.get(target) : undefined;
    if (element) (element.boundElements as unknown[]).push(ref);
  };

  for (const raw of drawn) {
    const { label, start, end, ...rest } = raw as RawElement & { label?: Record<string, unknown>; start?: { id?: string }; end?: { id?: string } };
    const id = rest.id ? String(rest.id) : uniqueId(`el-${out.length + 1}`);
    const element: RawElement = { ...base(), ...rest, id, boundElements: [...((rest.boundElements as unknown[]) ?? [])] };
    if (element.type === "text") {
      const fontSize = Number(element.fontSize ?? 20);
      const text = String(element.text ?? "");
      const box = textBox(text, fontSize);
      Object.assign(element, {
        fontSize,
        fontFamily: EXCALIFONT,
        text,
        originalText: text,
        textAlign: element.textAlign ?? "left",
        verticalAlign: element.verticalAlign ?? "top",
        containerId: element.containerId ?? null,
        lineHeight: LINE_HEIGHT,
        autoResize: true,
        width: element.width ?? box.width,
        height: element.height ?? box.height,
      });
    }
    if (element.type === "arrow" || element.type === "line") {
      const width = Number(element.width ?? 0);
      const height = Number(element.height ?? 0);
      element.points ??= [[0, 0], [width, height]];
      if (element.type === "arrow") {
        element.endArrowhead ??= "arrow";
        element.startArrowhead ??= null;
        if (start?.id && !element.startBinding) element.startBinding = { elementId: start.id, focus: 0, gap: 4 };
        if (end?.id && !element.endBinding) element.endBinding = { elementId: end.id, focus: 0, gap: 4 };
      }
    }
    out.push(element);
    byId.set(id, element);

    if (label && typeof label.text === "string") {
      const fontSize = Number(label.fontSize ?? 20);
      const box = textBox(label.text, fontSize);
      const width = Number(element.width ?? 0);
      const height = Number(element.height ?? 0);
      const textId = uniqueId(`${id}-label`);
      const text: RawElement = {
        ...base(),
        strokeColor: label.strokeColor ?? element.strokeColor ?? "#1e1e1e",
        id: textId,
        type: "text",
        x: Number(element.x ?? 0) + (width - box.width) / 2,
        y: Number(element.y ?? 0) + (height - box.height) / 2,
        width: box.width,
        height: box.height,
        text: label.text,
        originalText: label.text,
        fontSize,
        fontFamily: EXCALIFONT,
        textAlign: label.textAlign ?? "center",
        verticalAlign: label.verticalAlign ?? "middle",
        containerId: id,
        lineHeight: LINE_HEIGHT,
        autoResize: true,
      };
      (element.boundElements as unknown[]).push({ type: "text", id: textId });
      out.push(text);
      byId.set(textId, text);
    }
  }

  for (const element of out) {
    if (element.type !== "arrow") continue;
    const ref = { type: "arrow", id: String(element.id) };
    bind((element.startBinding as { elementId?: string } | null)?.elementId, ref);
    bind((element.endBinding as { elementId?: string } | null)?.elementId, ref);
  }
  return out;
}
