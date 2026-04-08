#!/usr/bin/env node
/**
 * MCP stdio server that bridges Paperclip plugin tools to Claude Code.
 *
 * Translates JSON-RPC 2.0 over stdin/stdout into HTTP calls against:
 *   GET  /api/plugins/tools          — list available plugin tools
 *   POST /api/plugins/tools/execute  — execute a plugin tool
 *
 * Environment variables:
 *   PAPERCLIP_API_URL      — Paperclip server base URL (required)
 *   PAPERCLIP_API_KEY      — Bearer token (optional, not needed in local_trusted mode)
 *   PAPERCLIP_AGENT_ID     — Agent ID for runContext
 *   PAPERCLIP_COMPANY_ID   — Company ID for runContext
 *   PAPERCLIP_RUN_ID       — Run ID for runContext
 *   PAPERCLIP_PROJECT_ID   — Project ID for runContext (falls back to company ID)
 */

const API_URL = process.env.PAPERCLIP_API_URL;
const API_KEY = process.env.PAPERCLIP_API_KEY;
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID || "";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";
const RUN_ID = process.env.PAPERCLIP_RUN_ID || "";
const PROJECT_ID = process.env.PAPERCLIP_PROJECT_ID || COMPANY_ID;

if (!API_URL) {
  process.stderr.write("mcp-bridge: PAPERCLIP_API_URL is required\n");
  process.exit(1);
}

// Reverse map: MCP-safe name → Paperclip namespaced name
const toolNameMap = new Map();

function toMcpName(namespacedName) {
  return namespacedName.replace(/\./g, "_").replace(/:/g, "__");
}

function toPaperclipName(mcpName) {
  return toolNameMap.get(mcpName) || mcpName;
}

function buildHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  return headers;
}

async function apiGet(path) {
  const res = await fetch(`${API_URL}${path}`, { headers: buildHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 handlers
// ---------------------------------------------------------------------------

async function handleInitialize(params) {
  return {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "paperclip-tools", version: "0.1.0" },
  };
}

async function handleToolsList() {
  let tools;
  try {
    tools = await apiGet("/api/plugins/tools");
  } catch {
    return { tools: [] };
  }
  if (!Array.isArray(tools)) return { tools: [] };

  toolNameMap.clear();
  return {
    tools: tools.map((t) => {
      const mcpName = toMcpName(t.name);
      toolNameMap.set(mcpName, t.name);
      return {
        name: mcpName,
        description: `[${t.displayName}] ${t.description}`,
        inputSchema: t.parametersSchema || { type: "object", properties: {} },
      };
    }),
  };
}

async function handleToolsCall(params) {
  const { name, arguments: args } = params;
  const paperclipName = toPaperclipName(name);
  const runContext = {
    agentId: AGENT_ID,
    runId: RUN_ID,
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
  };

  try {
    const response = await apiPost("/api/plugins/tools/execute", {
      tool: paperclipName,
      parameters: args || {},
      runContext,
    });

    const result = response.result || response;
    if (result.error) {
      return {
        content: [{ type: "text", text: result.error }],
        isError: true,
      };
    }
    const text = result.content || JSON.stringify(result.data ?? result);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Plugin tool error: ${err.message}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 dispatch
// ---------------------------------------------------------------------------

const HANDLERS = {
  initialize: handleInitialize,
  "notifications/initialized": async () => undefined,
  "tools/list": handleToolsList,
  "tools/call": handleToolsCall,
};

async function dispatch(message) {
  const { jsonrpc, id, method, params } = message;
  if (jsonrpc !== "2.0") return null;

  // Notifications (no id) — fire and forget
  if (id === undefined || id === null) {
    const handler = HANDLERS[method];
    if (handler) await handler(params).catch(() => {});
    return null;
  }

  const handler = HANDLERS[method];
  if (!handler) {
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
  }

  try {
    const result = await handler(params);
    return { jsonrpc: "2.0", id, result: result ?? {} };
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// Stdio transport (line-delimited JSON)
// ---------------------------------------------------------------------------

let buffer = "";
let pending = Promise.resolve();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`mcp-bridge: invalid JSON: ${line.slice(0, 200)}\n`);
      continue;
    }

    // Chain dispatches so they run in order and we can await them on exit
    pending = pending.then(async () => {
      const response = await dispatch(message);
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    });
  }
});

process.stdin.on("end", () => {
  pending.then(() => process.exit(0));
});
process.stderr.write("mcp-bridge: started\n");
