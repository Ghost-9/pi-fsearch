import { registerHooks } from "node:module";

/**
 * Resolves the host-provided `typebox` module to the committed stub so the Pi
 * extension can be imported from tests without installing a dependency.
 * Must run before index.ts is dynamically imported.
 */
registerHooks({
  resolve(specifier: string, context: any, nextResolve: (spec: string, ctx: any) => any) {
    if (specifier === "typebox") {
      return { url: new URL("./typebox-stub.mjs", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export interface PiHarness {
  tools: Map<string, any>;
  commands: Map<string, any>;
  handlers: Map<string, Array<(event: any) => any>>;
  mod: any;
  toolName(suffix: string): string | null;
  callTool(suffix: string, params: any): Promise<any>;
  emit(event: string, payload: any): Promise<any[]>;
}

export async function loadPiHarness(options: { socketPath?: string } = {}): Promise<PiHarness> {
  if (options.socketPath) process.env.PI_ULTRASEARCH_SOCKET = options.socketPath;
  const mod = await import("../../index.ts");

  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any) => any>>();
  const pi = {
    registerTool: (def: any) => tools.set(def.name, def),
    registerCommand: (name: string, def: any) => commands.set(name, def),
    on: (name: string, fn: (event: any) => any) => {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name)!.push(fn);
      return () => {
        const list = handlers.get(name);
        if (list) list.splice(list.indexOf(fn), 1);
      };
    },
  };
  mod.default(pi);

  const toolName = (suffix: string): string | null => {
    for (const name of tools.keys()) if (name.endsWith(suffix)) return name;
    return null;
  };

  return {
    tools,
    commands,
    handlers,
    mod,
    toolName,
    callTool: async (suffix: string, params: any) => {
      const name = toolName(suffix);
      if (!name) throw new Error(`no registered tool ends with '${suffix}' (have: ${[...tools.keys()].join(", ")})`);
      return tools.get(name)!.execute("test-call", params);
    },
    emit: async (event: string, payload: any) => {
      const list = handlers.get(event) ?? [];
      return await Promise.all(list.map((fn) => fn(payload)));
    },
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `fn` returns truthy or the timeout elapses. */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 2000, intervalMs = 25): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(intervalMs);
  }
  return null;
}
