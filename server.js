// ============================================================================
// Poe API + Algolia MCP 代理服務 (Node.js / Render)
// 將 OpenAI 相容請求轉發到 Poe API，並支援透過模擬 tool call 呼叫
// 遠端 Algolia MCP Server
//
// 保留原本「不支援原生 tool calling 的模型」的模擬機制：
//   - 在 system prompt 中注入工具列表與 JSON 輸出格式要求
//   - 偵測模型輸出中的 {"tool_name":..., "tool_arguments":...} 文字
//   - 若偵測到的是 Algolia 工具 -> 直接呼叫 MCP server 執行、把結果餵回模型，
//     由 proxy 內部完成一次「工具呼叫 -> 二次生成」的迴圈，最終只回傳最終答案
//   - 若偵測到的是「其他/外部」工具 -> 維持原行為，包成 OpenAI tool_calls 格式
//     回傳給呼叫端，讓外部自行執行
// ============================================================================

import crypto from "node:crypto";
import express from "express";

// ----------------------------------------------------------------------------
// 環境設定
// ----------------------------------------------------------------------------

const POE_API_BASE_URL = process.env.POE_API_BASE_URL || "https://api.poe.com/v1";

const ALGOLIA_MCP_URL =
  process.env.ALGOLIA_MCP_URL ||
  "https://yhq31rr2ww.algolia.net/mcp/1/yHNEvm9LR7Goh82Wb-Leog/mcp";

const ALGOLIA_TOOL_NAMES = new Set([
  "algolia_for_facet_values",
  "algolia_index_help_md",
  "algolia_index_help",
  "algolia_index_forum",
  "algolia_index_syss",
]);

function isAlgoliaTool(name) {
  return ALGOLIA_TOOL_NAMES.has(name) || name.startsWith("algolia_");
}

const MAX_TOOL_ITERATIONS = 4;
const PORT = Number(process.env.PORT) || 10000;

// ----------------------------------------------------------------------------
// 會話（conversation）管理
// ----------------------------------------------------------------------------

const systemToConversationMap = new Map();

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [key, value] of systemToConversationMap.entries()) {
    if (now > value.expireAt) {
      systemToConversationMap.delete(key);
      console.log(`Cleaned expired session for fingerprint: ${key}`);
    }
  }
}
setInterval(cleanExpiredSessions, 60 * 60 * 1000);

function storeConversation(fingerprint, conversationId) {
  const EIGHT_HOURS = 8 * 60 * 60 * 1000;
  systemToConversationMap.set(fingerprint, {
    conversationId,
    expireAt: Date.now() + EIGHT_HOURS,
  });
}

