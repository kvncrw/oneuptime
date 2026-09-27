import { Browser, TestInfo, expect, test } from "@playwright/test";
import { JSONish, toId } from "../Tests/Dashboard/Helpers/MonitorAlerting";
import {
  DiscordState,
  InteractionResult,
  ProvisionedProject,
  WorkflowRef,
  actions,
  buttonPayload,
  countDiscordEvents,
  deliverWebhook,
  discordFixture,
  discordMessagesForWorkflow,
  eventsForWorkflow,
  expectStable,
  failRun,
  finalReply,
  findWorkflow,
  githubFixture,
  llmFixture,
  nextRunId,
  programFailure,
  provisionProject,
  sampleFailureLog,
  seedGreen,
  sendInteraction,
  astraPayload,
  threadIdForWorkflow,
  uniqueWorkflow,
  waitForEvents,
  workflowRunPayload,
} from "./Helpers";

/*
 * Discord delivery: FM14 (a failing post is retried once and state still
 * advances exactly once) and FM21 (slow work answers Discord inside its 3 s
 * window with a deferred response, then edits the original).
 */

let project: ProvisionedProject;

test.beforeAll(async ({ browser }: { browser: Browser }): Promise<void> => {
  test.setTimeout(300000);
  project = await provisionProject(browser, {
    namePrefix: "CI watch delivery",
    llm: true,
  });
});

test.afterEach(
  async (
    { browser: _browser }: { browser: Browser },
    testInfo: TestInfo,
  ): Promise<void> => {
    await discordFixture.scenario("valid");
    await llmFixture.program({
      kind: "answer",
      content: "Fixture analysis: the build failed.",
    });
    await testInfo.attach("discord-provider", {
      body: JSON.stringify(await discordFixture.state()),
      contentType: "application/json",
    });
    await testInfo.attach("github-provider", {
      body: JSON.stringify(await githubFixture.state()),
      contentType: "application/json",
    });
  },
);

test.afterAll(async (): Promise<void> => {
  await discordFixture.scenario("valid");
  await project?.context.close();
});

async function postsToThread(threadId: string): Promise<number> {
  return countDiscordEvents(
    await discordFixture.state(),
    "POST",
    new RegExp(`^/api(?:/v10)?/channels/${threadId}/messages$`),
  );
}

test("FM14 a Discord post that fails once is retried once and the alert lands exactly once", async (): Promise<void> => {
  const workflow: WorkflowRef = uniqueWorkflow("fm14 once");
  await seedGreen(project.page, project.projectId, workflow);
  const runId: string = nextRunId();
  await programFailure({ runId, log: sampleFailureLog("fm14-once") });
  await discordFixture.scenario("message-post-fails-once");
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
  expect(threadId).toBeTruthy();
  await expect
    .poll(async (): Promise<number> => {
      return postsToThread(threadId);
    })
    .toBe(2);
  const messages: Array<{ id?: string }> = await discordMessagesForWorkflow(
    project.page,
    project.projectId,
    workflow,
  );
  expect(messages, "the retry succeeded").toHaveLength(1);
  expect(String(events[0]!["discordMessageId"])).toBe(messages[0]!.id);
  expect(String(row["lastRunId"])).toBe(runId);
  await expectStable(async (): Promise<number> => {
    return postsToThread(threadId);
  }, 2);
});

