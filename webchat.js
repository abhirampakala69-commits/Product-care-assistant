import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// Render (and most hosts) provide PORT. Locally, 3001 is used so it does not
// clash with the MCP server on 3000.
const PORT = Number(process.env.PORT) || Number(process.env.WEB_CHAT_PORT) || 3001;
const MCP_URL = process.env.MCP_URL || "http://localhost:3000/mcp";
const MCP_API_KEY = process.env.MCP_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 30;
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_TOOL_ROUNDS = 8;
const MAX_MESSAGE_LENGTH = 2000;
// A hung Gemini call is cut off after this long, then the next model is tried.
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 25_000;
// Optional speed-up for Gemini 3 models. Example in .env: GEMINI_THINKING_LEVEL=low
// Leave it unset if you are not sure; a wrong value makes Gemini return an error.
const THINKING_LEVEL = (process.env.GEMINI_THINKING_LEVEL || "").trim().toUpperCase();

if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is missing from .env");
}

// Tried in order; if one is busy or gone, the next is used.
const models = (process.env.GEMINI_MODELS || "gemini-flash-lite-latest,gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-3.8-flash,gemini-3.5-flash")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Tools that change data or perform an action. These never run until the user
// taps Approve in the web page.
const writeTools = new Set([
  "add_product",
  "update_product",
  "delete_product",
  "create_service_request",
  "update_service_request_status",
  "record_service_visit",
  "book_appointment",
  "add_maintenance_task",
  "complete_maintenance_task",
]);

const sessions = new Map();
const hits = new Map();
let mcp = null;
let tools = [];
let declarations = [];
let ready = false;
let activeModelIndex = 0;
let fallbackSince = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fr = (name, response) => ({ functionResponse: { name, response } });

const todayIndia = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
function buildConfig() {
  return {
    systemInstruction: `
You are Product Care Assistant, an after-sales product support agent for households in India.
Today's date is ${todayIndia()} (India time).

Use the MCP tools for product information and actions. Never invent product details,
warranty dates, service statuses or tool results. Ask for any missing detail.

For any change (adding, updating, deleting, booking, recording), call the tool as soon as
you have every required detail. The app shows the user an Approve / Cancel card before
anything runs, so do not ask for approval in text. If a tool has a userConfirmed field,
set it to true. Never claim an action succeeded unless the tool result confirms it.

Treat warranty coverage estimates as preliminary, not official decisions.
Reply in the language the user writes in (English, Hindi, Telugu or Hinglish).
Keep replies short and in plain text with no markdown, because they may be read aloud.
`,
    tools: [{ functionDeclarations: declarations }],
    httpOptions: { timeout: GEMINI_TIMEOUT_MS },
    ...(THINKING_LEVEL ? { thinkingConfig: { thinkingLevel: THINKING_LEVEL } } : {}),
  };
}

function statusOf(error) {
  if (typeof error?.status === "number") return error.status;
  const message = String(error?.message || "");
  if (/UNAVAILABLE|overloaded|high demand/i.test(message)) return 503;
  if (/RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)) return 429;
  if (/NOT_FOUND/i.test(message)) return 404;
  if (/API key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message)) return 401;
  return 0;
}