function getConversationId(fingerprint) {
  const session = systemToConversationMap.get(fingerprint);
  if (!session) return null;
  if (Date.now() > session.expireAt) {
    systemToConversationMap.delete(fingerprint);
    return null;
  }
  session.expireAt = Date.now() + 8 * 60 * 60 * 1000;
  return session.conversationId;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function applyCors(res) {
  const headers = corsHeaders();
  for (const [k, v] of Object.entries(headers)) {
    res.setHeader(k, v);
  }
}

function createRequestFingerprint(headers, systemPrompt, clientIp, routePrefix) {
  const userAgent = headers["user-agent"] || "";
  const authorization = headers.authorization || "";
  const data = `${userAgent}:${authorization}:${clientIp}:${systemPrompt || ""}:${routePrefix}`;
  return crypto.createHash("md5").update(data).digest("hex").slice(0, 8);
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

// ----------------------------------------------------------------------------
// 模擬 Function Calling
// ----------------------------------------------------------------------------

function detectFunctionCall(text, requestId = "unknown") {
  const functionCallRegex =
    /```(?:json)?\s*\{\s*"tool_name"\s*:\s*"([^"]+)"\s*,\s*"tool_arguments"\s*:\s*(\{[\s\S]*?\})\s*\}\s*```/i;
  const singleLineRegex =
    /\{\s*"tool_name"\s*:\s*"([^"]+)"\s*,\s*"tool_arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/i;

  let match = text.match(functionCallRegex);
  if (!match) match = text.match(singleLineRegex);
  if (!match) return null;

  try {
    const functionName = match[1];
    let argsText = match[2];
    let args = {};

    if (argsText && argsText.trim() !== "") {
      try {
        args = JSON.parse(argsText);
      } catch (e) {
        console.error(`[${requestId}] Failed to parse arguments JSON:`, e.message);
        argsText = argsText
          .replace(/'/g, '"')
          .replace(/\\"/g, '"')
          .replace(/"\{/g, "{")
          .replace(/\}"/g, "}");
        args = JSON.parse(argsText);
      }
    }

    console.log(`[${requestId}] Detected function call: ${functionName} with args:`, args);
    return { name: functionName, arguments: args };
  } catch (e) {
    console.error(`[${requestId}] Failed to parse function call:`, e.message);
    console.error(`[${requestId}] Text that failed to parse:`, text);
    return null;
  }
}

function stripFunctionCallText(text) {
  const functionCallRegex =
    /```(?:json)?\s*\{\s*"tool_name"\s*:\s*"[^"]+"\s*,\s*"tool_arguments"\s*:\s*\{[\s\S]*?\}\s*\}\s*```/i;
  const singleLineRegex =
    /\{\s*"tool_name"\s*:\s*"[^"]+"\s*,\s*"tool_arguments"\s*:\s*\{[\s\S]*?\}\s*\}/i;
  return text.replace(functionCallRegex, "").replace(singleLineRegex, "").trim();
}

function buildToolsDescription(tools) {
  let toolsDescription = "";
  tools.forEach((tool, index) => {
    if (tool.type === "function" && tool.function) {
      const func = tool.function;
      toolsDescription += `${index + 1}. 工具名稱: "${func.name}"\n`;
      toolsDescription += `   描述: ${func.description || "無描述"}\n`;

      if (func.parameters && func.parameters.properties) {
        toolsDescription += `   參數:\n`;
        const properties = func.parameters.properties;
        for (const propName in properties) {
          const prop = properties[propName];
          const required = func.parameters.required?.includes(propName) ? "(必填)" : "(可選)";
          toolsDescription += `     - ${propName} ${required}: ${prop.description || "無描述"}\n`;
        }
      }
      if (index < tools.length - 1) toolsDescription += "\n";
    }
  });
  return toolsDescription;
}

function addFunctionCallSystemPrompt(originalPrompt, tools) {
  if (!tools || tools.length === 0) return originalPrompt || "";

  const toolsDescription = buildToolsDescription(tools);

  const functionCallPrompt = `
當你需要調用以下工具時，必須使用以下精確的 JSON 格式輸出你的響應（且只在這一個 JSON 區塊，不要夾雜其他工具呼叫）：

\`\`\`json
{
  "tool_name": "工具名稱",
  "tool_arguments": {
    "參數1": "值1",
    "參數2": "值2"
  }
}
\`\`\`

可用工具列表：
${toolsDescription}

工具使用規則：
1. 選擇最適合的工具，一輪只呼叫一個工具。
2. 工具調用必須放在回答最後，且是本輪回應中唯一的內容（不要在同一則訊息中夾帶其他文字說明）。
3. 若不需要使用工具，直接正常回答問題即可，不要輸出上述 JSON 格式。
4. 確保 "tool_name" 與參數名稱與定義完全一致。
5. 參數必須是有效的 JSON。
6. 對於 Algolia 相關的搜尋工具，系統會自動代替你執行查詢並把結果提供給你，你只需要根據結果組織最終回答。
`;

  return originalPrompt ? `${originalPrompt}\n\n${functionCallPrompt}` : functionCallPrompt;
}

// ----------------------------------------------------------------------------
// Algolia MCP Client (Streamable HTTP / JSON-RPC 2.0)
// ----------------------------------------------------------------------------

let algoliaSessionId = null;
let algoliaInitPromise = null;

async function parseMcpResponse(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    const lines = text.split("\n");
    let lastData = null;
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        lastData = line.slice(6).trim();
      }
    }
    if (!lastData) {
      throw new Error("No data payload found in SSE response from MCP server");
    }
    return JSON.parse(lastData);
  }

  return await response.json();
}

async function algoliaMcpInitialize(requestId) {
  const initBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "dify-poe-proxy", version: "1.0.0" },
    },
  };

  const res = await fetch(ALGOLIA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(initBody),
  });

  if (!res.ok) {
    throw new Error(`Algolia MCP initialize failed: HTTP ${res.status}`);
  }

  const sessionId = res.headers.get("mcp-session-id");
  if (sessionId) {
    algoliaSessionId = sessionId;
  }

  await parseMcpResponse(res).catch(() => undefined);

  await fetch(ALGOLIA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(algoliaSessionId ? { "Mcp-Session-Id": algoliaSessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  }).catch((e) => {
    console.error(
      `[${requestId}] Algolia MCP notifications/initialized failed:`,
      e.message,
    );
  });

  console.log(
    `[${requestId}] Algolia MCP session initialized: ${algoliaSessionId ?? "(no session id)"}`,
  );
}

