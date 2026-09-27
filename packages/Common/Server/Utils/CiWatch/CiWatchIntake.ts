import CiWatchConfig from "../../../Models/DatabaseModels/CiWatchConfig";
import CodeRepository from "../../../Models/DatabaseModels/CodeRepository";
import CodeRepositoryType from "../../../Types/CodeRepository/CodeRepositoryType";
import LIMIT_MAX from "../../../Types/Database/LimitMax";
import { JSONObject } from "../../../Types/JSON";
import ObjectID from "../../../Types/ObjectID";
import CiWatchConfigService from "../../Services/CiWatchConfigService";
import CodeRepositoryService from "../../Services/CodeRepositoryService";
import GitHubInstallationBinding from "../CodeRepository/GitHub/GitHubInstallationBinding";
import GitHubWebhookEvents, {
  GitHubWebhookRepository,
} from "../CodeRepository/GitHub/GitHubWebhookEvents";
import logger from "../Logger";
import CaptureSpan from "../Telemetry/CaptureSpan";
import CiWatchProcessor, {
  CiWatchProcessResult,
  CiWatchRepositoryContext,
} from "./CiWatchProcessor";
import GitHubActions, { GitHubActionsRun } from "./GitHubActions";

/*
 * The two ways a completed run reaches the processor: GitHub's workflow_run
 * webhook, and the ten-minute reconcile sweep that catches anything the
 * webhook missed. Both resolve "which project, which repository, which
 * branch" here and hand the run to CiWatchProcessor.processRun.
 */

const MAX_REPOSITORY_CANDIDATES: number = 20;

export interface CiWatchWebhookResult {
  handled: boolean;
  outcome: string;
}

export interface CiWatchReconcileSummary {
  projectId: ObjectID;
  repositories: number;
  failedRepositories: number;
  runsProcessed: number;
  alerts: number;
  monitorFailure: boolean;
}

const repositoryColumns: {
  _id: true;
  projectId: true;
  organizationName: true;
  repositoryName: true;
  mainBranchName: true;
  gitHubAppInstallationId: true;
  repositoryHostedAt: true;
} = {
  _id: true,
  projectId: true,
  organizationName: true,
  repositoryName: true,
  mainBranchName: true,
  gitHubAppInstallationId: true,
  repositoryHostedAt: true,
};

export default class CiWatchIntake {
  /*
   * workflow_run, action "completed". Matches repository.full_name against
   * linked CodeRepository rows for the delivering installation, keeps only
   * rows whose installation is really bound to their project, and processes
   * the run for every enabled project that has one.
   */
  @CaptureSpan()
  public static async handleWorkflowRunWebhook(
    payload: JSONObject,
  ): Promise<CiWatchWebhookResult> {
    if (GitHubWebhookEvents.getAction(payload) !== "completed") {
      return { handled: false, outcome: "action-not-completed" };
    }

    const repository: GitHubWebhookRepository | null =
      GitHubWebhookEvents.getRepository(payload);
    const installationId: string | null =
      GitHubWebhookEvents.getInstallationId(payload);
    const run: GitHubActionsRun | null = GitHubActions.runFromPayload(
      (payload["workflow_run"] as JSONObject) || {},
    );

    if (!repository || !installationId || !run) {
      return { handled: false, outcome: "unresolvable-context" };
    }

    const candidates: Array<CodeRepository> =
      await CodeRepositoryService.findBy({
        query: {
          organizationName: repository.organizationName,
          repositoryName: repository.repositoryName,
          gitHubAppInstallationId: installationId,
        },
        select: repositoryColumns,
        limit: MAX_REPOSITORY_CANDIDATES,
        skip: 0,
        props: { isRoot: true },
      });

    if (!candidates.length) {
      return { handled: false, outcome: "repository-not-linked" };
    }

    const outcomes: Array<string> = [];

    for (const candidate of candidates) {
      const context: CiWatchRepositoryContext | null =
        await CiWatchIntake.contextFor(candidate);

      if (!context) {
        continue;
      }

      const result: CiWatchProcessResult = await CiWatchProcessor.processRun({
        context,
        run,
      });

      outcomes.push(result.outcome);
    }

    if (!outcomes.length) {
      return { handled: false, outcome: "ci-watch-not-enabled" };
    }

    return {
      handled: outcomes.includes("alert"),
      outcome: outcomes.join(","),
    };
  }

  // Every enabled project, one after another. Never throws.
  @CaptureSpan()
  public static async reconcileAll(): Promise<Array<CiWatchReconcileSummary>> {
    const configs: Array<CiWatchConfig> = await CiWatchConfigService.findBy({
      query: { isEnabled: true },
      select: {
        _id: true,
        projectId: true,
        isEnabled: true,
        discordChannelId: true,
        branchName: true,
        issueTarget: true,
      },
      limit: LIMIT_MAX,
      skip: 0,
      props: { isRoot: true },
    });

    const summaries: Array<CiWatchReconcileSummary> = [];

    for (const config of configs) {
      try {
        summaries.push(await CiWatchIntake.reconcileProject(config));
      } catch (error) {
        logger.error(
          `CI watch: reconcile failed for project ${config.projectId?.toString()}: ${error}`,
        );
      }
    }

    return summaries;
  }

