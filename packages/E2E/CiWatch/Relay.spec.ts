import { Browser, TestInfo, expect, test } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { JSONish, toId } from "../Tests/Dashboard/Helpers/MonitorAlerting";
import {
  GitHubState,
  InteractionResult,
  LlmState,
  PostedMessage,
  ProvisionedProject,
  RelayClaimResult,
  RelayWorkerState,
  WorkflowRef,
  analysisStatuses,
  astraPayload,
  astraTimeoutMs,
  astraTools,
  countRequests,
  createRelayProvider,
  discordFixture,
  discordMessagesForWorkflow,
  drainRelayQueue,
  eventsForWorkflow,
  failRun,
  finalReply,
  findWorkflow,
  githubFixture,
  interactionFollowUp,
  llmFixture,
  messageText,
  provisionProject,
  relayClaim,
  relayCompletion,
  relayMaxBodyBytes,
  relayMaxClaimWaitSeconds,
  relayModel,
  relayResult,
  relayWorker,
  releaseProject,
  routes,
  seedGreen,
  sendInteraction,
  testProvider,
  threadIdForWorkflow,
  uniqueWorkflow,
  updateItem,
  waitForEvents,
} from "./Helpers";

/*
 * The LLM relay (~/.buzz/PLANS/ONEUPTIME_LLM_RELAY.md): a `Relay` provider
 * queues the built OpenAI chat-completions body on Redis instead of posting
 * it, and a worker beside the gateway claims it, forwards it, and posts the
 * answer back. Failure modes RFM01 and RFM03 to RFM11 run against the normal
 * stack, with the worker fixture paused where a spec needs to claim by hand.
 * RFM02 (token unset) and RFM12 (Redis down) need the stack reconfigured and
 * live in RelayStack.spec.ts.
 */

let project: ProvisionedProject;
let providerId: string;

test.beforeAll(async ({ browser }: { browser: Browser }): Promise<void> => {
  test.setTimeout(300000);
  await relayWorker.reset();
  await relayWorker.program({ enabled: true, forwardDelayMs: 0 });
  project = await provisionProject(browser, {
    namePrefix: "CI watch relay",
  });
  providerId = await createRelayProvider(project.page, project.projectId);
});

test.afterEach(
  async (
    { browser: _browser }: { browser: Browser },
    testInfo: TestInfo,
  ): Promise<void> => {
    await testInfo.attach("relay-worker", {
      body: JSON.stringify(await relayWorker.state()),
      contentType: "application/json",
    });
    await testInfo.attach("llm-provider", {
      body: JSON.stringify(await llmFixture.state()),
      contentType: "application/json",
    });
    await testInfo.attach("discord-provider", {
      body: JSON.stringify(await discordFixture.state()),
      contentType: "application/json",
    });
    await testInfo.attach("github-provider", {
      body: JSON.stringify(await githubFixture.state()),
      contentType: "application/json",
    });
    // Leave the queue empty and the worker running for the next spec.
    await drainRelayQueue();
    await relayWorker.program({ enabled: true, forwardDelayMs: 0 });
    await llmFixture.program({
      kind: "answer",
      content: "Fixture analysis: the build failed.",
    });
  },
);

test.afterAll(async (): Promise<void> => {
  await releaseProject(project);
});

async function llmCalls(): Promise<number> {
  return (await llmFixture.state()).requests.length;
}

async function workerClaims(): Promise<number> {
  return (await relayWorker.state()).claims.length;
}

async function alertInThread(
  label: string,
): Promise<{ workflow: WorkflowRef; threadId: string; eventId: string }> {
  const workflow: WorkflowRef = uniqueWorkflow(label);
  await seedGreen(project.page, project.projectId, workflow);
  await failRun(project.page, workflow, label.replace(/\s+/g, "-"));
  const events: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    workflow,
    1,
  );
  const row: JSONish = (await findWorkflow(
    project.page,
    project.projectId,
    workflow,
  ))!;
  const threadId: string = (await threadIdForWorkflow(
    project.page,
    project.projectId,
    toId(row["_id"]),
  ))!;
  return { workflow, threadId, eventId: toId(events[0]!["_id"]) };
}

// Pauses the worker and empties the queue so the spec owns every claim.
async function takeOverQueue(): Promise<void> {
  await relayWorker.program({ enabled: false });
  await drainRelayQueue();
}

async function followUpText(token: string): Promise<string> {
  const message: PostedMessage | undefined = await interactionFollowUp(token);
  return message ? messageText(message) : "";
}

