import AIService, {
  AI_CI_WATCH_FEATURE,
  AILogResponse,
  AutonomousBudgetStatus,
} from "../../Services/AIService";
import CiWatchConfigService from "../../Services/CiWatchConfigService";
import CiWorkflowEventService from "../../Services/CiWorkflowEventService";
import CiWorkflowService from "../../Services/CiWorkflowService";
import CodeRepositoryService from "../../Services/CodeRepositoryService";
import DiscordResourceThreadService from "../../Services/DiscordResourceThreadService";
import LlmProviderService from "../../Services/LlmProviderService";
import CiWatchConfig from "../../../Models/DatabaseModels/CiWatchConfig";
import CiWorkflow from "../../../Models/DatabaseModels/CiWorkflow";
import CiWorkflowEvent, {
  CiWorkflowEventType,
} from "../../../Models/DatabaseModels/CiWorkflowEvent";
import CodeRepository from "../../../Models/DatabaseModels/CodeRepository";
import DiscordResourceThread, {
  DiscordResourceThreadState,
  DiscordResourceType,
} from "../../../Models/DatabaseModels/DiscordResourceThread";
import LlmProvider from "../../../Models/DatabaseModels/LlmProvider";
import DatabaseCommonInteractionProps from "../../../Types/BaseDatabase/DatabaseCommonInteractionProps";
import SortOrder from "../../../Types/BaseDatabase/SortOrder";
import OneUptimeDate from "../../../Types/Date";
import BadDataException from "../../../Types/Exception/BadDataException";
import NotAuthorizedException from "../../../Types/Exception/NotAuthorizedException";
import ObjectID from "../../../Types/ObjectID";
import WorkspaceType from "../../../Types/Workspace/WorkspaceType";
import GitHubInstallationBinding from "../CodeRepository/GitHub/GitHubInstallationBinding";
import GlobalCache from "../../Infrastructure/GlobalCache";
import logger from "../Logger";
import CaptureSpan from "../Telemetry/CaptureSpan";
import { LLMMessage } from "../LLM/LLMService";
import CiLogScrubber from "./CiLogScrubber";
import CiWatchDecisionTable from "./CiWatchDecision";
import CiWatchNotifier, { CiWatchDiscordTarget } from "./CiWatchNotifier";
import CiWatchProcessor from "./CiWatchProcessor";
import GitHubActions, {
  GitHubActionsError,
  GitHubActionsJob,
  GitHubActionsRun,
  GitHubWorkflowFile,
} from "./GitHubActions";

/*
 * What the four alert buttons (and /astra, which maps to the same four) do.
 * Every action runs with the acting user's own database props, so the
 * model's access control is the permission check: an update on
 * CiWorkflowEvent / CiWorkflow needs EditCiWatch (or admin), a read needs
 * ReadCiWatch (or membership). A user the framework refuses gets a
 * NotAuthorizedException, which the Discord dispatcher shows ephemerally.
 */

const DEFAULT_MUTE_HOURS: number = 24;
const FILE_ISSUE_LEASE_NAMESPACE: string = "ci-watch-file-issue";
// Longer than the GitHub create call plus the thread follow-up.
const FILE_ISSUE_LEASE_SECONDS: number = 120;
const MAX_MUTE_HOURS: number = 24 * 30;
const RETIRE_HISTORY_RUNS: number = 30;
const RETIRE_LOG_LINES: number = 200;
const RETIRE_WORKFLOW_FILE_LIMIT: number = 6000;
const RETIRE_TIMEOUT_MS: number = 90_000;
const RETIRE_MAX_TOKENS: number = 900;

export interface CiWatchActionScope {
  projectId: ObjectID;
  userId: ObjectID;
  props: DatabaseCommonInteractionProps;
  // The Discord channel (thread) the action was taken in, when known.
  channelId?: string | undefined;
}

export interface CiWatchActionResult {
  // What to tell the acting user (shown ephemerally).
  reply: string;
}

