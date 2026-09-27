import { Browser, TestInfo, expect, test } from "@playwright/test";
import { JSONish, toId } from "../Tests/Dashboard/Helpers/MonitorAlerting";
import {
  LlmRequest,
  LlmState,
  PostedMessage,
  ProvisionedProject,
  WorkflowRef,
  analysisStatuses,
  containsSecret,
  createLlmProvider,
  deliverWebhook,
  discordFixture,
  discordMessagesForWorkflow,
  eventsForWorkflow,
  expectStable,
  failRun,
  findWorkflow,
  githubFixture,
  llmFixture,
  messageText,
  nextRunId,
  programFailure,
  provisionProject,
  secretLiterals,
  seedGreen,
  uniqueWorkflow,
  updateItem,
  waitForEvents,
  workflowRunPayload,
} from "./Helpers";

/*
 * LLM analysis on an alert: FM12 (no provider / failure / timeout), FM13
 * (AI disabled / budget exhausted: no call made) and FM22 (secrets scrubbed
 * before the model, Discord and storage see the log tail).
 */

let project: ProvisionedProject;

test.beforeAll(async ({ browser }: { browser: Browser }): Promise<void> => {
  test.setTimeout(300000);
  project = await provisionProject(browser, {
    namePrefix: "CI watch analysis",
  });
});

test.afterEach(
  async (
    { browser: _browser }: { browser: Browser },
    testInfo: TestInfo,
  ): Promise<void> => {
    await llmFixture.program({
      kind: "answer",
      content: "Fixture analysis: the build failed.",
    });
    await updateItem(
      project.page,
      project.projectId,
      "/api/project",
      project.projectId,
      { enableAi: true, aiDailyAutonomousTokenLimit: null },
    );
    await testInfo.attach("llm-provider", {
      body: JSON.stringify(await llmFixture.state()),
      contentType: "application/json",
    });
    await testInfo.attach("github-provider", {
      body: JSON.stringify(await githubFixture.state()),
      contentType: "application/json",
    });
    await testInfo.attach("discord-provider", {
      body: JSON.stringify(await discordFixture.state()),
      contentType: "application/json",
    });
  },
);

test.afterAll(async (): Promise<void> => {
  await project?.context.close();
});

async function llmCalls(): Promise<number> {
  return (await llmFixture.state()).requests.length;
}

async function alertedWithStatus(
  workflow: WorkflowRef,
  marker: string,
): Promise<{ event: JSONish; message: PostedMessage }> {
  await seedGreen(project.page, project.projectId, workflow);
  await failRun(project.page, workflow, marker);
  const events: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    workflow,
    1,
  );
  const messages: Array<PostedMessage> = await discordMessagesForWorkflow(
    project.page,
    project.projectId,
    workflow,
  );
  expect(messages, "the alert posts regardless of analysis").toHaveLength(1);
  return { event: events[0]!, message: messages[0]! };
}

test("FM12 with no LLM provider the alert still posts, marked no analysis, and no model is called", async (): Promise<void> => {
  const workflow: WorkflowRef = uniqueWorkflow("fm12 no provider");
  const before: number = await llmCalls();
  const { event, message } = await alertedWithStatus(workflow, "fm12-none");
  expect(event["analysisStatus"]).toBe(analysisStatuses.noProvider);
  expect(event["analysis"]).toBeFalsy();
  expect(messageText(message)).toMatch(/No analysis/i);
  expect(await llmCalls()).toBe(before);
});

test("FM12 an LLM error still posts the alert, marked failed, after the attempt", async (): Promise<void> => {
  await createLlmProvider(project.page, project.projectId);
  await llmFixture.program({
    kind: "error",
    status: 500,
    content: "fixture provider failure",
  });
  const workflow: WorkflowRef = uniqueWorkflow("fm12 error");
  const { event, message } = await alertedWithStatus(workflow, "fm12-error");
  expect(event["analysisStatus"]).toBe(analysisStatuses.failed);
  expect(messageText(message)).toMatch(/No analysis/i);
  expect(await llmCalls(), "the model was tried").toBeGreaterThanOrEqual(1);
});

test("FM12 an LLM call that hangs past the timeout still posts the alert within the deadline", async (): Promise<void> => {
  test.setTimeout(240000);
  // Held longer than any sane analysis budget; the app must give up, not wait.
  await llmFixture.program({ kind: "hang", hangMs: 5 * 60 * 1000 });
  const workflow: WorkflowRef = uniqueWorkflow("fm12 hang");
  await seedGreen(project.page, project.projectId, workflow);
  const started: number = Date.now();
  await failRun(project.page, workflow, "fm12-hang");
  await expect
    .poll(
      async (): Promise<number> => {
        return (
          await discordMessagesForWorkflow(
            project.page,
            project.projectId,
            workflow,
          )
        ).length;
      },
      { timeout: 120000 },
    )
    .toBe(1);
  expect(
    Date.now() - started,
    "alert posted within 120 s despite a hung provider",
  ).toBeLessThan(120000);
  const events: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    workflow,
    1,
  );
  expect(events[0]!["analysisStatus"]).toBe(analysisStatuses.failed);
  expect(
    messageText(
      (
        await discordMessagesForWorkflow(
          project.page,
          project.projectId,
          workflow,
        )
      )[0]!,
    ),
  ).toMatch(/No analysis/i);
});