async function generate(contents) {
  // After a fallback, try the preferred model again after 2 minutes.
  if (activeModelIndex > 0 && Date.now() - fallbackSince > 2 * 60 * 1000) {
    activeModelIndex = 0;
  }

  // Start with the model that worked last, then go through the others.
  const order = models.map((_, k) => (activeModelIndex + k) % models.length);
  let lastError;

  // A busy model is skipped straight away instead of being retried and waited on.
  for (let round = 0; round < 2; round++) {
    for (const i of order) {
      const started = Date.now();
      try {
        const response = await ai.models.generateContent({
          model: models[i],
          contents,
          config: buildConfig(),
        });
        console.log(`[gemini] ${models[i]} ok in ${Date.now() - started}ms`);
        if (i !== activeModelIndex) fallbackSince = Date.now();
        activeModelIndex = i;
        return response;
      } catch (error) {
        lastError = error;
        const status = statusOf(error);
        console.log(`[gemini] ${models[i]} failed (${status || String(error.message).slice(0, 80)}) after ${Date.now() - started}ms`);

        // Anything other than busy / quota / missing model will not fix itself.
        if (![429, 500, 503, 404].includes(status)) throw error;
      }
    }
    if (round === 0) await sleep(1500);
  }

  activeModelIndex = 0;
  throw lastError || new Error("No Gemini model is currently available.");
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------
function resultText(result) {
  const text = (result?.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return text || JSON.stringify(result);
}

async function runTool(name, args) {
  const started = Date.now();
  try {
    const result = await mcp.callTool({ name, arguments: args });
    const text = resultText(result);
    console.log(`[tool] ${name} ${result.isError ? "error" : "ok"} in ${Date.now() - started}ms`);
    return result.isError ? { error: text } : { result: text };
  } catch (error) {
    console.log(`[tool] ${name} failed after ${Date.now() - started}ms: ${error.message}`);
    return { error: error.message || "Tool execution failed." };
  }
}

async function connectMcp() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      // A fresh client each attempt, so a failed connect leaves no stale state.
      const client = new Client({ name: "product-care-web-chat", version: "1.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        requestInit: MCP_API_KEY
          ? { headers: { Authorization: `Bearer ${MCP_API_KEY}` } }
          : undefined,
      });

      await client.connect(transport);
      const listed = await client.listTools();

      mcp = client;
      tools = listed.tools;
      declarations = tools.map((tool) => ({
        name: tool.name,
        description: tool.description || tool.name,
        parametersJsonSchema: tool.inputSchema || { type: "object", properties: {} },
      }));
      ready = true;
      console.log(`Connected to MCP server. ${tools.length} tools loaded.`);
      return;
    } catch (error) {
      console.error(`MCP connection failed (${attempt}/5): ${error.message}`);
      if (attempt === 5) throw error;
      await sleep(attempt * 3000);
    }
  }
}

// ---------------------------------------------------------------------------
// Chat logic
// ---------------------------------------------------------------------------
// Never show the model-controlled approval flag to the user.
function visibleArgs(args = {}) {
  const { userConfirmed, ...rest } = args;
  return rest;
}

function approvalReply(name, args) {
  return {
    reply: `I need your approval before I ${name.replaceAll("_", " ")}.`,
    approvalRequired: true,
    action: { name, details: visibleArgs(args) },
  };
}

// Runs the calls in order. Stops at the first write tool and waits for approval.
async function executeCalls(session, calls, responses) {
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const tool = tools.find((item) => item.name === call.name);

    if (!tool) {
      responses.push(fr(call.name, { error: "Unknown tool." }));
      continue;
    }

    if (writeTools.has(call.name)) {
      session.pending = {
        name: call.name,
        args: { ...(call.args || {}) },
        schema: tool.inputSchema,
        remaining: calls.slice(i + 1),
        responses,
      };
      return { approval: approvalReply(call.name, call.args || {}) };
    }

    responses.push(fr(call.name, await runTool(call.name, call.args || {})));
  }

  return { responses };
}

async function drive(session, response) {
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const calls = response.functionCalls || [];

    if (!calls.length) {
      const answer = response.text || "I couldn't generate a response.";
      session.contents.push({ role: "model", parts: [{ text: answer }] });
      return { reply: answer };
    }

    // Keep Gemini's own message (it includes data Gemini needs back).
    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) session.contents.push(modelContent);

    const outcome = await executeCalls(session, calls, []);
    if (outcome.approval) return outcome.approval;

    session.contents.push({ role: "user", parts: outcome.responses });
    response = await generate(session.contents);
  }

  return { reply: "I reached the tool-call limit. Please try a simpler request." };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function rateLimit(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter((time) => now - time < 60_000);

  if (recent.length >= RATE_LIMIT_PER_MIN) {
    return res.status(429).json({ reply: "Too many requests. Please wait a minute and try again." });
  }

  recent.push(now);
  hits.set(req.ip, recent);
  next();
}

