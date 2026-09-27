import CiWatchConfig from "../../../Models/DatabaseModels/CiWatchConfig";
import CiWorkflow from "../../../Models/DatabaseModels/CiWorkflow";
import CiWorkflowEvent, {
  CiAnalysisStatus,
  CiWorkflowEventType,
} from "../../../Models/DatabaseModels/CiWorkflowEvent";
import CodeRepository from "../../../Models/DatabaseModels/CodeRepository";
import SortOrder from "../../../Types/BaseDatabase/SortOrder";
import ObjectID from "../../../Types/ObjectID";
import { WorkspaceMessageBlock } from "../../../Types/Workspace/WorkspaceMessagePayload";
import CiWorkflowEventService from "../../Services/CiWorkflowEventService";
import CiWorkflowService from "../../Services/CiWorkflowService";
import GlobalCache from "../../Infrastructure/GlobalCache";
import Select from "../../Types/Database/Select";
import logger from "../Logger";
import CaptureSpan from "../Telemetry/CaptureSpan";
import CiFailureSignature from "./CiFailureSignature";
import CiLogScrubber from "./CiLogScrubber";
import CiWatchAnalysis, { CiWatchAnalysisResult } from "./CiWatchAnalysis";
import CiWatchDecisionTable, { CiWatchDecision } from "./CiWatchDecision";
import CiWatchNotifier, { CiWatchDiscordTarget } from "./CiWatchNotifier";
import GitHubActions, {
  GitHubActionsJob,
  GitHubActionsRun,
} from "./GitHubActions";

/*
 * One completed run in, one decision out. Both intake routes (the
 * workflow_run webhook and the reconcile sweep) call processRun, which is
 * what makes them exactly-once together: a run id already stored as the
 * workflow's lastRunId is a no-op whichever route brings it second.
 *
 * Order of side effects on an alert, and why:
 *   1. the CiWorkflow state patch (the baseline moves first, so a crash or
 *      a Discord failure after this point can never produce a second alert
 *      for the same run);
 *   2. the CiWorkflowEvent row (the button ids need it);
 *   3. the LLM analysis (may be absent, never blocks the post);
 *   4. the Discord post (retried once inside the notifier; a failure is
 *      logged on the event row and nothing is rolled back).
 */

const LOG_TAIL_LINES: number = 200;
const RECENT_EVENT_LIMIT: number = 5;
const MONITOR_FAILURE_NAMESPACE: string = "ci-watch-monitor-failure";
const MONITOR_FAILURE_WINDOW_SECONDS: number = 60 * 60;

export interface CiWatchRepositoryContext {
  config: CiWatchConfig;
  repository: CodeRepository;
  installationId: string;
  branchName: string;
}

export interface CiWatchProcessResult {
  outcome: CiWatchDecision["outcome"] | "branch-not-watched";
  eventId?: ObjectID | undefined;
}

interface FailureDetails {
  firstFailingJob: string;
  firstFailingStep: string;
  logTail: string;
  signature: string;
}

export default class CiWatchProcessor {
  public static repositoryLabel(repository: CodeRepository): string {
    return `${repository.organizationName || "?"}/${repository.repositoryName || "?"}`;
  }

  // The branch a repository is watched on: its own main branch, else the config's.
  public static branchFor(data: {
    config: CiWatchConfig;
    repository: CodeRepository;
  }): string {
    return (
      data.repository.mainBranchName?.trim() ||
      data.config.branchName?.trim() ||
      "main"
    );
  }

