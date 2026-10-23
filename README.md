# CareOrbit AI

Intelligence beyond the purchase. CareOrbit is an after-sales assistant for households in India. It tracks registered products, warranties, service requests, appointments and maintenance through chat and voice (English, Hindi, Telugu).

Live demo: https://product-care-web.onrender.com/

Track: Alexa+ (self-hosted MCP server over Streamable HTTP, with a simulated assistant experience in a web app).

## How it works

- MCP server (server.js, port 3000): a self-hosted Model Context Protocol server over Streamable HTTP with 25 tools, backed by Supabase PostgreSQL.
- Web chat (webchat.js, port 3001): an Express app with the UI that connects to the MCP server as a client. Google Gemini decides which tools to call.
- Safe actions: any tool that changes data (add, update, delete, book) waits for the user to tap Approve or Cancel before it runs.
- Voice: browser speech recognition and read-aloud in English, Hindi and Telugu (public/voice.js).

## Requirements

- Node.js 20 or newer
- A Gemini API key
- A Supabase project

## Setup

```bash
git clone https://github.com/abhirampakala69-commits/Product-care-assistant.git
cd Product-care-assistant
npm install
cp .env.example .env
```

On Windows, use `copy .env.example .env`. Then open `.env` and add your own keys. The variable names are listed in `.env.example`.

## Run

```bash
npm start
```

This starts the MCP server on port 3000 and the web chat on port 3001. Open http://localhost:3001.

You can also run them separately: `npm run start:mcp` and `npm run start:web`.

## Try it

Ask in chat or by voice:

- "Show my registered products"
- "Which warranties expire soon?"
- "Book a service slot"
- Ask it to add a product, then approve the action card.

To test without setting up your own database, use the live demo above.

## Significantly updated during the hackathon

- Built the MCP server with 25 tools for products, warranties, service requests, appointments and maintenance.
- Added a web chat that uses Gemini to call those tools through MCP.
- Added an Approve / Cancel step that blocks any data-changing action until the user confirms.
- Added voice input and read-aloud in English, Hindi and Telugu.
- Added model fallback, request timeouts and clear error messages so slow or failed AI calls no longer break chat or voice.

## Hackathon

Submitted to the Build, Ship, Shape: Amazon Developer Hackathon.

## License

MIT