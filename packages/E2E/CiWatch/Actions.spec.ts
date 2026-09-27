import {
  APIResponse,
  Browser,
  BrowserContext,
  Page,
  TestInfo,
  expect,
  test,
} from "@playwright/test";
import { registerAndCreateProject } from "../Tests/Dashboard/Helpers/ProductOnboarding";
import {
  JSONish,
  createItem,
  getSessionUser,
  listItems,
  toId,
} from "../Tests/Dashboard/Helpers/MonitorAlerting";
import {
  DiscordState,
  GitHubState,
  InteractionResult,
  PostedMessage,
  ProvisionedProject,
  WorkflowRef,
  actions,
  app,
  buttonPayload,
  countRequests,
  discordFixture,
  discordIds,
  discordMessagesForWorkflow,
  eventsForWorkflow,
  expectStable,
  failRun,
  finalReply,
  findWorkflow,
  githubFixture,
  headers,
  linkDiscordUser,
  messageText,
  provisionProject,
  repoFullName,
  routes,
  seedGreen,
  signedInteractionHeaders,
  threadIdForWorkflow,
  uniqueWorkflow,
  updateItem,
  waitForEvents,
} from "./Helpers";

/*
 * Alert buttons: FM15 (unlinked Discord user), FM16 (linked member without
 * EditCiWatch), FM17 (File issue twice), FM18 (Issues: Write missing).
 * A refusal is: a clear reply, no state mutation, no extra outbound call.
 */

let project: ProvisionedProject;
const issuesPath: RegExp = /\/issues$/;
const issuesWording: RegExp = /issues/i;
const permissionWording: RegExp = /permission|write|403|not accessible/i;

interface Alert {
  workflow: WorkflowRef;
  workflowId: string;
  eventId: string;
  threadId: string;
}

test.beforeAll(async ({ browser }: { browser: Browser }): Promise<void> => {
  test.setTimeout(300000);
  project = await provisionProject(browser, { namePrefix: "CI watch actions" });
});

