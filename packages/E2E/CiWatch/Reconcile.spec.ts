import { APIResponse, Browser, TestInfo, expect, test } from "@playwright/test";
import { JSONish } from "../Tests/Dashboard/Helpers/MonitorAlerting";
import {
  DiscordState,
  GitHubRequest,
  GitHubState,
  PostedMessage,
  ProvisionedProject,
  WorkflowRef,
  countRequests,
  discordFixture,
  discordMessagesForWorkflow,
  eventTypes,
  eventsForWorkflow,
  expectStable,
  findWorkflow,
  githubFixture,
  listEvents,
  messageText,
  nextRunId,
  programFailure,
  provisionProject,
  reconcile,
  repoFullName,
  runListEntry,
  sampleFailureLog,
  uniqueWorkflow,
  waitForEvents,
  workflowRunPayload,
} from "./Helpers";

/*
 * The reconcile sweep (worker CiWatch:Reconcile): FM10 and FM11. The sweep
 * is triggered on demand through POST /api/ci-watch/reconcile (contract
 * addition, see Helpers.routes) instead of waiting for the 10 minute cron.
 */

let project: ProvisionedProject;

test.beforeAll(async ({ browser }: { browser: Browser }): Promise<void> => {
  test.setTimeout(300000);
  project = await provisionProject(browser, {
    namePrefix: "CI watch reconcile",
  });
});

