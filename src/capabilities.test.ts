import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createExcalidrawCapabilityProvider, DESCRIPTORS } from "./capabilities.js";
import type { ExcalidrawMcp, McpToolResult } from "./mcpClient.js";
import type { InvocationContext } from "./runtimeProtocol.js";
import { SceneStore, skeletonToExcalidraw, parseElements } from "./scene.js";
import { createDiagramUiApplication } from "./ui.js";

const invocation: InvocationContext = { principal: { id: "agent", kind: "agent" }, scope: { sessionId: "s1" } };
const text = (value: string): McpToolResult => ({ content: [{ type: "text", text: value }] });
const boxes = [
  { type: "cameraUpdate", x: 0, y: 0, width: 800, height: 600 },
  { type: "rectangle", id: "a", x: 0, y: 0, width: 160, height: 60, label: { text: "Hello" } },
  { type: "rectangle", id: "b", x: 300, y: 0, width: 160, height: 60, label: { text: "World" } },
  { type: "arrow", id: "c", x: 160, y: 30, width: 140, height: 0, start: { id: "a" }, end: { id: "b" } },
];

function fakeMcp(checkpoints: Record<string, unknown[]> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const mcp: ExcalidrawMcp = {
    endpoint: "https://mcp.example/mcp",
    listTools: async () => [{ name: "read_me" }, { name: "create_view" }],
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "read_me") return text("# Excalidraw Element Format");
      if (name === "create_view") return { ...text('Diagram displayed! Checkpoint id: "cp1".'), structuredContent: { checkpointId: "cp1" } };
      if (name === "read_checkpoint") {
        const elements = checkpoints[String(args.id)];
        return elements ? text(JSON.stringify({ elements })) : { ...text("not found"), isError: true };
      }
      if (name === "export_to_excalidraw") return text("https://excalidraw.com/#json=abc,key");
      if (name === "save_checkpoint") return text("ok");
      return { ...text(`unknown tool ${name}`), isError: true };
    },
  };
  return { mcp, calls };
}

function provider(options: { checkpoints?: Record<string, unknown[]>; execute?: ReturnType<typeof vi.fn> } = {}) {
  const { mcp, calls } = fakeMcp(options.checkpoints);
  const scenes = new SceneStore();
  const execute =
    options.execute ??
    vi.fn(async () => ({ status: "success" as const, result: { output: { ok: true, value: { receipt: { instanceId: "inst-1" } } } } }));
  return { calls, scenes, execute, capabilities: createExcalidrawCapabilityProvider({ mcp, scenes, execute: execute as never }) };
}

describe("excalidraw.draw", () => {
  it("creates the checkpoint through create_view and shows the card with the elements", async () => {
    const { capabilities, calls, execute } = provider();
    const { output } = await capabilities.invoke("excalidraw.draw", { elements: JSON.stringify(boxes), title: "Flow" }, invocation);
    expect(calls[0]).toEqual({ name: "create_view", args: { elements: JSON.stringify(boxes) } });
    expect(output).toMatchObject({ checkpointId: "cp1", elementCount: 3, shown: true, instanceId: "inst-1" });
    const [request, context] = execute.mock.calls[0]!;
    expect(context).toBe(invocation);
    expect(request).toMatchObject({
      target: "ui.chat.card.show",
      input: { extensionId: "@marshal/excalidraw", applicationId: "diagram", placement: "card", title: "Flow", state: { checkpointId: "cp1", title: "Flow", elements: boxes } },
    });
  });

  it("renders the server-resolved checkpoint when restoring", async () => {
    const resolved = [boxes[1], { type: "ellipse", id: "d", x: 0, y: 100, width: 50, height: 50 }];
    const { capabilities, execute } = provider({ checkpoints: { cp1: resolved } });
    const { output } = await capabilities.invoke(
      "excalidraw.draw",
      { elements: [{ type: "restoreCheckpoint", id: "cp0" }, { type: "delete", ids: "b" }, resolved[1]] },
      invocation,
    );
    expect(output).toMatchObject({ elementCount: 2 });
    expect(execute.mock.calls[0]![0]).toMatchObject({ input: { state: { elements: resolved } } });
  });

  it("redraws an open card in place when instanceId is given", async () => {
    const { capabilities, execute } = provider();
    await capabilities.invoke("excalidraw.draw", { elements: boxes, instanceId: "inst-9" }, invocation);
    expect(execute.mock.calls[0]![0]).toMatchObject({ target: "ui.application.update", input: { instanceId: "inst-9", state: { checkpointId: "cp1" } } });
  });

  it("still returns the checkpoint when the card cannot be shown", async () => {
    const execute = vi.fn(async () => ({ status: "error" as const, error: { message: "no chat" } }));
    const { capabilities } = provider({ execute });
    const { output } = await capabilities.invoke("excalidraw.draw", { elements: boxes }, invocation);
    expect(output).toMatchObject({ checkpointId: "cp1", shown: false });
    expect((output as { notice: string }).notice).toContain("no chat");
  });

  it("rejects malformed elements before calling the server", async () => {
    const { capabilities, calls } = provider();
    await expect(capabilities.invoke("excalidraw.draw", { elements: "[{]" }, invocation)).rejects.toThrow(/not valid JSON/);
    await expect(capabilities.invoke("excalidraw.draw", { elements: [{ id: "x" }] }, invocation)).rejects.toThrow(/needs a string "type"/);
    expect(calls).toHaveLength(0);
  });
});

