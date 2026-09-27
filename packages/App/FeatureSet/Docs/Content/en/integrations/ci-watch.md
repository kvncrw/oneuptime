# CI Watch

CI Watch follows GitHub Actions on your repositories' main branch and posts to Discord when a workflow starts failing, changes how it fails, or recovers. Each alert carries a short AI analysis and buttons your team can act on from Discord.

It needs the [GitHub App](/docs/self-hosted/github-integration) connected to your project and the [Discord integration](/docs/integrations/discord) installed in your server.

## What gets an alert

CI Watch keeps one record per workflow and compares each completed run on the watched branch with it.

| Situation | Result |
| --- | --- |
| A repository's first sweep | Every workflow is recorded. Nothing is posted, so connecting a repository never floods the channel with old failures. |
| A workflow fails, and it was passing or failed differently last time | Alert. |
| A workflow fails exactly as it did last time | Silent. |
| A workflow marked **known-red** fails the same way | Silent. |
| A known-red workflow fails in a new way | Alert: "failure changed". |
| A failing or known-red workflow passes | One recovery message. |
| A workflow marked **flaky** fails | Alert only on the second failure in a row. |
| A workflow is muted | Recorded, never posted, until the mute ends. |
| GitHub cannot be read for any repository in a sweep | One "monitor failure" warning per hour. CI state is unknown, not green. |

"Fails the same way" means the same failure signature: the first failing job and step plus the error lines of its log, with timestamps, IDs and numbers removed.

Cancelled and skipped runs, and runs on other branches, are ignored.

## How runs arrive

GitHub sends a `workflow_run` webhook when a run completes. A sweep also runs every ten minutes and reads the newest completed run of each workflow, so a lost webhook delays an alert by at most ten minutes instead of hiding it. A run already recorded is never processed twice.

## Set it up

1. Connect the GitHub App to your project. It needs **Actions: Read** and **Issues: Read and write** and the **Workflow run** event.
2. Install the Discord integration and choose the parent channel for CI alerts. Each workflow gets its own thread under that channel.
3. Create the CI Watch configuration for the project (API: `/api/ci-watch-config`) with `isEnabled: true` and `discordChannelId` set to the parent channel.
4. Run the first sweep now instead of waiting ten minutes: `POST /api/ci-watch/reconcile`.
5. Optional: configure an [LLM provider](/docs/ai/llm-provider) for the project. Without one, alerts still post, marked "No analysis".

## Acting on an alert

Every failure alert has four buttons. You need a linked Discord account and the **Edit CI Watch** permission (reading an assessment needs **Read CI Watch**).

| Button | What it does |
| --- | --- |
| **File issue** | Opens a GitHub issue in the repository with the run, commit, failing job and analysis. Pressing it again returns the same issue. The first issue filed becomes the workflow's ticket. |
| **Can this test be retired?** | Reads the failing job's log, the workflow file and the last 30 runs, and posts a verdict with its evidence in the thread. It does not change any code. |
| **Mark known-red** | Stops alerts for this failure signature. A different failure still alerts. |
| **Mute 24 h** | Stops all alerts for the workflow for 24 hours. |

### Asking in words

Inside a workflow's thread, use the slash command:

```text
/astra request: file an issue about this failure
/astra request: can we retire this test?
/astra request: why did this start failing?
```

The command maps the request to one of the four actions, or answers the question without acting. Outside a workflow thread it asks you to use it in one and does nothing else.

The bot receives slash commands and button presses only. It does not read ordinary chat messages, so a plain `@mention` gets no answer.

## Privacy

Before a log leaves OneUptime, for the LLM or for Discord, CI Watch removes common secret formats: GitHub tokens, API keys, AWS access keys, JWTs and bearer tokens. Treat this as a safety net. Keep secrets masked in your workflows.
