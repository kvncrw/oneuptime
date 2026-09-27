import AIService, {
  AI_CI_WATCH_FEATURE,
  AILogResponse,
} from "../../Services/AIService";
import CiWorkflowService from "../../Services/CiWorkflowService";
import CiWorkflow from "../../../Models/DatabaseModels/CiWorkflow";
import CiWorkflowEvent from "../../../Models/DatabaseModels/CiWorkflowEvent";
import { JSONObject } from "../../../Types/JSON";
import ObjectID from "../../../Types/ObjectID";
import logger from "../Logger";
import CaptureSpan from "../Telemetry/CaptureSpan";
import { LLMMessage, LLMToolCall, LLMToolDefinition } from "../LLM/LLMService";
import CiLogScrubber from "./CiLogScrubber";
import CiWatchActions, {
  CiWatchActionResult,
  CiWatchActionScope,
} from "./CiWatchActions";
import CiWatchNotifier from "./CiWatchNotifier";
import CiWatchProcessor from "./CiWatchProcessor";

/*
 * The /astra slash command: "astra file an issue about this failure",
 * "astra can we retire this test", "astra why is this red". Used inside a
 * workflow thread it resolves the workflow from the thread, then lets the
 * LLM choose one of the four alert actions (as tools) or answer in words.
 * Outside a workflow thread it asks for the thread and does nothing.
 */

const ASTRA_TIMEOUT_MS: number = 45_000;
const ASTRA_MAX_TOKENS: number = 500;
const MAX_REQUEST_CHARACTERS: number = 2000;

export const ASTRA_OUTSIDE_THREAD_REPLY: string =
  "Which workflow do you mean? Use /astra inside that workflow's CI alert thread and I will act on its latest alert.";

const TOOLS: Array<LLMToolDefinition> = [
  {
    name: "file_issue",
    description:
      "File a GitHub issue for the workflow's latest CI alert (or return the existing issue link).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "assess_retire",
    description:
      "Assess whether the failing workflow or test can be retired, using the job log, run history and workflow file. Posts a verdict in the thread.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "mark_known_red",
    description:
      "Mark the workflow known-red for its current failure signature so it stops alerting until the failure changes or it goes green.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why the workflow is expected to stay red.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mute",
    description:
      "Mute alerts for the workflow for a number of hours (default 24). State keeps updating.",
    inputSchema: {
      type: "object",
      properties: {
        hours: {
          type: "number",
          description: "How many hours to mute for. Default 24.",
        },
      },
      additionalProperties: false,
    },
  },
];

export default class CiWatchAstra {
  @CaptureSpan()
  public static async handle(data: {
    scope: CiWatchActionScope;
    request: string;
  }): Promise<CiWatchActionResult> {
    const request: string = (data.request || "")
      .trim()
      .substring(0, MAX_REQUEST_CHARACTERS);

    if (!request) {
      return {
        reply:
          "Tell me what you want: for example, /astra request: file an issue about this failure.",
      };
    }

    const workflowId: ObjectID | null = data.scope.channelId
      ? await CiWatchNotifier.workflowIdForThread({
          projectId: data.scope.projectId,
          threadId: data.scope.channelId,
        })
      : null;

    if (!workflowId) {
      return { reply: ASTRA_OUTSIDE_THREAD_REPLY };
    }

    const workflow: CiWorkflow | null = await CiWorkflowService.findOneBy({
      query: { _id: workflowId.toString(), projectId: data.scope.projectId },
      select: CiWatchProcessor.workflowColumns(),
      props: data.scope.props,
    });

    if (!workflow) {
      return { reply: ASTRA_OUTSIDE_THREAD_REPLY };
    }

    const latest: CiWorkflowEvent | null =
      await CiWatchActions.latestEventForWorkflow(data.scope, workflowId);

    const unavailable: string | null = await CiWatchActions.aiUnavailableReason(
      data.scope.projectId,
    );

    if (unavailable) {
      return {
        reply: `I cannot reason about requests right now: ${unavailable} Use the buttons on the alert instead.`,
      };
    }

    let response: AILogResponse;

    try {
      response = await AIService.executeWithLogging({
        projectId: data.scope.projectId,
        userId: data.scope.userId,
        feature: AI_CI_WATCH_FEATURE,
        messages: CiWatchAstra.messages({ workflow, latest, request }),
        tools: TOOLS,
        maxTokens: ASTRA_MAX_TOKENS,
        temperature: 0.1,
        requestTimeoutInMs: ASTRA_TIMEOUT_MS,
        requestRetries: 0,
        protectRequestParameters: true,
        storeErrorDetails: false,
      });
    } catch (error) {
      logger.error(`CI watch: /astra LLM call failed: ${error}`);
      return {
        reply:
          "I could not reach the LLM to understand that. Use the buttons on the alert, or try again in a minute.",
      };
    }

    const call: LLMToolCall | undefined = response.toolCalls?.[0];

    if (call && !call.argumentsParseError) {
      if (!latest?.id) {
        return {
          reply:
            "This workflow has no alert on record yet, so there is nothing to act on. Ask me again after its next alert.",
        };
      }

      return await CiWatchAstra.execute({
        scope: data.scope,
        eventId: latest.id,
        call,
      });
    }

    const answer: string = CiLogScrubber.scrub((response.content || "").trim());

    return {
      reply:
        answer ||
        "I did not find an action for that, and I have nothing to add. Try 'file an issue', 'can this be retired', 'mark known-red' or 'mute'.",
    };
  }

