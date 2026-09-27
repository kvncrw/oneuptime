import {
  APIResponse,
  Browser,
  BrowserContext,
  Page,
  expect,
} from "@playwright/test";
import { createHmac, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerAndCreateProject } from "../Tests/Dashboard/Helpers/ProductOnboarding";
import {
  JSONish,
  createItem,
  getItem,
  getSessionUser,
  listItems,
  requestJson,
  toId,
} from "../Tests/Dashboard/Helpers/MonitorAlerting";
import discord from "../Discord/Fixture/identities.json";
import github from "./Fixture/identities.json";

/*
 * Shared plumbing for the CI watch acceptance suite (see README.md and
 * ~/.buzz/PLANS/ONEUPTIME_CI_WATCH.md "Contract"). Written before the feature
 * exists; every route and field name here is the contract the server must
 * meet. The helpers talk to three disposable fixtures:
 *
 *   https://discord.com          Discord/Fixture/server.cjs
 *   https://api.github.com       CiWatch/Fixture/github-server.cjs (+ github.com)
 *   http://llm-fixture:8089      CiWatch/Fixture/llm-server.cjs
 */

export const app: string = `http://${process.env["HOST"] || "oneuptime.test:7849"}`;
export const discordIds: typeof discord = discord;
export const githubIds: typeof github = github;
export const repoFullName: string = `${github.owner}/${github.repository}`;

// ---------------------------------------------------------------- contract --

export const routes: {
  config: string;
  workflow: string;
  event: string;
  webhook: string;
  interactions: string;
  reconcile: string;
  threads: string;
  codeRepository: string;
  llmProvider: string;
  llmProviderTest: string;
  relayClaim: string;
  relayResult: string;
} = {
  config: "/api/ci-watch-config",
  workflow: "/api/ci-workflow",
  event: "/api/ci-workflow-event",
  webhook: "/api/github/webhook",
  interactions: "/api/discord/interactions",
  /*
   * Contract addition (not in the plan's route list): a manual trigger for
   * the CiWatch:Reconcile worker, scoped by the projectid header and gated on
   * EditCiWatch, so FM10/FM11 do not wait for the 10 minute cron.
   */
  reconcile: "/api/ci-watch/reconcile",
  threads: "/api/discord-resource-thread",
  codeRepository: "/api/code-repository",
  llmProvider: "/api/llm-provider",
  llmProviderTest: "/api/llm-provider/test",
  /*
   * LLM relay (~/.buzz/PLANS/ONEUPTIME_LLM_RELAY.md): a worker long-polls
   * `claim` and answers on `result/:id`, both gated by the
   * `x-llm-relay-token` header against the app's LLM_RELAY_TOKEN.
   */
  relayClaim: "/api/llm-relay/claim",
  relayResult: "/api/llm-relay/result",
};

export const relayTokenHeader: string = "x-llm-relay-token";

// The timeouts the CI watch callers pass, so the relay specs can bound waits.
export const astraTimeoutMs: number = 45000;
export const relayMaxClaimWaitSeconds: number = 25;
export const relayMaxBodyBytes: number = 1024 * 1024;

export const actions: {
  fileIssue: string;
  assessRetire: string;
  markKnownRed: string;
  mute: string;
} = {
  fileIssue: "CiFileIssue",
  assessRetire: "CiAssessRetire",
  markKnownRed: "CiMarkKnownRed",
  mute: "CiMute",
};

// The tool names /astra offers the model. Distinct from the button action ids above.
export const astraTools: {
  fileIssue: string;
  markKnownRed: string;
} = {
  fileIssue: "file_issue",
  markKnownRed: "mark_known_red",
};

export const eventTypes: {
  newFailure: string;
  signatureChanged: string;
  recovered: string;
  monitorFailure: string;
} = {
  newFailure: "NewFailure",
  signatureChanged: "SignatureChanged",
  recovered: "Recovered",
  monitorFailure: "MonitorFailure",
};

export const analysisStatuses: {
  done: string;
  noProvider: string;
  disabled: string;
  failed: string;
} = {
  done: "Done",
  noProvider: "NoProvider",
  disabled: "Disabled",
  failed: "Failed",
};

export const workflowSelect: JSONish = {
  _id: true,
  codeRepositoryId: true,
  workflowName: true,
  gitHubWorkflowId: true,
  branchName: true,
  lastConclusion: true,
  lastRunId: true,
  lastRunUrl: true,
  lastFailureSignature: true,
  consecutiveFailureCount: true,
  isKnownRed: true,
  knownRedReason: true,
  knownRedSignature: true,
  ticketUrl: true,
  isFlaky: true,
  mutedUntil: true,
};

export const eventSelect: JSONish = {
  _id: true,
  ciWorkflowId: true,
  runId: true,
  runUrl: true,
  headSha: true,
  conclusion: true,
  eventType: true,
  failureSignature: true,
  firstFailingJob: true,
  analysis: true,
  analysisStatus: true,
  issueUrl: true,
  discordMessageId: true,
  postedAt: true,
  actedByUserId: true,
};

// --------------------------------------------------------- fixture control --

