import { APPLICATION_ID, DESCRIPTORS } from "./capabilities.js";
import type { RuntimeExtensionUiApplication } from "./extensionProtocol.js";
import { VIEW_CSS, VIEW_SCRIPT } from "./generated/viewAssets.js";

// UI application manifest protocol version; the host refuses anything but 1.0.0.
const APPLICATION_VERSION = "1.0.0";

/** Inline-only document: the host CSP allows no network, so Excalidraw, React and fonts are all bundled in. */
export function buildDiagramHtml(): string {
  const script = VIEW_SCRIPT.replace(/<\/script/gi, "<\\/script");
  const css = VIEW_CSS.replace(/<\/style/gi, "<\\/style");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Excalidraw</title><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>`;
}

const ACTIONS: ReadonlyArray<{ capability: string; risk: string; idempotency: string }> = [
  { capability: "excalidraw.view.sync", risk: "write", idempotency: "supported" },
  { capability: "excalidraw.export", risk: "external-effect", idempotency: "none" },
];

export function createDiagramUiApplication(): RuntimeExtensionUiApplication {
  return {
    id: APPLICATION_ID,
    title: "Excalidraw diagram",
    description: "A hand-drawn Excalidraw diagram drawn by the agent through the Excalidraw MCP. View inline; edit in fullscreen.",
    renderId: "excalidraw.diagram.v1",
    resource: { uri: "ui://marshal/excalidraw/diagram", mimeType: "text/html", text: buildDiagramHtml() },
    application: {
      version: APPLICATION_VERSION,
      presentationModes: ["inline", "fullscreen"],
      tools: [],
      actions: ACTIONS.map((spec) => {
        const descriptor = DESCRIPTORS.find((entry) => entry.name === spec.capability);
        if (!descriptor) throw new Error(`Missing capability descriptor for UI action "${spec.capability}".`);
        return {
          id: spec.capability.replace(/\./g, "-"),
          version: APPLICATION_VERSION,
          title: descriptor.title ?? descriptor.name,
          target: { kind: "capability", capability: descriptor.name },
          inputSchema: descriptor.inputSchema,
          outputSchema: descriptor.outputSchema,
          allowedScopes: ["session"],
          requiredPermissions: [],
          risk: spec.risk,
          idempotency: spec.idempotency,
        };
      }),
    },
    tags: ["excalidraw", "diagram", "whiteboard"],
    metadata: { "marshal.ui.viewports": ["mobile", "desktop"] },
  };
}
