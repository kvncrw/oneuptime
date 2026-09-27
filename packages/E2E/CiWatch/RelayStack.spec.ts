import {
  Browser,
  BrowserContext,
  Page,
  TestInfo,
  expect,
  test,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
 *          (LLM_RELAY_E2E_MODE=redis-down; the runner stops the valkey container
 *          right after running the "RFM12 prep" test on the healthy stack)
 *
 * In any other run the reconfigured halves are reported as skipped, never as
 * passed.
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

/*
 * RFM12 runs in two halves because nothing can be provisioned without Redis:
 * signup takes a Redis mutex and the session refresh fails closed. The prep
 * half (healthy stack, run right before valkey is stopped so the 15 minute
 * session JWT is still fresh) registers an owner, a project and a Relay
 * provider and saves the signed-in browser state beside the evidence. The
 * probe half loads that state and makes the Relay call with Redis down.
 */
interface RedisDownState {
  projectId: string;
  providerId: string;
  savedAt: string;
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;
}

const redisDownStatePath: string = join(
  dirname(
    process.env["CI_WATCH_E2E_OUTPUT"] ||
      "../../output/playwright/ci-watch/test-results",
  ),
  "relay-redis-down.json",
);

test("RFM12 prep (healthy stack): save a signed-in session and a Relay provider for the redis-down probe", async ({
  browser,
}: {
  browser: Browser;
}): Promise<void> => {
  test.skip(
    mode === "redis-down",
    "prep needs Redis; the probe half runs in redis-down mode",
  );
  test.setTimeout(300000);
  const context: BrowserContext = await browser.newContext();
  const page: Page = await context.newPage();
  const projectId: string = await registerAndCreateProject({
    page,
    projectNamePrefix: "CI watch relay redis-down",
  });
  const providerId: string = await createRelayProvider(page, projectId);
  const state: RedisDownState = {
    projectId,
    providerId,
    savedAt: new Date().toISOString(),
    storageState: await context.storageState(),
  };
  mkdirSync(dirname(redisDownStatePath), { recursive: true });
  writeFileSync(redisDownStatePath, JSON.stringify(state));
  expect(existsSync(redisDownStatePath)).toBe(true);
  await context.close();
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
  expect(
    existsSync(redisDownStatePath),
    `run the "RFM12 prep" test on a healthy stack first (${redisDownStatePath})`,
  ).toBe(true);
  const state: RedisDownState = JSON.parse(
    readFileSync(redisDownStatePath, "utf8"),
  ) as RedisDownState;
  expect(
    Date.now() - new Date(state.savedAt).getTime(),
    "the saved session must be younger than its 15 minute JWT",
  ).toBeLessThan(14 * 60 * 1000);
  const context: BrowserContext = await browser.newContext({
    storageState: state.storageState,
  });
  const page: Page = await context.newPage();

  const probe: { status: number; elapsedMs: number; text: string } =
    await testProvider(page, state.projectId, state.providerId);
  expect(probe.status, probe.text).toBe(400);
  expect(probe.text).toMatch(/redis|valkey|relay/i);
  expect(probe.elapsedMs, "a readable failure, not a hang").toBeLessThan(20000);

  const claim: RelayClaimResult = await relayClaim({ waitSeconds: 1 });
  expect([400, 503], claim.text).toContain(claim.status);
  expect(claim.elapsedMs).toBeLessThan(20000);
  await context.close();
});