  /*
   * One project's sweep: the newest completed run per workflow on the
   * watched branch of every linked GitHub repository. A repository whose
   * runs cannot be read counts as failed; when every repository failed the
   * project gets a MonitorFailure (rate-limited to one per hour).
   */
  @CaptureSpan()
  public static async reconcileProject(
    config: CiWatchConfig,
  ): Promise<CiWatchReconcileSummary> {
    const projectId: ObjectID = config.projectId!;
    const summary: CiWatchReconcileSummary = {
      projectId,
      repositories: 0,
      failedRepositories: 0,
      runsProcessed: 0,
      alerts: 0,
      monitorFailure: false,
    };

    const boundInstallationId: string | null =
      await GitHubInstallationBinding.getBoundInstallationId(projectId);

    if (!boundInstallationId) {
      return summary;
    }

    const repositories: Array<CodeRepository> =
      await CodeRepositoryService.findBy({
        query: {
          projectId,
          gitHubAppInstallationId: boundInstallationId,
        },
        select: repositoryColumns,
        limit: LIMIT_MAX,
        skip: 0,
        props: { isRoot: true },
      });

    const reasons: Array<string> = [];

    for (const repository of repositories) {
      if (
        repository.repositoryHostedAt &&
        repository.repositoryHostedAt !== CodeRepositoryType.GitHub
      ) {
        continue;
      }

      summary.repositories++;

      const context: CiWatchRepositoryContext = {
        config,
        repository,
        installationId: boundInstallationId,
        branchName: CiWatchProcessor.branchFor({ config, repository }),
      };

      let runs: Array<GitHubActionsRun>;

      try {
        runs = await GitHubActions.listCompletedRuns({
          installationId: boundInstallationId,
          organizationName: repository.organizationName || "",
          repositoryName: repository.repositoryName || "",
          branchName: context.branchName,
        });
      } catch (error) {
        summary.failedRepositories++;
        reasons.push(
          `${CiWatchProcessor.repositoryLabel(repository)}: ${(error as Error).message}`,
        );
        continue;
      }

      for (const run of CiWatchIntake.newestPerWorkflow(runs)) {
        try {
          const result: CiWatchProcessResult =
            await CiWatchProcessor.processRun({ context, run });

          summary.runsProcessed++;

          if (result.outcome === "alert") {
            summary.alerts++;
          }
        } catch (error) {
          logger.error(
            `CI watch: processing run ${run.id} of ${CiWatchProcessor.repositoryLabel(repository)} failed: ${error}`,
          );
        }
      }
    }

    if (
      summary.repositories > 0 &&
      summary.failedRepositories === summary.repositories
    ) {
      summary.monitorFailure = Boolean(
        await CiWatchProcessor.reportMonitorFailure({
          config,
          reason: reasons.join("\n"),
        }),
      );
    }

    return summary;
  }

  /*
   * The list is newest-first per GitHub; keep the first run seen for each
   * workflow, and skip runs still in progress or with an ignored conclusion
   * so a cancelled re-run does not shadow the real newest result.
   */
  public static newestPerWorkflow(
    runs: Array<GitHubActionsRun>,
  ): Array<GitHubActionsRun> {
    const newest: Map<string, GitHubActionsRun> = new Map<
      string,
      GitHubActionsRun
    >();

    for (const run of runs) {
      if (run.status !== "completed" || !run.conclusion) {
        continue;
      }

      if (!newest.has(run.workflowId)) {
        newest.set(run.workflowId, run);
      }
    }

    return Array.from(newest.values());
  }

  /*
   * The processing context for a linked repository, or null when its
   * installation is not bound to its project or the project has no enabled
   * CI watch. The binding check is what stops a guessed installation id
   * from steering another tenant's watch.
   */
  private static async contextFor(
    repository: CodeRepository,
  ): Promise<CiWatchRepositoryContext | null> {
    if (!repository.projectId || !repository.gitHubAppInstallationId) {
      return null;
    }

    if (
      !(await GitHubInstallationBinding.isRepositoryInstallationBound(
        repository,
      ))
    ) {
      logger.warn(
        `CI watch: ignoring workflow_run for ${CiWatchProcessor.repositoryLabel(repository)}: installation ${repository.gitHubAppInstallationId} is not bound to project ${repository.projectId.toString()}.`,
      );
      return null;
    }

    const config: CiWatchConfig | null =
      await CiWatchConfigService.getForProject(repository.projectId);

    if (!config?.isEnabled) {
      return null;
    }

    return {
      config,
      repository,
      installationId: repository.gitHubAppInstallationId,
      branchName: CiWatchProcessor.branchFor({ config, repository }),
    };
  }
}
