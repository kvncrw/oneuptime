import BadDataException from "../../../../../Types/Exception/BadDataException";
import ObjectID from "../../../../../Types/ObjectID";
import CiWatchActions, {
  CiWatchActionResult,
  CiWatchActionScope,
} from "../../../CiWatch/CiWatchActions";
import CiWatchAstra from "../../../CiWatch/CiWatchAstra";
import {
  CI_ASSESS_RETIRE_ACTION,
  CI_FILE_ISSUE_ACTION,
  CI_MARK_KNOWN_RED_ACTION,
  CI_MUTE_ACTION,
} from "../../../CiWatch/CiWatchNotifier";
import {
  DiscordActionModuleRegistration,
  DiscordActionRequest,
  DiscordActionResult,
  DiscordCommandOptionType,
  DiscordHandlerResponseMode,
  DiscordInteractionKind,
} from "./Types";

/*
 * The CI watch's Discord surface: four buttons on every red alert and the
 * /astra slash command. All of it runs Deferred: filing an issue, an LLM
 * call, or three GitHub reads do not fit Discord's three-second window.
 *
 * The dispatcher has already resolved the linked OneUptime user and their
 * project membership by the time a handler runs; a Discord user with no
 * link is refused before this file is reached. Permission on the project
 * (EditCiWatch, ReadCiWatch) is enforced by the scoped database calls in
 * CiWatchActions.
 */

const ASTRA_COMMAND_ACTION: string = "CiAstra";

function scopeOf(request: DiscordActionRequest): CiWatchActionScope {
  return {
    projectId: request.context.projectId,
    userId: request.context.userId,
    props: request.context.props,
    channelId: request.context.channelId,
  };
}

function eventIdOf(request: DiscordActionRequest): ObjectID {
  if (
    !request.resourceId ||
    !ObjectID.isValidUUID(request.resourceId.toString())
  ) {
    throw new BadDataException("This CI alert button carries no alert id.");
  }

  return request.resourceId;
}

async function handleButton(
  request: DiscordActionRequest,
): Promise<DiscordActionResult> {
  const scope: CiWatchActionScope = scopeOf(request);
  const eventId: ObjectID = eventIdOf(request);
  let result: CiWatchActionResult;

  switch (request.action) {
    case CI_FILE_ISSUE_ACTION:
      result = await CiWatchActions.fileIssue(scope, eventId);
      break;
    case CI_ASSESS_RETIRE_ACTION:
      result = await CiWatchActions.assessRetire(scope, eventId);
      break;
    case CI_MARK_KNOWN_RED_ACTION:
      result = await CiWatchActions.markKnownRed(scope, eventId);
      break;
    case CI_MUTE_ACTION:
      result = await CiWatchActions.mute(scope, eventId);
      break;
    default:
      throw new BadDataException("This CI watch action is not supported.");
  }

  return { kind: "message", content: result.reply, ephemeral: true };
}

async function handleAstra(
  request: DiscordActionRequest,
): Promise<DiscordActionResult> {
  const result: CiWatchActionResult = await CiWatchAstra.handle({
    scope: scopeOf(request),
    request: request.values["request"] || "",
  });

  return { kind: "message", content: result.reply, ephemeral: true };
}

export const DiscordCiWatchActionModule: DiscordActionModuleRegistration = {
  handlers: [
    {
      actions: [
        CI_FILE_ISSUE_ACTION,
        CI_ASSESS_RETIRE_ACTION,
        CI_MARK_KNOWN_RED_ACTION,
        CI_MUTE_ACTION,
      ],
      interactionKinds: [DiscordInteractionKind.MessageComponent],
      responseMode: DiscordHandlerResponseMode.Deferred,
      handle: handleButton,
    },
    {
      actions: [ASTRA_COMMAND_ACTION],
      interactionKinds: [DiscordInteractionKind.ApplicationCommand],
      responseMode: DiscordHandlerResponseMode.Deferred,
      handle: handleAstra,
    },
  ],
  commands: [
    {
      name: "astra",
      description: "Ask the CI watch to act on or explain this workflow thread",
      action: ASTRA_COMMAND_ACTION,
      options: [
        {
          type: DiscordCommandOptionType.String,
          name: "request",
          description:
            "What to do or answer, e.g. file an issue about this failure",
          required: true,
        },
      ],
    },
  ],
};
