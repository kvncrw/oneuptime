import CiWatchConfig from "../../../Models/DatabaseModels/CiWatchConfig";
import CiWorkflow from "../../../Models/DatabaseModels/CiWorkflow";
import CiWorkflowEvent, {
  CiAnalysisStatus,
  CiWorkflowEventType,
} from "../../../Models/DatabaseModels/CiWorkflowEvent";
import DiscordResourceThread, {
  DiscordResourceThreadState,
  DiscordResourceType,
} from "../../../Models/DatabaseModels/DiscordResourceThread";
import WorkspaceProjectAuthToken from "../../../Models/DatabaseModels/WorkspaceProjectAuthToken";
import { JSONObject } from "../../../Types/JSON";
import ObjectID from "../../../Types/ObjectID";
import {
  WorkspaceMessageBlock,
  WorkspaceMessagePayloadButton,
} from "../../../Types/Workspace/WorkspaceMessagePayload";
import WorkspaceType from "../../../Types/Workspace/WorkspaceType";
import DiscordResourceThreadService from "../../Services/DiscordResourceThreadService";
import WorkspaceProjectAuthTokenService from "../../Services/WorkspaceProjectAuthTokenService";
import logger from "../Logger";
import CaptureSpan from "../Telemetry/CaptureSpan";
import Discord from "../Workspace/Discord/Discord";
import DiscordMessageRenderer from "../Workspace/Discord/DiscordMessageRenderer";
import { WorkspaceChannel, WorkspaceThread } from "../Workspace/WorkspaceBase";

/*
 * Everything the CI watch says in Discord: the per-workflow thread, the alert
 * message with its four buttons, and follow-ups posted by the button
 * handlers. A post is retried once; a second failure is logged and the
 * caller carries on, because the state change that produced the alert has
 * already been written and must not be rolled back or re-done.
 */

export const CI_FILE_ISSUE_ACTION: string = "CiFileIssue";
export const CI_ASSESS_RETIRE_ACTION: string = "CiAssessRetire";
export const CI_MARK_KNOWN_RED_ACTION: string = "CiMarkKnownRed";
export const CI_MUTE_ACTION: string = "CiMute";

// Discord caps a thread name at 100 characters.
const THREAD_NAME_LIMIT: number = 100;
const ANALYSIS_CHARACTER_LIMIT: number = 1500;

export interface CiWatchDiscordTarget {
  authToken: string;
  channel: WorkspaceChannel;
}

export default class CiWatchNotifier {
  @CaptureSpan()
  public static async getAuthToken(
    projectId: ObjectID,
  ): Promise<string | null> {
    const auth: WorkspaceProjectAuthToken | null =
      await WorkspaceProjectAuthTokenService.getProjectAuth({
        projectId,
        workspaceType: WorkspaceType.Discord,
      });

    return auth?.authToken || null;
  }

  /*
   * The workflow's thread under the configured parent channel, creating it
   * on first use. Null when Discord is not connected, the parent channel is
   * not configured, or the thread service declined (ambiguous outcome,
   * stale installation) — the caller logs and moves on.
   */
  @CaptureSpan()
  public static async ensureWorkflowThread(data: {
    config: CiWatchConfig;
    workflow: CiWorkflow;
    repositoryLabel: string;
  }): Promise<CiWatchDiscordTarget | null> {
    if (!data.config.discordChannelId || !data.workflow.id) {
      return null;
    }

    const authToken: string | null = await CiWatchNotifier.getAuthToken(
      data.config.projectId!,
    );

    if (!authToken) {
      return null;
    }

    const channel: WorkspaceChannel | null =
      await DiscordResourceThreadService.ensureThread({
        projectId: data.config.projectId!,
        authToken,
        resource: {
          resourceType: DiscordResourceType.CiWorkflow,
          resourceId: data.workflow.id,
        },
        parentChannelId: data.config.discordChannelId,
        channelName:
          `${data.repositoryLabel} · ${data.workflow.workflowName || "workflow"}`
            .substring(0, THREAD_NAME_LIMIT)
            .trim(),
        isPrivate: false,
      });

    return channel ? { authToken, channel } : null;
  }

  // The parent channel itself, for alerts that belong to no workflow.
  @CaptureSpan()
  public static async parentChannel(
    config: CiWatchConfig,
  ): Promise<CiWatchDiscordTarget | null> {
    if (!config.discordChannelId) {
      return null;
    }

    const authToken: string | null = await CiWatchNotifier.getAuthToken(
      config.projectId!,
    );

    if (!authToken) {
      return null;
    }

    return {
      authToken,
      channel: {
        id: config.discordChannelId,
        name: config.discordChannelId,
        workspaceType: WorkspaceType.Discord,
      },
    };
  }

  /*
   * The CiWorkflow a Discord thread belongs to, or null when the channel is
   * not one of ours. Used by /astra to refuse outside a workflow thread.
   */
  @CaptureSpan()
  public static async workflowIdForThread(data: {
    projectId: ObjectID;
    threadId: string;
  }): Promise<ObjectID | null> {
    const row: DiscordResourceThread | null =
      await DiscordResourceThreadService.findOneBy({
        query: {
          projectId: data.projectId,
          threadId: data.threadId,
          resourceType: DiscordResourceType.CiWorkflow,
          state: DiscordResourceThreadState.Active,
        },
        select: { resourceId: true },
        props: { isRoot: true },
      });

    return row?.resourceId || null;
  }