export interface ProviderEvent {
  method: string;
  path: string;
  status: number | null;
}
export interface PostedMessage {
  id?: string;
  channel_id?: string;
  content?: string;
  embeds?: Array<JSONish>;
  components?: Array<JSONish>;
  interaction_token?: string;
  webhook_kind?: string;
  edited_original?: boolean;
}
export interface FixtureThread {
  id: string;
  name: string;
  parent_id: string;
}
export interface DiscordState {
  scenario: string;
  events: Array<ProviderEvent>;
  unhandled: Array<string>;
  postedMessages: Array<PostedMessage>;
  createdThreads: Array<FixtureThread>;
}
export interface GitHubRequest {
  host: string;
  method: string;
  path: string;
  query: string;
  auth: string;
  status: number | null;
  body: JSONish | null;
}
export interface GitHubState {
  scenario: {
    runs: string;
    jobs: string;
    logs: string;
    issues: string;
    token: string;
  };
  installationId: string;
  repositories: Array<{ owner: string; name: string; id: number }>;
  issues: Array<{
    number: number;
    title: string;
    body: string;
    html_url: string;
    repository: string;
  }>;
  requests: Array<GitHubRequest>;
  unhandled: Array<string>;
}
export interface LlmRequest {
  receivedAt: string;
  authorization: string;
  model: string;
  messages: Array<{ role: string; content?: unknown }>;
  tools: Array<string>;
  raw: string;
}
export interface LlmState {
  mode: JSONish;
  requests: Array<LlmRequest>;
  unhandled: Array<string>;
}

async function control<T>(
  base: string,
  tokenEnv: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token: string | undefined = process.env[tokenEnv];
  if (!token) {
    throw new Error(`Disposable ${tokenEnv} is required`);
  }
  const response: Response = await fetch(`${base}/__fixture/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-fixture-control": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, `${base} fixture control ${path} failed`).toBe(200);
  return (await response.json()) as T;
}

export const discordFixture: {
  state: () => Promise<DiscordState>;
  scenario: (name: string) => Promise<DiscordState>;
} = {
  state: (): Promise<DiscordState> => {
    return control(
      "https://discord.com",
      "DISCORD_FIXTURE_CONTROL_TOKEN",
      "state",
    );
  },
  scenario: (name: string): Promise<DiscordState> => {
    return control(
      "https://discord.com",
      "DISCORD_FIXTURE_CONTROL_TOKEN",
      "scenario",
      { scenario: name },
    );
  },
};

export const githubFixture: {
  state: () => Promise<GitHubState>;
  reset: () => Promise<GitHubState>;
  program: (input: JSONish) => Promise<GitHubState>;
} = {
  state: (): Promise<GitHubState> => {
    return control(
      "https://api.github.com",
      "CI_WATCH_FIXTURE_CONTROL_TOKEN",
      "state",
    );
  },
  reset: (): Promise<GitHubState> => {
    return control(
      "https://api.github.com",
      "CI_WATCH_FIXTURE_CONTROL_TOKEN",
      "reset",
      {},
    );
  },
  program: (input: JSONish): Promise<GitHubState> => {
    return control(
      "https://api.github.com",
      "CI_WATCH_FIXTURE_CONTROL_TOKEN",
      "program",
      input,
    );
  },
};

export const llmFixture: {
  state: () => Promise<LlmState>;
  reset: () => Promise<LlmState>;
  program: (mode: JSONish) => Promise<LlmState>;
} = {
  state: (): Promise<LlmState> => {
    return control(
      "http://llm-fixture:8089",
      "CI_WATCH_FIXTURE_CONTROL_TOKEN",
      "state",
    );
  },
  reset: (): Promise<LlmState> => {
    return control(
      "http://llm-fixture:8089",
      "CI_WATCH_FIXTURE_CONTROL_TOKEN",
      "reset",
      {},
    );
  },
  program: (mode: JSONish): Promise<LlmState> => {
    return control(
      "http://llm-fixture:8089",
      "CI_WATCH_FIXTURE_CONTROL_TOKEN",
      "program",
      { mode, clearRequests: true },
    );
  },
};

// ------------------------------------------------------------- LLM relay --

/*
 * The relay worker fixture (Fixture/llm-relay-worker.cjs) models the
 * headshot worker: it long-polls the app's claim route, forwards each body
 * verbatim to the LLM fixture and posts the upstream answer back. It can be
 * paused so a spec can claim by hand or model "no worker running".
 */
export interface RelayWorkerClaim {
  id: string;
  claimedAt: string;
  model: string;
  hasTools: boolean;
}
export interface RelayWorkerResult {
  id: string;
  upstreamStatus: number;
  postStatus: number;
}
export interface RelayWorkerState {
  enabled: boolean;
  forwardDelayMs: number;
  claims: Array<RelayWorkerClaim>;
  results: Array<RelayWorkerResult>;
  errors: Array<string>;
  claimStatuses: Array<number>;
}

export const relayWorker: {
  state: () => Promise<RelayWorkerState>;
  reset: () => Promise<RelayWorkerState>;
  program: (input: JSONish) => Promise<RelayWorkerState>;
} = {
  state: (): Promise<RelayWorkerState> => {
    return control(
      "http://llm-relay-worker:8090",
      "CI_WATCH_FIXTURE_CONTROL_TOKEN",
      "state",
    );
  },
  reset: (): Promise<RelayWorkerState> => {
    return control(
      "http://llm-relay-worker:8090",
      "CI_WATCH_FIXTURE_CONTROL_TOKEN",
      "reset",
      {},
    );
  },
  // `{enabled: false}` returns only once the worker is idle (no claim in flight).
  program: (input: JSONish): Promise<RelayWorkerState> => {
    return control(
      "http://llm-relay-worker:8090",
      "CI_WATCH_FIXTURE_CONTROL_TOKEN",
      "program",
      input,
    );
  },
};

export function relayToken(): string {
  const token: string | undefined = process.env["LLM_RELAY_TOKEN"];
  if (!token) {
    throw new Error("Disposable LLM_RELAY_TOKEN is required");
  }
  return token;
}

export interface RelayJob {
  id: string;
  body: JSONish;
}

export interface RelayClaimResult {
  status: number;
  elapsedMs: number;
  job: RelayJob | undefined;
  text: string;
}

/*
 * One claim as the worker makes it. `token: null` sends no header at all;
 * a string other than the real token models a wrong one.
 */
export async function relayClaim(options: {
  waitSeconds: number;
  token?: string | null | undefined;
}): Promise<RelayClaimResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token !== null) {
    headers[relayTokenHeader] = options.token ?? relayToken();
  }
  const started: number = Date.now();
  const response: Response = await fetch(`${app}${routes.relayClaim}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ waitSeconds: options.waitSeconds }),
  });
  const text: string = await response.text();
  let job: RelayJob | undefined;
  if (response.status === 200 && text) {
    const parsed: JSONish = JSON.parse(text) as JSONish;
    job = { id: String(parsed["id"]), body: parsed["body"] as JSONish };
  }
  return {
    status: response.status,
    elapsedMs: Date.now() - started,
    job,
    text,
  };
}

