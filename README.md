# Poe API + Algolia MCP Proxy

OpenAI-compatible proxy that forwards chat completions to [Poe API](https://poe.com/api_key),
and transparently executes Algolia MCP tool calls on the server side.

Converted from Deno to **Node.js** for deployment on **Render**.

## Features

- OpenAI-compatible `POST /v1/chat/completions`
- Simulated function calling via system prompt injection
- Auto-executes Algolia MCP tools (`algolia_*`) and feeds results back to the model
- Non-Algolia tools are returned as standard OpenAI `tool_calls` for the client to run
- Streaming (`stream: true`) and non-streaming modes
- CORS enabled

## Local development

```bash
npm install
npm start
# or with auto-reload:
npm run dev
```

Server listens on `PORT` (default `10000`).

```bash
curl http://localhost:10000/healthz
curl http://localhost:10000/
```

## Deploy to Render

### Option A: Blueprint (`render.yaml`)

1. Push this repo to GitHub/GitLab
2. In Render Dashboard → **New** → **Blueprint**
3. Connect the repo; Render reads `render.yaml`

### Option B: Manual Web Service

| Setting | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Node Version | 18+ (recommended 20) |

Render injects `PORT` automatically — the app already reads `process.env.PORT`.

### Environment variables (optional)

| Key | Default |
|---|---|
| `PORT` | set by Render |
| `POE_API_BASE_URL` | `https://api.poe.com/v1` |
| `ALGOLIA_MCP_URL` | Algolia MCP endpoint |

> Poe API keys are passed per-request via `Authorization: Bearer <POE_API_KEY>`.
> You do **not** need to store the Poe key as a Render env var unless you want a server-side default.

## API

```bash
curl https://YOUR-SERVICE.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer $YOUR_POE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Claude-Sonnet-4.6",
    "messages": [{"role": "user", "content": "幫我查一下如何加入賽事"}],
    "stream": false,
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "algolia_index_help",
          "description": "Search the Algolia index help",
          "parameters": {
            "type": "object",
            "properties": {
              "query": { "type": "string", "description": "搜尋關鍵字" }
            },
            "required": ["query"]
          }
        }
      }
    ]
  }'
```

Also supports prefixed routes: `POST /:prefix/v1/chat/completions`.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Help text |
| GET | `/healthz` | Health check |
| POST | `/v1/chat/completions` | Chat completions |
| POST | `/:prefix/v1/chat/completions` | Prefixed chat completions |
