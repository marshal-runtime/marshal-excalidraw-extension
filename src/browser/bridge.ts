// MCP-Apps postMessage bridge to the Marshal host (see Marshal's packagedUiBridge.ts).
type Handler = (params: Record<string, unknown>) => void;

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const handlers = new Map<string, Set<Handler>>();

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

addEventListener("message", (event) => {
  if (event.source !== parent || !event.data || event.data.jsonrpc !== "2.0") return;
  const message = event.data as { id?: string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
  if (message.id !== undefined && pending.has(message.id)) {
    const call = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message || "Host request failed."));
    else call.resolve(message.result);
    return;
  }
  if (message.method) for (const handler of handlers.get(message.method) ?? []) handler(message.params ?? {});
});

export function request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = newId();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
}

export function notify(method: string, params: Record<string, unknown> = {}): void {
  parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
}

export function on(method: string, handler: Handler): () => void {
  const set = handlers.get(method) ?? new Set<Handler>();
  set.add(handler);
  handlers.set(method, set);
  return () => set.delete(handler);
}

export async function callCapability<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await request<{ structuredContent?: { output?: T } }>("tools/call", {
    name,
    arguments: args,
    _meta: { idempotencyKey: newId() },
  });
  return result?.structuredContent?.output as T;
}