interface LoadedEvent {
  event: CiWorkflowEvent;
  workflow: CiWorkflow;
  repository: CodeRepository;
  config: CiWatchConfig;
  installationId: string;
}

export default class CiWatchActions {
  /*
   * ---- File issue ----
   * One issue per event: a second press answers with the existing URL.
   */
  @CaptureSpan()
  public static async fileIssue(
    scope: CiWatchActionScope,
    eventId: ObjectID,
  ): Promise<CiWatchActionResult> {
    const loaded: LoadedEvent = await CiWatchActions.loadForEdit(
      scope,
      eventId,
    );

    if (loaded.event.issueUrl) {
      return {
        reply: `An issue already exists for this alert: ${loaded.event.issueUrl}`,
      };
    }

    /*
     * Two presses (or two people) at once both read "no issue yet". The lease
     * lets one file; the other is told to wait. With the cache down we file
     * anyway: a rare duplicate issue beats a button that does nothing.
     */
    const leaseToken: string = ObjectID.generate().toString();
    let leased: boolean = false;

    try {
      leased = await GlobalCache.setStringIfNotExists(
        FILE_ISSUE_LEASE_NAMESPACE,
        eventId.toString(),
        leaseToken,
        { expiresInSeconds: FILE_ISSUE_LEASE_SECONDS },
      );

      if (!leased) {
        return {
          reply:
            "An issue for this alert is being filed right now. Press again in a minute to get its link.",
        };
      }
    } catch (error) {
      logger.warn(`CI watch: file-issue lease unavailable: ${error}`);
    }

    try {
      return await CiWatchActions.fileIssueLeased(scope, eventId);
    } finally {
      if (leased) {
        try {
          await GlobalCache.deleteKeyIfValue(
            FILE_ISSUE_LEASE_NAMESPACE,
            eventId.toString(),
            leaseToken,
          );
        } catch (error) {
          logger.debug(
            `CI watch: could not release file-issue lease: ${error}`,
          );
        }
      }
    }
  }

  private static async fileIssueLeased(
    scope: CiWatchActionScope,
    eventId: ObjectID,
  ): Promise<CiWatchActionResult> {
    // Re-read under the lease: the holder before us may have just filed it.
    const loaded: LoadedEvent = await CiWatchActions.loadForRead(
      scope,
      eventId,
    );

    if (loaded.event.issueUrl) {
      return {
        reply: `An issue already exists for this alert: ${loaded.event.issueUrl}`,
      };
    }

    const label: string = CiWatchProcessor.repositoryLabel(loaded.repository);
    const title: string =
      `[CI] ${loaded.workflow.workflowName || "workflow"} failing on ${loaded.workflow.branchName || "main"}` +
      (loaded.event.firstFailingJob ? `: ${loaded.event.firstFailingJob}` : "");

    const body: string = [
      `The CI watch flagged **${loaded.workflow.workflowName || "workflow"}** on \`${loaded.workflow.branchName || "main"}\` in ${label}.`,
      "",
      `- Run: ${loaded.event.runUrl || "n/a"}`,
      `- Commit: ${loaded.event.headSha || "n/a"}`,
      `- Conclusion: ${loaded.event.conclusion || "n/a"}`,
      `- First failing job: ${loaded.event.firstFailingJob || "unknown"}`,
      `- Failure signature: \`${loaded.event.failureSignature || "n/a"}\``,
      "",
      "## Analysis",
      "",
      loaded.event.analysis || "No analysis was produced for this alert.",
      "",
      "_Filed from Discord through OneUptime CI watch._",
    ].join("\n");

    let issueUrl: string;

    try {
      issueUrl = await GitHubActions.createIssue({
        installationId: loaded.installationId,
        organizationName: loaded.repository.organizationName || "",
        repositoryName: loaded.repository.repositoryName || "",
        title: title.substring(0, 250),
        body: CiLogScrubber.scrub(body),
      });
    } catch (error) {
      const message: string =
        error instanceof GitHubActionsError
          ? `Could not file the issue in ${label}: ${error.message} The GitHub App needs "Issues: Read and write" on this repository.`
          : `Could not file the issue in ${label}: ${(error as Error).message}`;

      logger.error(`CI watch: ${message}`);
      await CiWatchActions.say(scope, loaded, message);

      return { reply: message };
    }

    await CiWorkflowEventService.updateOneBy({
      query: { _id: eventId.toString(), projectId: scope.projectId },
      data: { issueUrl, actedByUserId: scope.userId },
      props: scope.props,
    });

    await CiWatchActions.say(scope, loaded, `Issue filed: ${issueUrl}`);

    return { reply: `Issue filed: ${issueUrl}` };
  }

