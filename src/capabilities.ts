import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertOk, resultText, type ExcalidrawMcp } from "./mcpClient.js";
import type { RuntimeExtensionActivationContext } from "./extensionProtocol.js";
import type { CapabilityDescriptor, CapabilityProvider, InvocationContext, JsonSchema } from "./runtimeProtocol.js";
import {
  drawnElementCount,
  excalidrawFile,
  hasRestore,
  parseElements,
  skeletonToExcalidraw,
  type RawElement,
  type SceneStore,
} from "./scene.js";

export const EXTENSION_ID = "@marshal/excalidraw";
export const APPLICATION_ID = "diagram";
const VERSION = "0.1.0";

const object = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const checkpointId = { type: "string", minLength: 1, maxLength: 128, description: "Checkpoint id returned by excalidraw.draw." };
const elementsInput = {
  description: "Excalidraw elements: a JSON array string (as the MCP's create_view takes) or the array itself. Call excalidraw.guide once first for the format, colors and camera rules.",
  anyOf: [{ type: "string", minLength: 2 }, { type: "array", minItems: 1, items: { type: "object" } }],
};

const descriptor = (
  name: string,
  title: string,
  description: string,
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
  extra: Partial<CapabilityDescriptor> = {},
): CapabilityDescriptor => ({
  protocolVersion: "1.0.0",
  name,
  version: VERSION,
  title,
  description,
  tags: ["excalidraw", "diagram", "mcp"],
  inputSchema,
  outputSchema,
  ...extra,
});

