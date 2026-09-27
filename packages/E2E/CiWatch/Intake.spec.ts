import { APIResponse, Browser, TestInfo, expect, test } from "@playwright/test";
import { JSONish, listItems } from "../Tests/Dashboard/Helpers/MonitorAlerting";
import {
  DiscordState,
  GitHubState,
  ProvisionedProject,
  WorkflowRef,
  countRequests,
  deliverWebhook,
  discordFixture,
  discordMessagesForWorkflow,
  eventsForWorkflow,
  expectStable,
  findWorkflow,
  githubFixture,
  githubIds,
  listEvents,
  listWorkflows,
  nextRunId,
  programFailure,
  provisionProject,
  reconcile,
  repoFullName,
  runListEntry,
  sampleFailureLog,
  signWebhook,
  uniqueWorkflow,
  waitForEvents,
  workflowRunPayload,
} from "./Helpers";

/*
 * Webhook intake: FM01 to FM05 of ~/.buzz/PLANS/ONEUPTIME_CI_WATCH.md.
 * Red first: authored before the feature. Each test owns a unique workflow so
 * no assertion depends on state another test left behind.
 */

let project: ProvisionedProject;

test.beforeAll(async ({ browser }: { browser: Browser }): Promise<void> => {
  test.setTimeout(300000);
  project = await provisionProject(browser, { namePrefix: "CI watch intake" });
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
  await project?.context.close();
});

async function noStateFor(workflow: WorkflowRef): Promise<void> {
  expect(
    await findWorkflow(project.page, project.projectId, workflow),
    "no CiWorkflow row",
  ).toBeUndefined();
  expect(
    await eventsForWorkflow(project.page, project.projectId, workflow),
  ).toHaveLength(0);
  expect(
    await discordMessagesForWorkflow(project.page, project.projectId, workflow),
  ).toHaveLength(0);
}

test("FM01 a webhook with a bad or missing signature is rejected and creates no state", async (): Promise<void> => {
  const workflow: WorkflowRef = uniqueWorkflow("fm01");
  const runId: string = nextRunId();
  await programFailure({ runId, log: sampleFailureLog("fm01") });
  const payload: JSONish = workflowRunPayload({
    workflow,
    conclusion: "failure",
    runId,
  });
  const body: string = JSON.stringify(payload);
  const github: GitHubState = await githubFixture.state();
  const requestsBefore: number = github.requests.length;

  const attempts: Array<{ name: string; signature: string | null }> = [
    { name: "missing signature", signature: null },
    {
      name: "wrong secret",
      signature: signWebhook(body, "not-the-webhook-secret"),
    },
    { name: "malformed signature", signature: "sha256=zz" },
    {
      name: "signature of a different body",
      signature: signWebhook(body + " "),
    },
  ];
  for (const attempt of attempts) {
    const { response } = await deliverWebhook(project.page, payload, {
      signature: attempt.signature,
    });
    expect(
      [400, 401, 403],
      `${attempt.name} must be refused, not ${response.status()}`,
    ).toContain(response.status());
  }

  await noStateFor(workflow);
  expect(
    (await githubFixture.state()).requests.length,
    "no GitHub call for a refused webhook",
  ).toBe(requestsBefore);
});

test("FM02 a redelivered webhook with the same x-github-delivery alerts once", async (): Promise<void> => {
  const workflow: WorkflowRef = uniqueWorkflow("fm02");
  // Seed green first so the failure is alertable (decision table row 2).
  const seed: { response: APIResponse } = await deliverWebhook(
    project.page,
    workflowRunPayload({ workflow, conclusion: "success" }),
  );
  expect(seed.response.status()).toBe(200);
  await expect
    .poll(async (): Promise<string> => {
      return String(
        (await findWorkflow(project.page, project.projectId, workflow))?.[
          "lastConclusion"
        ] || "",
      );
    })
    .toBe("success");

  const runId: string = nextRunId();
  await programFailure({ runId, log: sampleFailureLog("fm02") });
  const payload: JSONish = workflowRunPayload({
    workflow,
    conclusion: "failure",
    runId,
  });
  const first: { response: APIResponse; deliveryId: string } =
    await deliverWebhook(project.page, payload);
  expect(first.response.status()).toBe(200);
  await waitForEvents(project.page, project.projectId, workflow, 1);

  // GitHub redelivery: identical body, identical delivery id.
  const replay: { response: APIResponse } = await deliverWebhook(
    project.page,
    payload,
    { deliveryId: first.deliveryId },
  );
  expect(
    replay.response.status(),
    "a redelivery is acknowledged, not errored",
  ).toBe(200);
  // A fresh delivery id for a run already recorded is the same no-op.
  const sameRun: { response: APIResponse } = await deliverWebhook(
    project.page,
    payload,
  );
  expect(sameRun.response.status()).toBe(200);

  await expectStable(async (): Promise<number> => {
    return (await eventsForWorkflow(project.page, project.projectId, workflow))
      .length;
  }, 1);
  await expectStable(async (): Promise<number> => {
    return (
      await discordMessagesForWorkflow(
        project.page,
        project.projectId,
        workflow,
      )
    ).length;
  }, 1);
});