test("RFM01 no worker running: /astra fails after the relay timeout with its 'could not reach the LLM' reply, no hang", async (): Promise<void> => {
  test.setTimeout(240000);
  const { threadId } = await alertInThread("rfm01");
  await takeOverQueue();
  const llmBefore: number = await llmCalls();
  const claimsBefore: number = await workerClaims();

  const started: number = Date.now();
  const reply: InteractionResult & { deferred: boolean } = await finalReply(
    project.page,
    astraPayload("rfm01 what does this error mean?", { channelId: threadId }),
    astraTimeoutMs + 60000,
  );
  const elapsedMs: number = Date.now() - started;

  expect(reply.status).toBe(200);
  expect(
    reply.deferred,
    "the answer is deferred, never a Discord timeout",
  ).toBe(true);
  expect(reply.content).toMatch(/could not reach the LLM/i);
  expect(elapsedMs, "gave up at the relay timeout").toBeLessThan(
    astraTimeoutMs + 30000,
  );
  expect(elapsedMs, "waited for the worker before giving up").toBeGreaterThan(
    30000,
  );
  expect(await llmCalls(), "nothing reached the model").toBe(llmBefore);
  expect(await workerClaims(), "the paused worker claimed nothing").toBe(
    claimsBefore,
  );
});

test("RFM03 wrong or missing token: claim and result answer 401 and the job stays queued", async (): Promise<void> => {
  const { threadId } = await alertInThread("rfm03");
  await takeOverQueue();
  const llmBefore: number = await llmCalls();

  const initial: InteractionResult = await sendInteraction(
    project.page,
    astraPayload("rfm03 what does this mean?", { channelId: threadId }),
  );
  expect(initial.status).toBe(200);
  expect(initial.type, "deferred while the relay waits").toBe(5);

  const wrongToken: RelayClaimResult = await relayClaim({
    waitSeconds: 1,
    token: "not-the-relay-token",
  });
  expect(wrongToken.status).toBe(401);
  expect(wrongToken.job).toBeUndefined();
  const noToken: RelayClaimResult = await relayClaim({
    waitSeconds: 1,
    token: null,
  });
  expect(noToken.status).toBe(401);
  expect(noToken.job).toBeUndefined();

  // Still queued: the real token gets it.
  const claim: RelayClaimResult = await relayClaim({ waitSeconds: 5 });
  expect(claim.status, claim.text).toBe(200);
  const job: { id: string; body: JSONish } = claim.job!;
  expect(job.id).toBeTruthy();
  expect(job.body["model"]).toBe(relayModel);
  expect(JSON.stringify(job.body["messages"])).toContain(
    "rfm03 what does this mean?",
  );

  const forged: { status: number } = await relayResult({
    id: job.id,
    status: 200,
    json: relayCompletion("forged answer"),
    token: "not-the-relay-token",
  });
  expect(forged.status).toBe(401);
  const unsigned: { status: number } = await relayResult({
    id: job.id,
    status: 200,
    json: relayCompletion("unsigned answer"),
    token: null,
  });
  expect(unsigned.status).toBe(401);
  expect(
    await followUpText(initial.token),
    "a rejected result never reaches the caller",
  ).toBe("");

  const accepted: { status: number; text: string } = await relayResult({
    id: job.id,
    status: 200,
    json: relayCompletion("Relay answer for rfm03"),
  });
  expect(accepted.status, accepted.text).toBe(200);
  await expect
    .poll(
      async (): Promise<string> => {
        return followUpText(initial.token);
      },
      { timeout: 30000 },
    )
    .toContain("Relay answer for rfm03");
  expect(await llmCalls(), "answered by hand, the model was never called").toBe(
    llmBefore,
  );
});