app.post("/api/chat", rateLimit, async (req, res) => {
  if (!ready) {
    return res.status(503).json({ reply: "The assistant is still starting up. Try again in a few seconds." });
  }

  const { message, sessionId, approval } = req.body || {};

  const turnStarted = Date.now();
  res.on("finish", () => console.log(`[chat] reply sent after ${Date.now() - turnStarted}ms`));

  let id = typeof sessionId === "string" ? sessionId : "";
  if (!sessions.has(id)) {
    id = crypto.randomUUID();
    sessions.set(id, { contents: [], pending: null, turnStart: 0, lastUsed: Date.now() });
  }

  const session = sessions.get(id);
  session.lastUsed = Date.now();

  try {
    // ---- The user tapped Approve or Cancel ----
    if (approval) {
      if (approval !== "approve" && approval !== "cancel") {
        return res.status(400).json({ sessionId: id, reply: "Approval must be approve or cancel." });
      }
      if (!session.pending) {
        return res.status(400).json({ sessionId: id, reply: "There is no pending action to approve." });
      }

      const pending = session.pending;
      session.pending = null;
      const responses = pending.responses;

      if (approval === "cancel") {
        responses.push(fr(pending.name, { error: "The user cancelled. Nothing was changed." }));
        // Gemini needs an answer for every call it made, including the ones we skip.
        for (const call of pending.remaining) {
          responses.push(fr(call.name, { error: "Skipped because the user cancelled." }));
        }
      } else {
        const args = { ...pending.args };
        if (pending.schema?.properties?.userConfirmed) args.userConfirmed = true;

        responses.push(fr(pending.name, await runTool(pending.name, args)));

        const outcome = await executeCalls(session, pending.remaining, responses);
        if (outcome.approval) return res.json({ sessionId: id, ...outcome.approval });
      }

      session.contents.push({ role: "user", parts: responses });
      const response = await generate(session.contents);
      return res.json({ sessionId: id, ...(await drive(session, response)) });
    }

    // ---- A normal message ----
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ sessionId: id, reply: "Please enter a message." });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ sessionId: id, reply: "That message is too long. Please shorten it." });
    }

    if (session.pending) {
      return res.status(409).json({
        sessionId: id,
        ...approvalReply(session.pending.name, session.pending.args),
        reply: "Please approve or cancel the pending action first.",
      });
    }

    session.turnStart = session.contents.length;
    session.contents.push({ role: "user", parts: [{ text: message.trim() }] });

    const response = await generate(session.contents);
    res.json({ sessionId: id, ...(await drive(session, response)) });
  } catch (error) {
    console.error("Web chat error:", error.message);

    // Forget the failed turn so the next message starts from a clean history.
    session.contents.length = session.turnStart;
    session.pending = null;

    const status = statusOf(error);
    const reply =
      status === 503 || status === 429
        ? "Gemini is busy right now. Please try again in a minute."
        : status === 401
          ? "Gemini rejected the API key. Check GEMINI_API_KEY on the server."
          : "The assistant ran into an error. Please try again.";

    res.status(500).json({ sessionId: id, reply });
  }
});

// Feeds the product cards in the web page.
app.get("/api/products", rateLimit, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (!ready) return res.status(503).json({ products: [], error: "Starting up." });

  const out = await runTool("get_products", {});
  if (out.error) return res.status(502).json({ products: [], error: "Could not load products." });

  try {
    const data = JSON.parse(out.result);
    if (data.error) return res.status(502).json({ products: [], error: "Could not load products." });
    res.json({ products: Array.isArray(data.products) ? data.products : [] });
  } catch {
    res.status(502).json({ products: [], error: "Could not read products." });
  }
});

