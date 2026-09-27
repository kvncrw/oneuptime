/*
 * LLM relay worker fixture for the CI watch acceptance suite.
 *
 * Models the worker that runs beside the LLM gateway in production
 * (~/.buzz/PLANS/ONEUPTIME_LLM_RELAY.md): it long-polls the app's
 * POST /api/llm-relay/claim with the shared token, posts each claimed body
 * verbatim to the OpenAI-compatible LLM fixture, and returns the upstream
 * status and JSON on POST /api/llm-relay/result/:id. Nothing is interpreted
 * on the way through, so tool calls and provider errors pass unchanged.
 *
 * Control (POST /__fixture/program {enabled, forwardDelayMs}):
 *   enabled: false  - stop claiming. The reply waits until no claim is in
 *                     flight, so a spec that then queues a job knows the
 *                     worker cannot take it ("no worker running").
 *   forwardDelayMs  - hold each claimed job before forwarding it upstream.
 *
 * Every claim and result is recorded so a spec can prove what the worker
 * saw (or that it saw nothing).
 */
const http = require("http");

if (!process.env.CI_WATCH_FIXTURE_CONTROL_TOKEN)
  throw new Error(
    "CI_WATCH_FIXTURE_CONTROL_TOKEN is required for the relay worker fixture",
  );
if (!process.env.LLM_RELAY_TOKEN)
  throw new Error("LLM_RELAY_TOKEN is required for the relay worker fixture");

const token = process.env.LLM_RELAY_TOKEN;
const appUrl = (
  process.env.LLM_RELAY_APP_URL || "http://oneuptime.test:7849"
).replace(/\/$/, "");
const upstreamUrl =
  process.env.LLM_RELAY_UPSTREAM_URL ||
  "http://llm-fixture:8089/v1/chat/completions";
const claimWaitSeconds = Number(process.env.LLM_RELAY_CLAIM_WAIT_SECONDS || 3);

let state;
let idle = true;
const reset = () => {
  state = {
    enabled: state ? state.enabled : true,
    forwardDelayMs: 0,
    claims: [],
    results: [],
    errors: [],
    claimStatuses: [],
  };
};
reset();

const snapshot = () => ({ ...state });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const push = (list, value) => {
  list.push(value);
  if (list.length > 500) list.shift();
};

const relayHeaders = {
  "content-type": "application/json",
  "x-llm-relay-token": token,
};

async function claimOnce() {
  const claim = await fetch(`${appUrl}/api/llm-relay/claim`, {
    method: "POST",
    headers: relayHeaders,
    body: JSON.stringify({ waitSeconds: claimWaitSeconds }),
  });
  push(state.claimStatuses, claim.status);
  if (claim.status === 204) return;
  if (claim.status !== 200) {
    push(state.errors, `claim answered ${claim.status}`);
    await sleep(1000);
    return;
  }
  const job = await claim.json();
  push(state.claims, {
    id: String(job.id),
    claimedAt: new Date().toISOString(),
    model: job.body && job.body.model,
    hasTools: Boolean(job.body && Array.isArray(job.body.tools)),
  });
  if (state.forwardDelayMs) await sleep(Number(state.forwardDelayMs));

  let upstreamStatus;
  let json;
  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job.body),
    });
    upstreamStatus = upstream.status;
    const text = await upstream.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: { message: text } };
    }
  } catch (error) {
    upstreamStatus = 502;
    json = { error: { message: `relay worker upstream failure: ${error}` } };
  }

  const posted = await fetch(
    `${appUrl}/api/llm-relay/result/${encodeURIComponent(job.id)}`,
    {
      method: "POST",
      headers: relayHeaders,
      body: JSON.stringify({ status: upstreamStatus, json }),
    },
  );
  push(state.results, {
    id: String(job.id),
    upstreamStatus,
    postStatus: posted.status,
  });
}

async function loop() {
  for (;;) {
    if (!state.enabled) {
      idle = true;
      await sleep(100);
      continue;
    }
    idle = false;
    try {
      await claimOnce();
    } catch (error) {
      push(
        state.errors,
        String(error && error.message ? error.message : error),
      );
      await sleep(1000);
    }
    idle = true;
  }
}

async function waitUntilIdle(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!idle && Date.now() < deadline) await sleep(50);
  return idle;
}

const send = (res, status, body) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 1024 * 1024)
      throw new Error("Control body exceeds fixture limit");
  }
  return body;
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://llm-relay-worker").pathname;
  if (pathname === "/__fixture/health") return send(res, 200, { ready: true });
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
      if (typeof input.forwardDelayMs === "number")
        state.forwardDelayMs = input.forwardDelayMs;
      if (typeof input.enabled === "boolean") {
        state.enabled = input.enabled;
        if (!input.enabled && !(await waitUntilIdle(20000)))
          return send(res, 500, { error: "Worker did not go idle" });
      }
      return send(res, 200, snapshot());
    }
    return send(res, 404, { error: "Unknown control operation" });
  } catch {
    return send(res, 400, { error: "Invalid control request" });
  }
});

server.listen(
  Number(process.env.LLM_RELAY_WORKER_PORT || 8090),
  "0.0.0.0",
  () => {
    console.log(
      `Disposable LLM relay worker fixture ready; claiming from ${appUrl}, forwarding to ${upstreamUrl}.`,
    );
    loop().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  },
);
