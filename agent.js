import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createInterface } from "node:readline/promises";

// ---------------------------------------------------------------------------
// Configuration (all optional values can be set in .env)
// ---------------------------------------------------------------------------
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY is missing from your .env file.");
}

const MCP_URL = process.env.MCP_URL || "http://localhost:3000/mcp";
const MCP_API_KEY = process.env.MCP_API_KEY || "";

// Models are tried in this order. If one is busy (503), the next one is used.
// Override in .env with: GEMINI_MODELS=gemini-2.5-flash,gemini-2.5-flash-lite
const MODELS = (process.env.GEMINI_MODELS || "gemini-2.5-flash,gemini-2.5-flash-lite")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const MAX_TOOL_ROUNDS = 8;

const ai = new GoogleGenAI({ apiKey });

const mcp = new Client({
  name: "after-sale-agent",
  version: "1.1.0",
});

// Sends the API key to the MCP server if MCP_API_KEY is set in .env.
const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
  requestInit: MCP_API_KEY
    ? { headers: { Authorization: `Bearer ${MCP_API_KEY}` } }
    : undefined,
});

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Tools that change stored data or perform an action
// must be approved by the user before execution.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function todayIndia() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// One shared config for EVERY Gemini call, so the safety rules are never lost.
function buildConfig(functionDeclarations) {
  return {
    systemInstruction: `
You are Product Care Assistant, an after-sales product support agent.
Today's date is ${todayIndia()} (India time).

Use the provided MCP tools when needed. Do not invent product details,
warranty dates, service statuses, or tool results.

Ask a clear question if required information is missing.
Explain results in simple, helpful language.

For any change (adding, updating, deleting, or booking), gather all required
details first. The agent must ask the user for explicit approval before
executing any write tool. Never treat the user's original request as approval.
Never claim an action succeeded unless the tool result confirms it.
    `,
    tools: [{ functionDeclarations }],
  };
}

// Works out the HTTP status of a Gemini error, even when it only has a message.
function errorStatus(err) {
  if (typeof err?.status === "number") return err.status;
  const message = String(err?.message ?? "");
  if (/UNAVAILABLE|overloaded|high demand/i.test(message)) return 503;
  if (/RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)) return 429;
  if (/NOT_FOUND/i.test(message)) return 404;
  return 0;
}

let modelIndex = 0;

// Calls Gemini. Retries when the model is busy, then falls back to the next model.
async function generate(contents, config) {
  let lastError;

  while (modelIndex < MODELS.length) {
    const model = MODELS[modelIndex];

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await ai.models.generateContent({ model, contents, config });
      } catch (err) {
        lastError = err;
        const status = errorStatus(err);

        if (status === 503 || status === 429 || status === 500) {
          if (attempt < 3) {
            console.log(`(${model} is busy, retrying in ${attempt * 3}s...)`);
            await sleep(attempt * 3000);
            continue;
          }
          break; // give up on this model, try the next one
        }

        if (status === 404) break; // model name not found, try the next one

        throw err; // 400 / 401 / 403 etc. will not fix themselves
      }
    }

    console.log(`(switching away from ${model})`);
    modelIndex++;
  }

  modelIndex = 0; // start again from the first model on the next question
  throw lastError ?? new Error("No Gemini model is available.");
}

// Turns an MCP tool result into plain text for Gemini.
function toolResultText(result) {
  const text = (result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return text || JSON.stringify(result);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function main() {
  try {
    await mcp.connect(transport);

    const { tools } = await mcp.listTools();

    // Convert MCP tool definitions into Gemini function declarations.
    const functionDeclarations = tools.map((tool) => ({
      name: tool.name,
      description: tool.description || tool.name,
      parametersJsonSchema: tool.inputSchema || {
        type: "object",
        properties: {},
      },
    }));

    const contents = [];

    console.log(`\nProduct Care Assistant is ready! (${tools.length} tools loaded)`);
    console.log("Type a request, or type exit to quit.\n");

    while (true) {
      const prompt = await rl.question("You: ");

      if (prompt.trim().toLowerCase() === "exit") break;
      if (!prompt.trim()) continue;

      // If anything fails during this turn, we roll the conversation back to here
      // so one error does not break the rest of the chat.
      const checkpoint = contents.length;

      try {
        contents.push({ role: "user", parts: [{ text: prompt }] });

        let response = await generate(contents, buildConfig(functionDeclarations));
        let rounds = 0;

        // Let Gemini call tools and then explain their results.
        while (response.functionCalls?.length && rounds < MAX_TOOL_ROUNDS) {
          rounds++;

          // Preserve Gemini's tool-call message in the conversation.
          const modelContent = response.candidates?.[0]?.content;
          if (modelContent) contents.push(modelContent);

          const functionResponseParts = [];

          for (const call of response.functionCalls) {
            const name = call.name;
            const args = { ...(call.args || {}) };
            const tool = tools.find((item) => item.name === name);

            if (!tool) {
              functionResponseParts.push({
                functionResponse: { name, response: { error: "Unknown tool." } },
              });
              continue;
            }

            console.log(`\nGemini requested tool: ${name}`);
            console.log("Arguments:", JSON.stringify(args));

            let responsePayload;

            if (writeTools.has(name)) {
              const answer = await rl.question(
                "Allow this change? Type yes to approve: "
              );

              if (answer.trim().toLowerCase() === "yes") {
                // The user approved, so set the flag ourselves.
                // Gemini cannot approve on the user's behalf.
                if (tool.inputSchema?.properties?.userConfirmed) {
                  args.userConfirmed = true;
                }
              } else {
                responsePayload = {
                  error: "The user did not approve this action. Nothing was changed.",
                };
              }
            }

            if (!responsePayload) {
              try {
                const result = await mcp.callTool({ name, arguments: args });
                const text = toolResultText(result);
                responsePayload = result.isError ? { error: text } : { result: text };
              } catch (error) {
                responsePayload = { error: error.message };
              }
            }

            functionResponseParts.push({
              functionResponse: { name, response: responsePayload },
            });
          }

          contents.push({ role: "user", parts: functionResponseParts });

          response = await generate(contents, buildConfig(functionDeclarations));
        }

        if (response.functionCalls?.length) {
          console.log("\nI reached the tool-call limit for this request.\n");
          contents.length = checkpoint;
        } else {
          const answer = response.text || "I couldn't generate a text response.";
          console.log(`\nAssistant: ${answer}\n`);
          contents.push({ role: "model", parts: [{ text: answer }] });
        }
      } catch (error) {
        contents.length = checkpoint; // forget the failed turn
        const status = errorStatus(error);

        if (status === 401 || status === 403 || /API key/i.test(error.message)) {
          console.log("\nGemini rejected your API key. Check GEMINI_API_KEY in .env.\n");
        } else if (status === 503 || status === 429) {
          console.log("\nGemini is busy or out of quota right now. Wait a minute and ask again.\n");
        } else {
          console.log(`\nSomething went wrong: ${error.message}\n`);
        }
      }
    }
  } finally {
    rl.close();
    await mcp.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("Agent error:", error);
  process.exitCode = 1;
});
