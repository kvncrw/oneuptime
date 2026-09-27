import { Browser, Page, TestInfo, expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { JSONish, toId } from "../Tests/Dashboard/Helpers/MonitorAlerting";
import { registerAndCreateProject } from "../Tests/Dashboard/Helpers/ProductOnboarding";
import {
  InteractionResult,
  ProvisionedProject,
  RelayClaimResult,
  WorkflowRef,
  analysisStatuses,
  astraPayload,
  createRelayProvider,
  discordFixture,
  failRun,
  finalReply,
  findWorkflow,
  llmFixture,
  provisionProject,
  relayClaim,
  relayCompletion,
  relayResult,
  releaseProject,
  seedGreen,
  testProvider,
  threadIdForWorkflow,
  uniqueWorkflow,
  waitForEvents,
} from "./Helpers";

/*
 * Relay failure modes that need the stack itself reconfigured, so they
 * cannot share a run with the rest of the suite:
 *
 *   RFM02  the app started WITHOUT LLM_RELAY_TOKEN
 *          (LLM_RELAY_E2E_MODE=no-token; launcher: CI_WATCH_RELAY_TOKEN_UNSET=1 start)
 *   RFM12  Redis (valkey) stopped while the app is up
 *          (LLM_RELAY_E2E_MODE=redis-down; the runner stops the valkey container)
 *
 * In any other run both are reported as skipped, never as passed.
 */

const mode: string = process.env["LLM_RELAY_E2E_MODE"] || "";

let project: ProvisionedProject | undefined;

test.afterEach(
  async (
    { browser: _browser }: { browser: Browser },
    testInfo: TestInfo,
  ): Promise<void> => {
    // Fixture reads may fail in a reconfigured stack; evidence is best effort.
    const quietly: (promise: Promise<unknown>) => Promise<unknown> = (
      promise: Promise<unknown>,
    ): Promise<unknown> => {
      return promise.catch((): null => {
        return null;
      });
    };
    await testInfo.attach("llm-provider", {
      body: JSON.stringify(await quietly(llmFixture.state())),
      contentType: "application/json",
    });
    await testInfo.attach("discord-provider", {
      body: JSON.stringify(await quietly(discordFixture.state())),
      contentType: "application/json",
    });
  },
);

test.afterAll(async (): Promise<void> => {
  await releaseProject(project);
});

test("RFM02 LLM_RELAY_TOKEN unset: claim and result answer 404 and a Relay provider fails fast, not after the timeout", async ({
  browser,
}: {
  browser: Browser;
}): Promise<void> => {
  test.skip(
    mode !== "no-token",
    "needs the app started without LLM_RELAY_TOKEN (LLM_RELAY_E2E_MODE=no-token)",
  );
  test.setTimeout(300000);
  project = await provisionProject(browser, {
    namePrefix: "CI watch relay no-token",
  });
  const providerId: string = await createRelayProvider(
    project.page,
    project.projectId,
  );

  // The routes do not exist without the token, whatever header is sent.
  const claim: RelayClaimResult = await relayClaim({ waitSeconds: 1 });
  expect(claim.status, claim.text).toBe(404);
  expect(claim.elapsedMs).toBeLessThan(5000);
  const result: { status: number; text: string } = await relayResult({
    id: randomUUID(),
    status: 200,
    json: relayCompletion("nobody home"),
  });
  expect(result.status, result.text).toBe(404);

  // A Relay call fails right away with a message that names the cause.
  const probe: { status: number; elapsedMs: number; text: string } =
    await testProvider(project.page, project.projectId, providerId);
  expect(probe.status, probe.text).toBe(400);
  expect(probe.text).toMatch(/LLM_RELAY_TOKEN|relay is not configured/i);
  expect(
    probe.elapsedMs,
    "fails fast, not after the request timeout",
  ).toBeLessThan(5000);

  // The CI watch callers see the same fast failure.
  const workflow: WorkflowRef = uniqueWorkflow("rfm02");
  await seedGreen(project.page, project.projectId, workflow);
  await failRun(project.page, workflow, "rfm02");
  const events: Array<JSONish> = await waitForEvents(
    project.page,
    project.projectId,
    workflow,
    1,
  );
  expect(events[0]!["analysisStatus"]).toBe(analysisStatuses.failed);
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
  const started: number = Date.now();
  const reply: InteractionResult & { deferred: boolean } = await finalReply(
    project.page,
    astraPayload("rfm02 what does this mean?", { channelId: threadId }),
    30000,
  );
  expect(reply.content).toMatch(/could not reach the LLM/i);
  expect(Date.now() - started).toBeLessThan(15000);
});

test("RFM12 Redis unavailable: a Relay call fails with a readable error, not a hang", async ({
  browser,
}: {
  browser: Browser;
}): Promise<void> => {
  test.skip(
    mode !== "redis-down",
    "needs the valkey container stopped (LLM_RELAY_E2E_MODE=redis-down)",
  );
  test.setTimeout(300000);
  /*
   * Only what the call needs: an owner, a project and the Relay provider.
   * Discord and GitHub onboarding are not exercised here because the
   * Discord routes themselves refuse (503) while their rate limiter has no
   * Redis, which is not the relay's behaviour under test.
   */
  const page: Page = await (await browser.newContext()).newPage();
  const projectId: string = await registerAndCreateProject({
    page,
    projectNamePrefix: "CI watch relay redis-down",
  });
  const providerId: string = await createRelayProvider(page, projectId);

  const probe: { status: number; elapsedMs: number; text: string } =
    await testProvider(page, projectId, providerId);
  expect(probe.status, probe.text).toBe(400);
  expect(probe.text).toMatch(/redis|valkey|relay/i);
  expect(probe.elapsedMs, "a readable failure, not a hang").toBeLessThan(20000);

  const claim: RelayClaimResult = await relayClaim({ waitSeconds: 1 });
  expect([400, 503], claim.text).toContain(claim.status);
  expect(claim.elapsedMs).toBeLessThan(20000);
  await page.context().close();
});