  @CaptureSpan()
  public static async processRun(data: {
    context: CiWatchRepositoryContext;
    run: GitHubActionsRun;
  }): Promise<CiWatchProcessResult> {
    const { context, run } = data;
    const now: Date = new Date();

    if (CiWatchDecisionTable.isIgnored(run.conclusion)) {
      return { outcome: "ignored-conclusion" };
    }

    if (run.headBranch !== context.branchName) {
      return { outcome: "branch-not-watched" };
    }

    let workflow: CiWorkflow | null = await CiWorkflowService.findOneBy({
      query: {
        codeRepositoryId: context.repository.id!,
        gitHubWorkflowId: run.workflowId,
      },
      select: CiWatchProcessor.workflowColumns(),
      props: { isRoot: true },
    });

    if (workflow?.lastRunId && workflow.lastRunId === run.id) {
      return { outcome: "already-recorded" };
    }

    /*
     * Failure details cost three GitHub calls, so only a red run pays for
     * them. A seed row pays too: its signature is what keeps the next
     * identical failure silent.
     */
    const details: FailureDetails | null = CiWatchDecisionTable.isFailure(
      run.conclusion,
    )
      ? await CiWatchProcessor.failureDetails({ context, run })
      : null;

    const decision: CiWatchDecision = CiWatchDecisionTable.decide({
      workflow,
      run: {
        runId: run.id,
        runUrl: run.htmlUrl,
        conclusion: run.conclusion,
        completedAt: run.completedAt,
        failureSignature: details?.signature,
      },
      now,
    });

    if (!decision.patch) {
      return { outcome: decision.outcome };
    }

    if (workflow) {
      await CiWorkflowService.updateOneById({
        id: workflow.id!,
        data: {
          ...decision.patch,
          lastFailureSignature: decision.patch.lastFailureSignature as string,
        },
        props: { isRoot: true },
      });
      workflow = { ...workflow, ...decision.patch } as CiWorkflow;
      // null in the patch means "no signature"; the in-memory row mirrors the DB.
      workflow.lastFailureSignature = decision.patch
        .lastFailureSignature as string;
    } else {
      const seed: CiWorkflow = new CiWorkflow();
      seed.projectId = context.config.projectId!;
      seed.codeRepositoryId = context.repository.id!;
      seed.workflowName = (run.name || "workflow").substring(0, 100);
      seed.gitHubWorkflowId = run.workflowId;
      seed.branchName = context.branchName;
      seed.lastConclusion = decision.patch.lastConclusion;
      seed.lastRunId = decision.patch.lastRunId;
      seed.lastRunUrl = decision.patch.lastRunUrl;
      seed.lastRunAt = decision.patch.lastRunAt;
      if (decision.patch.lastFailureSignature) {
        seed.lastFailureSignature = decision.patch.lastFailureSignature;
      }
      seed.consecutiveFailureCount = decision.patch.consecutiveFailureCount;
      seed.isKnownRed = false;
      seed.isFlaky = false;

      workflow = await CiWorkflowService.create({
        data: seed,
        props: { isRoot: true },
      });
    }

    if (!decision.eventType) {
      return { outcome: decision.outcome };
    }

    const event: CiWorkflowEvent = await CiWatchProcessor.recordAndPostAlert({
      context,
      workflow,
      run,
      eventType: decision.eventType,
      details,
    });

    return { outcome: "alert", eventId: event.id || undefined };
  }

  /*
   * A sweep that could not read GitHub for any of a project's repositories
   * is a monitor failure: one warning per project per hour, never a silent
   * "all green". The hour fence lives in Redis; a cache outage means a
   * repeated warning, which is the better failure.
   */
  @CaptureSpan()
  public static async reportMonitorFailure(data: {
    config: CiWatchConfig;
    reason: string;
  }): Promise<CiWorkflowEvent | null> {
    const projectId: ObjectID = data.config.projectId!;
    let claimed: boolean = true;

    try {
      claimed = await GlobalCache.setStringIfNotExists(
        MONITOR_FAILURE_NAMESPACE,
        projectId.toString(),
        "1",
        { expiresInSeconds: MONITOR_FAILURE_WINDOW_SECONDS },
      );
    } catch (error) {
      logger.debug(`CI watch: monitor-failure fence unavailable: ${error}`);
    }

    if (!claimed) {
      return null;
    }

    const reason: string = CiLogScrubber.scrub(data.reason).substring(0, 1500);
    const event: CiWorkflowEvent = new CiWorkflowEvent();
    event.projectId = projectId;
    event.eventType = CiWorkflowEventType.MonitorFailure;
    event.analysis = reason;

    const saved: CiWorkflowEvent = await CiWorkflowEventService.create({
      data: event,
      props: { isRoot: true },
    });

    const target: CiWatchDiscordTarget | null =
      await CiWatchNotifier.parentChannel(data.config);

    if (target) {
      const messageId: string | null = await CiWatchNotifier.post({
        projectId,
        target,
        blocks: [
          {
            _type: "WorkspacePayloadHeader",
            text: "CI watch · monitor failure",
          } as WorkspaceMessageBlock,
          {
            _type: "WorkspacePayloadMarkdown",
            text:
              "The reconcile sweep could not read GitHub Actions for any linked repository, so this project's CI state is unknown, not green.\n\n" +
              `**Reason:** ${reason}`,
          } as WorkspaceMessageBlock,
        ],
      });

      await CiWatchProcessor.markPosted(saved, messageId);
    }

    return saved;
  }

