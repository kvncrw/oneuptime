/*
 * Disposable GitHub fixture for the CI watch acceptance suite.
 *
 * Serves BOTH `api.github.com` and `github.com` over HTTPS from the Discord
 * fixture's disposable CA (the server certificate carries both names as SANs,
 * see Discord/Fixture/prepare-certificates.sh). It models only what the CI
 * watch and the GitHub App install callback call, records every request, and
 * is programmable per test through /__fixture/* control routes.
 *
 * Differences from real GitHub that a reader must know:
 *  - /actions/jobs/{id}/logs answers 200 text/plain directly. GitHub answers
 *    302 to a signed blob URL; the app must follow that redirect in production.
 *  - App JWTs are checked for shape only (three base64url segments); the
 *    signature is not verified because the fixture never sees the app's key.
 */
const https = require("https");
const fs = require("fs");
const crypto = require("crypto");
const ids = require("./identities.json");

for (const key of [
  "CI_WATCH_FIXTURE_CONTROL_TOKEN",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
]) {
  if (!process.env[key])
    throw new Error(`${key} is required for the disposable GitHub fixture`);
}

const defaultRepositories = () => [
  { owner: ids.owner, name: ids.repository, id: 7100001 },
  { owner: ids.owner, name: ids.secondRepository, id: 7100002 },
];

let state;
const reset = () => {
  state = {
    scenario: { runs: "ok", jobs: "ok", logs: "ok", issues: "ok", token: "ok" },
    installationId: ids.installationId,
    repositories: defaultRepositories(),
    runs: {},
    jobs: {},
    logs: {},
    contents: {},
    issues: [],
    requests: [],
    unhandled: [],
    oauthCodes: [],
    userTokens: [],
    issueCounter: 0,
  };
};
reset();

const snapshot = () => ({
  scenario: state.scenario,
  installationId: state.installationId,
  repositories: state.repositories,
  issues: state.issues,
  requests: state.requests,
  unhandled: state.unhandled,
});

const send = (res, status, body, contentType = "application/json") => {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 4 * 1024 * 1024)
      throw new Error("Request body exceeds fixture limit");
  }
  return body;
}

const repoRecord = (repo) => ({
  id: repo.id,
  name: repo.name,
  full_name: `${repo.owner}/${repo.name}`,
  private: true,
  html_url: `https://github.com/${repo.owner}/${repo.name}`,
  description: "CI watch acceptance repository",
  default_branch: repo.default_branch || ids.defaultBranch,
  owner: { login: repo.owner },
});

const authKind = (req) => {
  const authorization = req.headers.authorization || "";
  if (/^Bearer ghs_/.test(authorization)) return "installation";
  if (/^Bearer ghu_/.test(authorization)) return "user";
  if (
    /^(Bearer|token) [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
      authorization,
    )
  )
    return "app-jwt";
  if (authorization) return "unknown";
  return "none";
};