export const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  descriptor(
    "excalidraw.guide",
    "Excalidraw element format guide",
    "The official Excalidraw MCP's element format reference (read_me): element types, labels, arrow bindings, color palette, cameraUpdate sizing, checkpoints and delete. Read it once per conversation before the first excalidraw.draw.",
    object({}),
    object({ guide: { type: "string" } }, ["guide"]),
  ),
  descriptor(
    "excalidraw.draw",
    "Draw an Excalidraw diagram",
    "Render a hand-drawn diagram through the official Excalidraw MCP (create_view) and show it as an Excalidraw card in this chat (view mode inline; fullscreen lets the user edit). Returns a checkpointId: to change the diagram later, start elements with {\"type\":\"restoreCheckpoint\",\"id\":\"<checkpointId>\"} and add or delete elements; pass instanceId to redraw an open card in place.",
    object({
      elements: elementsInput,
      title: { type: "string", minLength: 1, maxLength: 120, description: "Short card title." },
      show: { type: "boolean", description: "Show the card (default true). false only creates the checkpoint." },
      placement: { enum: ["card", "transient"], description: "card (default) is saved in the conversation; transient floats above it." },
      slot: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,64}$", description: "Render the card inside your reply at a <!--ui:<slot>--> line written after this call." },
      afterMessageId: { type: "string", minLength: 1, maxLength: 256 },
      instanceId: { type: "string", minLength: 1, maxLength: 128, description: "Redraw this already-open diagram card instead of adding a new one." },
    }, ["elements"]),
    object({
      checkpointId: { type: "string" },
      elementCount: { type: "integer" },
      shown: { type: "boolean" },
      instanceId: { type: "string" },
      notice: { type: "string" },
      guidance: { type: "string" },
    }, ["checkpointId", "elementCount", "shown", "guidance"]),
  ),
  descriptor(
    "excalidraw.checkpoint.read",
    "Read a diagram checkpoint",
    "Read the stored elements of a diagram checkpoint, including edits the user made in the card's fullscreen editor. Check this before modifying a diagram the user may have touched.",
    object({ checkpointId }, ["checkpointId"]),
    object({ checkpointId: { type: "string" }, elements: { type: "array" }, editedInCard: { type: "boolean" } }, ["checkpointId", "elements", "editedInCard"]),
  ),
  descriptor(
    "excalidraw.export",
    "Share a diagram on excalidraw.com",
    "Upload a diagram (end-to-end encrypted, the key stays in the link) to excalidraw.com and return a shareable URL that opens it for editing. Anyone with the link can open it.",
    object({ checkpointId, elements: elementsInput }),
    object({ url: { type: "string" }, elementCount: { type: "integer" }, source: { enum: ["card", "checkpoint", "elements"] } }, ["url", "elementCount", "source"]),
    { permissions: [{ permission: "marshal.tool.invoke:excalidraw.export", risk: "medium", reason: "Uploads the diagram to excalidraw.com and creates a shareable link anyone with the URL can open." }] },
  ),
  descriptor(
    "excalidraw.save",
    "Save a diagram as a .excalidraw file",
    "Write a diagram to a local .excalidraw file (opens in excalidraw.com, the VS Code Excalidraw extension, or Obsidian). Uses the card's rendered scene, including the user's edits, when available.",
    object({
      checkpointId,
      elements: elementsInput,
      path: { type: "string", minLength: 1, maxLength: 4096, description: "Absolute destination path ending in .excalidraw." },
    }, ["path"]),
    object({ path: { type: "string" }, bytes: { type: "integer" }, elementCount: { type: "integer" }, source: { enum: ["card", "checkpoint", "elements"] } }, ["path", "bytes", "elementCount", "source"]),
    { permissions: [{ permission: "marshal.tool.invoke:excalidraw.save", risk: "medium", reason: "Writes a .excalidraw file to the given path on this machine." }] },
  ),
  descriptor(
    "excalidraw.mcp.list_tools",
    "List Excalidraw MCP tools",
    "Discover the raw tools of the Excalidraw MCP server and their input schemas. Prefer the named excalidraw.* capabilities; use this with excalidraw.mcp.call only for tools they do not cover.",
    object({}),
    object({ endpoint: { type: "string" }, tools: { type: "array" } }, ["endpoint", "tools"]),
  ),
  descriptor(
    "excalidraw.mcp.call",
    "Call an Excalidraw MCP tool",
    "Invoke a raw Excalidraw MCP tool by its exact name with arguments matching its input schema (from excalidraw.mcp.list_tools). create_view through this path does not show a card; use excalidraw.draw for that.",
    object({ tool: { type: "string", minLength: 1, maxLength: 128 }, arguments: { type: "object", additionalProperties: true } }, ["tool"]),
    object({ data: {} }, ["data"]),
    { permissions: [{ permission: "marshal.tool.invoke:excalidraw.mcp.call", risk: "medium", reason: "Runs a raw Excalidraw MCP tool, which can store or publish diagram data on Excalidraw's servers." }] },
  ),
  descriptor(
    "excalidraw.view.sync",
    "Sync a diagram card's scene",
    "Used by the diagram card: records the scene it rendered, and saves the user's edits back to the checkpoint so a later restoreCheckpoint includes them. Agents do not need to call this.",
    object({
      checkpointId,
      elements: { type: "array", maxItems: 20000, items: { type: "object" } },
      edited: { type: "boolean" },
    }, ["checkpointId", "elements", "edited"]),
    object({ checkpointId: { type: "string" }, savedToCheckpoint: { type: "boolean" } }, ["checkpointId", "savedToCheckpoint"]),
    { tags: ["excalidraw", "ui"] },
  ),
];

const DRAW_GUIDANCE = (id: string) =>
  `Diagram ${id} is drawn. For a new diagram, draw from scratch. To change this one, first call excalidraw.checkpoint.read {checkpointId:"${id}"} in case the user edited it, then call excalidraw.draw with elements starting [{"type":"restoreCheckpoint","id":"${id}"}, ...new elements] and remove elements with {"type":"delete","ids":"<id1>,<id2>"}. Pass instanceId to redraw the same card. excalidraw.export gives a shareable excalidraw.com link; excalidraw.save writes a .excalidraw file.`;

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid_request" });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseCheckpoint(text: string): RawElement[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("The Excalidraw MCP returned an unreadable checkpoint.");
  }
  const elements = record(parsed).elements;
  if (!Array.isArray(elements)) throw new Error("The Excalidraw MCP checkpoint has no elements.");
  return elements as RawElement[];
}

type Execute = NonNullable<RuntimeExtensionActivationContext["execute"]>;

