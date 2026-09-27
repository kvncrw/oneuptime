# CI watch acceptance tests

Standard: googledev-style.

End-to-end acceptance suite for the CI watch feature (GitHub Actions failures
watched per project, alerted into Discord threads, actionable from Discord).
Written before the feature, from the contract in
`~/.buzz/PLANS/ONEUPTIME_CI_WATCH.md`. Every one of the plan's 22 failure
modes has at least one test named with its number.

The suite runs the real app, browser, API routes, PostgreSQL and Redis. Three
external services are replaced by disposable fixtures on the isolated Docker
network the Discord suite already uses:

| Host the app calls                               | Fixture                                                          | Programmable through                                         |
| ------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `https://discord.com`                            | `../Discord/Fixture/server.cjs`                                  | `/__fixture/scenario`, `/__fixture/state`                    |
| `https://api.github.com`, `https://github.com`   | `Fixture/github-server.cjs`                                      | `/__fixture/program`, `/__fixture/reset`, `/__fixture/state` |
| `http://llm-fixture:8089/v1` (OpenAI-compatible) | `Fixture/llm-server.cjs`                                         | `/__fixture/program`, `/__fixture/reset`, `/__fixture/state` |
| (the app's relay worker; it calls the app)       | `Fixture/llm-relay-worker.cjs` at `http://llm-relay-worker:8090` | `/__fixture/program`, `/__fixture/reset`, `/__fixture/state` |

Both HTTPS fixtures share the Discord fixture's disposable CA and server
certificate; `prepare-certificates.sh` adds `api.github.com`, `github.com` and
`github-fixture` to its SANs. The LLM fixture is plain HTTP because the base
URL is a per-project setting, not an impersonated host.

## Prerequisites

- The Discord fixture prepared and built (its `build` step regenerates the
  certificate with the GitHub names). A stack built before this suite existed
  must be rebuilt: `bash packages/E2E/Discord/Fixture/local-stack.sh build`.
- 20 GiB free under the Docker root; the launcher refuses otherwise.
- A committed revision: the app image freezes `git archive HEAD`. The CiWatch
  specs and this suite's Playwright config are bind-mounted, so editing a spec
  does not need a rebuild; server changes do.

## Run

From the repository root:

```bash
bash packages/E2E/Discord/Fixture/local-stack.sh prepare
bash packages/E2E/Discord/Fixture/local-stack.sh build
bash packages/E2E/CiWatch/Fixture/local-stack.sh prepare
bash packages/E2E/CiWatch/Fixture/local-stack.sh start
bash packages/E2E/CiWatch/Fixture/local-stack.sh test
```

`prepare` generates the GitHub App settings (`GITHUB_APP_ID`, `GITHUB_APP_NAME`,
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`
as base64 PEM of a throwaway RSA-2048 key, `GITHUB_APP_WEBHOOK_SECRET`), the
fixture control token and the relay token (`LLM_RELAY_TOKEN`) into
`.scratch/discord-e2e/config.env` (ignored, mode 600), copies `ci-watch.yml`
and `no-relay-token.yml` beside the Discord compose files, and re-runs the
Discord launcher's isolation check on the merged configuration. Public
identifiers live in `Fixture/identities.json`. Nothing secret is committed or
printed.

`start` brings up `app`, `ingress`, `discord-fixture`, `github-fixture`,
`llm-fixture` and `llm-relay-worker`; it re-creates the app container so it
receives the GitHub App environment and `LLM_RELAY_TOKEN`.

`test` accepts Playwright arguments, for example one failure mode:

```bash
bash packages/E2E/CiWatch/Fixture/local-stack.sh test --grep FM17
```

Reports land in the `oneuptime-discord-e2e_evidence` volume under
`ci-watch/` (HTML, JSON, traces, screenshots, fixture transcripts attached
per test). Stop with `bash packages/E2E/CiWatch/Fixture/local-stack.sh stop`;
volumes are retained.

Type-check without a stack (needs the E2E and Common dependencies installed):

```bash
npx tsc --noEmit -p packages/E2E
```

## What a test does

Every spec provisions its own owner and project (`Helpers.provisionProject`):
register, connect the Discord server and link the user (the Discord suite's
OAuth flows against the fixture), install the GitHub App the way the product
does (`GET /api/github/auth/install` redirects the browser to the `github.com`
fixture, which returns to `/api/github/auth/callback` with `installation_id`
and `code`; the app verifies the code, writes `Project.gitHubAppInstallationId`
and imports `ci-e2e/watched` and `ci-e2e/watched-two` as `CodeRepository`
rows), then creates a `CiWatchConfig` pointed at the fixture's incident
channel, and finally runs the repository's first reconcile sweep with one
green `baseline build` workflow. Only that first sweep seeds silently; from
then on a workflow nobody has seen before alerts on its first failure (FM06).
FM05 provisions its own unswept project to watch the seeding sweep itself.
Specs that need analysis also register the LLM fixture as the project's
default `OpenAICompatible` provider.

Each test then owns a unique workflow id and name, so no assertion depends on
state another test left behind (Playwright restarts the worker after a
failure, which resets `beforeAll` state). Failures arrive as signed
`workflow_run` webhooks (`x-hub-signature-256`, `x-github-delivery`) with jobs
and a log programmed on the GitHub fixture. Assertions read both the Discord
transcript (threads, messages, buttons, retries, interaction follow-ups) and
the persisted rows through `/api/ci-workflow`, `/api/ci-workflow-event`,
`/api/ci-watch-config` and `/api/discord-resource-thread`. "Exactly one" is
asserted by reaching the count and holding it through a quiet period. A
refusal is asserted as a clear reply plus unchanged rows plus an unchanged
outbound request count on the fixtures.

## Failure mode map

| FM                                | Spec                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| 1 to 5                            | `Intake.spec.ts`                                             |
| 6 to 9 (plus flaky and mute rows) | `Decision.spec.ts`                                           |
| 10, 11                            | `Reconcile.spec.ts`                                          |
| 12, 13, 22                        | `Analysis.spec.ts`                                           |
| 14, 21                            | `Delivery.spec.ts`                                           |
| 15 to 18                          | `Actions.spec.ts`                                            |
| 19, 20                            | `Astra.spec.ts`                                              |
| Relay RFM01, RFM03 to RFM11       | `Relay.spec.ts`                                              |
| Relay RFM02, RFM12                | `RelayStack.spec.ts` (needs a reconfigured stack, see below) |

## LLM relay

`~/.buzz/PLANS/ONEUPTIME_LLM_RELAY.md` adds `LlmType.Relay`: the built
OpenAI chat-completions body goes onto Redis (`llm-relay:pending`) and the
caller blocks on `llm-relay:result:<id>`; a worker claims with
`POST /api/llm-relay/claim` (`{waitSeconds <= 25}`, 204 when empty) and answers
with `POST /api/llm-relay/result/:id` (`{status, json}`), both under the
`x-llm-relay-token` header. The relay specs register a `Relay` provider
(model `fixture-model`, no base URL, no API key) and drive it through
`/astra`, alert analysis and the provider "test connection" route. The worker
fixture is paused (`relayWorker.program({enabled: false})`) wherever a spec
claims by hand; the pause returns only once no claim is in flight.

Two failure modes reconfigure the stack, so they are skipped in a normal run
and executed on their own:

```bash
# RFM02: app without LLM_RELAY_TOKEN
CI_WATCH_RELAY_TOKEN_UNSET=1 bash packages/E2E/CiWatch/Fixture/local-stack.sh start
LLM_RELAY_E2E_MODE=no-token bash packages/E2E/CiWatch/Fixture/local-stack.sh test --grep RFM02
bash packages/E2E/CiWatch/Fixture/local-stack.sh start

# RFM12: Redis stopped under a running app. Nothing can be provisioned without
# Redis (signup takes a Redis mutex, session refresh fails closed), so the prep
# half saves a signed-in session and a Relay provider first, and the probe half
# runs within the session JWT's 15 minutes with globalSetup skipped.
bash packages/E2E/CiWatch/Fixture/local-stack.sh test --grep "RFM12 prep"
docker stop <project>-valkey-1
LLM_RELAY_E2E_MODE=redis-down bash packages/E2E/CiWatch/Fixture/local-stack.sh test --grep "RFM12 Redis"
docker start <project>-valkey-1
```

Relay contract points the suite pins beyond the plan: a malformed result id is
refused with 400 (a well-formed unknown id is accepted with 200); `waitSeconds`
above 25 is clamped, not rejected; Relay providers require a model name; the
relay makes one attempt per request-adaptation step (no HTTP retry ladder).
RFM12 uses the provider test route only, because Discord interactions answer
503 while their rate limiter has no Redis.

## Contract points the server must meet

Beyond the plan's contract, the suite pins these:

- `POST /api/ci-watch/reconcile` with `projectid`/`tenantid` headers runs the
  reconcile sweep for that project synchronously and answers 2xx (4xx on a
  monitor failure is acceptable, never 5xx). Gate it on `EditCiWatch`. The
  plan only names the 10 minute worker; the tests cannot wait for it.
- `workflow_run` deliveries are covered by the existing `x-github-delivery`
  dedupe, and a run id equal to `lastRunId` is a no-op regardless of delivery id.
- Seeding is per repository, not per workflow: the first sweep of a
  repository records every workflow it finds without alerting; a workflow
  first seen after that alerts on its first failure. A first sighting that
  is green never alerts.
- Button `custom_id` is `<Action>:<CiWorkflowEvent id>` for `CiFileIssue`,
  `CiAssessRetire`, `CiMarkKnownRed`, `CiMute`; all four use the deferred
  response (`type: 5`) and complete by editing the original response
  (`PATCH /webhooks/{app}/{token}/messages/@original`), which the Discord
  fixture now records with `webhook_kind: "interaction"`.
- The slash command is `astra` with one string option `request`.
- `CiMute` mutes for 24 h and stamps `actedByUserId` on the event; `CiFileIssue`
  stores `issueUrl` on the event and `ticketUrl` on the workflow.
- Analysis is bounded: with a provider that never answers, the alert still
  posts within 120 s (`Analysis.spec.ts`, FM12 hang). Pass a short
  `requestTimeoutInMs` and no retries for the `CI Watch` feature.
- `analysisStatus` is `NoProvider` without a provider, `Failed` on a provider
  error or timeout, `Disabled` when `Project.enableAi` is false; the budget
  case accepts `Disabled` or `Failed`. The message says "No analysis" in each.
- The alert message names the repository (`owner/name`), the workflow, the run
  URL and the first failing job.
- A `MonitorFailure` event has no `ciWorkflowId`, and its Discord post mentions
  GitHub and CI.

## Fixture behaviours added for this suite

`Discord/Fixture/server.cjs` (additive; existing scenarios unchanged):
scenarios `second-user`, `message-post-fails-once`, `message-post-fails`; the
`PATCH .../messages/@original` route; the follow-up route's undefined
`identities` reference corrected to `ids`, and `webhook_kind: "interaction"`
stamped on both, which `Discord/ResponderActions.spec.ts` already filtered on.

`Fixture/github-server.cjs`: `/actions/jobs/{id}/logs` answers 200 text
directly where GitHub answers 302 to a blob URL, so a production client must
follow that redirect; the fixture does not exercise it.

## Evidence limits

A pass proves the app's contract against modeled GitHub, Discord and LLM
servers on an internal network. It does not prove GitHub's real webhook
signing, App installation UI, log redirect behaviour, or a live model.