// Posts an upstream answer for a claimed job, as the worker does.
export async function relayResult(options: {
  id: string;
  status: number;
  json: JSONish;
  token?: string | null | undefined;
}): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token !== null) {
    headers[relayTokenHeader] = options.token ?? relayToken();
  }
  const response: Response = await fetch(
    `${app}${routes.relayResult}/${encodeURIComponent(options.id)}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ status: options.status, json: options.json }),
    },
  );
  return { status: response.status, text: await response.text() };
}

// Pops every job left on the queue so the next spec starts from empty.
export async function drainRelayQueue(): Promise<number> {
  let drained: number = 0;
  for (let attempt: number = 0; attempt < 50; attempt++) {
    const claim: RelayClaimResult = await relayClaim({ waitSeconds: 0 });
    if (claim.status !== 200) {
      break;
    }
    drained++;
  }
  return drained;
}

// An OpenAI-shaped completion, for results a spec posts by hand.
export function relayCompletion(content: string): JSONish {
  return {
    id: `chatcmpl-e2e-${randomBytes(4).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: github.llmModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

export const relayModel: string = github.llmModel;

// A `Relay` provider: no base URL, no API key, only a model name.
export async function createRelayProvider(
  page: Page,
  projectId: string,
  modelName: string = relayModel,
): Promise<string> {
  const row: JSONish = await createItem({
    page,
    projectId,
    path: routes.llmProvider,
    item: {
      projectId,
      name: "CI watch relay",
      llmType: "Relay",
      modelName,
      isDefault: true,
    },
  });
  return toId(row["_id"]);
}

export interface ProviderTestResult {
  status: number;
  elapsedMs: number;
  text: string;
}

// The dashboard's "Test connection" button: one completion through the provider.
export async function testProvider(
  page: Page,
  projectId: string,
  providerId: string,
): Promise<ProviderTestResult> {
  const started: number = Date.now();
  const response: APIResponse = await page.request.post(
    `${app}${routes.llmProviderTest}`,
    {
      headers: { "content-type": "application/json", ...headers(projectId) },
      data: { llmProviderId: providerId },
    },
  );
  return {
    status: response.status(),
    elapsedMs: Date.now() - started,
    text: await response.text(),
  };
}

// The latest interaction follow-up the fixture saw for a token, if any.
export async function interactionFollowUp(
  token: string,
): Promise<PostedMessage | undefined> {
  const state: DiscordState = await discordFixture.state();
  return state.postedMessages.find((message: PostedMessage): boolean => {
    return (
      message.webhook_kind === "interaction" &&
      message.interaction_token === token
    );
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve: (value: void) => void): void => {
    setTimeout(resolve, ms);
  });
}

// ----------------------------------------------------------- GitHub events --

let runCounter: number = Math.floor(Date.now() / 1000) * 100;
let workflowCounter: number = Math.floor(Date.now() / 1000);

/*
 * Every provisioned project binds its own GitHub App installation id. The
 * app fans a workflow_run out to every project whose repository is bound to
 * the delivering installation, so with one shared id every earlier project
 * (another spec file, or a beforeAll re-run after a worker restart) would
 * alert too and double every "exactly one" count. The id is looked up by
 * the page that owns the project, so a fresh project provisioned inside a
 * test cannot steer the file-level project's deliveries.
 */
const installationByPage: WeakMap<Page, string> = new WeakMap<Page, string>();
let currentInstallationId: string = github.installationId;

export function installationFor(page: Page): string {
  return installationByPage.get(page) || currentInstallationId;
}

export interface WorkflowRef {
  id: string;
  name: string;
}

// A workflow name nobody else in the run will use, so every test owns its row.
export function uniqueWorkflow(label: string): WorkflowRef {
  workflowCounter++;
  return { id: String(workflowCounter), name: `${label} ${workflowCounter}` };
}

export function nextRunId(): string {
  runCounter++;
  return String(runCounter);
}

export interface RunOptions {
  workflow: WorkflowRef;
  conclusion: string;
  runId?: string | undefined;
  branch?: string | undefined;
  repository?: string | undefined;
  headSha?: string | undefined;
  action?: string | undefined;
  installationId?: string | undefined;
}

// The `workflow_run` webhook body, in GitHub's shape, for one completed run.
export function workflowRunPayload(options: RunOptions): JSONish {
  const runId: string = options.runId || nextRunId();
  const fullName: string = options.repository || repoFullName;
  const [owner, name] = fullName.split("/") as [string, string];
  const branch: string = options.branch || github.defaultBranch;
  const sha: string = options.headSha || randomBytes(20).toString("hex");
  return {
    action: options.action || "completed",
    workflow_run: {
      id: Number(runId),
      name: options.workflow.name,
      workflow_id: Number(options.workflow.id),
      head_branch: branch,
      head_sha: sha,
      event: "push",
      status: "completed",
      conclusion: options.conclusion,
      run_number: Number(runId) % 1000,
      run_attempt: 1,
      html_url: `https://github.com/${fullName}/actions/runs/${runId}`,
      jobs_url: `https://api.github.com/repos/${fullName}/actions/runs/${runId}/jobs`,
      created_at: new Date(Date.now() - 60000).toISOString(),
      updated_at: new Date().toISOString(),
      path: `.github/workflows/${options.workflow.id}.yml`,
    },
    workflow: {
      id: Number(options.workflow.id),
      name: options.workflow.name,
      path: `.github/workflows/${options.workflow.id}.yml`,
    },
    repository: {
      id: 7100001,
      name,
      full_name: fullName,
      private: true,
      html_url: `https://github.com/${fullName}`,
      default_branch: github.defaultBranch,
      owner: { login: owner },
    },
    installation: {
      id: Number(options.installationId || currentInstallationId),
    },
    sender: { login: "ci-e2e-bot", type: "User" },
  };
}

// The same run in the shape GET /repos/{o}/{r}/actions/runs returns.
export function runListEntry(payload: JSONish): JSONish {
  return payload["workflow_run"] as JSONish;
}

export function webhookSecret(): string {
  const secret: string | undefined = process.env["GITHUB_APP_WEBHOOK_SECRET"];
  if (!secret) {
    throw new Error("GITHUB_APP_WEBHOOK_SECRET is required to sign webhooks");
  }
  return secret;
}

export function signWebhook(
  body: string,
  secret: string = webhookSecret(),
): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export interface DeliveryOptions {
  deliveryId?: string | undefined;
  signature?: string | null | undefined;
  event?: string | undefined;
}

/*
 * Delivers one signed workflow_run webhook as GitHub would, from the
 * installation bound to the page's project. Returns the response.
 */
export async function deliverWebhook(
  page: Page,
  payload: JSONish,
  options: DeliveryOptions = {},
): Promise<{ response: APIResponse; deliveryId: string; body: string }> {
  payload = {
    ...payload,
    installation: { id: Number(installationFor(page)) },
  };
  const body: string = JSON.stringify(payload);
  const deliveryId: string =
    options.deliveryId || `e2e-${randomBytes(8).toString("hex")}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": options.event || "workflow_run",
    "x-github-delivery": deliveryId,
    "user-agent": "GitHub-Hookshot/e2e",
  };
  if (options.signature !== null) {
    headers["x-hub-signature-256"] = options.signature || signWebhook(body);
  }
  const response: APIResponse = await page.request.post(
    `${app}${routes.webhook}`,
    {
      data: body,
      headers,
    },
  );
  return { response, deliveryId, body };
}

export interface FailureLog {
  runId: string;
  jobId?: string | undefined;
  jobName?: string | undefined;
  stepName?: string | undefined;
  log: string;
}

// Programs the jobs and log the app will fetch for a failed run.
export async function programFailure(data: FailureLog): Promise<string> {
  const jobId: string = data.jobId || `${data.runId}1`;
  const jobName: string = data.jobName || "test";
  const stepName: string = data.stepName || "Run tests";
  await githubFixture.program({
    jobs: {
      [data.runId]: [
        {
          id: Number(`${data.runId}0`),
          run_id: Number(data.runId),
          name: "lint",
          status: "completed",
          conclusion: "success",
          html_url: `https://github.com/${repoFullName}/actions/runs/${data.runId}/job/${data.runId}0`,
          steps: [
            {
              name: "Lint",
              status: "completed",
              conclusion: "success",
              number: 1,
            },
          ],
        },
        {
          id: Number(jobId),
          run_id: Number(data.runId),
          name: jobName,
          status: "completed",
          conclusion: "failure",
          html_url: `https://github.com/${repoFullName}/actions/runs/${data.runId}/job/${jobId}`,
          steps: [
            {
              name: "Checkout",
              status: "completed",
              conclusion: "success",
              number: 1,
            },
            {
              name: stepName,
              status: "completed",
              conclusion: "failure",
              number: 2,
            },
          ],
        },
      ],
    },
    logs: { [jobId]: data.log },
  });
  return jobId;
}

