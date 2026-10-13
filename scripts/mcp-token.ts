// Prints a fresh JOBMANAGER_MCP_TOKEN line for .env.local (or your host's env).
// The MCP server URL is then https://<host>/api/mcp/<token>.
import { generateInboxToken } from "../src/lib/auth";

console.log(`JOBMANAGER_MCP_TOKEN=${generateInboxToken()}`);
