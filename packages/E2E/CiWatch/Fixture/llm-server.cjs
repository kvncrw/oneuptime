/*
 * Tiny OpenAI-compatible fixture for the CI watch acceptance suite.
 *
 * Plain HTTP on the internal Docker network (the LLM base URL is a per-project
 * setting, so no hostname impersonation is needed). Registered in a project as
 * an `OpenAICompatible` LlmProvider with baseUrl http://llm-fixture:8089/v1.
 *
 * Programmable modes (POST /__fixture/program {mode}):
 *   answer  - reply with `content` after `delayMs`
 *   tool    - first turn replies with a tool call (`toolName`, `toolArguments`);
 *             a turn that already carries a `tool` role message gets `content`
 *   error   - HTTP `status` (default 500) after `delayMs`
 *   hang    - hold the socket open for `hangMs` (default 10 min), then 500
 *
 * Every request body is recorded so a test can prove what reached the model
 * (FM22: no secret in any prompt).
 */
const http = require("http");

if (!process.env.CI_WATCH_FIXTURE_CONTROL_TOKEN)
  throw new Error(
    "CI_WATCH_FIXTURE_CONTROL_TOKEN is required for the LLM fixture",
  );

let state;
const reset = () => {
  state = {
    mode: {
      kind: "answer",
      content: "Fixture analysis: the build failed.",
      delayMs: 0,
    },
    requests: [],
    unhandled: [],
    counter: 0,
  };
};
reset();

const snapshot = () => ({
  mode: state.mode,
  requests: state.requests,
  unhandled: state.unhandled,
});
const send = (res, status, body) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 8 * 1024 * 1024)
      throw new Error("Request body exceeds fixture limit");
  }
  return body;
}

const completion = (message, finishReason) => ({
  id: `chatcmpl-fixture-${++state.counter}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: "fixture-model",
  choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
  usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
});

const server = http.createServer(async (req, res) => {
  const target = new URL(req.url, "http://llm-fixture");
  const pathname = target.pathname;
  if (pathname === "/__fixture/health") return send(res, 200, { ready: true });
  if (pathname.startsWith("/__fixture/")) {
    if (
      req.headers["x-fixture-control"] !==
      process.env.CI_WATCH_FIXTURE_CONTROL_TOKEN
    )
      return send(res, 403, { error: "Forbidden" });
    try {
      if (pathname === "/__fixture/state" && req.method === "GET")
        return send(res, 200, snapshot());
      if (pathname === "/__fixture/reset" && req.method === "POST") {
        await readBody(req);
        reset();
        return send(res, 200, snapshot());
      }
      if (pathname === "/__fixture/program" && req.method === "POST") {
        const input = JSON.parse(await readBody(req));
        if (input.mode) state.mode = { ...input.mode };
        if (input.clearRequests) state.requests = [];
        return send(res, 200, snapshot());
      }
      return send(res, 404, { error: "Unknown control operation" });
    } catch {
      return send(res, 400, { error: "Invalid control request" });
    }
  }

  try {
    if (req.method === "GET" && pathname === "/v1/models")
      return send(res, 200, {
        object: "list",
        data: [{ id: "fixture-model", object: "model" }],
      });

    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: { message: "Malformed JSON body" } });
      }
      const record = {
        receivedAt: new Date().toISOString(),
        authorization: req.headers.authorization ? "present" : "absent",
        model: body.model,
        stream: Boolean(body.stream),
        messages: body.messages || [],
        tools: (body.tools || []).map(
          (tool) => tool.function?.name || tool.name || "unknown",
        ),
        raw,
      };
      state.requests.push(record);
      const mode = state.mode;
      if (mode.delayMs) await sleep(Number(mode.delayMs));
      if (mode.kind === "hang") {
        await sleep(Number(mode.hangMs || 10 * 60 * 1000));
        return send(res, 500, { error: { message: "fixture hang released" } });
      }
      if (mode.kind === "error")
        return send(res, Number(mode.status || 500), {
          error: {
            message: mode.content || "fixture provider failure",
            type: "server_error",
          },
        });
      if (body.stream)
        return send(res, 400, {
          error: { message: "The fixture does not stream" },
        });
      const hasToolResult = record.messages.some(
        (message) => message.role === "tool",
      );
      if (mode.kind === "tool" && !hasToolResult) {
        return send(
          res,
          200,
          completion(
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_fixture_${state.counter + 1}`,
                  type: "function",
                  function: {
                    name: mode.toolName,
                    arguments: JSON.stringify(mode.toolArguments || {}),
                  },
                },
              ],
            },
            "tool_calls",
          ),
        );
      }
      return send(
        res,
        200,
        completion({ role: "assistant", content: mode.content || "" }, "stop"),
      );
    }
    state.unhandled.push(`${req.method} ${pathname}`);
    return send(res, 404, {
      error: { message: "Unmodeled LLM fixture request" },
    });
  } catch {
    state.unhandled.push(`${req.method} ${pathname}: malformed request`);
    return send(res, 400, { error: { message: "Malformed fixture request" } });
  }
});

server.listen(Number(process.env.LLM_FIXTURE_PORT || 8089), "0.0.0.0", () => {
  console.log(
    "Disposable OpenAI-compatible LLM fixture ready; prompts are recorded in memory only.",
  );
});