export function sampleFailureLog(marker: string, lines: number = 40): string {
  const output: Array<string> = [];
  for (let index: number = 0; index < lines; index++) {
    output.push(
      `2026-09-27T10:00:${String(index % 60).padStart(2, "0")}.000Z ##[group]step ${index}`,
    );
  }
  output.push(
    `2026-09-27T10:01:00.000Z ##[error]AssertionError: expected 200 to equal 500 (${marker})`,
  );
  output.push(
    `2026-09-27T10:01:00.100Z     at Context.<anonymous> (tests/${marker}.spec.ts:42:11)`,
  );
  output.push(
    `2026-09-27T10:01:00.200Z Error: Process completed with exit code 1.`,
  );
  return output.join("\n");
}

// ---------------------------------------------------------- app data reads --

export async function listWorkflows(
  page: Page,
  projectId: string,
  query: JSONish = {},
): Promise<Array<JSONish>> {
  return listItems({
    page,
    projectId,
    path: routes.workflow,
    query: { projectId, ...query },
    select: workflowSelect,
    limit: 100,
  });
}

export async function findWorkflow(
  page: Page,
  projectId: string,
  workflow: WorkflowRef,
): Promise<JSONish | undefined> {
  const rows: Array<JSONish> = await listWorkflows(page, projectId, {
    gitHubWorkflowId: workflow.id,
  });
  return rows[0];
}