async function ensureAlgoliaMcpInitialized(requestId) {
  if (algoliaSessionId) return;
  if (!algoliaInitPromise) {
    algoliaInitPromise = algoliaMcpInitialize(requestId).catch((e) => {
      algoliaInitPromise = null;
      throw e;
    });
  }
  await algoliaInitPromise;
}

async function callAlgoliaMcpTool(toolName, args, requestId) {
  await ensureAlgoliaMcpInitialized(requestId);

  const callBody = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args,
    },
  };

  const doCall = async () =>
    fetch(ALGOLIA_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(algoliaSessionId ? { "Mcp-Session-Id": algoliaSessionId } : {}),
      },
      body: JSON.stringify(callBody),
    });

  let res = await doCall();

  if (res.status === 400 || res.status === 404) {
    console.log(`[${requestId}] Algolia MCP session may be invalid, re-initializing...`);
    algoliaSessionId = null;
    algoliaInitPromise = null;
    await ensureAlgoliaMcpInitialized(requestId);
    res = await doCall();
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Algolia MCP tools/call failed: HTTP ${res.status} ${errText}`);
  }

  const data = await parseMcpResponse(res);

  if (data.error) {
    throw new Error(`Algolia MCP error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  const result = data.result;
  if (!result) return "(工具沒有回傳內容)";

  if (Array.isArray(result.content)) {
    const textParts = result.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text);
    if (textParts.length > 0) return textParts.join("\n");
  }

  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }

  return JSON.stringify(result);
}

// ----------------------------------------------------------------------------
// 訊息前處理
// ----------------------------------------------------------------------------

function normalizeImageContent(content) {
  return content;
}

function processToolRequest(toolMessage) {
  if (!toolMessage || toolMessage.role !== "assistant" || !toolMessage.tool_calls) {
    return toolMessage;
  }
  const toolCalls = toolMessage.tool_calls.map((toolCall) => ({
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
  }));
  return {
    role: "assistant",
    content: `[工具調用請求] ${JSON.stringify(toolCalls)}`,
  };
}

function processToolResult(toolMessage) {
  if (!toolMessage || toolMessage.role !== "tool") return toolMessage;
  return {
    role: "assistant",
    content: `[工具調用結果] ${JSON.stringify(toolMessage)}`,
  };
}

function mergeAdjacentAssistantMessages(messages) {
  const acc = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && acc.length > 0 && acc[acc.length - 1].role === "assistant") {
      const prevContent = acc[acc.length - 1].content;
      if (typeof prevContent === "string" && typeof msg.content === "string") {
        acc[acc.length - 1].content = prevContent + msg.content;
        continue;
      }
    }
    acc.push(msg);
  }
  return acc;
}