test("FM14 a Discord post that keeps failing is retried once, logged, and state still advances exactly once", async (): Promise<void> => {
  const workflow: WorkflowRef = uniqueWorkflow("fm14 always");
  await seedGreen(project.page, project.projectId, workflow);
  const runId: string = nextRunId();
  await programFailure({ runId, log: sampleFailureLog("fm14-always") });
  const discordBefore: DiscordState = await discordFixture.state();
  const threadsBefore: number = discordBefore.createdThreads.length;
  await discordFixture.scenario("message-post-fails");
  const { response } = await deliverWebhook(
    project.page,
    workflowRunPayload({ workflow, conclusion: "failure", runId }),
  );
  expect(
    response.status(),
    "a Discord outage never fails the webhook back to GitHub",
  ).toBe(200);

  // State advanced once: the row and one event, with no message id.
  await expect
    .poll(async (): Promise<string> => {
      return String(
        (await findWorkflow(project.page, project.projectId, workflow))?.[
          "lastRunId"
        ] || "",
      );
    })
    .toBe(runId);
  const events: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    workflow,
    1,
  );
  expect(events[0]!["discordMessageId"]).toBeFalsy();
  const row: JSONish = (await findWorkflow(
    project.page,
    project.projectId,
    workflow,
  ))!;
  const threadId: string | undefined = await threadIdForWorkflow(
    project.page,
    project.projectId,
    toId(row["_id"]),
  );
  const state: DiscordState = await discordFixture.state();
  const attempts: number = threadId
    ? countDiscordEvents(
        state,
        "POST",
        new RegExp(`^/api(?:/v10)?/channels/${threadId}/messages$`),
      )
    : countDiscordEvents(state, "POST", /\/channels\/\d+\/messages$/);
  expect(attempts, "one attempt plus one retry, then give up").toBe(2);
  expect(
    state.createdThreads.length - threadsBefore,
    "one thread, not one per attempt",
  ).toBeLessThanOrEqual(1);

  // A redelivery of the same run while Discord is back must not re-post: state already advanced.
  await discordFixture.scenario("valid");
  await deliverWebhook(
    project.page,
    workflowRunPayload({ workflow, conclusion: "failure", runId }),
  );
  await expectStable(async (): Promise<number> => {
    return (await eventsForWorkflow(project.page, project.projectId, workflow))
      .length;
  }, 1);
  expect(
    await discordMessagesForWorkflow(project.page, project.projectId, workflow),
  ).toHaveLength(0);
});

test("FM21 button presses are acknowledged inside Discord's 3 s window with a deferred response, then completed", async (): Promise<void> => {
  const workflow: WorkflowRef = uniqueWorkflow("fm21 button");
  await seedGreen(project.page, project.projectId, workflow);
  await failRun(project.page, workflow, "fm21");
  const events: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    workflow,
    1,
  );
  const eventId: string = toId(events[0]!["_id"]);
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

  const body: string = buttonPayload(actions.mute, eventId, {
    channelId: threadId,
  });
  const initial: InteractionResult = await sendInteraction(project.page, body);
  expect(initial.status).toBe(200);
  expect(initial.type, "deferred acknowledgement").toBe(5);
  expect(initial.elapsedMs, "acknowledged inside the 3 s window").toBeLessThan(
    3000,
  );

  // The outcome arrives as an edit of the original response, keyed by the interaction token.
  await expect
    .poll(async (): Promise<boolean> => {
      const state: DiscordState = await discordFixture.state();
      return state.postedMessages.some(
        (message: {
          interaction_token?: string;
          webhook_kind?: string;
        }): boolean => {
          return (
            message.webhook_kind === "interaction" &&
            message.interaction_token === initial.token
          );
        },
      );
    })
    .toBe(true);
  await expect
    .poll(async (): Promise<boolean> => {
      const muted: unknown = (
        await findWorkflow(project.page, project.projectId, workflow)
      )?.["mutedUntil"];
      return (
        Boolean(muted) &&
        new Date(String(muted)).getTime() > Date.now() + 23 * 3600 * 1000
      );
    })
    .toBe(true);
  expect(
    toId(
      (await eventsForWorkflow(project.page, project.projectId, workflow))[0]![
        "actedByUserId"
      ],
    ),
  ).toBe(project.userId);
});

test("FM21 a slow /astra answer is deferred inside 3 s and delivered as a follow-up, never a timeout", async (): Promise<void> => {
  const workflow: WorkflowRef = uniqueWorkflow("fm21 astra");
  await seedGreen(project.page, project.projectId, workflow);
  await failRun(project.page, workflow, "fm21-astra");
  await waitForEvents(project.page, project.projectId, workflow, 1);
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

  // The model takes 6 s: longer than Discord waits for the first byte.
  await llmFixture.program({
    kind: "answer",
    content: "Slow fixture answer: the assertion is wrong.",
    delayMs: 6000,
  });
  const body: string = astraPayload("what is going on with this workflow?", {
    channelId: threadId,
  });
  const started: number = Date.now();
  const reply: InteractionResult & { deferred: boolean } = await finalReply(
    project.page,
    body,
    60000,
  );
  expect(reply.status).toBe(200);
  expect(reply.deferred, "an LLM-backed command must defer").toBe(true);
  expect(reply.elapsedMs).toBeLessThan(3000);
  expect(Date.now() - started).toBeGreaterThanOrEqual(6000);
  expect(reply.content).toContain("Slow fixture answer");
});