  public static alertTitle(data: {
    repositoryLabel: string;
    workflowName: string;
    eventType: CiWorkflowEventType;
  }): string {
    const what: string = {
      [CiWorkflowEventType.NewFailure]: "failing",
      [CiWorkflowEventType.SignatureChanged]: "failing with a new signature",
      [CiWorkflowEventType.Recovered]: "recovered",
      [CiWorkflowEventType.MonitorFailure]: "monitor failure",
    }[data.eventType];

    return `${data.repositoryLabel} · ${data.workflowName} · ${what}`;
  }

  public static alertBlocks(data: {
    repositoryLabel: string;
    workflow: CiWorkflow;
    event: CiWorkflowEvent;
    // The analysis text or the reason there is none. Already scrubbed.
    analysisText: string;
  }): Array<WorkspaceMessageBlock> {
    const eventType: CiWorkflowEventType = data.event.eventType!;
    const lines: Array<string> = [];

    lines.push(
      `**Run:** ${data.event.runUrl || "(no run url)"}${data.event.headSha ? ` (\`${data.event.headSha.substring(0, 7)}\`)` : ""}`,
    );
    lines.push(`**Branch:** ${data.workflow.branchName || "?"}`);

    if (eventType !== CiWorkflowEventType.Recovered) {
      lines.push(`**Conclusion:** ${data.event.conclusion || "?"}`);
      lines.push(
        `**First failing job:** ${data.event.firstFailingJob || "unknown"}`,
      );
      lines.push(`**Signature:** \`${data.event.failureSignature || "n/a"}\``);

      if (data.event.analysisStatus === CiAnalysisStatus.Done) {
        lines.push("");
        lines.push(data.analysisText.substring(0, ANALYSIS_CHARACTER_LIMIT));
      } else {
        lines.push("");
        lines.push(`No analysis: ${data.analysisText}`);
      }
    }

    const blocks: Array<WorkspaceMessageBlock> = [
      {
        _type: "WorkspacePayloadHeader",
        text: CiWatchNotifier.alertTitle({
          repositoryLabel: data.repositoryLabel,
          workflowName: data.workflow.workflowName || "workflow",
          eventType,
        }),
      } as WorkspaceMessageBlock,
      {
        _type: "WorkspacePayloadMarkdown",
        text: lines.join("\n"),
      } as WorkspaceMessageBlock,
    ];

    if (eventType !== CiWorkflowEventType.Recovered && data.event.id) {
      blocks.push({
        _type: "WorkspacePayloadButtons",
        buttons: CiWatchNotifier.buttons(data.event.id),
      } as WorkspaceMessageBlock);
    }

    return blocks;
  }

  public static buttons(
    eventId: ObjectID,
  ): Array<WorkspaceMessagePayloadButton> {
    const value: string = eventId.toString();

    return [
      {
        _type: "WorkspaceMessagePayloadButton",
        title: "File issue",
        value,
        actionId: CI_FILE_ISSUE_ACTION,
      },
      {
        _type: "WorkspaceMessagePayloadButton",
        title: "Can this test be retired?",
        value,
        actionId: CI_ASSESS_RETIRE_ACTION,
      },
      {
        _type: "WorkspaceMessagePayloadButton",
        title: "Mark known-red",
        value,
        actionId: CI_MARK_KNOWN_RED_ACTION,
      },
      {
        _type: "WorkspaceMessagePayloadButton",
        title: "Mute 24 h",
        value,
        actionId: CI_MUTE_ACTION,
      },
    ];
  }

  /*
   * Post blocks to a channel or thread, retrying once. Returns the first
   * message id, or null when both attempts failed (already logged).
   */
  @CaptureSpan()
  public static async post(data: {
    projectId: ObjectID;
    target: CiWatchDiscordTarget;
    blocks: Array<WorkspaceMessageBlock>;
  }): Promise<string | null> {
    const rendered: Array<JSONObject> = DiscordMessageRenderer.render({
      messageBlocks: data.blocks,
    });

    let lastError: unknown = null;

    for (let attempt: number = 1; attempt <= 2; attempt++) {
      try {
        const thread: WorkspaceThread =
          await Discord.sendPayloadBlocksToChannel({
            authToken: data.target.authToken,
            workspaceChannel: data.target.channel,
            blocks: rendered,
            projectId: data.projectId,
          });

        return thread.threadId || null;
      } catch (error) {
        lastError = error;
        logger.warn(
          `CI watch: Discord post to ${data.target.channel.id} failed (attempt ${attempt} of 2): ${error}`,
        );
      }
    }

    logger.error(
      `CI watch: giving up posting to Discord channel ${data.target.channel.id}: ${lastError}`,
    );

    return null;
  }

  // A plain markdown follow-up in a thread, e.g. an issue link or a verdict.
  @CaptureSpan()
  public static async postMarkdown(data: {
    projectId: ObjectID;
    target: CiWatchDiscordTarget;
    text: string;
  }): Promise<string | null> {
    return await CiWatchNotifier.post({
      projectId: data.projectId,
      target: data.target,
      blocks: [
        {
          _type: "WorkspacePayloadMarkdown",
          text: data.text,
        } as WorkspaceMessageBlock,
      ],
    });
  }
}
