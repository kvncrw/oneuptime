import { Browser, TestInfo, expect, test } from "@playwright/test";
import { JSONish, toId } from "../Tests/Dashboard/Helpers/MonitorAlerting";
import {
  GitHubState,
  InteractionResult,
  LlmState,
  ProvisionedProject,
  WorkflowRef,
  actions,
  astraPayload,
  countRequests,
  discordFixture,
  discordIds,
  discordMessagesForWorkflow,
  eventsForWorkflow,
  failRun,
  finalReply,
  findWorkflow,
  githubFixture,
  llmFixture,
  provisionProject,
  releaseProject,
  seedGreen,
  threadIdForWorkflow,
  uniqueWorkflow,
  waitForEvents,
} from "./Helpers";

/*
 * The `/astra request:<text>` slash command: FM19 (outside a workflow thread
 * it asks for the thread and does nothing) and FM20 (a request that maps to
 * no action is answered, with no action taken). Plus the positive contract:
 * a request the model maps to an action performs that action.
 */

let project: ProvisionedProject;

test.beforeAll(async ({ browser }: { browser: Browser }): Promise<void> => {
  test.setTimeout(300000);
  project = await provisionProject(browser, {
    namePrefix: "CI watch astra",
    llm: true,
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
  },
);

test.afterAll(async (): Promise<void> => {
  await releaseProject(project);
});

async function alertInThread(
  label: string,
): Promise<{ workflow: WorkflowRef; threadId: string; eventId: string }> {
  const workflow: WorkflowRef = uniqueWorkflow(label);
  await seedGreen(project.page, project.projectId, workflow);
  await failRun(project.page, workflow, label);
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

test("FM19 /astra used outside an alert thread asks which workflow and does not guess", async (): Promise<void> => {
  const { workflow } = await alertInThread("fm19");
  const workflowsBefore: JSONish = (await findWorkflow(
    project.page,
    project.projectId,
    workflow,
  ))!;
  const github: GitHubState = await githubFixture.state();
  const issuesBefore: number = countRequests(github, "POST", /\/issues$/);
  const llmBefore: number = (await llmFixture.state()).requests.length;
  // The model would happily pick an action; the app must not ask it to.
  await llmFixture.program({
    kind: "tool",
    toolName: actions.fileIssue,
    toolArguments: {},
    content: "guessed",
  });

  for (const channelId of [discordIds.channelId, discordIds.threadChannelId]) {
    const reply: InteractionResult & { deferred: boolean } = await finalReply(
      project.page,
      astraPayload("file an issue about this failure", { channelId }),
    );
    expect(reply.status).toBe(200);
    expect(reply.content).toMatch(/thread|workflow/i);
    if (!reply.deferred) {
      expect(reply.type).toBe(4);
      expect((reply.flags || 0) & 64, "ephemeral").toBe(64);
    }
  }
  expect(
    countRequests(await githubFixture.state(), "POST", /\/issues$/),
    "no issue filed by guessing",
  ).toBe(issuesBefore);
  expect(
    (await llmFixture.state()).requests.length,
    "no model call without a workflow to reason about",
  ).toBe(llmBefore);
  expect(await findWorkflow(project.page, project.projectId, workflow)).toEqual(
    workflowsBefore,
  );
  expect(
    (await eventsForWorkflow(project.page, project.projectId, workflow))[0]![
      "issueUrl"
    ],
  ).toBeFalsy();
});

test("FM20 /astra with a request that maps to no action answers and takes no action", async (): Promise<void> => {
  const { workflow, threadId } = await alertInThread("fm20");
  const before: JSONish = (await findWorkflow(
    project.page,
    project.projectId,
    workflow,
  ))!;
  const eventsBefore: Array<JSONish> = await eventsForWorkflow(
    project.page,
    project.projectId,
    workflow,
  );
  const issuesBefore: number = countRequests(
    await githubFixture.state(),
    "POST",
    /\/issues$/,
  );
  const postsBefore: number = (
    await discordMessagesForWorkflow(project.page, project.projectId, workflow)
  ).length;
  await llmFixture.program({
    kind: "answer",
    content:
      "Plain fixture answer: the assertion compares the wrong status code.",
  });

  const reply: InteractionResult & { deferred: boolean } = await finalReply(
    project.page,
    astraPayload("what does this error actually mean?", {
      channelId: threadId,
    }),
  );
  expect(reply.status).toBe(200);
  expect(reply.content).toContain("Plain fixture answer");
  const llm: LlmState = await llmFixture.state();
  expect(llm.requests.length).toBeGreaterThanOrEqual(1);
  expect(
    llm.requests[llm.requests.length - 1]!.raw,
    "the request text reached the model",
  ).toContain("what does this error actually mean?");

  expect(countRequests(await githubFixture.state(), "POST", /\/issues$/)).toBe(
    issuesBefore,
  );
  expect(await findWorkflow(project.page, project.projectId, workflow)).toEqual(
    before,
  );
  expect(
    await eventsForWorkflow(project.page, project.projectId, workflow),
  ).toEqual(eventsBefore);
  expect(
    (
      await discordMessagesForWorkflow(
        project.page,
        project.projectId,
        workflow,
      )
    ).length,
    "an answer is a reply, not a new alert",
  ).toBe(postsBefore);
});

test("contract: /astra maps 'mark this known red' to CiMarkKnownRed on the thread's workflow", async (): Promise<void> => {
  const { workflow, threadId } = await alertInThread("astra known-red");
  await llmFixture.program({
    kind: "tool",
    toolName: actions.markKnownRed,
    toolArguments: { reason: "flaky upstream image" },
    content: "Marked known-red.",
  });
  const reply: InteractionResult & { deferred: boolean } = await finalReply(
    project.page,
    astraPayload("mark this known red, it is a flaky upstream image", {
      channelId: threadId,
    }),
  );
  expect(reply.status).toBe(200);
  await expect
    .poll(async (): Promise<boolean> => {
      return Boolean(
        (await findWorkflow(project.page, project.projectId, workflow))?.[
          "isKnownRed"
        ],
      );
    })
    .toBe(true);
  const row: JSONish = (await findWorkflow(
    project.page,
    project.projectId,
    workflow,
  ))!;
  expect(String(row["knownRedReason"] || "")).toMatch(/flaky upstream image/i);
  expect(
    toId(
      (await eventsForWorkflow(project.page, project.projectId, workflow))[0]![
        "actedByUserId"
      ],
    ),
  ).toBe(project.userId);
});