test("RFM04 a job whose caller already timed out is dropped at claim time, never sent upstream", async (): Promise<void> => {
  test.setTimeout(240000);
  const { threadId } = await alertInThread("rfm04");
  await takeOverQueue();
  const llmBefore: number = await llmCalls();

  const expired: InteractionResult & { deferred: boolean } = await finalReply(
    project.page,
    astraPayload("rfm04 expired request", { channelId: threadId }),
    astraTimeoutMs + 60000,
  );
  expect(expired.content).toMatch(/could not reach the LLM/i);

  // The caller is gone. The job is still on the list; a claim must drop it.
  const stale: RelayClaimResult = await relayClaim({ waitSeconds: 2 });
  expect(stale.status, stale.text).toBe(204);
  expect(stale.job).toBeUndefined();

  // Control: the same path hands out a job whose caller is still waiting.
  const live: InteractionResult = await sendInteraction(
    project.page,
    astraPayload("rfm04 live request", { channelId: threadId }),
  );
  expect(live.type).toBe(5);
  const claim: RelayClaimResult = await relayClaim({ waitSeconds: 5 });
  expect(claim.status, claim.text).toBe(200);
  const messages: string = JSON.stringify(claim.job!.body["messages"]);
  expect(messages).toContain("rfm04 live request");
  expect(messages, "the expired job was not handed out later").not.toContain(
    "rfm04 expired request",
  );
  const accepted: { status: number } = await relayResult({
    id: claim.job!.id,
    status: 200,
    json: relayCompletion("Relay answer for rfm04"),
  });
  expect(accepted.status).toBe(200);
  await expect
    .poll(
      async (): Promise<string> => {
        return followUpText(live.token);
      },
      { timeout: 30000 },
    )
    .toContain("Relay answer for rfm04");
  expect(await llmCalls(), "nothing went upstream for either request").toBe(
    llmBefore,
  );
});

test("RFM05 a result for an unknown or already answered id is accepted and discarded, with no effect on other callers", async (): Promise<void> => {
  const { threadId } = await alertInThread("rfm05");
  await takeOverQueue();

  const unknown: { status: number; text: string } = await relayResult({
    id: randomUUID(),
    status: 200,
    json: relayCompletion("nobody is waiting for this"),
  });
  expect(unknown.status, unknown.text).toBe(200);
  const malformed: { status: number } = await relayResult({
    id: "not-a-job-id",
    status: 200,
    json: relayCompletion("bad id"),
  });
  expect(malformed.status, "a malformed id is refused, not stored").toBe(400);

  const initial: InteractionResult = await sendInteraction(
    project.page,
    astraPayload("rfm05 first request", { channelId: threadId }),
  );
  expect(initial.type).toBe(5);
  const claim: RelayClaimResult = await relayClaim({ waitSeconds: 5 });
  expect(claim.status, claim.text).toBe(200);
  const first: { status: number } = await relayResult({
    id: claim.job!.id,
    status: 200,
    json: relayCompletion("Relay answer one for rfm05"),
  });
  expect(first.status).toBe(200);
  const second: { status: number; text: string } = await relayResult({
    id: claim.job!.id,
    status: 200,
    json: relayCompletion("Relay answer two for rfm05"),
  });
  expect(second.status, second.text).toBe(200);
  await expect
    .poll(
      async (): Promise<string> => {
        return followUpText(initial.token);
      },
      { timeout: 30000 },
    )
    .toContain("Relay answer one for rfm05");
  expect(await followUpText(initial.token)).not.toContain(
    "Relay answer two for rfm05",
  );

  // Other callers: with the worker back, a fresh request gets its own answer.
  await relayWorker.program({ enabled: true });
  await llmFixture.program({
    kind: "answer",
    content: "Fixture answer after stray results (rfm05)",
  });
  const reply: InteractionResult & { deferred: boolean } = await finalReply(
    project.page,
    astraPayload("rfm05 follow-up request", { channelId: threadId }),
  );
  expect(reply.content).toContain("Fixture answer after stray results (rfm05)");
});

test("RFM06 two concurrent callers each get their own answer, never the other's", async (): Promise<void> => {
  const alpha: { threadId: string } = await alertInThread("rfm06 alpha");
  const beta: { threadId: string } = await alertInThread("rfm06 beta");
  const markerA: string = `rfm06-alpha-${randomBytes(4).toString("hex")}`;
  const markerB: string = `rfm06-beta-${randomBytes(4).toString("hex")}`;
  await llmFixture.program({
    kind: "echo",
    echoRegex: "rfm06-(?:alpha|beta)-[0-9a-f]{8}",
  });
  // Hold each job upstream so both are outstanding at the same time.
  await relayWorker.program({ enabled: true, forwardDelayMs: 1500 });
  const claimsBefore: number = await workerClaims();

  const [replyA, replyB]: [
    InteractionResult & { deferred: boolean },
    InteractionResult & { deferred: boolean },
  ] = await Promise.all([
    finalReply(
      project.page,
      astraPayload(`explain ${markerA}`, { channelId: alpha.threadId }),
    ),
    finalReply(
      project.page,
      astraPayload(`explain ${markerB}`, { channelId: beta.threadId }),
    ),
  ]);

  expect(replyA.content).toContain(markerA);
  expect(replyA.content).not.toContain(markerB);
  expect(replyB.content).toContain(markerB);
  expect(replyB.content).not.toContain(markerA);
  expect((await workerClaims()) - claimsBefore).toBe(2);
});

