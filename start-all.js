// start-all.js: Boots both the MCP Server (port 3000) and CareOrbit Web Chat (port 3001) concurrently.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log("\x1b[36m%s\x1b[0m", "=================================================");
console.log("\x1b[36m%s\x1b[0m", "  CareOrbit AI — Starting Full Stack Subsystems  ");
console.log("\x1b[36m%s\x1b[0m", "=================================================");

// 1. Start MCP Server (port 3000)
const mcp = spawn("node", ["server.js"], {
  cwd: __dirname,
  stdio: ["inherit", "pipe", "pipe"],
  env: process.env
});

mcp.stdout.on("data", (data) => {
  process.stdout.write(`\x1b[35m[mcp]\x1b[0m ${data}`);
});

mcp.stderr.on("data", (data) => {
  process.stderr.write(`\x1b[31m[mcp:err]\x1b[0m ${data}`);
});

// Wait briefly for MCP server port to bind, then start Web Chat server (port 3001)
setTimeout(() => {
  const web = spawn("node", ["webchat.js"], {
    cwd: __dirname,
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env
  });

  web.stdout.on("data", (data) => {
    process.stdout.write(`\x1b[36m[web]\x1b[0m ${data}`);
  });

  web.stderr.on("data", (data) => {
    process.stderr.write(`\x1b[31m[web:err]\x1b[0m ${data}`);
  });

  function cleanup() {
    console.log("\nShutting down CareOrbit AI servers...");
    try { mcp.kill(); } catch {}
    try { web.kill(); } catch {}
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}, 1200);
