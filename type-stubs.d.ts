// Ambient stubs for Pi runtime modules provided by the agent host.
declare module "@earendil-works/pi-coding-agent" {
  export type AgentToolResult<T = unknown> = {
    content: { type: string; text?: string }[];
    details?: unknown;
  };
  export type ExtensionAPI = any;
  export type ToolDefinition = any;
  export function defineTool<T = unknown>(definition: any): any;
}

declare module "typebox" {
  export const Type: any;
}