  /*
   * ---- Mark known-red ----
   * Forgives this alert's signature (a different signature still alerts) and
   * links the issue if one was filed.
   */
  @CaptureSpan()
  public static async markKnownRed(
    scope: CiWatchActionScope,
    eventId: ObjectID,
    reason?: string | undefined,
  ): Promise<CiWatchActionResult> {
    const loaded: LoadedEvent = await CiWatchActions.loadForEdit(
      scope,
      eventId,
    );

    const knownRedReason: string = (
      reason?.trim() || `Marked known-red from Discord`
    ).substring(0, 2000);

    await CiWorkflowService.updateOneBy({
      query: {
        _id: loaded.workflow.id!.toString(),
        projectId: scope.projectId,
      },
      data: {
        isKnownRed: true,
        knownRedReason,
        knownRedSignature: loaded.event.failureSignature as string,
        ...(loaded.event.issueUrl ? { ticketUrl: loaded.event.issueUrl } : {}),
      },
      props: scope.props,
    });

    const reply: string = `Marked **${loaded.workflow.workflowName || "workflow"}** known-red for signature \`${loaded.event.failureSignature || "any"}\`. It stays quiet until the failure changes or the workflow goes green.`;

    await CiWatchActions.say(scope, loaded, reply);

    return { reply };
  }

  // ---- Mute ----
  @CaptureSpan()
  public static async mute(
    scope: CiWatchActionScope,
    eventId: ObjectID,
    hours?: number | undefined,
  ): Promise<CiWatchActionResult> {
    const loaded: LoadedEvent = await CiWatchActions.loadForEdit(
      scope,
      eventId,
    );

    const duration: number = Math.min(
      Math.max(Math.round(hours || DEFAULT_MUTE_HOURS), 1),
      MAX_MUTE_HOURS,
    );
    const mutedUntil: Date = OneUptimeDate.addRemoveHours(
      OneUptimeDate.getCurrentDate(),
      duration,
    );

    await CiWorkflowService.updateOneBy({
      query: {
        _id: loaded.workflow.id!.toString(),
        projectId: scope.projectId,
      },
      data: { mutedUntil },
      props: scope.props,
    });

    const reply: string = `Muted **${loaded.workflow.workflowName || "workflow"}** for ${duration} h (until ${mutedUntil.toISOString()}). State keeps updating; nothing posts until then.`;

    await CiWatchActions.say(scope, loaded, reply);

    return { reply };
  }