  private static async execute(data: {
    scope: CiWatchActionScope;
    eventId: ObjectID;
    call: LLMToolCall;
  }): Promise<CiWatchActionResult> {
    const args: JSONObject = data.call.arguments || {};

    switch (data.call.name) {
      case "file_issue":
        return await CiWatchActions.fileIssue(data.scope, data.eventId);
      case "assess_retire":
        return await CiWatchActions.assessRetire(data.scope, data.eventId);
      case "mark_known_red":
        return await CiWatchActions.markKnownRed(
          data.scope,
          data.eventId,
          typeof args["reason"] === "string" ? args["reason"] : undefined,
        );
      case "mute":
        return await CiWatchActions.mute(
          data.scope,
          data.eventId,
          typeof args["hours"] === "number" ? args["hours"] : undefined,
        );
      default:
        return {
          reply: `I picked an action I do not know how to run (${data.call.name}). Use the buttons on the alert.`,
        };
    }
  }

  private static messages(data: {
    workflow: CiWorkflow;
    latest: CiWorkflowEvent | null;
    request: string;
  }): Array<LLMMessage> {
    const state: string =
      `Workflow: ${data.workflow.workflowName || "workflow"} on ${data.workflow.branchName || "main"}\n` +
      `Last conclusion: ${data.workflow.lastConclusion || "unknown"}; consecutive failures: ${data.workflow.consecutiveFailureCount || 0}\n` +
      `Known-red: ${data.workflow.isKnownRed ? "yes" : "no"}; flaky: ${data.workflow.isFlaky ? "yes" : "no"}; muted until: ${data.workflow.mutedUntil ? data.workflow.mutedUntil.toISOString() : "not muted"}\n` +
      `Ticket: ${data.workflow.ticketUrl || "none"}\n` +
      (data.latest
        ? `Latest alert: ${data.latest.eventType} (signature ${data.latest.failureSignature || "n/a"}), run ${data.latest.runUrl || "n/a"}, issue ${data.latest.issueUrl || "none"}`
        : "Latest alert: none on record");

    return [
      {
        role: "system",
        content:
          "You are astra, the CI watch assistant in a team's Discord. The user is in the alert thread of one GitHub Actions workflow. " +
          "If the request asks you to DO one of the available things (file an issue, assess whether the test can be retired, mark the workflow known-red, mute it), call exactly one tool. " +
          "If the request is a question or a comment that maps to no tool, do not call a tool; answer briefly in plain text using only the state given. Never invent run results or log lines.",
      },
      {
        role: "user",
        content: `Current state:\n${state}\n\nRequest: ${data.request}`,
      },
    ];
  }
}