test("RFM07 an upstream HTTP error takes the provider-error path: analysis Failed, the alert still posts", async (): Promise<void> => {
  await llmFixture.program({
    kind: "error",
    status: 503,
    content: "relay fixture upstream failure",
  });
  const resultsBefore: number = (await relayWorker.state()).results.length;
  const workflow: WorkflowRef = uniqueWorkflow("rfm07 error");
  await seedGreen(project.page, project.projectId, workflow);
  await failRun(project.page, workflow, "rfm07-error");
  const events: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    workflow,
    1,
  );
  expect(events[0]!["analysisStatus"]).toBe(analysisStatuses.failed);
  const messages: Array<PostedMessage> = await discordMessagesForWorkflow(
    project.page,
    project.projectId,
    workflow,
  );
  expect(messages).toHaveLength(1);
  expect(messageText(messages[0]!)).toMatch(/No analysis/i);
  expect(await llmCalls(), "the model was tried through the relay").toBe(1);
  const worker: RelayWorkerState = await relayWorker.state();
  const relayed: Array<{ upstreamStatus: number; postStatus: number }> =
    worker.results.slice(resultsBefore);
  expect(relayed).toHaveLength(1);
  expect(relayed[0]!.upstreamStatus).toBe(503);
  expect(relayed[0]!.postStatus, "the error result was accepted").toBe(200);
});

test("RFM07 the max_tokens adaptation retry runs through the relay exactly as through a direct provider", async (): Promise<void> => {
  const { threadId } = await alertInThread("rfm07 adapt");
  // A model name the app has not learned yet, so the first attempt is cold.
  const reasoningModel: string = `fixture-reasoning-${randomBytes(3).toString("hex")}`;
  await updateItem(
    project.page,
    project.projectId,
    routes.llmProvider,
    providerId,
    { modelName: reasoningModel },
  );
  try {
    await llmFixture.program({
      kind: "reject-max-tokens",
      content: "Adapted fixture answer for rfm07",
    });
    const claimsBefore: number = await workerClaims();
    const reply: InteractionResult & { deferred: boolean } = await finalReply(
      project.page,
      astraPayload("rfm07 adapt request", { channelId: threadId }),
    );
    expect(reply.content).toContain("Adapted fixture answer for rfm07");

    const llm: LlmState = await llmFixture.state();
    expect(llm.requests, "rejected once, then resent adapted").toHaveLength(2);
    const first: JSONish = JSON.parse(llm.requests[0]!.raw) as JSONish;
    const second: JSONish = JSON.parse(llm.requests[1]!.raw) as JSONish;
    expect(first["model"]).toBe(reasoningModel);
    expect(second["model"]).toBe(reasoningModel);
    expect(first["max_tokens"]).toBeGreaterThan(0);
    expect(first["max_completion_tokens"]).toBeUndefined();
    expect(second["max_completion_tokens"]).toBe(first["max_tokens"]);
    expect(second["max_tokens"]).toBeUndefined();
    expect(
      (await workerClaims()) - claimsBefore,
      "both attempts went through the relay",
    ).toBe(2);
  } finally {
    await updateItem(
      project.page,
      project.projectId,
      routes.llmProvider,
      providerId,
      { modelName: relayModel },
    );
  }
});

test("RFM08 a tool call through the relay: /astra 'file an issue' resolves to file_issue and files it", async (): Promise<void> => {
  const { workflow, threadId } = await alertInThread("rfm08");
  const issuesBefore: number = countRequests(
    await githubFixture.state(),
    "POST",
    /\/issues$/,
  );
  await llmFixture.program({
    kind: "tool",
    toolName: astraTools.fileIssue,
    toolArguments: {},
    content: "Filed.",
  });
  const claimsBefore: number = await workerClaims();

  const reply: InteractionResult & { deferred: boolean } = await finalReply(
    project.page,
    astraPayload("file an issue about this failure", { channelId: threadId }),
  );
  expect(reply.status).toBe(200);

  const github: GitHubState = await githubFixture.state();
  expect(countRequests(github, "POST", /\/issues$/) - issuesBefore).toBe(1);
  const issue: { html_url: string; title: string } =
    github.issues[github.issues.length - 1]!;
  expect(issue.title).toContain(workflow.name);
  expect(reply.content).toContain(issue.html_url);
  await expect
    .poll(async (): Promise<string> => {
      return String(
        (
          await eventsForWorkflow(project.page, project.projectId, workflow)
        )[0]?.["issueUrl"] || "",
      );
    })
    .toBe(issue.html_url);

  const llm: LlmState = await llmFixture.state();
  expect(
    llm.requests[llm.requests.length - 1]!.tools,
    "the tool belt reached the model unchanged",
  ).toContain(astraTools.fileIssue);
  const worker: RelayWorkerState = await relayWorker.state();
  expect(worker.claims.length).toBeGreaterThan(claimsBefore);
  expect(worker.claims[worker.claims.length - 1]!.hasTools).toBe(true);
});