const server = https.createServer(
  {
    key: fs.readFileSync(
      process.env.GITHUB_FIXTURE_TLS_KEY || "/fixture-certs/server.key",
    ),
    cert: fs.readFileSync(
      process.env.GITHUB_FIXTURE_TLS_CERT || "/fixture-certs/server.crt",
    ),
  },
  async (req, res) => {
    const host = String(req.headers.host || "").replace(/:\d+$/, "");
    const target = new URL(req.url, `https://${host || "api.github.com"}`);
    const pathname = target.pathname;

    if (pathname === "/__fixture/health")
      return send(res, 200, { ready: true });
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
        // Merge programming: runs/jobs/logs/contents are keyed maps, scenario
        // is a partial object, repositories replaces the installation list.
        if (pathname === "/__fixture/program" && req.method === "POST") {
          const input = JSON.parse(await readBody(req));
          if (input.scenario) Object.assign(state.scenario, input.scenario);
          if (input.repositories) state.repositories = input.repositories;
          if (input.installationId)
            state.installationId = String(input.installationId);
          for (const key of ["runs", "jobs", "logs", "contents"]) {
            if (input[key]) Object.assign(state[key], input[key]);
          }
          if (input.clearRuns) state.runs = {};
          if (input.clearRequests) state.requests = [];
          return send(res, 200, snapshot());
        }
        return send(res, 404, { error: "Unknown control operation" });
      } catch {
        return send(res, 400, { error: "Invalid control request" });
      }
    }

    let recordedBody = null;
    const record = {
      host,
      method: req.method,
      path: pathname,
      query: target.search,
      auth: authKind(req),
      status: null,
      body: null,
    };
    state.requests.push(record);
    res.on("finish", () => {
      record.status = res.statusCode;
      record.body = recordedBody;
    });

    try {
      // ---- github.com: the App install page and the OAuth code exchange ----
      if (host === "github.com") {
        const install = pathname.match(/^\/apps\/([^/]+)\/installations\/new$/);
        if (req.method === "GET" && install) {
          if (install[1] !== ids.appName)
            return send(res, 404, { message: "Unknown GitHub App" });
          const redirectUri = target.searchParams.get("redirect_uri");
          const oauthState = target.searchParams.get("state");
          if (!redirectUri || !oauthState)
            return send(res, 400, {
              message: "state and redirect_uri are required",
            });
          const redirect = new URL(redirectUri);
          if (
            redirect.hostname !== "oneuptime.test" ||
            redirect.pathname !== "/api/github/auth/callback"
          )
            return send(res, 400, {
              message: "Callback is outside the disposable test application",
            });
          const code = "gho_code_" + crypto.randomBytes(12).toString("hex");
          state.oauthCodes.push(code);
          redirect.searchParams.set("installation_id", state.installationId);
          redirect.searchParams.set("setup_action", "install");
          redirect.searchParams.set("state", oauthState);
          redirect.searchParams.set("code", code);
          res.writeHead(302, {
            location: redirect.toString(),
            "cache-control": "no-store",
          });
          return res.end();
        }
        if (req.method === "POST" && pathname === "/login/oauth/access_token") {
          const raw = await readBody(req);
          let form;
          try {
            form = JSON.parse(raw);
          } catch {
            form = Object.fromEntries(new URLSearchParams(raw));
          }
          recordedBody = { client_id: form.client_id, code: form.code };
          const index = state.oauthCodes.indexOf(form.code);
          if (
            index < 0 ||
            form.client_id !== process.env.GITHUB_APP_CLIENT_ID ||
            form.client_secret !== process.env.GITHUB_APP_CLIENT_SECRET
          )
            return send(res, 200, { error: "bad_verification_code" });
          state.oauthCodes.splice(index, 1);
          const token = "ghu_fixture_" + crypto.randomBytes(16).toString("hex");
          state.userTokens.push(token);
          return send(res, 200, {
            access_token: token,
            token_type: "bearer",
            scope: "",
          });
        }
        state.unhandled.push(`${req.method} ${host}${pathname}`);
        return send(res, 404, {
          message: "Unmodeled github.com fixture request",
        });
      }

      // ---- api.github.com ----
      const kind = authKind(req);
      if (kind === "none" || kind === "unknown")
        return send(res, 401, { message: "Requires authentication" });

      if (req.method === "GET" && pathname === "/user/installations") {
        if (kind !== "user")
          return send(res, 403, { message: "User token required" });
        return send(res, 200, {
          total_count: 1,
          installations: [{ id: Number(state.installationId) }],
        });
      }

      const tokenRoute = pathname.match(
        /^\/app\/installations\/(\d+)\/access_tokens$/,
      );
      if (req.method === "POST" && tokenRoute) {
        recordedBody = JSON.parse((await readBody(req)) || "{}");
        if (kind !== "app-jwt")
          return send(res, 401, { message: "A GitHub App JWT is required" });
        if (state.scenario.token === "error")
          return send(res, 500, { message: "fixture token failure" });
        if (tokenRoute[1] !== state.installationId)
          return send(res, 404, { message: "Not Found" });
        return send(res, 201, {
          token: "ghs_fixture_" + crypto.randomBytes(16).toString("hex"),
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          permissions: recordedBody.permissions || {},
        });
      }

      if (req.method === "GET" && pathname === "/installation/repositories") {
        return send(res, 200, {
          total_count: state.repositories.length,
          repositories: state.repositories.map(repoRecord),
        });
      }

      const repoRoute = pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
      if (repoRoute) {
        const owner = repoRoute[1],
          name = repoRoute[2],
          rest = repoRoute[3] || "";
        const fullName = `${owner}/${name}`;
        const repo = state.repositories.find(
          (item) => item.owner === owner && item.name === name,
        );
        if (!repo) return send(res, 404, { message: "Not Found" });

        if (req.method === "GET" && rest === "")
          return send(res, 200, repoRecord(repo));

        if (req.method === "GET" && rest === "/actions/runs") {
          if (state.scenario.runs === "error")
            return send(res, 500, { message: "fixture runs failure" });
          if (state.scenario.runs === "empty")
            return send(res, 200, "", "application/json");
          const branch = target.searchParams.get("branch");
          const status = target.searchParams.get("status");
          const perPage = Number(target.searchParams.get("per_page") || 30);
          const runs = (state.runs[fullName] || []).filter(
            (run) =>
              (!branch || run.head_branch === branch) &&
              (!status || run.status === status || run.conclusion === status),
          );
          return send(res, 200, {
            total_count: runs.length,
            workflow_runs: runs.slice(0, perPage),
          });
        }

        const jobsRoute = rest.match(/^\/actions\/runs\/(\d+)\/jobs$/);
        if (req.method === "GET" && jobsRoute) {
          if (state.scenario.jobs === "error")
            return send(res, 500, { message: "fixture jobs failure" });
          const jobs = state.jobs[jobsRoute[1]] || [];
          return send(res, 200, { total_count: jobs.length, jobs });
        }

        const logsRoute = rest.match(/^\/actions\/jobs\/(\d+)\/logs$/);
        if (req.method === "GET" && logsRoute) {
          if (state.scenario.logs === "error")
            return send(res, 500, { message: "fixture logs failure" });
          const text = state.logs[logsRoute[1]];
          if (text === undefined)
            return send(res, 404, { message: "Not Found" });
          return send(res, 200, text, "text/plain; charset=utf-8");
        }

        const contentsRoute = rest.match(/^\/contents\/(.+)$/);
        if (req.method === "GET" && contentsRoute) {
          const path = decodeURIComponent(contentsRoute[1]);
          const text = state.contents[`${fullName}:${path}`];
          if (text === undefined)
            return send(res, 404, { message: "Not Found" });
          return send(res, 200, {
            type: "file",
            name: path.split("/").pop(),
            path,
            sha: crypto.createHash("sha1").update(text).digest("hex"),
            size: Buffer.byteLength(text),
            encoding: "base64",
            content: Buffer.from(text).toString("base64"),
          });
        }

        if (req.method === "POST" && rest === "/issues") {
          recordedBody = JSON.parse((await readBody(req)) || "{}");
          if (state.scenario.issues === "forbidden")
            return send(res, 403, {
              message: "Resource not accessible by integration",
            });
          if (state.scenario.issues === "error")
            return send(res, 500, { message: "fixture issues failure" });
          const number = ++state.issueCounter;
          const issue = {
            number,
            title: recordedBody.title || "",
            body: recordedBody.body || "",
            labels: recordedBody.labels || [],
            html_url: `https://github.com/${fullName}/issues/${number}`,
            repository: fullName,
          };
          state.issues.push(issue);
          return send(res, 201, issue);
        }
      }

      state.unhandled.push(`${req.method} ${host}${pathname}`);
      return send(res, 404, { message: "Unmodeled GitHub fixture request" });
    } catch {
      state.unhandled.push(
        `${req.method} ${host}${pathname}: malformed request`,
      );
      return send(res, 400, { message: "Malformed fixture request" });
    }
  },
);

server.listen(Number(process.env.GITHUB_FIXTURE_PORT || 443), "0.0.0.0", () => {
  console.log(
    "Disposable GitHub HTTPS fixture ready (api.github.com + github.com); secrets are never logged.",
  );
});