// ----------------------------------------------------------------------------
// 呼叫 Poe API（非串流）
// ----------------------------------------------------------------------------

async function callPoeChatCompletions(authHeader, poeBody, requestId) {
  console.log(`[${requestId}] Request to ${POE_API_BASE_URL}/chat/completions`);

  const res = await fetch(`${POE_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...poeBody, stream: false }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const err = new Error(errData?.error?.message || `Poe API error: HTTP ${res.status}`);
    err.status = res.status;
    err.data = errData;
    throw err;
  }

  return await res.json();
}

// ----------------------------------------------------------------------------
// Express 應用
// ----------------------------------------------------------------------------

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  applyCors(res);
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
});

app.get(["/", ""], (req, res) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  const helpText = `
Hello Poe-API-Proxy (with Algolia MCP support)!

本代理將 OpenAI 相容請求轉發至 Poe API (${POE_API_BASE_URL})，
並在模型不支援原生 tool calling 時，透過系統提示詞模擬工具呼叫。

當模型模擬呼叫 Algolia 相關工具（algolia_index_help、algolia_index_forum、
algolia_index_help_md、algolia_for_facet_values、algolia_index_syss）時，
本代理會直接呼叫遠端 Algolia MCP Server 執行查詢，並自動把結果餵回模型，
產生最終回答（整個流程對呼叫端透明，不需要自行執行工具）。

若模擬呼叫的是其他（非 Algolia）工具，則維持原行為：包成 OpenAI
tool_calls 格式回傳給呼叫端，由外部自行執行。

API 調用範例：

curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer $YOUR_POE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
      "model": "Claude-Sonnet-4.6",
      "messages": [{"role": "user", "content": "幫我查一下如何加入賽事"}],
      "temperature": 0.7,
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

API 說明：
- Authorization: 直接帶你的 Poe API Key（poe.com/api_key），格式為 Bearer <POE_API_KEY>
- stream: 設為 true 可取得串流回應
- conversation_id: 目前 Poe 端點為單輪 stateless 呼叫，此欄位僅作相容保留用途
- tools: 定義模型可用的工具，將透過系統提示詞注入並偵測模擬呼叫
- health: GET /healthz
`;
  res.type("text/plain; charset=utf-8").send(helpText);
});

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

async function handleChatCompletions(req, res) {
  const requestId = randomHex(4);
  let clientIp = req.headers["x-forwarded-for"] || req.ip || "";
  if (typeof clientIp === "string" && clientIp.includes(",")) {
    clientIp = clientIp.split(",")[0].trim();
  }

  const routePrefix = req.params.prefix || "";
  console.log(`[${requestId}] ${req.method} ${req.path} from ${clientIp}`);

  try {
    const body = req.body || {};
    const authHeader = req.headers.authorization || "";

    if (body.messages && Array.isArray(body.messages)) {
      body.messages = body.messages.map((msg) => {
        if (msg.role === "assistant" && msg.tool_calls) return processToolRequest(msg);
        if (msg.role === "tool") return processToolResult(msg);
        return { ...msg, content: normalizeImageContent(msg.content) };
      });
    }

    body.messages = mergeAdjacentAssistantMessages(body.messages || []);

    let systemMessage = body.messages.find((msg) => msg.role === "system");
    const originalTools = body.tools;

    if (originalTools && originalTools.length > 0) {
      const originalSystemPrompt = systemMessage ? systemMessage.content : "";
      const enhancedSystemPrompt = addFunctionCallSystemPrompt(
        originalSystemPrompt,
        originalTools,
      );

      if (!systemMessage) {
        systemMessage = { role: "system", content: enhancedSystemPrompt };
        body.messages.unshift(systemMessage);
      } else {
        systemMessage.content = enhancedSystemPrompt;
      }
    }

    let fingerprint = null;
    if (systemMessage) {
      fingerprint = createRequestFingerprint(
        req.headers,
        systemMessage.content,
        clientIp,
        routePrefix,
      );
    }

    const poeBody = {
      model: body.model || "Claude-Sonnet-4.6",
      messages: body.messages,
      temperature: body.temperature,
      top_p: body.top_p,
      max_tokens: body.max_tokens,
      stop: body.stop,
    };
    Object.keys(poeBody).forEach((k) => poeBody[k] === undefined && delete poeBody[k]);

    // ------------------------------------------------------------------
    // 串流回應
    // ------------------------------------------------------------------
    if (body.stream) {
      console.log(`[${requestId}] Starting stream`);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      try {
        let iterationMessages = [...poeBody.messages];
        let finalHandled = false;

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS && !finalHandled; iter++) {
          const data = await callPoeChatCompletions(
            authHeader,
            { ...poeBody, messages: iterationMessages },
            requestId,
          );

          const answer = data.choices?.[0]?.message?.content || "";
          const functionCall = originalTools ? detectFunctionCall(answer, requestId) : null;

          if (functionCall && isAlgoliaTool(functionCall.name)) {
            console.log(
              `[${requestId}] [stream] Executing Algolia MCP tool: ${functionCall.name}`,
            );
            let toolResultText;
            try {
              toolResultText = await callAlgoliaMcpTool(
                functionCall.name,
                functionCall.arguments,
                requestId,
              );
            } catch (e) {
              toolResultText = `工具執行失敗: ${e.message}`;
              console.error(`[${requestId}] Algolia MCP call failed:`, e.message);
            }

            iterationMessages = [
              ...iterationMessages,
              { role: "assistant", content: answer },
              {
                role: "user",
                content: `[工具調用結果] tool_name=${functionCall.name}\n${toolResultText}\n\n請根據以上結果回答原本的問題，不要再輸出 tool_name/tool_arguments JSON。`,
              },
            ];
            continue;
          }

          if (functionCall) {
            const callId = `call_${randomHex(12)}`;
            const toolInitResponse = {
              choices: [
                {
                  delta: {
                    content: null,
                    role: "assistant",
                    tool_calls: [
                      {
                        function: { arguments: "", name: functionCall.name },
                        id: callId,
                        index: 0,
                        type: "function",
                      },
                    ],
                  },
                  finish_reason: null,
                  index: 0,
                },
              ],
              created: Math.floor(Date.now() / 1000),
              id: data.id || `chatcmpl-${randomHex(12)}`,
              model: poeBody.model,
              object: "chat.completion.chunk",
            };
            res.write(`data: ${JSON.stringify(toolInitResponse)}\n\n`);

            const argsStr = JSON.stringify(functionCall.arguments);
            const chunkSize = 30;
            for (let pos = 0; pos < argsStr.length; pos += chunkSize) {
              const chunk = argsStr.slice(pos, pos + chunkSize);
              const argsChunkResponse = {
                choices: [
                  {
                    delta: { tool_calls: [{ function: { arguments: chunk }, index: 0 }] },
                    finish_reason: null,
                    index: 0,
                  },
                ],
                created: Math.floor(Date.now() / 1000),
                id: data.id || `chatcmpl-${randomHex(12)}`,
                model: poeBody.model,
                object: "chat.completion.chunk",
              };
              res.write(`data: ${JSON.stringify(argsChunkResponse)}\n\n`);
            }

            const toolFinishResponse = {
              choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
              created: Math.floor(Date.now() / 1000),
              id: data.id || `chatcmpl-${randomHex(12)}`,
              model: poeBody.model,
              object: "chat.completion.chunk",
            };
            res.write(`data: ${JSON.stringify(toolFinishResponse)}\n\n`);
            res.write("data: [DONE]\n\n");
            finalHandled = true;
            break;
          }

          const cleanAnswer = stripFunctionCallText(answer);
          const chunkSize = 20;
          for (let pos = 0; pos < cleanAnswer.length; pos += chunkSize) {
            const chunk = cleanAnswer.slice(pos, pos + chunkSize);
            const openAIChunk = {
              id: data.id || `chatcmpl-${randomHex(12)}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: poeBody.model,
              choices: [
                {
                  delta: { content: chunk, role: "assistant" },
                  finish_reason: null,
                  index: 0,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);
          }

          const finishChunk = {
            id: data.id || `chatcmpl-${randomHex(12)}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: poeBody.model,
            choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          };
          res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
          res.write("data: [DONE]\n\n");
          finalHandled = true;
        }

        if (!finalHandled) {
          res.write(
            `data: ${JSON.stringify({
              error: { message: "Reached max tool iterations", type: "proxy_error" },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
        }

        res.end();
      } catch (error) {
        console.error(`[${requestId}] Stream error:`, error.message);
        try {
          res.write(
            `data: ${JSON.stringify({
              error: { message: error.message, type: "stream_error" },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } catch (e) {
          console.error(`[${requestId}] Failed to write error to stream:`, e.message);
        }
      } finally {
        console.log(`[${requestId}] Request completed`);
      }
      return;
    }

    // ------------------------------------------------------------------
    // 非串流回應
    // ------------------------------------------------------------------
    let iterationMessages = [...poeBody.messages];
    let data;
    let functionCall = null;

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      data = await callPoeChatCompletions(
        authHeader,
        { ...poeBody, messages: iterationMessages },
        requestId,
      );
      const answer = data.choices?.[0]?.message?.content || "";
      functionCall = originalTools ? detectFunctionCall(answer, requestId) : null;

      if (functionCall && isAlgoliaTool(functionCall.name)) {
        console.log(`[${requestId}] Executing Algolia MCP tool: ${functionCall.name}`);
        let toolResultText;
        try {
          toolResultText = await callAlgoliaMcpTool(
            functionCall.name,
            functionCall.arguments,
            requestId,
          );
        } catch (e) {
          toolResultText = `工具執行失敗: ${e.message}`;
          console.error(`[${requestId}] Algolia MCP call failed:`, e.message);
        }

        iterationMessages = [
          ...iterationMessages,
          { role: "assistant", content: answer },
          {
            role: "user",
            content: `[工具調用結果] tool_name=${functionCall.name}\n${toolResultText}\n\n請根據以上結果回答原本的問題，不要再輸出 tool_name/tool_arguments JSON。`,
          },
        ];
        functionCall = null;
        continue;
      }

      break;
    }

    console.log(`[${requestId}] Completed`);

    const rawAnswer = data.choices?.[0]?.message?.content || "";
    const cleanAnswer = stripFunctionCallText(rawAnswer);

    const openAIResponse = {
      id: data.id || `chatcmpl-${randomHex(12)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: poeBody.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: functionCall ? null : cleanAnswer },
          finish_reason: functionCall ? "tool_calls" : "stop",
        },
      ],
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    if (functionCall) {
      openAIResponse.choices[0].message.tool_calls = [
        {
          id: `call_${randomHex(12)}`,
          type: "function",
          function: {
            name: functionCall.name,
            arguments: JSON.stringify(functionCall.arguments),
          },
        },
      ];
    }

    if (fingerprint && data.id) {
      storeConversation(fingerprint, data.id);
      openAIResponse.conversation_id = data.id;
    }

    res.json(openAIResponse);
  } catch (error) {
    console.error(`[${requestId}] Error:`, error.message);
    const status = error.status || 500;
    res.status(status).json({
      error: {
        message: error.message || "Internal server error",
        type: "server_error",
      },
    });
  } finally {
    console.log(`[${requestId}] Request completed`);
  }
}

app.post("/v1/chat/completions", handleChatCompletions);
app.post("/:prefix/v1/chat/completions", handleChatCompletions);

app.use((_req, res) => {
  applyCors(res);
  res.status(404).send("Not Found");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://0.0.0.0:${PORT}/`);
});