describe("export, save and edits", () => {
  it("exports the card's rendered scene once the card has synced it", async () => {
    const { capabilities, calls } = provider();
    const rendered = [{ type: "rectangle", id: "a", x: 0, y: 0, width: 10, height: 10, version: 3 }];
    await capabilities.invoke("excalidraw.view.sync", { checkpointId: "cp1", elements: rendered, edited: false }, invocation);
    const { output } = await capabilities.invoke("excalidraw.export", { checkpointId: "cp1" }, invocation);
    expect(output).toEqual({ url: "https://excalidraw.com/#json=abc,key", elementCount: 1, source: "card" });
    const uploaded = JSON.parse(String(calls.find((call) => call.name === "export_to_excalidraw")!.args.json));
    expect(uploaded).toMatchObject({ type: "excalidraw", version: 2, elements: rendered });
    expect(calls.some((call) => call.name === "save_checkpoint")).toBe(false);
  });

  it("falls back to converting the server checkpoint when no card rendered it", async () => {
    const { capabilities } = provider({ checkpoints: { cp7: boxes } });
    const { output } = await capabilities.invoke("excalidraw.export", { checkpointId: "cp7" }, invocation);
    expect(output).toMatchObject({ source: "checkpoint", elementCount: 5 });
  });

  it("saves user edits back to the server checkpoint", async () => {
    const edited = [{ type: "ellipse", id: "e", x: 1, y: 2, width: 3, height: 4 }];
    const { capabilities, calls } = provider({ checkpoints: { cp1: edited } });
    const { output } = await capabilities.invoke("excalidraw.view.sync", { checkpointId: "cp1", elements: edited, edited: true }, invocation);
    expect(output).toEqual({ checkpointId: "cp1", savedToCheckpoint: true });
    expect(calls.at(-1)).toEqual({ name: "save_checkpoint", args: { id: "cp1", data: JSON.stringify({ elements: edited }) } });
    const read = await capabilities.invoke("excalidraw.checkpoint.read", { checkpointId: "cp1" }, invocation);
    expect(read.output).toEqual({ checkpointId: "cp1", elements: edited, editedInCard: true });
  });

  it("writes a .excalidraw file and refuses relative paths", async () => {
    const { capabilities } = provider();
    const directory = await mkdtemp(path.join(tmpdir(), "excalidraw-ext-"));
    const target = path.join(directory, "nested", "flow.excalidraw");
    const { output } = await capabilities.invoke("excalidraw.save", { elements: boxes, path: target }, invocation);
    expect(output).toMatchObject({ path: target, source: "elements", elementCount: 5 });
    const file = JSON.parse(await readFile(target, "utf8"));
    expect(file.type).toBe("excalidraw");
    await expect(capabilities.invoke("excalidraw.save", { elements: boxes, path: "flow.excalidraw" }, invocation)).rejects.toThrow(/absolute path/);
  });

  it("passes raw tool calls through and names the missing tool field", async () => {
    const { capabilities } = provider();
    const { output } = await capabilities.invoke("excalidraw.mcp.call", { tool: "read_me", arguments: {} }, invocation);
    expect(output).toEqual({ data: text("# Excalidraw Element Format") });
    await expect(capabilities.invoke("excalidraw.mcp.call", { name: "read_me" }, invocation)).rejects.toThrow(/"tool"/);
  });
});

describe("skeletonToExcalidraw", () => {
  it("turns labels into bound text and start/end into arrow bindings, applying deletes", () => {
    const elements = skeletonToExcalidraw([...boxes, { type: "rectangle", id: "z", x: 0, y: 0, width: 1, height: 1 }, { type: "delete", ids: "z" }]);
    const byId = new Map(elements.map((element) => [element.id, element]));
    expect(byId.has("z")).toBe(false);
    expect(byId.get("a-label")).toMatchObject({ type: "text", containerId: "a", text: "Hello", textAlign: "center" });
    expect(byId.get("a")!.boundElements).toEqual([{ type: "text", id: "a-label" }, { type: "arrow", id: "c" }]);
    expect(byId.get("c")).toMatchObject({ startBinding: { elementId: "a" }, endBinding: { elementId: "b" }, points: [[0, 0], [140, 0]] });
    expect(elements.some((element) => element.type === "cameraUpdate")).toBe(false);
  });

  it("accepts the JSON string or the array", () => {
    expect(parseElements(JSON.stringify(boxes)).elements).toEqual(boxes);
    expect(parseElements(boxes).json).toBe(JSON.stringify(boxes));
  });
});

describe("diagram UI application", () => {
  const app = createDiagramUiApplication();

  it("declares mobile and desktop and maps its actions to real capabilities", () => {
    expect(app.metadata).toEqual({ "marshal.ui.viewports": ["mobile", "desktop"] });
    expect(app.application.version).toBe("1.0.0");
    const actions = app.application.actions as Array<{ id: string; target: { capability: string } }>;
    for (const action of actions) {
      expect(action.id).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(DESCRIPTORS.some((entry) => entry.name === action.target.capability)).toBe(true);
    }
  });

  it("ships one self-contained document with no external scripts or styles", () => {
    const html = app.resource.text;
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // Script text ends only at "</script", so string literals inside the bundle cannot create elements.
    const open = html.indexOf("<script>");
    const close = html.lastIndexOf("</script>");
    const scriptBody = html.slice(open + "<script>".length, close);
    expect(scriptBody).not.toMatch(/<\/script/i);
    const markup = html.slice(0, open) + html.slice(close);
    expect(markup).not.toMatch(/<script[^>]+src=|<link[^>]+href=/i);
    expect(markup).not.toMatch(/url\(\s*["']?https?:/i);
  });
});