test("contract: a working provider produces an analysis on the alert", async (): Promise<void> => {
  await llmFixture.program({
    kind: "answer",
    content:
      "Fixture analysis: tests/fm12.spec.ts asserts the wrong status. Seen before: no. Next step: fix the assertion.",
  });
  const workflow: WorkflowRef = uniqueWorkflow("fm12 done");
  const { event, message } = await alertedWithStatus(workflow, "fm12-done");
  expect(event["analysisStatus"]).toBe(analysisStatuses.done);
  expect(String(event["analysis"])).toContain("Fixture analysis");
  expect(messageText(message)).toContain("Fixture analysis");
  const llm: LlmState = await llmFixture.state();
  const request: LlmRequest = llm.requests[llm.requests.length - 1]!;
  expect(request.model).toBe("fixture-model");
  expect(request.raw, "the failing log reached the model").toContain(
    "fm12-done",
  );
});

test("FM13 AI disabled on the project: the alert posts with no analysis and no LLM call is made", async (): Promise<void> => {
  await llmFixture.program({
    kind: "answer",
    content: "should never be requested",
  });
  await updateItem(
    project.page,
    project.projectId,
    "/api/project",
    project.projectId,
    { enableAi: false },
  );
  const before: number = await llmCalls();
  const workflow: WorkflowRef = uniqueWorkflow("fm13 disabled");
  const { event, message } = await alertedWithStatus(workflow, "fm13-disabled");
  expect(event["analysisStatus"]).toBe(analysisStatuses.disabled);
  expect(messageText(message)).toMatch(/No analysis/i);
  expect(messageText(message)).not.toContain("should never be requested");
  expect(await llmCalls(), "no model call while AI is disabled").toBe(before);
});

test("FM13 daily autonomous budget exhausted: the alert posts with no analysis and no LLM call is made", async (): Promise<void> => {
  await llmFixture.program({
    kind: "answer",
    content: "should never be requested",
  });
  // A limit of 0 is the kill switch: the budget is exhausted before any token is spent.
  await updateItem(
    project.page,
    project.projectId,
    "/api/project",
    project.projectId,
    { enableAi: true, aiDailyAutonomousTokenLimit: 0 },
  );
  const before: number = await llmCalls();
  const workflow: WorkflowRef = uniqueWorkflow("fm13 budget");
  const { event, message } = await alertedWithStatus(workflow, "fm13-budget");
  expect([analysisStatuses.disabled, analysisStatuses.failed]).toContain(
    String(event["analysisStatus"]),
  );
  expect(messageText(message)).toMatch(/No analysis/i);
  expect(await llmCalls(), "no model call once the budget is exhausted").toBe(
    before,
  );
});

test("FM22 a log tail containing secrets is scrubbed before the LLM, Discord and storage", async (): Promise<void> => {
  await llmFixture.program({
    kind: "answer",
    content: "Fixture analysis: credentials leaked into the log.",
  });
  const workflow: WorkflowRef = uniqueWorkflow("fm22");
  await seedGreen(project.page, project.projectId, workflow);
  const runId: string = nextRunId();
  const lines: Array<string> = [];
  for (let index: number = 0; index < 250; index++) {
    lines.push(`2026-09-27T10:00:00.000Z line ${index} ok`);
  }
  lines.push(
    "2026-09-27T10:05:00.000Z ##[error]Authentication failed for https://x-access-token:***@github.com/ci-e2e/watched",
  );
  for (const secret of secretLiterals) {
    lines.push(
      `2026-09-27T10:05:01.000Z Error: request failed with Authorization: ${secret} (fm22)`,
    );
  }
  lines.push(
    "2026-09-27T10:05:02.000Z Error: Process completed with exit code 1.",
  );
  await programFailure({ runId, log: lines.join("\n") });
  const { response } = await deliverWebhook(
    project.page,
    workflowRunPayload({ workflow, conclusion: "failure", runId }),
  );
  expect(response.status()).toBe(200);
  const events: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    workflow,
    1,
  );
  const event: JSONish = events[0]!;
  expect(event["analysisStatus"]).toBe(analysisStatuses.done);

  // Nothing that reached the model carries a secret literal.
  const llm: LlmState = await llmFixture.state();
  expect(llm.requests.length).toBeGreaterThanOrEqual(1);
  for (const request of llm.requests) {
    expect(
      containsSecret(request.raw),
      "secret reached the LLM",
    ).toBeUndefined();
  }
  expect(
    llm.requests[llm.requests.length - 1]!.raw,
    "the scrubbed tail still reached the model",
  ).toContain("fm22");

  // Nothing Discord saw carries one.
  for (const message of await discordMessagesForWorkflow(
    project.page,
    project.projectId,
    workflow,
  )) {
    expect(
      containsSecret(JSON.stringify(message)),
      "secret reached Discord",
    ).toBeUndefined();
  }
  // Nothing stored carries one.
  expect(
    containsSecret(JSON.stringify(event)),
    "secret stored on the event",
  ).toBeUndefined();
  const row: JSONish = (await findWorkflow(
    project.page,
    project.projectId,
    workflow,
  ))!;
  expect(
    containsSecret(JSON.stringify(row)),
    "secret stored on the workflow",
  ).toBeUndefined();
  expect(toId(event["ciWorkflowId"])).toBe(toId(row["_id"]));

  // And the redaction did not eat the alert: still exactly one.
  await expectStable(async (): Promise<number> => {
    return (await eventsForWorkflow(project.page, project.projectId, workflow))
      .length;
  }, 1);
});