test("FM03 a workflow_run for a repository not linked to any project is ignored", async (): Promise<void> => {
  const workflow: WorkflowRef = uniqueWorkflow("fm03");
  const repository: string = `${githubIds.unlinkedOwner}/${githubIds.unlinkedRepository}`;
  const github: GitHubState = await githubFixture.state();
  const requestsBefore: number = github.requests.length;
  const discord: DiscordState = await discordFixture.state();
  const postsBefore: number = discord.postedMessages.length;

  const { response } = await deliverWebhook(
    project.page,
    workflowRunPayload({ workflow, conclusion: "failure", repository }),
  );
  expect(
    response.status(),
    "signed webhook for an unknown repository is acknowledged",
  ).toBe(200);

  await noStateFor(workflow);
  const repositories: Array<JSONish> = await listItems({
    page: project.page,
    projectId: project.projectId,
    path: "/api/code-repository",
    query: {
      projectId: project.projectId,
      organizationName: githubIds.unlinkedOwner,
    },
    select: { _id: true },
  });
  expect(
    repositories,
    "an unknown repository is never auto-imported by a workflow_run",
  ).toHaveLength(0);
  expect(
    (await githubFixture.state()).requests.length,
    "no GitHub API call for an unlinked repository",
  ).toBe(requestsBefore);
  expect((await discordFixture.state()).postedMessages.length).toBe(
    postsBefore,
  );
});

test("FM04 a run on a non-main branch, or cancelled / skipped, changes nothing", async (): Promise<void> => {
  const cases: Array<{ label: string; branch?: string; conclusion: string }> = [
    {
      label: "feature branch failure",
      branch: "feature/not-main",
      conclusion: "failure",
    },
    { label: "cancelled", conclusion: "cancelled" },
    { label: "skipped", conclusion: "skipped" },
    { label: "neutral", conclusion: "neutral" },
    { label: "stale", conclusion: "stale" },
  ];
  for (const item of cases) {
    const workflow: WorkflowRef = uniqueWorkflow(`fm04 ${item.label}`);
    const runId: string = nextRunId();
    await programFailure({ runId, log: sampleFailureLog("fm04") });
    const before: number = (await githubFixture.state()).requests.length;
    const { response } = await deliverWebhook(
      project.page,
      workflowRunPayload({
        workflow,
        conclusion: item.conclusion,
        runId,
        branch: item.branch,
      }),
    );
    expect(response.status(), item.label).toBe(200);
    await noStateFor(workflow);
    const after: GitHubState = await githubFixture.state();
    expect(after.requests.length, `${item.label}: no GitHub call`).toBe(before);
    expect(
      countRequests(after, "GET", new RegExp(`/actions/runs/${runId}/`)),
      `${item.label}: no job lookup`,
    ).toBe(0);
  }

  // An in-progress run (action != completed) is not a result either.
  const workflow: WorkflowRef = uniqueWorkflow("fm04 requested");
  const { response } = await deliverWebhook(
    project.page,
    workflowRunPayload({
      workflow,
      conclusion: "failure",
      action: "requested",
    }),
  );
  expect(response.status()).toBe(200);
  await noStateFor(workflow);
});

test("FM05 a repository's first sweep seeds every workflow it finds and does not alert on the backlog", async ({
  browser,
}: {
  browser: Browser;
}): Promise<void> => {
  test.setTimeout(300000);
  // A project whose repository has never been swept.
  const fresh: ProvisionedProject = await provisionProject(browser, {
    namePrefix: "CI watch first sweep",
    seedRepository: false,
  });
  try {
    const red: WorkflowRef = uniqueWorkflow("fm05 red backlog");
    const green: WorkflowRef = uniqueWorkflow("fm05 green backlog");
    const redRun: string = nextRunId();
    await programFailure({ runId: redRun, log: sampleFailureLog("fm05") });
    await githubFixture.program({
      runs: {
        [repoFullName]: [
          runListEntry(
            workflowRunPayload({
              workflow: red,
              conclusion: "failure",
              runId: redRun,
            }),
          ),
          runListEntry(
            workflowRunPayload({ workflow: green, conclusion: "success" }),
          ),
        ],
      },
    });
    const sweep: APIResponse = await reconcile(fresh.page, fresh.projectId);
    expect(sweep.status(), "first sweep").toBe(200);

    let row: JSONish | undefined;
    await expect
      .poll(async (): Promise<string> => {
        row = await findWorkflow(fresh.page, fresh.projectId, red);
        return String(row?.["lastRunId"] || "");
      })
      .toBe(redRun);
    expect(row!["lastConclusion"]).toBe("failure");
    expect(String(row!["workflowName"])).toBe(red.name);
    expect(String(row!["branchName"])).toBe(githubIds.defaultBranch);
    expect(String(row!["lastFailureSignature"])).toMatch(/^[0-9a-f]{16}$/);
    expect(
      (await findWorkflow(fresh.page, fresh.projectId, green))?.[
        "lastConclusion"
      ],
    ).toBe("success");
    // The backlog is state, not news: no event, no Discord post.
    await expectStable(async (): Promise<number> => {
      return (await listEvents(fresh.page, fresh.projectId)).length;
    }, 0);
    expect(
      await discordMessagesForWorkflow(fresh.page, fresh.projectId, red),
    ).toHaveLength(0);

    // The row is unique on repository + workflow id: the same failure again updates, never duplicates.
    const secondRun: string = nextRunId();
    await programFailure({ runId: secondRun, log: sampleFailureLog("fm05") });
    const { response } = await deliverWebhook(
      fresh.page,
      workflowRunPayload({
        workflow: red,
        conclusion: "failure",
        runId: secondRun,
      }),
    );
    expect(response.status()).toBe(200);
    await expect
      .poll(async (): Promise<string> => {
        return String(
          (await findWorkflow(fresh.page, fresh.projectId, red))?.[
            "lastRunId"
          ] || "",
        );
      })
      .toBe(secondRun);
    expect(
      await listWorkflows(fresh.page, fresh.projectId, {
        gitHubWorkflowId: red.id,
      }),
    ).toHaveLength(1);
    await expectStable(async (): Promise<number> => {
      return (await listEvents(fresh.page, fresh.projectId)).length;
    }, 0);
  } finally {
    await fresh.context.close();
  }
});