  /*
   * ---- Can this test be retired? ----
   * In-process LLM call over read-only GitHub context: the failing job's log
   * tail, the workflow's recent run history, and the workflow file. Posts a
   * verdict with evidence into the thread. Opens no pull request.
   */
  @CaptureSpan()
  public static async assessRetire(
    scope: CiWatchActionScope,
    eventId: ObjectID,
  ): Promise<CiWatchActionResult> {
    const loaded: LoadedEvent = await CiWatchActions.loadForRead(
      scope,
      eventId,
    );

    const unavailable: string | null = await CiWatchActions.aiUnavailableReason(
      scope.projectId,
    );

    if (unavailable) {
      return { reply: `Cannot assess right now: ${unavailable}` };
    }

    const repository: {
      installationId: string;
      organizationName: string;
      repositoryName: string;
    } = {
      installationId: loaded.installationId,
      organizationName: loaded.repository.organizationName || "",
      repositoryName: loaded.repository.repositoryName || "",
    };

    const problems: Array<string> = [];
    let logTail: string = "";
    let history: string = "";
    let workflowFile: GitHubWorkflowFile | null = null;

    if (loaded.event.runId) {
      try {
        const jobs: Array<GitHubActionsJob> = await GitHubActions.listRunJobs({
          ...repository,
          runId: loaded.event.runId,
        });
        const failed: GitHubActionsJob | undefined = jobs.find(
          (job: GitHubActionsJob) => {
            return CiWatchDecisionTable.isFailure(job.conclusion);
          },
        );

        if (failed) {
          logTail = CiLogScrubber.tail(
            await GitHubActions.getJobLog({ ...repository, jobId: failed.id }),
            RETIRE_LOG_LINES,
          );
        }
      } catch (error) {
        problems.push(`job log unavailable (${(error as Error).message})`);
      }
    }

    try {
      const runs: Array<GitHubActionsRun> =
        await GitHubActions.listWorkflowRuns({
          ...repository,
          workflowId: loaded.workflow.gitHubWorkflowId || "",
          branchName: loaded.workflow.branchName || "main",
          perPage: RETIRE_HISTORY_RUNS,
        });

      history = runs
        .map((run: GitHubActionsRun) => {
          return `- ${run.completedAt ? run.completedAt.toISOString() : "?"}: ${run.conclusion || run.status} (${run.headSha.substring(0, 7)})`;
        })
        .join("\n");
    } catch (error) {
      problems.push(`run history unavailable (${(error as Error).message})`);
    }

    try {
      const path: string = await GitHubActions.getWorkflowPath({
        ...repository,
        workflowId: loaded.workflow.gitHubWorkflowId || "",
      });
      workflowFile = await GitHubActions.getFileContents({
        ...repository,
        path,
        ref: loaded.workflow.branchName || "main",
      });
    } catch (error) {
      problems.push(`workflow file unavailable (${(error as Error).message})`);
    }

    const messages: Array<LLMMessage> = [
      {
        role: "system",
        content:
          "You are astra, a CI reliability reviewer. A team asks whether a failing GitHub Actions workflow or the test it runs can be retired, skipped, or must be fixed. " +
          "You have read-only evidence: the failing job's log tail, the workflow's recent run history on its main branch, and the workflow file. " +
          "Answer in plain text with: a first line 'Verdict: retire' / 'Verdict: keep and fix' / 'Verdict: unclear'; then three to six bullet points of evidence, each citing a concrete line or run; then one line 'Recommendation:' with the single next step. " +
          "Never propose deleting a test without saying what coverage would be lost. Do not include secrets. No markdown headings.",
      },
      {
        role: "user",
        content:
          `Repository: ${CiWatchProcessor.repositoryLabel(loaded.repository)}\n` +
          `Workflow: ${loaded.workflow.workflowName || "workflow"} (branch ${loaded.workflow.branchName || "main"})\n` +
          `Known-red: ${loaded.workflow.isKnownRed ? `yes (${loaded.workflow.knownRedReason || "no reason recorded"})` : "no"}; flaky: ${loaded.workflow.isFlaky ? "yes" : "no"}\n` +
          `Latest alert: ${loaded.event.eventType} at ${loaded.event.runUrl || "n/a"}; first failing job: ${loaded.event.firstFailingJob || "unknown"}\n` +
          `Earlier analysis: ${loaded.event.analysis || "none"}\n` +
          (problems.length ? `Evidence gaps: ${problems.join("; ")}\n` : "") +
          `\nRecent runs (newest first):\n${history || "- unavailable"}\n\n` +
          `Workflow file${workflowFile ? ` (${workflowFile.path})` : ""}:\n\`\`\`yaml\n${workflowFile ? workflowFile.content.substring(0, RETIRE_WORKFLOW_FILE_LIMIT) : "(unavailable)"}\n\`\`\`\n\n` +
          `Failing job log tail:\n\`\`\`\n${logTail || "(unavailable)"}\n\`\`\``,
      },
    ];

    let verdict: string;

    try {
      const response: AILogResponse = await AIService.executeWithLogging({
        projectId: scope.projectId,
        userId: scope.userId,
        feature: AI_CI_WATCH_FEATURE,
        messages,
        maxTokens: RETIRE_MAX_TOKENS,
        temperature: 0.2,
        requestTimeoutInMs: RETIRE_TIMEOUT_MS,
        requestRetries: 0,
        protectRequestParameters: true,
        storeErrorDetails: false,
      });

      verdict = CiLogScrubber.scrub((response.content || "").trim());
    } catch (error) {
      logger.error(`CI watch: retire assessment failed: ${error}`);
      return {
        reply: "Cannot assess right now: the LLM call failed or timed out.",
      };
    }

    if (!verdict) {
      return { reply: "Cannot assess right now: the LLM returned nothing." };
    }

    const posted: string | null = await CiWatchActions.say(
      scope,
      loaded,
      `**Retire assessment for ${loaded.workflow.workflowName || "workflow"}**\n\n${verdict}`,
    );

    return {
      reply: posted
        ? "Assessment posted in the workflow thread."
        : `Assessment (could not post it in the thread):\n\n${verdict}`,
    };
  }

