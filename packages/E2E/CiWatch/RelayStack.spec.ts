import { Browser, TestInfo, expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JSONish, toId } from "../Tests/Dashboard/Helpers/MonitorAlerting";
import {
  InteractionResult,
  PostedMessage,
  ProvisionedProject,
  RelayClaimResult,
  WorkflowRef,
  analysisStatuses,
  astraPayload,
  astraTimeoutMs,
  createRelayProvider,
  discordFixture,
  drainRelayQueue,
  failRun,
  finalReply,
  findWorkflow,
  interactionFollowUp,
  llmFixture,
  messageText,
  provisionProject,
  relayClaim,
  relayCompletion,
  relayResult,
  relayWorker,
  releaseProject,
  seedGreen,
  sendInteraction,
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
 *   RFM12  Redis (valkey) stopped while a Relay call is waiting
 *          (LLM_RELAY_E2E_MODE=redis-down; the runner stops the valkey container
 *          when the spec writes its marker file beside the evidence)
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

/*
 * RFM12 is "Redis lost while a Relay call is waiting". A Redis that is
 * already down never reaches the relay at all: signup and session refresh
 * take Redis mutexes and rate limits, every authenticated route loads the
 * permission cache from it, Discord interactions answer 503 from their rate
 * limiter, and CI watch takes its per-run leases there. So the spec starts a
 * Relay call on the healthy stack with the worker paused, then signals the
 * runner (a marker file beside the evidence) to stop valkey while the call is
 * blocked on its result key. The caller must come back with its readable
 * failure well before its own 45 s timeout.
 */
const stopRedisMarkerPath: string = join(
  dirname(
    process.env["CI_WATCH_E2E_OUTPUT"] ||
      "../../output/playwright/ci-watch/test-results",
  ),
  "relay-stop-redis.json",
);

test("RFM12 Redis lost mid-wait: the Relay call fails with a readable error, not a hang; the routes answer 503", async ({
  browser,
}: {
  browser: Browser;
}): Promise<void> => {
  test.skip(
    mode !== "redis-down",
    "needs a runner that stops valkey on the marker file (LLM_RELAY_E2E_MODE=redis-down)",
  );
  test.setTimeout(300000);
  project = await provisionProject(browser, {
    namePrefix: "CI watch relay redis-down",
  });
  await createRelayProvider(project.page, project.projectId);
  const workflow: WorkflowRef = uniqueWorkflow("rfm12");
  await seedGreen(project.page, project.projectId, workflow);
  await failRun(project.page, workflow, "rfm12");
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

  // Nobody may answer the job; it must sit on Redis when Redis goes away.
  await relayWorker.program({ enabled: false });
  await drainRelayQueue();
  const started: number = Date.now();
  const initial: InteractionResult = await sendInteraction(
    project.page,
    astraPayload("rfm12 what does this mean?", { channelId: threadId }),
  );
  expect(initial.type, "deferred while the relay waits").toBe(5);
  mkdirSync(dirname(stopRedisMarkerPath), { recursive: true });
  writeFileSync(
    stopRedisMarkerPath,
    JSON.stringify({ token: initial.token, sentAt: new Date().toISOString() }),
  );

  let reply: string = "";
  await expect
    .poll(
      async (): Promise<string> => {
        const message: PostedMessage | undefined = await interactionFollowUp(
          initial.token,
        );
        reply = message ? messageText(message) : "";
        return reply;
      },
      { timeout: astraTimeoutMs + 30000 },
    )
    .toMatch(/could not reach the LLM/i);
  const elapsedMs: number = Date.now() - started;
  expect(
    elapsedMs,
    "the lost connection surfaced well before the 45 s relay timeout",
  ).toBeLessThan(astraTimeoutMs - 5000);

  // The worker-facing routes say why, immediately.
  const claim: RelayClaimResult = await relayClaim({ waitSeconds: 5 });
  expect(claim.status, claim.text).toBe(503);
  expect(claim.text).toMatch(/redis/i);
  expect(claim.elapsedMs).toBeLessThan(5000);
  const result: { status: number; text: string } = await relayResult({
    id: randomUUID(),
    status: 200,
    json: relayCompletion("nobody home"),
  });
  expect(result.status, result.text).toBe(503);
  expect(result.text).toMatch(/redis/i);
});