export function createExcalidrawCapabilityProvider(options: {
  readonly mcp: ExcalidrawMcp;
  readonly scenes: SceneStore;
  readonly execute?: Execute;
}): CapabilityProvider {
  const { mcp, scenes } = options;
  let guide: string | undefined;

  const readCheckpoint = async (id: string) => parseCheckpoint(resultText(assertOk(await mcp.callTool("read_checkpoint", { id }), `Checkpoint "${id}" could not be read`)));

  const sceneFor = async (input: Record<string, unknown>): Promise<{ elements: RawElement[]; source: "card" | "checkpoint" | "elements" }> => {
    if (input.elements !== undefined) return { elements: skeletonToExcalidraw(parseElements(input.elements).elements), source: "elements" };
    if (typeof input.checkpointId !== "string" || !input.checkpointId) throw invalid("Pass checkpointId (from excalidraw.draw) or elements.");
    const scene = scenes.get(input.checkpointId);
    if (scene?.converted?.length) return { elements: scene.converted, source: "card" };
    return { elements: skeletonToExcalidraw(await readCheckpoint(input.checkpointId)), source: "checkpoint" };
  };

  const showCard = async (
    input: Record<string, unknown>,
    state: Record<string, unknown>,
    invocation: InvocationContext,
  ): Promise<{ instanceId?: string; notice?: string }> => {
    if (!options.execute) return { notice: "This host cannot show extension cards; open the diagram with excalidraw.export instead." };
    const instanceId = typeof input.instanceId === "string" ? input.instanceId : undefined;
    const owner = { extensionId: EXTENSION_ID, applicationId: APPLICATION_ID };
    const request = instanceId
      ? { target: "ui.application.update", input: { ...owner, instanceId, state, idempotencyKey: randomUUID() } }
      : {
          target: "ui.chat.card.show",
          input: {
            ...owner,
            placement: input.placement === "transient" ? "transient" : "card",
            title: typeof state.title === "string" ? state.title : "Excalidraw diagram",
            ...(typeof input.slot === "string" ? { slot: input.slot } : {}),
            ...(typeof input.afterMessageId === "string" ? { afterMessageId: input.afterMessageId } : {}),
            state,
            idempotencyKey: randomUUID(),
          },
        };
    try {
      const result = await options.execute({ protocolVersion: "1.0.0", targetType: "operation", ...request }, invocation);
      if (result.status !== "success") throw new Error(result.error?.message || "the host refused the card.");
      const output = record(result.result?.output);
      if (output.ok === false) throw new Error(String(record(output.error).message ?? "the host refused the card."));
      const value = record(output.value ?? output);
      const shown = record(value.instance).instanceId ?? record(value.receipt).instanceId ?? instanceId;
      return typeof shown === "string" ? { instanceId: shown } : {};
    } catch (error) {
      return { notice: `The diagram was created but the card could not be shown: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  const invoke = async (name: string, rawInput: unknown, invocation: InvocationContext) => {
    if (invocation.signal?.aborted) throw new Error("Cancelled.");
    const input = record(rawInput);
    switch (name) {
      case "excalidraw.guide": {
        guide ??= resultText(assertOk(await mcp.callTool("read_me", {}), "read_me failed"));
        return { output: { guide } };
      }
      case "excalidraw.draw": {
        const { json, elements } = parseElements(input.elements);
        const created = assertOk(await mcp.callTool("create_view", { elements: json }), "create_view failed");
        const id = record(created.structuredContent).checkpointId;
        if (typeof id !== "string" || !id) throw new Error(`create_view returned no checkpoint id: ${resultText(created).slice(0, 300)}`);
        // The server resolves restoreCheckpoint/delete into the stored checkpoint; a fresh drawing keeps
        // its own pseudo-elements so the card can apply the camera and inline deletes itself.
        const rendered = hasRestore(elements) ? await readCheckpoint(id) : elements;
        const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined;
        scenes.put({ checkpointId: id, title, elements: rendered, updatedAt: Date.now() });
        const card = input.show === false ? {} : await showCard(input, { checkpointId: id, ...(title ? { title } : {}), elements: rendered }, invocation);
        const hint = resultText(created).match(/\nTip: [^\n]+/)?.[0]?.trim();
        return {
          output: {
            checkpointId: id,
            elementCount: drawnElementCount(rendered),
            shown: Boolean(card.instanceId),
            ...(card.instanceId ? { instanceId: card.instanceId } : {}),
            ...(card.notice ? { notice: card.notice } : {}),
            guidance: hint ? `${DRAW_GUIDANCE(id)} ${hint}` : DRAW_GUIDANCE(id),
          },
        };
      }
      case "excalidraw.checkpoint.read": {
        if (typeof input.checkpointId !== "string" || !input.checkpointId) throw invalid("checkpointId is required.");
        return { output: { checkpointId: input.checkpointId, elements: await readCheckpoint(input.checkpointId), editedInCard: Boolean(scenes.get(input.checkpointId)?.edited) } };
      }
      case "excalidraw.export": {
        const scene = await sceneFor(input);
        const uploaded = await mcp.callTool("export_to_excalidraw", { json: JSON.stringify(excalidrawFile(scene.elements)) }).catch((error: Error) => {
          // Observed 2026-11-03: after a couple of quick uploads the hosted server stops answering exports for a while.
          if (/timed out/i.test(error.message)) throw new Error("The excalidraw.com upload timed out; the hosted Excalidraw MCP limits rapid uploads. Try again in a minute, or use excalidraw.save for a local .excalidraw file.");
          throw error;
        });
        const result = assertOk(uploaded, "Export failed");
        const url = resultText(result).trim();
        if (!/^https:\/\/excalidraw\.com\/#json=/.test(url)) throw new Error(`Export returned an unexpected link: ${url.slice(0, 200)}`);
        return { output: { url, elementCount: scene.elements.length, source: scene.source } };
      }
      case "excalidraw.save": {
        const target = typeof input.path === "string" ? input.path : "";
        if (!path.isAbsolute(target) || !target.endsWith(".excalidraw")) throw invalid("path must be an absolute path ending in .excalidraw.");
        const scene = await sceneFor(input);
        const text = `${JSON.stringify(excalidrawFile(scene.elements), null, 2)}\n`;
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, text, "utf8");
        return { output: { path: target, bytes: Buffer.byteLength(text), elementCount: scene.elements.length, source: scene.source } };
      }
      case "excalidraw.mcp.list_tools":
        return { output: { endpoint: mcp.endpoint, tools: await mcp.listTools() } };
      case "excalidraw.mcp.call": {
        if (typeof input.tool !== "string" || !input.tool.trim()) throw invalid('Pass "tool": an exact tool name from excalidraw.mcp.list_tools.');
        if (input.arguments !== undefined && (typeof input.arguments !== "object" || input.arguments === null || Array.isArray(input.arguments))) {
          throw invalid('"arguments" must be an object matching the tool\'s input schema.');
        }
        return { output: { data: await mcp.callTool(input.tool, record(input.arguments)) } };
      }
      case "excalidraw.view.sync": {
        if (typeof input.checkpointId !== "string" || !input.checkpointId) throw invalid("checkpointId is required.");
        if (!Array.isArray(input.elements)) throw invalid("elements must be an array.");
        const elements = input.elements as RawElement[];
        const existing = scenes.get(input.checkpointId);
        const edited = input.edited === true;
        scenes.put({
          checkpointId: input.checkpointId,
          title: existing?.title,
          elements: existing?.elements ?? elements,
          converted: elements,
          edited: edited || Boolean(existing?.edited),
          updatedAt: Date.now(),
        });
        if (edited) assertOk(await mcp.callTool("save_checkpoint", { id: input.checkpointId, data: JSON.stringify({ elements }) }), "Saving the edit failed");
        return { output: { checkpointId: input.checkpointId, savedToCheckpoint: edited } };
      }
      default:
        throw invalid(`Unknown Excalidraw capability ${JSON.stringify(name)}.`);
    }
  };

  return {
    id: "marshal.excalidraw",
    version: VERSION,
    list: () => DESCRIPTORS,
    get: (name) => DESCRIPTORS.find((entry) => entry.name === name),
    invoke,
  };
}
