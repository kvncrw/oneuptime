import CiWorkflow, {
  CiWorkflowConclusion,
} from "../../../Models/DatabaseModels/CiWorkflow";
import { CiWorkflowEventType } from "../../../Models/DatabaseModels/CiWorkflowEvent";

/*
 * The decision table from the CI watch contract, as a pure function: given
 * the workflow's stored state and one newly completed run, what state to
 * write and whether to alert. Nothing here touches the database, GitHub or
 * Discord, so the table can be read (and tested) on its own.
 */

// Conclusions the watch treats as "red". Everything else completed is green.
const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set<string>([
  CiWorkflowConclusion.Failure,
  CiWorkflowConclusion.TimedOut,
  CiWorkflowConclusion.ActionRequired,
  CiWorkflowConclusion.StartupFailure,
]);

// Conclusions the watch does not react to at all.
const IGNORED_CONCLUSIONS: ReadonlySet<string> = new Set<string>([
  "cancelled",
  "skipped",
  "neutral",
  "stale",
]);

export interface CiRunObservation {
  runId: string;
  runUrl: string;
  conclusion: string;
  completedAt: Date | undefined;
  // Present only for a failed run whose signature could be computed.
  failureSignature: string | undefined;
}

export interface CiWorkflowStatePatch {
  lastConclusion: CiWorkflowConclusion;
  lastRunId: string;
  lastRunUrl: string;
  lastRunAt: Date;
  lastFailureSignature: string | null;
  consecutiveFailureCount: number;
}

export interface CiWatchDecision {
  // Why the run produced no alert, or "alert" when it did. For logs and tests.
  outcome:
    | "ignored-conclusion"
    | "already-recorded"
    | "seeded"
    | "older-run"
    | "muted"
    | "silent"
    | "alert";
  eventType: CiWorkflowEventType | null;
  patch: CiWorkflowStatePatch | null;
}

export default class CiWatchDecisionTable {
  public static isFailure(conclusion: string | undefined): boolean {
    return Boolean(conclusion) && FAILURE_CONCLUSIONS.has(conclusion!);
  }

  public static isIgnored(conclusion: string | undefined): boolean {
    return !conclusion || IGNORED_CONCLUSIONS.has(conclusion);
  }

  public static isActionable(conclusion: string | undefined): boolean {
    return (
      CiWatchDecisionTable.isFailure(conclusion) ||
      conclusion === CiWorkflowConclusion.Success
    );
  }

  /*
   * GitHub run ids only grow, so a smaller id is an older run: a late
   * webhook, or a sweep page read before a newer webhook landed.
   */
  public static isOlderRun(
    runId: string,
    lastRunId: string | undefined,
  ): boolean {
    if (!lastRunId || !(/^\d+$/).test(runId) || !(/^\d+$/).test(lastRunId)) {
      return false;
    }
    return BigInt(runId) < BigInt(lastRunId);
  }

  public static decide(data: {
    workflow: CiWorkflow | null;
    run: CiRunObservation;
    now: Date;
    /*
     * True once the repository has been swept before. Only a repository's
     * first sighting seeds silently; a workflow added later is new work and
     * its first failure alerts.
     */
    repositorySeeded: boolean;
  }): CiWatchDecision {
    const { workflow, run, now, repositorySeeded } = data;

    if (!CiWatchDecisionTable.isActionable(run.conclusion)) {
      return { outcome: "ignored-conclusion", eventType: null, patch: null };
    }

    const failed: boolean = CiWatchDecisionTable.isFailure(run.conclusion);
    const previousFailed: boolean = CiWatchDecisionTable.isFailure(
      workflow?.lastConclusion,
    );
    const previousCount: number = workflow?.consecutiveFailureCount || 0;

    const patch: CiWorkflowStatePatch = {
      lastConclusion: run.conclusion as CiWorkflowConclusion,
      lastRunId: run.runId,
      lastRunUrl: run.runUrl,
      lastRunAt: run.completedAt || now,
      lastFailureSignature: failed
        ? run.failureSignature || null
        : workflow?.lastFailureSignature || null,
      consecutiveFailureCount: failed
        ? previousFailed
          ? previousCount + 1
          : 1
        : 0,
    };

    if (!workflow) {
      // A new workflow in an already-watched repository alerts on its first failure.
      return repositorySeeded && failed
        ? { outcome: "alert", eventType: CiWorkflowEventType.NewFailure, patch }
        : { outcome: "seeded", eventType: null, patch };
    }

    if (workflow.lastRunId && workflow.lastRunId === run.runId) {
      // Webhook and sweep both saw it; whichever came second is a no-op.
      return { outcome: "already-recorded", eventType: null, patch: null };
    }

    if (CiWatchDecisionTable.isOlderRun(run.runId, workflow.lastRunId)) {
      return { outcome: "older-run", eventType: null, patch: null };
    }

    if (workflow.mutedUntil && workflow.mutedUntil.getTime() > now.getTime()) {
      return { outcome: "muted", eventType: null, patch };
    }

    if (!failed) {
      /*
       * Green after red posts one recovery. lastConclusion moves to success
       * with this patch, so the next green run is silent, known-red or not.
       */
      const recovered: boolean =
        previousFailed ||
        (Boolean(workflow.isKnownRed) &&
          workflow.lastConclusion !== CiWorkflowConclusion.Success);

      return recovered
        ? { outcome: "alert", eventType: CiWorkflowEventType.Recovered, patch }
        : { outcome: "silent", eventType: null, patch };
    }

    const signature: string | undefined = run.failureSignature;

    if (workflow.isKnownRed) {
      const forgiven: boolean =
        !workflow.knownRedSignature || workflow.knownRedSignature === signature;

      return forgiven
        ? { outcome: "silent", eventType: null, patch }
        : {
            outcome: "alert",
            eventType: CiWorkflowEventType.SignatureChanged,
            patch,
          };
    }

    if (workflow.isFlaky) {
      return patch.consecutiveFailureCount === 2
        ? { outcome: "alert", eventType: CiWorkflowEventType.NewFailure, patch }
        : { outcome: "silent", eventType: null, patch };
    }

    const changed: boolean =
      !previousFailed ||
      !workflow.lastFailureSignature ||
      workflow.lastFailureSignature !== signature;

    return changed
      ? { outcome: "alert", eventType: CiWorkflowEventType.NewFailure, patch }
      : { outcome: "silent", eventType: null, patch };
  }
}