test.afterEach(
  async (
    { browser: _browser }: { browser: Browser },
    testInfo: TestInfo,
  ): Promise<void> => {
    await discordFixture.scenario("valid");
    await githubFixture.program({ scenario: { issues: "ok" } });
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

async function raiseAlert(label: string): Promise<Alert> {
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
  const workflowId: string = toId(row["_id"]);
  const threadId: string = (await threadIdForWorkflow(
    project.page,
    project.projectId,
    workflowId,
  ))!;
  expect(threadId).toBeTruthy();
  return { workflow, workflowId, eventId: toId(events[0]!["_id"]), threadId };
}

async function snapshot(alert: Alert): Promise<{
  workflow: JSONish;
  events: Array<JSONish>;
  issuePosts: number;
  threadPosts: number;
}> {
  const github: GitHubState = await githubFixture.state();
  return {
    workflow: (await findWorkflow(
      project.page,
      project.projectId,
      alert.workflow,
    ))!,
    events: await eventsForWorkflow(
      project.page,
      project.projectId,
      alert.workflow,
    ),
    issuePosts: countRequests(github, "POST", /\/issues$/),
    threadPosts: (
      await discordMessagesForWorkflow(
        project.page,
        project.projectId,
        alert.workflow,
      )
    ).length,
  };
}

async function expectRefused(
  alert: Alert,
  reply: InteractionResult & { deferred: boolean },
  before: Awaited<ReturnType<typeof snapshot>>,
  pattern: RegExp,
): Promise<void> {
  expect(reply.status).toBe(200);
  expect(reply.content, "a clear refusal").toMatch(pattern);
  if (!reply.deferred) {
    expect(reply.type).toBe(4);
    expect((reply.flags || 0) & 64, "refusal is ephemeral").toBe(64);
  }
  // Quiet period: nothing changes after the refusal.
  await new Promise((resolve: (value: void) => void): void => {
    setTimeout(resolve, 3000);
  });
  const after: Awaited<ReturnType<typeof snapshot>> = await snapshot(alert);
  expect(after.workflow).toEqual(before.workflow);
  expect(after.events).toEqual(before.events);
  expect(after.issuePosts, "no outbound GitHub write").toBe(before.issuePosts);
  expect(after.threadPosts, "no message in the thread").toBe(
    before.threadPosts,
  );
}

test("FM15 a button pressed by a Discord user with no linked OneUptime account is refused with no side effect", async (): Promise<void> => {
  const alert: Alert = await raiseAlert("fm15");
  const before: Awaited<ReturnType<typeof snapshot>> = await snapshot(alert);
  for (const action of [
    actions.fileIssue,
    actions.markKnownRed,
    actions.mute,
    actions.assessRetire,
  ]) {
    const reply: InteractionResult & { deferred: boolean } = await finalReply(
      project.page,
      buttonPayload(action, alert.eventId, {
        channelId: alert.threadId,
        userId: discordIds.secondUserId,
      }),
    );
    await expectRefused(
      alert,
      reply,
      before,
      /link your discord|not linked|link .* account/i,
    );
  }
});

test("FM16 a button pressed by a linked member without EditCiWatch is refused", async ({
  browser,
}: {
  browser: Browser;
}): Promise<void> => {
  test.setTimeout(300000);
  const alert: Alert = await raiseAlert("fm16");

  // A second OneUptime user, member of this project through a read-only team.
  const readerContext: BrowserContext = await browser.newContext();
  const readerPage: Page = await readerContext.newPage();
  try {
    await registerAndCreateProject({
      page: readerPage,
      projectNamePrefix: "CI watch reader home",
    });
    const reader: { userId: string; email: string } = await getSessionUser({
      page: readerPage,
    });
    const team: JSONish = await createItem({
      page: project.page,
      projectId: project.projectId,
      path: "/api/team",
      item: { projectId: project.projectId, name: `ci-readers-${Date.now()}` },
    });
    const teamId: string = toId(team["_id"]);
    await createItem({
      page: project.page,
      projectId: project.projectId,
      path: "/api/team-permission",
      item: { projectId: project.projectId, teamId, permission: "ReadCiWatch" },
    });
    const invite: APIResponse = await project.page.request.post(
      `${app}/api/team-member`,
      {
        headers: {
          "content-type": "application/json",
          ...headers(project.projectId),
        },
        data: {
          data: { projectId: project.projectId, teamId },
          miscDataProps: { email: reader.email },
        },
      },
    );
    expect(
      invite.ok(),
      `invite: ${invite.status()} ${await invite.text()}`,
    ).toBe(true);
    const memberships: Array<JSONish> = await listItems({
      page: project.page,
      projectId: project.projectId,
      path: "/api/team-member",
      query: { projectId: project.projectId, teamId },
      select: { _id: true, userId: true },
    });
    const membership: JSONish | undefined = memberships.find(
      (row: JSONish): boolean => {
        return toId(row["userId"]) === reader.userId;
      },
    );
    expect(membership, "the reader was invited").toBeTruthy();
    // The invitee accepts for themselves (only the current user may flip hasAcceptedInvitation).
    await updateItem(
      readerPage,
      project.projectId,
      "/api/team-member",
      toId(membership!["_id"]),
      { hasAcceptedInvitation: true },
    );

    // The reader links a DIFFERENT Discord account (fixture: second-user).
    await discordFixture.scenario("second-user");
    await linkDiscordUser(readerPage, project.projectId);
    await discordFixture.scenario("valid");
    const links: Array<JSONish> = await listItems({
      page: project.page,
      projectId: project.projectId,
      path: "/api/workspace-user-auth-token",
      query: {
        projectId: project.projectId,
        workspaceType: "Discord",
        workspaceUserId: discordIds.secondUserId,
      },
      select: { _id: true, userId: true },
    });
    expect(links, "second Discord user linked to the reader").toHaveLength(1);
    expect(toId(links[0]!["userId"])).toBe(reader.userId);

    const before: Awaited<ReturnType<typeof snapshot>> = await snapshot(alert);
    for (const action of [
      actions.fileIssue,
      actions.markKnownRed,
      actions.mute,
    ]) {
      const reply: InteractionResult & { deferred: boolean } = await finalReply(
        project.page,
        buttonPayload(action, alert.eventId, {
          channelId: alert.threadId,
          userId: discordIds.secondUserId,
        }),
      );
      await expectRefused(
        alert,
        reply,
        before,
        /permission|not authorized|not allowed/i,
      );
    }
    // ReadCiWatch is enough for the read-only assessment; it must not be refused as a permission error.
    const assess: InteractionResult & { deferred: boolean } = await finalReply(
      project.page,
      buttonPayload(actions.assessRetire, alert.eventId, {
        channelId: alert.threadId,
        userId: discordIds.secondUserId,
      }),
    );
    expect(assess.status).toBe(200);
    expect(assess.content).not.toMatch(/permission|not authorized/i);
  } finally {
    await discordFixture.scenario("valid");
    await readerContext.close();
  }
});

test("FM17 File issue pressed twice creates one issue and the second press links to it", async (): Promise<void> => {
  const alert: Alert = await raiseAlert("fm17");
  const issuesBefore: number = countRequests(
    await githubFixture.state(),
    "POST",
    /\/issues$/,
  );

  const first: InteractionResult & { deferred: boolean } = await finalReply(
    project.page,
    buttonPayload(actions.fileIssue, alert.eventId, {
      channelId: alert.threadId,
    }),
  );
  expect(first.status).toBe(200);
  const github: GitHubState = await githubFixture.state();
  expect(countRequests(github, "POST", /\/issues$/) - issuesBefore).toBe(1);
  const issue: {
    html_url: string;
    title: string;
    body: string;
    repository: string;
  } = github.issues[github.issues.length - 1]!;
  expect(issue.repository).toBe(repoFullName);
  expect(issue.title).toContain(alert.workflow.name);
  expect(issue.body).toMatch(/actions\/runs\//);
  const created: JSONish = github.requests.filter(
    (request: { method: string; path: string }): boolean => {
      return request.method === "POST" && issuesPath.test(request.path);
    },
  )[0]!;
  expect(created["auth"], "issues are filed with the installation token").toBe(
    "installation",
  );
  expect(first.content).toContain(issue.html_url);
  await expect
    .poll(async (): Promise<string> => {
      return String(
        (
          await eventsForWorkflow(
            project.page,
            project.projectId,
            alert.workflow,
          )
        )[0]?.["issueUrl"] || "",
      );
    })
    .toBe(issue.html_url);
  expect(
    toId(
      (
        await eventsForWorkflow(project.page, project.projectId, alert.workflow)
      )[0]!["actedByUserId"],
    ),
  ).toBe(project.userId);
  await expect
    .poll(async (): Promise<string> => {
      return String(
        (await findWorkflow(project.page, project.projectId, alert.workflow))?.[
          "ticketUrl"
        ] || "",
      );
    })
    .toBe(issue.html_url);

  const second: InteractionResult & { deferred: boolean } = await finalReply(
    project.page,
    buttonPayload(actions.fileIssue, alert.eventId, {
      channelId: alert.threadId,
    }),
  );
  expect(second.status).toBe(200);
  expect(
    second.content,
    "the second press answers with the existing issue",
  ).toContain(issue.html_url);
  await expectStable(async (): Promise<number> => {
    return (
      countRequests(await githubFixture.state(), "POST", /\/issues$/) -
      issuesBefore
    );
  }, 1);
  expect((await githubFixture.state()).issues.length).toBe(
    github.issues.length,
  );
});

test("FM18 File issue when the installation lacks Issues: Write gives a clear error in the thread and no crash", async (): Promise<void> => {
  const alert: Alert = await raiseAlert("fm18");
  await githubFixture.program({ scenario: { issues: "forbidden" } });
  const postsBefore: number = (
    await discordMessagesForWorkflow(
      project.page,
      project.projectId,
      alert.workflow,
    )
  ).length;
  const reply: InteractionResult & { deferred: boolean } = await finalReply(
    project.page,
    buttonPayload(actions.fileIssue, alert.eventId, {
      channelId: alert.threadId,
    }),
  );
  expect(reply.status).toBe(200);
  expect(
    countRequests(await githubFixture.state(), "POST", /\/issues$/),
  ).toBeGreaterThanOrEqual(1);
  // The error is visible where the team is looking: the reply or a thread post names the missing permission.
  let visible: string = reply.content;
  await expect
    .poll(async (): Promise<boolean> => {
      const posts: Array<PostedMessage> = await discordMessagesForWorkflow(
        project.page,
        project.projectId,
        alert.workflow,
      );
      visible = [
        reply.content,
        ...posts.slice(postsBefore).map(messageText),
      ].join("\n");
      return issuesWording.test(visible) && permissionWording.test(visible);
    })
    .toBe(true);
  expect(visible).not.toMatch(/ghs_|stack|TypeError|undefined/);
  expect(
    (
      await eventsForWorkflow(project.page, project.projectId, alert.workflow)
    )[0]!["issueUrl"],
  ).toBeFalsy();

  // No crash: the app still serves interactions and the next alert still posts.
  const ping: string = JSON.stringify({
    type: 1,
    application_id: discordIds.applicationId,
  });
  const pong: APIResponse = await project.page.request.post(
    `${app}${routes.interactions}`,
    {
      data: ping,
      headers: signedInteractionHeaders(ping),
    },
  );
  expect(pong.status()).toBe(200);
  const state: DiscordState = await discordFixture.state();
  expect(
    state.unhandled.filter((entry: string): boolean => {
      return entry.includes("malformed");
    }),
  ).toHaveLength(0);
});
