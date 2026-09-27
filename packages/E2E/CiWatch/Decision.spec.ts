import { Browser, TestInfo, expect, test } from "@playwright/test";
import { JSONish, toId } from "../Tests/Dashboard/Helpers/MonitorAlerting";
import {
  PostedMessage,
  ProvisionedProject,
  WorkflowRef,
  actions,
  buttonIds,
  deliverWebhook,
  discordFixture,
  discordIds,
  discordMessagesForWorkflow,
  eventTypes,
  eventsForWorkflow,
  expectStable,
  failRun,
  findWorkflow,
  githubFixture,
  messageText,
  nextRunId,
  provisionProject,
  releaseProject,
  repoFullName,
  routes,
  seedGreen,
  threadIdForWorkflow,
  uniqueWorkflow,
  updateItem,
  waitForEvents,
  workflowRunPayload,
} from "./Helpers";

/*
 * The decision table: FM06 to FM09. Every positive case asserts the Discord
 * effect (thread, message, buttons) AND the persisted CiWorkflow /
 * CiWorkflowEvent state. This project has no LLM provider on purpose: the
 * alert path must not depend on analysis (analysis has its own spec).
 */

let project: ProvisionedProject;

test.beforeAll(async ({ browser }: { browser: Browser }): Promise<void> => {
  test.setTimeout(300000);
  project = await provisionProject(browser, {
    namePrefix: "CI watch decision",
  });
});

test.afterEach(
  async (
    { browser: _browser }: { browser: Browser },
    testInfo: TestInfo,
  ): Promise<void> => {
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
  await releaseProject(project);
});

async function alertCount(
  workflow: WorkflowRef,
): Promise<{ events: number; messages: number }> {
  return {
    events: (await eventsForWorkflow(project.page, project.projectId, workflow))
      .length,
    messages: (
      await discordMessagesForWorkflow(
        project.page,
        project.projectId,
        workflow,
      )
    ).length,
  };
}

test("FM06 a new failure on an unknown workflow posts exactly one red alert with state, thread and buttons", async (): Promise<void> => {
  /*
   * The repository was seeded by provisioning (baseline workflow). A
   * workflow nobody has seen before is new work, so its very first failure
   * is news.
   */
  const workflow: WorkflowRef = uniqueWorkflow("fm06");
  expect(
    await findWorkflow(project.page, project.projectId, workflow),
    "never seen",
  ).toBeUndefined();
  const runId: string = await failRun(project.page, workflow, "fm06");

  const events: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    workflow,
    1,
  );
  const event: JSONish = events[0]!;
  expect(event["eventType"]).toBe(eventTypes.newFailure);
  expect(String(event["runId"])).toBe(runId);
  expect(String(event["runUrl"])).toContain(`/actions/runs/${runId}`);
  expect(String(event["conclusion"])).toBe("failure");
  expect(String(event["firstFailingJob"])).toBe("test");
  expect(String(event["failureSignature"])).toMatch(/^[0-9a-f]{16}$/);
  expect(event["analysisStatus"], "no provider in this project").toBe(
    "NoProvider",
  );
  expect(event["postedAt"]).toBeTruthy();

  const row: JSONish = (await findWorkflow(
    project.page,
    project.projectId,
    workflow,
  ))!;
  expect(row["lastConclusion"]).toBe("failure");
  expect(String(row["lastRunId"])).toBe(runId);
  expect(String(row["lastFailureSignature"])).toBe(
    String(event["failureSignature"]),
  );
  expect(Number(row["consecutiveFailureCount"])).toBe(1);
  expect(row["isKnownRed"]).toBeFalsy();

  // Discord: one thread for the workflow under the configured channel, one message in it.
  const threadId: string | undefined = await threadIdForWorkflow(
    project.page,
    project.projectId,
    toId(row["_id"]),
  );
  expect(
    threadId,
    "a DiscordResourceThread row of type ciWorkflow",
  ).toBeTruthy();
  const thread: { parent_id: string } | undefined = (
    await discordFixture.state()
  ).createdThreads.find((item: { id: string }): boolean => {
    return item.id === threadId;
  });
  expect(
    thread?.parent_id,
    "thread created under CiWatchConfig.discordChannelId",
  ).toBe(discordIds.channelId);
  const messages: Array<PostedMessage> = await discordMessagesForWorkflow(
    project.page,
    project.projectId,
    workflow,
  );
  expect(messages).toHaveLength(1);
  const message: PostedMessage = messages[0]!;
  expect(message.channel_id).toBe(threadId);
  expect(String(event["discordMessageId"])).toBe(message.id);
  const text: string = messageText(message);
  expect(text).toContain(repoFullName);
  expect(text).toContain(workflow.name);
  expect(text).toContain(`/actions/runs/${runId}`);
  expect(text).toContain("test");
  expect(text).toMatch(/No analysis/i);
  const ids: Array<string> = buttonIds(message);
  const eventId: string = toId(event["_id"]);
  for (const action of [
    actions.fileIssue,
    actions.assessRetire,
    actions.markKnownRed,
    actions.mute,
  ]) {
    expect(ids, `button ${action}`).toContain(`${action}:${eventId}`);
  }

  // Exactly one: nothing more arrives after the quiet period.
  await expectStable(
    async (): Promise<{ events: number; messages: number }> => {
      return alertCount(workflow);
    },
    { events: 1, messages: 1 },
  );
});

