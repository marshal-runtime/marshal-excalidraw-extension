import { convertToExcalidrawElements, FONT_FAMILY } from "@excalidraw/excalidraw";

export type RawElement = Record<string, unknown> & { type: string; id?: string };
export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const PSEUDO_TYPES = new Set(["cameraUpdate", "delete", "restoreCheckpoint"]);

/** Same resolution as the official Excalidraw MCP app: final camera, deletes applied, labels centered, text in Excalifont. */
export function toScene(raw: readonly RawElement[]): { elements: readonly unknown[]; camera: Camera | null } {
  let camera: Camera | null = null;
  const deleted = new Set<string>();
  for (const element of raw) {
    if (element.type === "cameraUpdate") {
      const { x, y, width, height } = element as unknown as Camera;
      if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) camera = { x, y, width, height };
    } else if (element.type === "delete") {
      for (const id of String(element.ids ?? element.id ?? "").split(",")) if (id.trim()) deleted.add(id.trim());
    }
  }
  const drawn = raw
    .filter((element) => !PSEUDO_TYPES.has(element.type))
    .filter((element) => !deleted.has(String(element.id)) && !deleted.has(String(element.containerId ?? "")))
    .map((element) =>
      element.label && typeof element.label === "object"
        ? { ...element, label: { textAlign: "center", verticalAlign: "middle", ...(element.label as object) } }
        : element,
    );
  const elements = convertToExcalidrawElements(drawn as never, { regenerateIds: false }).map((element) =>
    element.type === "text" ? { ...element, fontFamily: FONT_FAMILY.Excalifont } : element,
  );
  return { elements, camera };
}