  private static async recordAndPostAlert(data: {
    context: CiWatchRepositoryContext;
    workflow: CiWorkflow;
    run: GitHubActionsRun;
    eventType: CiWorkflowEventType;
    details: FailureDetails | null;
  }): Promise<CiWorkflowEvent> {
    const { context, workflow, run, eventType, details } = data;
    const projectId: ObjectID = context.config.projectId!;
    const repositoryLabel: string = CiWatchProcessor.repositoryLabel(
      context.repository,
    );

    const event: CiWorkflowEvent = new CiWorkflowEvent();
    event.projectId = projectId;
    event.ciWorkflowId = workflow.id!;
    event.runId = run.id;
    event.runUrl = run.htmlUrl;
    event.headSha = run.headSha;
    event.conclusion = run.conclusion;
    event.eventType = eventType;

    if (details) {
      event.failureSignature = details.signature;
      event.firstFailingJob = details.firstFailingJob.substring(0, 500);
    }

    let analysisText: string = "";

    if (eventType !== CiWorkflowEventType.Recovered && details) {
      const recentEvents: Array<CiWorkflowEvent> =
        await CiWorkflowEventService.findBy({
          query: { ciWorkflowId: workflow.id! },
          select: {
            _id: true,
            eventType: true,
            failureSignature: true,
            analysis: true,
            createdAt: true,
          },
          sort: { createdAt: SortOrder.Descending },
          limit: RECENT_EVENT_LIMIT,
          skip: 0,
          props: { isRoot: true },
        });

      const analysis: CiWatchAnalysisResult = await CiWatchAnalysis.analyze({
        projectId,
        repository: repositoryLabel,
        workflowName: workflow.workflowName || "workflow",
        branchName: workflow.branchName || context.branchName,
        runUrl: run.htmlUrl,
        conclusion: run.conclusion,
        firstFailingJob: details.firstFailingJob,
        firstFailingStep: details.firstFailingStep,
        failureSignature: details.signature,
        logTail: details.logTail,
        recentEvents,
      });

      // The model may quote the log; scrub its answer as if it were a log.
      analysisText = CiLogScrubber.scrub(analysis.text);
      event.analysisStatus = analysis.status;
      event.analysis =
        analysis.status === CiAnalysisStatus.Done
          ? analysisText
          : `No analysis: ${analysisText}`;
    }

    const saved: CiWorkflowEvent = await CiWorkflowEventService.create({
      data: event,
      props: { isRoot: true },
    });

    const target: CiWatchDiscordTarget | null =
      await CiWatchNotifier.ensureWorkflowThread({
        config: context.config,
        workflow,
        repositoryLabel,
      });

    if (!target) {
      logger.warn(
        `CI watch: no Discord thread for ${repositoryLabel} · ${workflow.workflowName}; alert ${saved.id?.toString()} recorded but not posted.`,
      );
      return saved;
    }

    const messageId: string | null = await CiWatchNotifier.post({
      projectId,
      target,
      blocks: CiWatchNotifier.alertBlocks({
        repositoryLabel,
        workflow,
        event: saved,
        analysisText,
      }),
    });

    await CiWatchProcessor.markPosted(saved, messageId);

    return saved;
  }

  private static async markPosted(
    event: CiWorkflowEvent,
    messageId: string | null,
  ): Promise<void> {
    if (!messageId || !event.id) {
      return;
    }

    await CiWorkflowEventService.updateOneById({
      id: event.id,
      data: { discordMessageId: messageId, postedAt: new Date() },
      props: { isRoot: true },
    });

    event.discordMessageId = messageId;
  }

  /*
   * First failed job, its first failed step, and the scrubbed tail of its
   * log. Any GitHub error here degrades to empty fields: the alert still
   * posts, and the signature is computed from whatever was available so a
   * retry of the same failure lands on the same signature.
   */
  @CaptureSpan()
  public static async failureDetails(data: {
    context: CiWatchRepositoryContext;
    run: GitHubActionsRun;
  }): Promise<FailureDetails> {
    const repository: {
      installationId: string;
      organizationName: string;
      repositoryName: string;
    } = {
      installationId: data.context.installationId,
      organizationName: data.context.repository.organizationName || "",
      repositoryName: data.context.repository.repositoryName || "",
    };

    let firstFailingJob: string = "";
    let firstFailingStep: string = "";
    let logTail: string = "";

    try {
      const jobs: Array<GitHubActionsJob> = await GitHubActions.listRunJobs({
        ...repository,
        runId: data.run.id,
      });

      const failedJob: GitHubActionsJob | undefined = jobs.find(
        (job: GitHubActionsJob) => {
          return CiWatchDecisionTable.isFailure(job.conclusion);
        },
      );

      if (failedJob) {
        firstFailingJob = failedJob.name;
        firstFailingStep =
          failedJob.steps.find((step: { conclusion: string }) => {
            return CiWatchDecisionTable.isFailure(step.conclusion);
          })?.name || "";

        const rawLog: string = await GitHubActions.getJobLog({
          ...repository,
          jobId: failedJob.id,
        });

        logTail = CiLogScrubber.tail(rawLog, LOG_TAIL_LINES);
      }
    } catch (error) {
      logger.warn(
        `CI watch: could not fetch failure details for run ${data.run.id} in ${repository.organizationName}/${repository.repositoryName}: ${error}`,
      );
    }

    return {
      firstFailingJob,
      firstFailingStep,
      logTail,
      signature: CiFailureSignature.compute({
        firstFailingJob,
        firstFailingStep,
        logTail,
      }),
    };
  }

  public static workflowColumns(): Select<CiWorkflow> {
    return {
      _id: true,
      projectId: true,
      codeRepositoryId: true,
      workflowName: true,
      gitHubWorkflowId: true,
      branchName: true,
      lastConclusion: true,
      lastRunId: true,
      lastRunUrl: true,
      lastRunAt: true,
      lastFailureSignature: true,
      consecutiveFailureCount: true,
      isKnownRed: true,
      knownRedReason: true,
      knownRedSignature: true,
      ticketUrl: true,
      isFlaky: true,
      mutedUntil: true,
    };
  }
}
