/**
 * Loads the Pi extension from a plain .mjs bench context.
 *
 * The host runtime provides `typebox`; the bench resolves it to the committed
 * stub via Node's sync module hooks, so no dependency is added.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "typebox") {
      return { url: new URL("../../test/helpers/typebox-stub.mjs", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export async function loadPiTools(options = {}) {
  if (options.socketPath) process.env.PI_ULTRASEARCH_SOCKET = options.socketPath;
  const mod = await import("../../index.ts");
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    registerTool: (def) => tools.set(def.name, def),
    registerCommand: (name, def) => commands.set(name, def),
    on: (name, fn) => {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => handlers.get(name)?.splice(handlers.get(name).indexOf(fn), 1);
    },
  };
  mod.default(pi);

  const bySuffix = (suffix) => {
    for (const name of tools.keys()) if (name.endsWith(suffix)) return name;
    return null;
  };
  return {
    tools,
    commands,
    handlers,
    pi,
    toolName: (suffix) => bySuffix(suffix),
    callTool: async (suffix, params) => {
      const name = bySuffix(suffix);
      if (!name) throw new Error(`no registered tool ends with '${suffix}' (have: ${[...tools.keys()].join(", ")})`);
      return tools.get(name).execute("bench", params);
    },
  };
}