test("RFM09 plain completion: alert analysis through the relay comes back Done with the model's text", async (): Promise<void> => {
  await llmFixture.program({
    kind: "answer",
    content:
      "Relay fixture analysis: tests/rfm09.spec.ts asserts the wrong status. Next step: fix the assertion.",
  });
  const resultsBefore: number = (await relayWorker.state()).results.length;
  const workflow: WorkflowRef = uniqueWorkflow("rfm09");
  await seedGreen(project.page, project.projectId, workflow);
  await failRun(project.page, workflow, "rfm09-done");
  const events: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    workflow,
    1,
  );
  expect(events[0]!["analysisStatus"]).toBe(analysisStatuses.done);
  expect(String(events[0]!["analysis"])).toContain("Relay fixture analysis");
  const messages: Array<PostedMessage> = await discordMessagesForWorkflow(
    project.page,
    project.projectId,
    workflow,
  );
  expect(messages).toHaveLength(1);
  expect(messageText(messages[0]!)).toContain("Relay fixture analysis");

  const llm: LlmState = await llmFixture.state();
  expect(llm.requests).toHaveLength(1);
  expect(llm.requests[0]!.model).toBe(relayModel);
  expect(llm.requests[0]!.raw, "the failing log reached the model").toContain(
    "rfm09-done",
  );
  const worker: RelayWorkerState = await relayWorker.state();
  expect(worker.results.slice(resultsBefore)).toHaveLength(1);
  expect(worker.results[worker.results.length - 1]!.upstreamStatus).toBe(200);
});

test("RFM10 a body over 1 MB is rejected on the pilot before it is queued", async (): Promise<void> => {
  await takeOverQueue();
  const llmBefore: number = await llmCalls();
  // The connection test merges the provider's additional parameters verbatim.
  await updateItem(
    project.page,
    project.projectId,
    routes.llmProvider,
    providerId,
    {
      additionalParams: {
        relay_padding: "x".repeat(relayMaxBodyBytes + 64 * 1024),
      },
    },
  );
  try {
    const probe: { status: number; elapsedMs: number; text: string } =
      await testProvider(project.page, project.projectId, providerId);
    expect(probe.status, probe.text).toBe(400);
    expect(probe.text).toMatch(/1 ?M(i)?B|too large|exceeds/i);
    expect(probe.elapsedMs, "refused up front, not after a wait").toBeLessThan(
      15000,
    );
    const claim: RelayClaimResult = await relayClaim({ waitSeconds: 1 });
    expect(claim.status, "nothing was queued").toBe(204);
    expect(await llmCalls()).toBe(llmBefore);
  } finally {
    await updateItem(
      project.page,
      project.projectId,
      routes.llmProvider,
      providerId,
      { additionalParams: {} },
    );
  }
});

test("RFM11 claim long-poll answers 204 within waitSeconds + 2 on an empty queue, and clamps waitSeconds to 25", async (): Promise<void> => {
  await takeOverQueue();

  const immediate: RelayClaimResult = await relayClaim({ waitSeconds: 0 });
  expect(immediate.status, immediate.text).toBe(204);
  expect(immediate.elapsedMs).toBeLessThan(2000);

  const short: RelayClaimResult = await relayClaim({ waitSeconds: 3 });
  expect(short.status, short.text).toBe(204);
  expect(short.elapsedMs).toBeGreaterThanOrEqual(2500);
  expect(short.elapsedMs).toBeLessThan(5000);

  const clamped: RelayClaimResult = await relayClaim({ waitSeconds: 60 });
  expect(clamped.status, clamped.text).toBe(204);
  expect(clamped.elapsedMs).toBeGreaterThanOrEqual(20000);
  expect(clamped.elapsedMs).toBeLessThan((relayMaxClaimWaitSeconds + 2) * 1000);
});