test("FM07 a second failure with the same signature does not post again; a different signature does", async (): Promise<void> => {
  const workflow: WorkflowRef = uniqueWorkflow("fm07");
  await seedGreen(project.page, project.projectId, workflow);
  await failRun(project.page, workflow, "fm07-same");
  await waitForEvents(project.page, project.projectId, workflow, 1);

  const secondRun: string = await failRun(project.page, workflow, "fm07-same");
  await expect
    .poll(async (): Promise<string> => {
      return String(
        (await findWorkflow(project.page, project.projectId, workflow))?.[
          "lastRunId"
        ] || "",
      );
    })
    .toBe(secondRun);
  await expectStable(
    async (): Promise<{ events: number; messages: number }> => {
      return alertCount(workflow);
    },
    { events: 1, messages: 1 },
  );
  expect(
    Number(
      (await findWorkflow(project.page, project.projectId, workflow))![
        "consecutiveFailureCount"
      ],
    ),
  ).toBe(2);

  // Same run shape, different error text: a new signature is a new alert.
  await failRun(project.page, workflow, "fm07-different-error");
  const events: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    workflow,
    2,
  );
  expect(
    events
      .map((event: JSONish): string => {
        return String(event["failureSignature"]);
      })
      .sort(),
  ).toHaveLength(2);
  expect(
    new Set(
      events.map((event: JSONish): string => {
        return String(event["failureSignature"]);
      }),
    ).size,
  ).toBe(2);
  expect(
    events.every((event: JSONish): boolean => {
      return event["eventType"] === eventTypes.newFailure;
    }),
  ).toBe(true);
});

test("FM08 a known-red workflow stays silent on its known signature and posts red on a new one", async (): Promise<void> => {
  const workflow: WorkflowRef = uniqueWorkflow("fm08");
  await seedGreen(project.page, project.projectId, workflow);
  await failRun(project.page, workflow, "fm08-known");
  await waitForEvents(project.page, project.projectId, workflow, 1);
  const row: JSONish = (await findWorkflow(
    project.page,
    project.projectId,
    workflow,
  ))!;
  const knownSignature: string = String(row["lastFailureSignature"]);
  await updateItem(
    project.page,
    project.projectId,
    routes.workflow,
    toId(row["_id"]),
    {
      isKnownRed: true,
      knownRedReason: "Tracked in FM08",
      knownRedSignature: knownSignature,
    },
  );

  // Same signature while known-red: silent.
  const silentRun: string = await failRun(project.page, workflow, "fm08-known");
  await expect
    .poll(async (): Promise<string> => {
      return String(
        (await findWorkflow(project.page, project.projectId, workflow))?.[
          "lastRunId"
        ] || "",
      );
    })
    .toBe(silentRun);
  await expectStable(
    async (): Promise<{ events: number; messages: number }> => {
      return alertCount(workflow);
    },
    { events: 1, messages: 1 },
  );

  // A different signature while known-red: SignatureChanged, once.
  await failRun(project.page, workflow, "fm08-new-breakage");
  const events: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    workflow,
    2,
  );
  const changed: JSONish | undefined = events.find(
    (event: JSONish): boolean => {
      return event["eventType"] === eventTypes.signatureChanged;
    },
  );
  expect(changed, "a SignatureChanged event").toBeTruthy();
  expect(String(changed!["failureSignature"])).not.toBe(knownSignature);
  const messages: Array<PostedMessage> = await discordMessagesForWorkflow(
    project.page,
    project.projectId,
    workflow,
  );
  expect(messages).toHaveLength(2);
  expect(messageText(messages[1]!)).toContain(workflow.name);
  // Known-red is a human decision; a new signature does not clear it.
  const after: JSONish = (await findWorkflow(
    project.page,
    project.projectId,
    workflow,
  ))!;
  expect(after["isKnownRed"]).toBe(true);
  expect(String(after["knownRedSignature"])).toBe(knownSignature);

  // A null knownRedSignature forgives any signature.
  await updateItem(
    project.page,
    project.projectId,
    routes.workflow,
    toId(row["_id"]),
    { knownRedSignature: null },
  );
  const forgiven: string = await failRun(
    project.page,
    workflow,
    "fm08-anything-goes",
  );
  await expect
    .poll(async (): Promise<string> => {
      return String(
        (await findWorkflow(project.page, project.projectId, workflow))?.[
          "lastRunId"
        ] || "",
      );
    })
    .toBe(forgiven);
  await expectStable(
    async (): Promise<{ events: number; messages: number }> => {
      return alertCount(workflow);
    },
    { events: 2, messages: 2 },
  );
});