export async function listEvents(
  page: Page,
  projectId: string,
  query: JSONish = {},
): Promise<Array<JSONish>> {
  return listItems({
    page,
    projectId,
    path: routes.event,
    query: { projectId, ...query },
    select: eventSelect,
    limit: 100,
  });
}

export async function eventsForWorkflow(
  page: Page,
  projectId: string,
  workflow: WorkflowRef,
): Promise<Array<JSONish>> {
  const row: JSONish | undefined = await findWorkflow(
    page,
    projectId,
    workflow,
  );
  if (!row) {
    return [];
  }
  return listEvents(page, projectId, { ciWorkflowId: toId(row["_id"]) });
}

export async function updateItem(
  page: Page,
  projectId: string,
  path: string,
  id: string,
  data: JSONish,
): Promise<void> {
  await requestJson({
    page,
    projectId,
    path: `${path}/${id}`,
    body: { data },
    method: "put",
  });
}

export async function readItem(
  page: Page,
  projectId: string,
  path: string,
  id: string,
  select: JSONish,
): Promise<JSONish> {
  return getItem({ page, projectId, path, id, select });
}

// The Discord thread the app bound to a workflow (DiscordResourceType.ciWorkflow).
export async function threadIdForWorkflow(
  page: Page,
  projectId: string,
  workflowId: string,
): Promise<string | undefined> {
  const rows: Array<JSONish> = await listItems({
    page,
    projectId,
    path: routes.threads,
    query: { projectId, resourceType: "ciWorkflow", resourceId: workflowId },
    select: { _id: true, threadId: true, state: true, resourceType: true },
  });
  const active: JSONish | undefined = rows.find((row: JSONish): boolean => {
    return Boolean(row["threadId"]);
  });
  return active ? String(active["threadId"]) : undefined;
}

/*
 * Every Discord message the fixture saw for this workflow: posts into its
 * thread, plus anything anywhere that names the workflow (a mis-routed post
 * must still count as an alert).
 */
export async function discordMessagesForWorkflow(
  page: Page,
  projectId: string,
  workflow: WorkflowRef,
): Promise<Array<PostedMessage>> {
  const row: JSONish | undefined = await findWorkflow(
    page,
    projectId,
    workflow,
  );
  const threadId: string | undefined = row
    ? await threadIdForWorkflow(page, projectId, toId(row["_id"]))
    : undefined;
  const state: DiscordState = await discordFixture.state();
  return state.postedMessages.filter((message: PostedMessage): boolean => {
    if (message.webhook_kind === "interaction") {
      return false;
    }
    if (threadId && message.channel_id === threadId) {
      return true;
    }
    return messageText(message).includes(workflow.name);
  });
}

export function messageText(message: PostedMessage): string {
  const parts: Array<string> = [message.content || ""];
  for (const embed of message.embeds || []) {
    parts.push(
      String(embed["title"] || ""),
      String(embed["description"] || ""),
    );
    for (const field of (embed["fields"] as Array<JSONish> | undefined) || []) {
      parts.push(String(field["name"] || ""), String(field["value"] || ""));
    }
  }
  return parts.join("\n");
}

export function buttonIds(message: PostedMessage): Array<string> {
  const ids: Array<string> = [];
  for (const row of message.components || []) {
    for (const component of (row["components"] as Array<JSONish> | undefined) ||
      []) {
      if (component["custom_id"]) {
        ids.push(String(component["custom_id"]));
      }
    }
  }
  return ids;
}

// Counts fixture requests, so "suppressed" and "failed" are distinguishable.
export function countRequests(
  state: GitHubState,
  method: string,
  pathPattern: RegExp,
): number {
  return state.requests.filter((request: GitHubRequest): boolean => {
    return (
      request.host === "api.github.com" &&
      request.method === method &&
      pathPattern.test(request.path)
    );
  }).length;
}

