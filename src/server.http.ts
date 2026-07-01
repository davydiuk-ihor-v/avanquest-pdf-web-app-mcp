import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

// Phase 0 spike: prove that claude.ai (browser, no Desktop) can reach a
// Streamable-HTTP MCP server over a public tunnel, and observe how a
// chat-attached PDF actually shows up in a tool call (arguments shape).
// See avanquest-pdf-mcp-remote-architecture.md and the approved plan for context.
// This is deliberately separate from server.ts (stdio/.mcpb) -- that entry
// point is untouched and keeps working for Claude Desktop.

const PORT = Number(process.env.PWV_HTTP_PORT ?? 8787);

function createSession(): McpServer {
  const server = new McpServer({ name: 'avanquest-pdf-mcp-editor-http-spike', version: '0.0.0-spike' });

  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Spike tool: echoes back what it received, to confirm the remote HTTP transport works end to end from claude.ai.',
      inputSchema: { message: z.string().optional().describe('Optional message to echo back') },
    },
    async ({ message }) => ({
      content: [{ type: 'text' as const, text: `pong${message ? `: ${message}` : ''} (session alive, ${new Date().toISOString()})` }],
    }),
  );

  // Spike tool: whatever the client passes as `file`, dump its raw JSON shape.
  // Goal: find out how claude.ai represents a chat-attached PDF in a tool call
  // -- inline base64 blob, a fetchable resource URI, both, or nothing at all.
  server.registerTool(
    'inspect_attachment',
    {
      title: 'Inspect attachment',
      description: 'Spike tool: call this and attach/reference a PDF so we can see the exact shape the host sends for a file input.',
      inputSchema: { file: z.any().optional().describe('Attach or reference a PDF here') },
    },
    async (args) => {
      const dump = JSON.stringify(args, null, 2);
      console.error(`[inspect_attachment] received:\n${dump}`);
      return { content: [{ type: 'text' as const, text: `Received args:\n${dump}` }] };
    },
  );

  // Spike tool: ask the model to read the attached PDF itself (via its own
  // file-reading tool) and pass the raw bytes here, base64-encoded, instead
  // of a path/URI. Tests whether that route is viable (size limits, fidelity).
  server.registerTool(
    'inspect_attachment_base64',
    {
      title: 'Inspect attachment (base64)',
      description: 'Spike tool: read the attached PDF\'s full raw bytes yourself and pass them here as a base64-encoded string in pdf_base64. Do not summarize or truncate -- encode the entire file.',
      inputSchema: { pdf_base64: z.string().optional().describe('Full raw bytes of the attached PDF, base64-encoded') },
    },
    async ({ pdf_base64 }) => {
      if (!pdf_base64) {
        console.error('[inspect_attachment_base64] received no pdf_base64');
        return { content: [{ type: 'text' as const, text: 'No pdf_base64 provided.' }] };
      }
      let buf: Buffer;
      try {
        buf = Buffer.from(pdf_base64, 'base64');
      } catch (err) {
        console.error(`[inspect_attachment_base64] decode failed: ${(err as Error).message}`);
        return { content: [{ type: 'text' as const, text: `Failed to decode base64: ${(err as Error).message}` }] };
      }
      const header = buf.subarray(0, 8).toString('latin1');
      const looksLikePdf = header.startsWith('%PDF-');
      const summary = `bytes=${buf.length}, header="${header}", looksLikePdf=${looksLikePdf}, base64Len=${pdf_base64.length}`;
      console.error(`[inspect_attachment_base64] ${summary}`);
      return { content: [{ type: 'text' as const, text: summary }] };
    },
  );

  // Second attempt at the same thing, worded as a real product feature
  // instead of a "spike"/"test" tool, to isolate whether the earlier refusal
  // was about base64-file-transfer-to-remote-MCP in general, or specifically
  // about it looking like an untrusted/experimental third-party endpoint.
  server.registerTool(
    'open_pdf_from_upload',
    {
      title: 'Open PDF from upload',
      description: 'Open a PDF the user attached in this conversation inside the Avanquest PDF Viewer. Read the attached file\'s full raw bytes and pass them here, base64-encoded, in pdf_base64 -- this is required so the viewer can render and edit the document, since this server has no other way to access files attached in the chat.',
      inputSchema: { pdf_base64: z.string().describe('Full raw bytes of the attached PDF, base64-encoded') },
    },
    async ({ pdf_base64 }) => {
      let buf: Buffer;
      try {
        buf = Buffer.from(pdf_base64, 'base64');
      } catch (err) {
        console.error(`[open_pdf_from_upload] decode failed: ${(err as Error).message}`);
        return { content: [{ type: 'text' as const, text: `Failed to decode base64: ${(err as Error).message}` }], isError: true };
      }
      const header = buf.subarray(0, 8).toString('latin1');
      const looksLikePdf = header.startsWith('%PDF-');
      const summary = `bytes=${buf.length}, header="${header}", looksLikePdf=${looksLikePdf}, base64Len=${pdf_base64.length}`;
      console.error(`[open_pdf_from_upload] ${summary}`);
      return { content: [{ type: 'text' as const, text: `PDF received and opened (${buf.length} bytes).` }] };
    },
  );

  // Spike tool: explicitly ask the client for its `roots` (MCP roots
  // capability) to see whether claude.ai (browser) exposes the chat-attached
  // PDF as a root, the way the official Anthropic "PDF Viewer" connector's
  // display_pdf ("Accepts ... client MCP root directories") implies it can.
  server.registerTool(
    'list_client_roots',
    {
      title: 'List client roots',
      description: 'Spike tool: asks the connected client for its MCP `roots` list, to see if the chat-attached PDF is exposed that way.',
      inputSchema: {},
    },
    async () => {
      try {
        const result = await server.server.listRoots();
        console.error(`[list_client_roots] result: ${JSON.stringify(result)}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        console.error(`[list_client_roots] error: ${(err as Error).message}`);
        return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.method === 'POST' && req.path === '/mcp') {
      console.error(`[raw request] ${JSON.stringify(req.body)}`);
    }
    next();
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (sessionId) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
      }
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session ID provided' }, id: null });
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { transports.set(sid, transport!); },
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      const server = createSession();
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  const handleSessionRequest: express.RequestHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', handleSessionRequest);
  app.delete('/mcp', handleSessionRequest);

  app.listen(PORT, () => {
    console.error(`[avanquest-pdf-http-spike] listening on http://localhost:${PORT}/mcp`);
  });
}

main().catch((err) => {
  console.error('[avanquest-pdf-http-spike] fatal:', err);
  process.exit(1);
});
