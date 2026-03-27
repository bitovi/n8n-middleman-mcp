import http from 'node:http';
import { MCP_PORT } from './src/config.js';
import { handleRequest } from './src/routes/handleRequest.js';

const httpServer = http.createServer(async (req, res) => {
  await handleRequest(req, res);
});

httpServer.listen(MCP_PORT, () => {
  console.log(`External MCP connector listening at http://localhost:${MCP_PORT}/mcp`);
});