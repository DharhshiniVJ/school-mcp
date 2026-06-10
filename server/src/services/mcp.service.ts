import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let mcpClient: Client | null = null;

/**
 * Initializes and connects the MCP Client to the local MCP Server subprocess
 */
export async function initMcpClient(): Promise<Client> {
  if (mcpClient) {
    return mcpClient;
  }

  console.error('[Gateway MCP Link] Spawning MCP server subprocess...');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // Locate server.js: server/dist/services/mcp.service.js -> server/dist/server.js
  const serverPath = path.resolve(__dirname, '..', 'server.js');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'staging',
      // Ensure it doesn't try to mock roles when invoked through the gateway
      MOCK_ROLE: ''
    }
  });

  const client = new Client(
    {
      name: 'school-gateway-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  try {
    await client.connect(transport);
    console.error('[Gateway MCP Link] Connected to MCP server successfully.');
    mcpClient = client;
    return mcpClient;
  } catch (error) {
    console.error('[Gateway MCP Link] Failed to connect to MCP server:', error);
    throw error;
  }
}

/**
 * Executes an MCP database tool, injecting the actor's token in metadata
 */
export async function callMcpTool(toolName: string, toolArgs: any, token: string): Promise<any> {
  const client = await initMcpClient();
  
  // Inject the token in standard metadata parameters
  const params = {
    name: toolName,
    arguments: {
      ...toolArgs,
      _meta: { token }
    }
  };

  try {
    const response = await client.callTool(params);
    return response;
  } catch (error: any) {
    console.error(`[Gateway MCP Link] Error invoking tool "${toolName}":`, error);
    throw error;
  }
}