  // The newest alert for a workflow; /astra acts on it.
  @CaptureSpan()
  public static async latestEventForWorkflow(
    scope: CiWatchActionScope,
    workflowId: ObjectID,
  ): Promise<CiWorkflowEvent | null> {
    return await CiWorkflowEventService.findOneBy({
      query: {
        projectId: scope.projectId,
        ciWorkflowId: workflowId,
      },
      select: {
        _id: true,
        eventType: true,
        failureSignature: true,
        issueUrl: true,
        runUrl: true,
        createdAt: true,
      },
      sort: { createdAt: SortOrder.Descending },
      props: scope.props,
    });
  }

  // Why an LLM call cannot be made now, or null when it can.
  @CaptureSpan()
  public static async aiUnavailableReason(
    projectId: ObjectID,
  ): Promise<string | null> {
    if (!(await AIService.isProjectAIEnabled(projectId))) {
      return "AI is switched off for this project.";
    }

    try {
      const budget: AutonomousBudgetStatus =
        await AIService.getAutonomousDailyBudgetStatus(projectId);

      if (budget.exhausted) {
        return "the project's daily autonomous AI budget is exhausted.";
      }
    } catch (error) {
      return `the AI budget could not be read (${(error as Error).message}).`;
    }

    const provider: LlmProvider | null =
      await LlmProviderService.getLLMProviderForProject(projectId);

    if (!provider) {
      return "no LLM provider is configured for this project.";
    }

    return null;
  }

  /*
   * ---- Loading ----
   */

