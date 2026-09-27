import AIService, {
  AI_CI_WATCH_FEATURE,
  AILogResponse,
  AutonomousBudgetStatus,
} from "../../Services/AIService";
import LlmProviderService from "../../Services/LlmProviderService";
import CiWorkflowEvent, {
  CiAnalysisStatus,
} from "../../../Models/DatabaseModels/CiWorkflowEvent";
import LlmProvider from "../../../Models/DatabaseModels/LlmProvider";
import ObjectID from "../../../Types/ObjectID";
import logger from "../Logger";
import CaptureSpan from "../Telemetry/CaptureSpan";
import { LLMMessage } from "../LLM/LLMService";

/*
 * One constrained LLM call per alertable failure. Every way the call can
 * not happen (no provider, AI off, budget gone, provider error, timeout)
 * maps to an analysisStatus and a human-readable reason, and the caller
 * posts the alert regardless. The log tail arrives already scrubbed.
 */

const ANALYSIS_TIMEOUT_MS: number = 60_000;
const ANALYSIS_MAX_TOKENS: number = 600;

export interface CiWatchAnalysisInput {
  projectId: ObjectID;
  repository: string;
  workflowName: string;
  branchName: string;
  runUrl: string;
  conclusion: string;
  firstFailingJob: string;
  firstFailingStep: string;
  failureSignature: string;
  logTail: string;
  recentEvents: Array<CiWorkflowEvent>;
}

export interface CiWatchAnalysisResult {
  status: CiAnalysisStatus;
  // The analysis text when Done; otherwise why there is none.
  text: string;
}

export default class CiWatchAnalysis {
  @CaptureSpan()
  public static async analyze(
    input: CiWatchAnalysisInput,
  ): Promise<CiWatchAnalysisResult> {
    if (!(await AIService.isProjectAIEnabled(input.projectId))) {
      return {
        status: CiAnalysisStatus.Disabled,
        text: "AI is switched off for this project.",
      };
    }

    let budget: AutonomousBudgetStatus;

    try {
      budget = await AIService.getAutonomousDailyBudgetStatus(input.projectId);
    } catch (error) {
      logger.error(`CI watch: could not read the AI budget: ${error}`);
      return {
        status: CiAnalysisStatus.Failed,
        text: "the AI budget could not be read.",
      };
    }

    if (budget.exhausted) {
      return {
        status: CiAnalysisStatus.Disabled,
        text: "the project's daily autonomous AI budget is exhausted.",
      };
    }

    let provider: LlmProvider | null = null;

    try {
      provider = await LlmProviderService.getLLMProviderForProject(
        input.projectId,
      );
    } catch (error) {
      logger.error(`CI watch: could not read the LLM provider: ${error}`);
    }

    if (!provider) {
      return {
        status: CiAnalysisStatus.NoProvider,
        text: "no LLM provider is configured for this project.",
      };
    }

    try {
      const response: AILogResponse = await AIService.executeWithLogging({
        projectId: input.projectId,
        feature: AI_CI_WATCH_FEATURE,
        llmProviderId: provider.id || undefined,
        messages: CiWatchAnalysis.messages(input),
        maxTokens: ANALYSIS_MAX_TOKENS,
        temperature: 0.2,
        requestTimeoutInMs: ANALYSIS_TIMEOUT_MS,
        requestRetries: 0,
        protectRequestParameters: true,
        // The prompt carries log lines; never let a provider echo them into an error.
        storeErrorDetails: false,
      });

      const text: string = (response.content || "").trim();

      if (!text) {
        return {
          status: CiAnalysisStatus.Failed,
          text: "the LLM returned an empty answer.",
        };
      }

      return { status: CiAnalysisStatus.Done, text };
    } catch (error) {
      logger.error(`CI watch: LLM analysis failed: ${error}`);
      return {
        status: CiAnalysisStatus.Failed,
        text: "the LLM call failed or timed out.",
      };
    }
  }

  public static messages(input: CiWatchAnalysisInput): Array<LLMMessage> {
    const seenBefore: boolean = input.recentEvents.some(
      (event: CiWorkflowEvent) => {
        return (
          Boolean(event.failureSignature) &&
          event.failureSignature === input.failureSignature
        );
      },
    );

    const history: string = input.recentEvents.length
      ? input.recentEvents
          .map((event: CiWorkflowEvent) => {
            const when: string = event.createdAt
              ? new Date(event.createdAt).toISOString()
              : "unknown time";
            const summary: string = (event.analysis || "")
              .split("\n")[0]!
              .substring(0, 160);
            return `- ${when}: ${event.eventType} (signature ${event.failureSignature || "n/a"})${summary ? ` — ${summary}` : ""}`;
          })
          .join("\n")
      : "- none recorded";

    return [
      {
        role: "system",
        content:
          "You are a CI failure analyst for a software team. You read the tail of a failed GitHub Actions job log and the workflow's recent alert history, then write a short, concrete diagnosis for engineers reading a chat alert. " +
          "Answer in plain text with exactly three parts: (1) two to five sentences on what failed and the most likely cause, citing the log line that shows it; (2) one line starting with 'Seen before:' saying yes or no and when, based only on the history given; (3) one line starting with 'Next step:' with a single suggested action. " +
          "Do not speculate beyond the log. Do not include secrets or tokens. Do not use markdown headings.",
      },
      {
        role: "user",
        content:
          `Repository: ${input.repository}\n` +
          `Workflow: ${input.workflowName} (branch ${input.branchName})\n` +
          `Run: ${input.runUrl}\n` +
          `Conclusion: ${input.conclusion}\n` +
          `First failing job: ${input.firstFailingJob || "unknown"}\n` +
          `First failing step: ${input.firstFailingStep || "unknown"}\n` +
          `Failure signature: ${input.failureSignature}\n` +
          `Signature matches an earlier alert: ${seenBefore ? "yes" : "no"}\n\n` +
          `Recent alerts for this workflow (newest first):\n${history}\n\n` +
          `Last lines of the failing job log:\n\`\`\`\n${input.logTail || "(log unavailable)"}\n\`\`\``,
      },
    ];
  }
}