test("FM09 a known-red workflow passing posts one green recovery, and only once", async (): Promise<void> => {
  const workflow: WorkflowRef = uniqueWorkflow("fm09");
  await seedGreen(project.page, project.projectId, workflow);
  await failRun(project.page, workflow, "fm09");
  await waitForEvents(project.page, project.projectId, workflow, 1);
  const row: JSONish = (await findWorkflow(
    project.page,
    project.projectId,
    workflow,
  ))!;
  await updateItem(
    project.page,
    project.projectId,
    routes.workflow,
    toId(row["_id"]),
    {
      isKnownRed: true,
      knownRedReason: "FM09",
      knownRedSignature: String(row["lastFailureSignature"]),
    },
  );

  const greenRun: string = nextRunId();
  const { response } = await deliverWebhook(
    project.page,
    workflowRunPayload({ workflow, conclusion: "success", runId: greenRun }),
  );
  expect(response.status()).toBe(200);
  const events: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    workflow,
    2,
  );
  const recovered: JSONish | undefined = events.find(
    (event: JSONish): boolean => {
      return event["eventType"] === eventTypes.recovered;
    },
  );
  expect(recovered, "a Recovered event").toBeTruthy();
  expect(String(recovered!["runId"])).toBe(greenRun);
  expect(recovered!["conclusion"]).toBe("success");
  const messages: Array<PostedMessage> = await discordMessagesForWorkflow(
    project.page,
    project.projectId,
    workflow,
  );
  expect(messages).toHaveLength(2);
  expect(messageText(messages[1]!)).toMatch(/recover|green|passing/i);
  const after: JSONish = (await findWorkflow(
    project.page,
    project.projectId,
    workflow,
  ))!;
  expect(after["lastConclusion"]).toBe("success");
  expect(Number(after["consecutiveFailureCount"])).toBe(0);

  // A second green run is not a second recovery.
  await deliverWebhook(
    project.page,
    workflowRunPayload({ workflow, conclusion: "success" }),
  );
  await expectStable(
    async (): Promise<{ events: number; messages: number }> => {
      return alertCount(workflow);
    },
    { events: 2, messages: 2 },
  );

  // Contract row: a plain (not known-red) failing workflow recovers once too.
  const plain: WorkflowRef = uniqueWorkflow("fm09 plain");
  await seedGreen(project.page, project.projectId, plain);
  await failRun(project.page, plain, "fm09-plain");
  await waitForEvents(project.page, project.projectId, plain, 1);
  await deliverWebhook(
    project.page,
    workflowRunPayload({ workflow: plain, conclusion: "success" }),
  );
  const plainEvents: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    plain,
    2,
  );
  expect(
    plainEvents.filter((event: JSONish): boolean => {
      return event["eventType"] === eventTypes.recovered;
    }),
  ).toHaveLength(1);
});

test("contract: flaky workflows alert on the second consecutive failure only, and mute suppresses alerts", async (): Promise<void> => {
  const flaky: WorkflowRef = uniqueWorkflow("flaky");
  await seedGreen(project.page, project.projectId, flaky);
  const row: JSONish = (await findWorkflow(
    project.page,
    project.projectId,
    flaky,
  ))!;
  await updateItem(
    project.page,
    project.projectId,
    routes.workflow,
    toId(row["_id"]),
    { isFlaky: true },
  );
  const first: string = await failRun(project.page, flaky, "flaky-a");
  await expect
    .poll(async (): Promise<string> => {
      return String(
        (await findWorkflow(project.page, project.projectId, flaky))?.[
          "lastRunId"
        ] || "",
      );
    })
    .toBe(first);
  await expectStable(
    async (): Promise<{ events: number; messages: number }> => {
      return alertCount(flaky);
    },
    { events: 0, messages: 0 },
  );
  await failRun(project.page, flaky, "flaky-a");
  await waitForEvents(project.page, project.projectId, flaky, 1);

  const muted: WorkflowRef = uniqueWorkflow("muted");
  await seedGreen(project.page, project.projectId, muted);
  const mutedRow: JSONish = (await findWorkflow(
    project.page,
    project.projectId,
    muted,
  ))!;
  await updateItem(
    project.page,
    project.projectId,
    routes.workflow,
    toId(mutedRow["_id"]),
    {
      mutedUntil: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    },
  );
  const mutedRun: string = await failRun(project.page, muted, "muted");
  await expect
    .poll(async (): Promise<string> => {
      return String(
        (await findWorkflow(project.page, project.projectId, muted))?.[
          "lastRunId"
        ] || "",
      );
    })
    .toBe(mutedRun);
  expect(
    (await findWorkflow(project.page, project.projectId, muted))![
      "lastConclusion"
    ],
    "state still advances while muted",
  ).toBe("failure");
  await expectStable(
    async (): Promise<{ events: number; messages: number }> => {
      return alertCount(muted);
    },
    { events: 0, messages: 0 },
  );
});
