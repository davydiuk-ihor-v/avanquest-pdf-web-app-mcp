import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type ClientInfo = {
  name: string;
  version: string;
};

let _clientInfo: ClientInfo | undefined;

export function setupClientInfo(server: McpServer): void {
  server.server.oninitialized = () => {
    _clientInfo = server.server.getClientVersion();
    const isClaudeClient = _clientInfo?.name?.toLowerCase().includes('claude') ?? false;
    console.error(`[avanquest-pdf] client connected: ${JSON.stringify(_clientInfo)} isClaudeClient=${isClaudeClient}`);
  };
}

export function getClientInfo(): ClientInfo | undefined {
  return _clientInfo;
}

export function isClaudeClient(): boolean {
  return _clientInfo?.name?.toLowerCase().includes('claude') ?? false;
}
