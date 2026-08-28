#!/usr/bin/env node
// ローカル版エントリ: stdio MCP × markdown ファイル。
// ツール定義とハンドラは ../core/tools.ts（本番版と共有）。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, dispatch, RESOURCES, readResource,
  INSTRUCTIONS, PROMPTS, getPrompt } from '../core/tools.ts';
import { fsStore } from './lib/fs-store.ts';

const WRITES = new Set(['record_decision','file_analysis','record_memory',
  'record_outcome','retract_claim','update_page']);

const cli = process.argv[2];
if (cli) {
  const map = { '--briefing': 'get_coach_briefing', '--lint': 'lint_wiki' };
  if (cli === '--index') { console.log(`${fsStore.reindex()} pages indexed`); process.exit(0); }
  if (map[cli]) { console.log(await dispatch(fsStore, map[cli], {})); process.exit(0); }
  console.error('usage: server.js [--briefing|--lint|--index]'); process.exit(1);
}

const server = new Server({ name: 'coach-memory', title: 'コーチの記憶', version: '0.5.0' }, { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
server.setRequestHandler(GetPromptRequestSchema, async (req) => getPrompt(req.params.name));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
  contents: [{ uri: req.params.uri, mimeType: 'text/markdown',
    text: await readResource(fsStore, req.params.uri) }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const text = await dispatch(fsStore, name, args ?? {});
    if (WRITES.has(name)) fsStore.reindex();
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return { content: [{ type: 'text', text: e.message }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