  // Read-scoped load: needs ReadCiWatch (or membership) on the event.
  private static async loadForRead(
    scope: CiWatchActionScope,
    eventId: ObjectID,
  ): Promise<LoadedEvent> {
    const event: CiWorkflowEvent | null =
      await CiWorkflowEventService.findOneBy({
        query: { _id: eventId.toString(), projectId: scope.projectId },
        select: {
          _id: true,
          projectId: true,
          ciWorkflowId: true,
          runId: true,
          runUrl: true,
          headSha: true,
          conclusion: true,
          eventType: true,
          failureSignature: true,
          firstFailingJob: true,
          analysis: true,
          analysisStatus: true,
          issueUrl: true,
        },
        props: scope.props,
      });

    if (!event) {
      throw new NotAuthorizedException(
        "This CI alert was not found in your project, or you do not have permission to read it.",
      );
    }

    if (
      !event.ciWorkflowId ||
      event.eventType === CiWorkflowEventType.MonitorFailure
    ) {
      throw new BadDataException(
        "This alert is not about a workflow, so there is nothing to act on.",
      );
    }

    const workflow: CiWorkflow | null = await CiWorkflowService.findOneBy({
      query: { _id: event.ciWorkflowId.toString(), projectId: scope.projectId },
      select: CiWatchProcessor.workflowColumns(),
      props: { isRoot: true },
    });

    if (!workflow?.codeRepositoryId) {
      throw new BadDataException("The workflow behind this alert is gone.");
    }

    const repository: CodeRepository | null =
      await CodeRepositoryService.findOneBy({
        query: {
          _id: workflow.codeRepositoryId.toString(),
          projectId: scope.projectId,
        },
        select: {
          _id: true,
          projectId: true,
          organizationName: true,
          repositoryName: true,
          mainBranchName: true,
          gitHubAppInstallationId: true,
        },
        props: { isRoot: true },
      });

    if (!repository?.gitHubAppInstallationId) {
      throw new BadDataException(
        "The repository behind this alert is no longer linked to GitHub.",
      );
    }

    // Fail closed: a repository row's installation must be the project's.
    await GitHubInstallationBinding.assertInstallationBoundToProject({
      projectId: scope.projectId,
      installationId: repository.gitHubAppInstallationId,
    });

    const config: CiWatchConfig | null =
      await CiWatchConfigService.getForProject(scope.projectId);

    if (!config) {
      throw new BadDataException(
        "CI watch is not configured for this project.",
      );
    }

    return {
      event,
      workflow,
      repository,
      config,
      installationId: repository.gitHubAppInstallationId,
    };
  }

  /*
   * Edit-scoped load: the read above, then a scoped write of actedByUserId
   * on the event. The write is the EditCiWatch check — the framework
   * refuses it for a member without the permission — and it doubles as the
   * audit trail of who pressed what.
   */
  private static async loadForEdit(
    scope: CiWatchActionScope,
    eventId: ObjectID,
  ): Promise<LoadedEvent> {
    const loaded: LoadedEvent = await CiWatchActions.loadForRead(
      scope,
      eventId,
    );

    const updated: number = await CiWorkflowEventService.updateOneBy({
      query: { _id: eventId.toString(), projectId: scope.projectId },
      data: { actedByUserId: scope.userId },
      props: scope.props,
    });

    if (!updated) {
      throw new NotAuthorizedException(
        "You do not have permission to act on CI alerts in this project.",
      );
    }

    return loaded;
  }

  /*
   * Post a follow-up in the workflow's thread. Prefers the thread the
   * button was pressed in; otherwise the thread on record. Returns the
   * message id or null (failure already logged by the notifier).
   */
  private static async say(
    scope: CiWatchActionScope,
    loaded: LoadedEvent,
    text: string,
  ): Promise<string | null> {
    const authToken: string | null = await CiWatchNotifier.getAuthToken(
      scope.projectId,
    );

    if (!authToken) {
      return null;
    }

    let threadId: string | undefined = scope.channelId;

    if (!threadId) {
      const row: DiscordResourceThread | null =
        await DiscordResourceThreadService.findOneBy({
          query: {
            projectId: scope.projectId,
            resourceType: DiscordResourceType.CiWorkflow,
            resourceId: loaded.workflow.id!,
            state: DiscordResourceThreadState.Active,
          },
          select: { threadId: true },
          props: { isRoot: true },
        });

      threadId = row?.threadId || undefined;
    }

    if (!threadId) {
      return null;
    }

    const target: CiWatchDiscordTarget = {
      authToken,
      channel: {
        id: threadId,
        name: threadId,
        workspaceType: WorkspaceType.Discord,
      },
    };

    return await CiWatchNotifier.postMarkdown({
      projectId: scope.projectId,
      target,
      text,
    });
  }
}