export function countDiscordEvents(
  state: DiscordState,
  method: string,
  pathPattern: RegExp,
): number {
  return state.events.filter((event: ProviderEvent): boolean => {
    return event.method === method && pathPattern.test(event.path);
  }).length;
}

/*
 * Waits until `read` yields `expected`, then keeps reading for `quietMs` to
 * prove it stays there. "Exactly one alert" is this, not a single sample.
 */
export async function expectStable<T>(
  read: () => Promise<T>,
  expected: T,
  quietMs: number = 4000,
  timeout: number = 30000,
): Promise<void> {
  const sleep: (ms: number) => Promise<void> = (ms: number): Promise<void> => {
    return new Promise((resolve: (value: void) => void): void => {
      setTimeout(resolve, ms);
    });
  };
  const deadline: number = Date.now() + timeout;
  let last: T = await read();
  while (
    JSON.stringify(last) !== JSON.stringify(expected) &&
    Date.now() < deadline
  ) {
    await sleep(500);
    last = await read();
  }
  expect(last as unknown).toEqual(expected);
  const until: number = Date.now() + quietMs;
  while (Date.now() < until) {
    await sleep(500);
    expect((await read()) as unknown).toEqual(expected);
  }
}

// Reconcile sweep trigger (contract addition, see `routes.reconcile`).
export async function reconcile(
  page: Page,
  projectId: string,
): Promise<APIResponse> {
  return page.request.post(`${app}${routes.reconcile}`, {
    headers: {
      "content-type": "application/json",
      tenantid: projectId,
      projectid: projectId,
    },
    data: {},
  });
}

// ---------------------------------------------------- Discord interactions --

export interface InteractionOptions {
  userId?: string | undefined;
  channelId?: string | undefined;
}

export function interactionId(): string {
  return (
    BigInt(`0x${randomBytes(8).toString("hex")}`) + BigInt("100000000000000000")
  ).toString();
}

export function buttonPayload(
  action: string,
  resourceId: string,
  options: InteractionOptions = {},
): string {
  const id: string = interactionId();
  return JSON.stringify({
    id,
    token: `fixture-interaction-${id}`,
    application_id: discord.applicationId,
    guild_id: discord.guildId,
    channel_id: options.channelId || discord.channelId,
    member: { user: { id: options.userId || discord.userId } },
    type: 3,
    data: { custom_id: `${action}:${resourceId}`, component_type: 2 },
  });
}

// `/astra request:<text>` as Discord delivers a chat-input command.
export function astraPayload(
  request: string,
  options: InteractionOptions = {},
): string {
  const id: string = interactionId();
  return JSON.stringify({
    id,
    token: `fixture-interaction-${id}`,
    application_id: discord.applicationId,
    guild_id: discord.guildId,
    channel_id: options.channelId || discord.channelId,
    member: { user: { id: options.userId || discord.userId } },
    type: 2,
    data: {
      id: "200000000000000001",
      name: "astra",
      type: 1,
      options: [{ name: "request", type: 3, value: request }],
    },
  });
}

export function interactionToken(body: string): string {
  return String((JSON.parse(body) as JSONish)["token"]);
}

export function signedInteractionHeaders(body: string): Record<string, string> {
  const path: string | undefined = process.env["DISCORD_FIXTURE_SIGNING_KEY"];
  if (!path) {
    throw new Error("Disposable DISCORD_FIXTURE_SIGNING_KEY is required");
  }
  const timestamp: string = Math.floor(Date.now() / 1000).toString();
  return {
    "content-type": "application/json",
    "x-signature-timestamp": timestamp,
    "x-signature-ed25519": sign(
      null,
      Buffer.from(timestamp + body),
      readFileSync(path),
    ).toString("hex"),
  };
}

export interface InteractionResult {
  status: number;
  type: number | undefined;
  content: string;
  flags: number | undefined;
  elapsedMs: number;
  token: string;
}

// Sends a signed interaction and returns the initial (synchronous) response.
export async function sendInteraction(
  page: Page,
  body: string,
): Promise<InteractionResult> {
  const started: number = Date.now();
  const response: APIResponse = await page.request.post(
    `${app}${routes.interactions}`,
    {
      data: body,
      headers: signedInteractionHeaders(body),
    },
  );
  const elapsedMs: number = Date.now() - started;
  let parsed: JSONish = {};
  try {
    parsed = (await response.json()) as JSONish;
  } catch {
    parsed = {};
  }
  const data: JSONish = (parsed["data"] as JSONish | undefined) || {};
  return {
    status: response.status(),
    type:
      typeof parsed["type"] === "number"
        ? (parsed["type"] as number)
        : undefined,
    content: String(data["content"] || ""),
    flags:
      typeof data["flags"] === "number" ? (data["flags"] as number) : undefined,
    elapsedMs,
    token: interactionToken(body),
  };
}