test.afterEach(
  async (
    { browser: _browser }: { browser: Browser },
    testInfo: TestInfo,
  ): Promise<void> => {
    await githubFixture.program({
      scenario: { runs: "ok", jobs: "ok", logs: "ok" },
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

async function monitorFailures(): Promise<Array<JSONish>> {
  return listEvents(project.page, project.projectId, {
    eventType: eventTypes.monitorFailure,
  });
}

const monitorWording: RegExp = /monitor|could not|GitHub/i;
const ciWording: RegExp = /CI/i;

async function monitorFailureMessages(): Promise<Array<PostedMessage>> {
  const state: DiscordState = await discordFixture.state();
  return state.postedMessages.filter((message: PostedMessage): boolean => {
    return (
      message.webhook_kind !== "interaction" &&
      monitorWording.test(messageText(message)) &&
      ciWording.test(messageText(message))
    );
  });
}

test("FM10 a webhook missed entirely is caught by the reconcile sweep, once", async (): Promise<void> => {
  const workflow: WorkflowRef = uniqueWorkflow("fm10");
  // The workflow is known green from an earlier run the sweep will also list.
  const greenRun: string = nextRunId();
  const green: JSONish = runListEntry(
    workflowRunPayload({ workflow, conclusion: "success", runId: greenRun }),
  );
  // Newest first, as GitHub lists them. A branch-mismatched run must be filtered by the query.
  const feature: JSONish = runListEntry(
    workflowRunPayload({
      workflow,
      conclusion: "failure",
      branch: "feature/ignored",
    }),
  );
  await githubFixture.program({
    runs: { [repoFullName]: [feature, green] },
  });

  // No webhook was ever delivered for this workflow. The sweep sees it green.
  let response: APIResponse = await reconcile(project.page, project.projectId);
  expect(response.status(), "reconcile trigger").toBe(200);
  await expect
    .poll(async (): Promise<string> => {
      return String(
        (await findWorkflow(project.page, project.projectId, workflow))?.[
          "lastRunId"
        ] || "",
      );
    })
    .toBe(greenRun);
  const github: GitHubState = await githubFixture.state();
  const sweep: GitHubRequest | undefined = github.requests.find(
    (request: GitHubRequest): boolean => {
      return (
        request.method === "GET" &&
        request.path === `/repos/${repoFullName}/actions/runs`
      );
    },
  );
  expect(
    sweep,
    "the sweep lists completed runs on the watched branch",
  ).toBeTruthy();
  expect(sweep!.query).toContain("branch=main");
  expect(sweep!.query).toContain("status=completed");
  expect(sweep!.query).toContain("per_page=50");
  expect(sweep!.auth).toBe("installation");
  await expectStable(async (): Promise<number> => {
    return (await eventsForWorkflow(project.page, project.projectId, workflow))
      .length;
  }, 0);

  // A failure lands that GitHub never delivered.
  const missedRun: string = nextRunId();
  await programFailure({
    runId: missedRun,
    log: sampleFailureLog("fm10-missed"),
  });
  await githubFixture.program({
    runs: {
      [repoFullName]: [
        feature,
        runListEntry(
          workflowRunPayload({
            workflow,
            conclusion: "failure",
            runId: missedRun,
          }),
        ),
        green,
      ],
    },
  });
  response = await reconcile(project.page, project.projectId);
  expect(response.status()).toBe(200);
  const events: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    workflow,
    1,
  );
  expect(events[0]!["eventType"]).toBe(eventTypes.newFailure);
  expect(String(events[0]!["runId"])).toBe(missedRun);
  expect(
    await discordMessagesForWorkflow(project.page, project.projectId, workflow),
  ).toHaveLength(1);

  // Sweep again, and deliver the late webhook: the run id is already recorded, so both are no-ops.
  response = await reconcile(project.page, project.projectId);
  expect(response.status()).toBe(200);
  await expectStable(async (): Promise<number> => {
    return (await eventsForWorkflow(project.page, project.projectId, workflow))
      .length;
  }, 1);
  expect(
    await discordMessagesForWorkflow(project.page, project.projectId, workflow),
  ).toHaveLength(1);
});

test("FM11 a GitHub API error during reconcile is one monitor-failure alert per hour, never a silent all-green", async (): Promise<void> => {
  const workflow: WorkflowRef = uniqueWorkflow("fm11");
  const failedRun: string = nextRunId();
  await programFailure({ runId: failedRun, log: sampleFailureLog("fm11") });
  await githubFixture.program({
    runs: {
      [repoFullName]: [
        runListEntry(
          workflowRunPayload({
            workflow,
            conclusion: "failure",
            runId: failedRun,
          }),
        ),
      ],
    },
  });
  await reconcile(project.page, project.projectId);
  await expect
    .poll(async (): Promise<string> => {
      return String(
        (await findWorkflow(project.page, project.projectId, workflow))?.[
          "lastConclusion"
        ] || "",
      );
    })
    .toBe("failure");
  const before: number = (await monitorFailures()).length;
  const messagesBefore: number = (await monitorFailureMessages()).length;
  const discordBefore: DiscordState = await discordFixture.state();
  const postsBefore: number = discordBefore.postedMessages.length;

  await githubFixture.program({ scenario: { runs: "error" } });
  let response: APIResponse = await reconcile(project.page, project.projectId);
  expect(
    response.status(),
    "a monitor failure is reported, not thrown to the caller",
  ).toBeLessThan(500);
  await expect
    .poll(async (): Promise<number> => {
      return (await monitorFailures()).length;
    })
    .toBe(before + 1);
  await expect
    .poll(async (): Promise<number> => {
      return (await monitorFailureMessages()).length;
    })
    .toBe(messagesBefore + 1);
  const warning: PostedMessage = (await monitorFailureMessages())[
    messagesBefore
  ]!;
  expect(messageText(warning)).toMatch(/GitHub/);

  // The failing sweep must not touch workflow state or read as a recovery.
  const row: JSONish = (await findWorkflow(
    project.page,
    project.projectId,
    workflow,
  ))!;
  expect(row["lastConclusion"]).toBe("failure");
  expect(String(row["lastRunId"])).toBe(failedRun);
  expect(
    await listEvents(project.page, project.projectId, {
      eventType: eventTypes.recovered,
    }),
  ).toHaveLength(0);

  // Still failing within the hour: no second warning.
  response = await reconcile(project.page, project.projectId);
  expect(response.status()).toBeLessThan(500);
  await githubFixture.program({ scenario: { runs: "empty" } });
  response = await reconcile(project.page, project.projectId);
  expect(response.status()).toBeLessThan(500);
  expect(
    countRequests(
      await githubFixture.state(),
      "GET",
      new RegExp(`^/repos/${repoFullName}/actions/runs$`),
    ),
    "every sweep still asks GitHub",
  ).toBeGreaterThanOrEqual(4);
  await expectStable(async (): Promise<number> => {
    return (await monitorFailures()).length;
  }, before + 1);
  expect((await monitorFailureMessages()).length).toBe(messagesBefore + 1);
  expect(
    (await discordFixture.state()).postedMessages.length - postsBefore,
    "exactly one Discord post for the outage",
  ).toBe(1);

  // Back to healthy: the next sweep processes normally and posts no recovery for the monitor itself.
  await githubFixture.program({ scenario: { runs: "ok" } });
  response = await reconcile(project.page, project.projectId);
  expect(response.status()).toBe(200);
  await expectStable(async (): Promise<number> => {
    return (await monitorFailures()).length;
  }, before + 1);
});

test("FM11 an empty body from the GitHub API is a monitor failure in a fresh project", async ({
  browser,
}: {
  browser: Browser;
}): Promise<void> => {
  test.setTimeout(300000);
  const fresh: ProvisionedProject = await provisionProject(browser, {
    namePrefix: "CI watch empty body",
  });
  try {
    await githubFixture.program({ scenario: { runs: "empty" } });
    const response: APIResponse = await reconcile(fresh.page, fresh.projectId);
    expect(response.status()).toBeLessThan(500);
    await expect
      .poll(async (): Promise<number> => {
        return (
          await listEvents(fresh.page, fresh.projectId, {
            eventType: eventTypes.monitorFailure,
          })
        ).length;
      })
      .toBe(1);
    const event: JSONish = (
      await listEvents(fresh.page, fresh.projectId, {
        eventType: eventTypes.monitorFailure,
      })
    )[0]!;
    expect(
      event["ciWorkflowId"],
      "a monitor failure belongs to the project, not a workflow",
    ).toBeFalsy();
    expect(
      await listEvents(fresh.page, fresh.projectId, {
        eventType: eventTypes.recovered,
      }),
    ).toHaveLength(0);
    await reconcile(fresh.page, fresh.projectId);
    await expectStable(async (): Promise<number> => {
      return (
        await listEvents(fresh.page, fresh.projectId, {
          eventType: eventTypes.monitorFailure,
        })
      ).length;
    }, 1);
  } finally {
    await githubFixture.program({ scenario: { runs: "ok" } });
    await fresh.context.close();
  }
});