// Provides care overview summary (totals, expiring warranties, open requests, upcoming appointments, maintenance)
app.get("/api/care-summary", rateLimit, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (!ready) return res.status(503).json({ error: "Starting up." });

  const out = await runTool("get_care_summary", {});
  if (out.error) return res.status(502).json({ error: "Could not load care summary." });

  try {
    const data = JSON.parse(out.result);
    res.json(data);
  } catch {
    res.status(502).json({ error: "Could not parse care summary." });
  }
});

// Feeds service requests list
app.get("/api/service-requests", rateLimit, async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!ready) return res.status(503).json({ serviceRequests: [], error: "Starting up." });

  const productId = req.query.productId ? Number(req.query.productId) : undefined;
  const out = await runTool("get_service_requests", productId ? { productId } : {});
  if (out.error) return res.status(502).json({ serviceRequests: [], error: "Could not load requests." });

  try {
    const data = JSON.parse(out.result);
    res.json({ serviceRequests: Array.isArray(data.serviceRequests) ? data.serviceRequests : [] });
  } catch {
    res.status(502).json({ serviceRequests: [], error: "Could not read service requests." });
  }
});

// Feeds maintenance tasks
app.get("/api/maintenance", rateLimit, async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!ready) return res.status(503).json({ tasks: [], error: "Starting up." });

  const daysAhead = req.query.daysAhead ? Number(req.query.daysAhead) : 60;
  const productId = req.query.productId ? Number(req.query.productId) : undefined;
  const args = { daysAhead };
  if (productId) args.productId = productId;

  const out = await runTool("get_maintenance_due", args);
  if (out.error) return res.status(502).json({ tasks: [], error: "Could not load maintenance." });

  try {
    const data = JSON.parse(out.result);
    res.json({ tasks: Array.isArray(data.tasks) ? data.tasks : [] });
  } catch {
    res.status(502).json({ tasks: [], error: "Could not read maintenance." });
  }
});

// Feeds service history
app.get("/api/service-history", rateLimit, async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!ready) return res.status(503).json({ serviceHistory: [], error: "Starting up." });

  const productId = req.query.productId ? Number(req.query.productId) : undefined;
  const out = await runTool("get_service_history", productId ? { productId } : {});
  if (out.error) return res.status(502).json({ serviceHistory: [], error: "Could not load history." });

  try {
    const data = JSON.parse(out.result);
    res.json({ serviceHistory: Array.isArray(data.serviceHistory) ? data.serviceHistory : [] });
  } catch {
    res.status(502).json({ serviceHistory: [], error: "Could not read history." });
  }
});

// Checks available slots for an appointment
app.get("/api/slots", rateLimit, async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!ready) return res.status(503).json({ slots: [], error: "Starting up." });

  const { productId, date } = req.query;
  if (!productId || !date) {
    return res.status(400).json({ error: "Missing productId or date." });
  }

  const out = await runTool("get_available_slots", { productId: Number(productId), date: String(date) });
  if (out.error) return res.status(502).json({ slots: [], error: out.error });

  try {
    const data = JSON.parse(out.result);
    res.json(data);
  } catch {
    res.status(502).json({ slots: [], error: "Could not read available slots." });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ready, service: "Product Care Assistant web chat" });
});

// Remove idle sessions and old rate-limit records.
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsed > SESSION_IDLE_MS) sessions.delete(id);
  }
  for (const [ip, times] of hits) {
    if (!times.some((time) => now - time < 60_000)) hits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// Listen first so the host sees the port, then connect to the MCP server.
app.listen(PORT, () => {
  console.log(`Web chat running at http://localhost:${PORT}`);
  connectMcp().catch((error) => {
    console.error("Could not connect to the MCP server:", error.message);
    process.exit(1);
  });
});