// The message the actor ends up seeing: immediate content, or the deferred edit.
export async function finalReply(
  page: Page,
  body: string,
  timeout: number = 60000,
): Promise<InteractionResult & { deferred: boolean }> {
  const initial: InteractionResult = await sendInteraction(page, body);
  if (initial.type !== 5 && initial.type !== 6) {
    return { ...initial, deferred: false };
  }
  let terminal: PostedMessage | undefined;
  await expect
    .poll(
      async (): Promise<boolean> => {
        const state: DiscordState = await discordFixture.state();
        terminal = state.postedMessages.find(
          (message: PostedMessage): boolean => {
            return (
              message.webhook_kind === "interaction" &&
              message.interaction_token === initial.token
            );
          },
        );
        return Boolean(terminal);
      },
      { timeout },
    )
    .toBe(true);
  return {
    ...initial,
    deferred: true,
    content: terminal ? messageText(terminal) : "",
    flags: undefined,
  };
}

// ---------------------------------------------------------- provisioning --

export interface ProvisionedProject {
  context: BrowserContext;
  page: Page;
  projectId: string;
  userId: string;
  codeRepositoryId: string;
  configId: string;
  installationId: string;
}

export const headers: (projectId: string) => Record<string, string> = (
  projectId: string,
): Record<string, string> => {
  return { tenantid: projectId, projectid: projectId };
};

// Connects the project's Discord server (install) and links the current user.
export async function connectDiscord(
  page: Page,
  projectId: string,
  linkUser: boolean = true,
): Promise<void> {
  for (const route of linkUser
    ? ["install-url", "sign-in-url"]
    : ["install-url"]) {
    const response: APIResponse = await page.request.get(
      `${app}/api/discord/${route}`,
      { headers: headers(projectId) },
    );
    expect(response.status(), `GET /api/discord/${route}`).toBe(200);
    const result: { authorizationUrl: string } = (await response.json()) as {
      authorizationUrl: string;
    };
    await page.goto(result.authorizationUrl);
  }
  const linked: Array<JSONish> = await listItems({
    page,
    projectId,
    path: "/api/workspace-project-auth-token",
    query: { projectId, workspaceType: "Discord" },
    select: { _id: true },
  });
  expect(linked, "Discord project binding").toHaveLength(1);
}

// Links only the current user's Discord account to an already connected project.
export async function linkDiscordUser(
  page: Page,
  projectId: string,
): Promise<void> {
  const response: APIResponse = await page.request.get(
    `${app}/api/discord/sign-in-url`,
    { headers: headers(projectId) },
  );
  expect(response.status(), "GET /api/discord/sign-in-url").toBe(200);
  const result: { authorizationUrl: string } = (await response.json()) as {
    authorizationUrl: string;
  };
  await page.goto(result.authorizationUrl);
}

/*
 * Binds the project to the fixture's GitHub App installation THE WAY THE
 * PRODUCT DOES: /api/github/auth/install redirects the browser to
 * github.com (the fixture), which bounces back to /api/github/auth/callback
 * with installation_id + code; the app trades the code, checks the user
 * controls the installation, writes Project.gitHubAppInstallationId and
 * imports the installation's repositories as CodeRepository rows.
 */
export async function connectGitHub(
  page: Page,
  projectId: string,
): Promise<string> {
  await page.goto(`${app}/api/github/auth/install?projectId=${projectId}`);
  let repository: JSONish | undefined;
  await expect
    .poll(
      async (): Promise<boolean> => {
        const rows: Array<JSONish> = await listItems({
          page,
          projectId,
          path: routes.codeRepository,
          query: {
            projectId,
            organizationName: github.owner,
            repositoryName: github.repository,
          },
          select: {
            _id: true,
            mainBranchName: true,
            gitHubAppInstallationId: true,
          },
        });
        repository = rows[0];
        return Boolean(repository);
      },
      { timeout: 60000 },
    )
    .toBe(true);
  expect(String(repository!["gitHubAppInstallationId"])).toBe(
    installationFor(page),
  );
  return toId(repository!["_id"]);
}

export async function createConfig(
  page: Page,
  projectId: string,
  overrides: JSONish = {},
): Promise<string> {
  const row: JSONish = await createItem({
    page,
    projectId,
    path: routes.config,
    item: {
      projectId,
      isEnabled: true,
      discordChannelId: discord.channelId,
      branchName: github.defaultBranch,
      issueTarget: "GitHub",
      ...overrides,
    },
  });
  const id: string = toId(row["_id"]);
  expect(id, "CiWatchConfig id").toBeTruthy();
  return id;
}

export async function createLlmProvider(
  page: Page,
  projectId: string,
): Promise<string> {
  const row: JSONish = await createItem({
    page,
    projectId,
    path: routes.llmProvider,
    item: {
      projectId,
      name: "CI watch fixture",
      llmType: "OpenAICompatible",
      baseUrl: github.llmBaseUrl,
      modelName: github.llmModel,
      apiKey: "fixture-key-not-a-secret",
      isDefault: true,
    },
  });
  return toId(row["_id"]);
}

export interface ProvisionOptions {
  llm?: boolean | undefined;
  namePrefix?: string | undefined;
  /*
   * Only a repository's FIRST sweep seeds silently; a workflow that appears
   * later alerts on its first failure. Provisioning runs that first sweep
   * with `baselineWorkflow` so every spec starts from a seeded repository.
   * FM05 opts out to observe the seeding sweep itself.
   */
  seedRepository?: boolean | undefined;
}

// The one workflow every seeded repository starts with.
export const baselineWorkflow: WorkflowRef = {
  id: "100",
  name: "baseline build",
};

// Runs the repository's first reconcile sweep with a green baseline workflow.
export async function seedRepository(
  page: Page,
  projectId: string,
): Promise<void> {
  const green: JSONish = runListEntry(
    workflowRunPayload({ workflow: baselineWorkflow, conclusion: "success" }),
  );
  await githubFixture.program({ runs: { [repoFullName]: [green] } });
  const response: APIResponse = await reconcile(page, projectId);
  expect(response.status(), "seeding sweep").toBe(200);
  await expect
    .poll(async (): Promise<string> => {
      return String(
        (await findWorkflow(page, projectId, baselineWorkflow))?.[
          "lastConclusion"
        ] || "",
      );
    })
    .toBe("success");
  expect(
    await listEvents(page, projectId),
    "seeding never alerts",
  ).toHaveLength(0);
}

// A fresh owner, project, Discord binding, GitHub installation and CI config.
export async function provisionProject(
  browser: Browser,
  options: ProvisionOptions = {},
): Promise<ProvisionedProject> {
  const context: BrowserContext = await browser.newContext();
  const page: Page = await context.newPage();
  const projectId: string = await registerAndCreateProject({
    page,
    projectNamePrefix: options.namePrefix || "CI watch",
  });
  const userId: string = (await getSessionUser({ page })).userId;
  await githubFixture.reset();
  await llmFixture.reset();
  const installationId: string = String(Date.now());
  await githubFixture.program({ installationId });
  installationByPage.set(page, installationId);
  currentInstallationId = installationId;
  await connectDiscord(page, projectId);
  const codeRepositoryId: string = await connectGitHub(page, projectId);
  const configId: string = await createConfig(page, projectId);
  if (options.llm) {
    await createLlmProvider(page, projectId);
  }
  if (options.seedRepository !== false) {
    await seedRepository(page, projectId);
  }
  return {
    context,
    page,
    projectId,
    userId,
    codeRepositoryId,
    configId,
    installationId,
  };
}

/*
 * Switches the project's CI watch off before closing its browser context.
 * The ten-minute reconcile worker sweeps every enabled project, and a
 * finished spec's project must not keep posting into the shared fixture
 * channel while a later spec counts messages there.
 */
export async function releaseProject(
  project: ProvisionedProject | undefined,
): Promise<void> {
  if (!project) {
    return;
  }
  try {
    await updateItem(
      project.page,
      project.projectId,
      routes.config,
      project.configId,
      {
        isEnabled: false,
      },
    );
  } catch {
    // The context may already be unusable; the worker restart case.
  }
  await project.context.close();
}

/*
 * Gives a workflow one successful run first, so the failure that follows is
 * the "last run passed" row of the decision table rather than a first
 * sighting.
 */
export async function seedGreen(
  page: Page,
  projectId: string,
  workflow: WorkflowRef,
): Promise<JSONish> {
  const { response } = await deliverWebhook(
    page,
    workflowRunPayload({ workflow, conclusion: "success" }),
  );
  expect(response.status(), "seed webhook").toBe(200);
  let row: JSONish | undefined;
  await expect
    .poll(async (): Promise<string> => {
      row = await findWorkflow(page, projectId, workflow);
      return String(row?.["lastConclusion"] || "");
    })
    .toBe("success");
  return row!;
}

// Delivers a failed run with a programmed log; returns the run id.
export async function failRun(
  page: Page,
  workflow: WorkflowRef,
  marker: string,
  extra: Partial<RunOptions> = {},
): Promise<string> {
  const runId: string = nextRunId();
  await programFailure({ runId, log: sampleFailureLog(marker) });
  const { response } = await deliverWebhook(
    page,
    workflowRunPayload({ workflow, conclusion: "failure", runId, ...extra }),
  );
  expect(response.status(), "failure webhook").toBe(200);
  return runId;
}

export async function waitForEvents(
  page: Page,
  projectId: string,
  workflow: WorkflowRef,
  count: number,
): Promise<Array<JSONish>> {
  await expectStable(async (): Promise<number> => {
    return (await eventsForWorkflow(page, projectId, workflow)).length;
  }, count);
  return eventsForWorkflow(page, projectId, workflow);
}

/*
 * Fake credentials in every shape the scrubber must catch. Assembled at
 * runtime so no source line looks like a real token to secret scanners
 * (GitHub push protection rejects the joined forms as literals).
 */
export const secretLiterals: Array<string> = [
  ["ghp", "E2ESECRETTOKEN0123456789abcdefABCDEF"].join("_"),
  ["github", "pat", "11E2ESECRET", "abcdefghijklmnopqrstuvwxyz0123456789"].join(
    "_",
  ),
  ["sk", "e2esecretopenai0123456789abcdefghij"].join("-"),
  ["xoxb", "1234567890", "e2esecretslack"].join("-"),
  ["AKIA", "E2ESECRETKEY0001"].join(""),
  ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJlMmUifQ", "e2esecretsignaturepart"].join(
    ".",
  ),
  ["Bearer", "e2e-secret-bearer-token"].join(" "),
];

export function containsSecret(text: string): string | undefined {
  return secretLiterals.find((secret: string): boolean => {
    return text.includes(secret);
  });
}
