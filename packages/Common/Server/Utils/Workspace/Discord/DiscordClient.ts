import HTTPMethod from "../../../../Types/API/HTTPMethod";
import HTTPErrorResponse from "../../../../Types/API/HTTPErrorResponse";
import HTTPResponse from "../../../../Types/API/HTTPResponse";
import URL from "../../../../Types/API/URL";
import BadDataException from "../../../../Types/Exception/BadDataException";
import { JSONArray, JSONObject } from "../../../../Types/JSON";
import API from "../../../../Utils/API";

export class DiscordAPIError extends BadDataException {
  public readonly statusCode: number;
  public constructor(statusCode: number) {
    super(`Discord API request failed (HTTP ${statusCode}).`);
    this.statusCode = statusCode;
  }
}

/*
 * Thrown when the request left the process but no answer came back (socket
 * error, timeout). The remote side may have completed the operation, so a
 * caller that created something must treat the outcome as unknown rather
 * than retry. Distinguished by type because the generic BadDataException is
 * also what validation failures throw.
 */
export class DiscordAmbiguousOutcomeError extends BadDataException {
  public constructor() {
    super("Discord API transport failed; delivery is unknown.");
  }
}

export default class DiscordClient {
  public static readonly BASE_URL: string = "https://discord.com/api/v10";

  public static snowflake(value: string): string {
    const pattern: RegExp = /^[0-9]{17,20}$/;
    if (!pattern.test(value)) {
      throw new BadDataException("Invalid Discord identifier.");
    }
    return value;
  }

  public static async request(data: {
    authToken: string;
    method: HTTPMethod;
    path: string;
    body?: JSONObject | JSONArray;
    params?: { before?: string; limit?: string };
    /*
     * Opaque operation id recorded in the guild audit log as
     * "oneuptime:<uuid>". Only that shape is accepted so no title, user or
     * secret can leak into a log guild admins read.
     */
    auditLogReason?: string;
  }): Promise<JSONObject | JSONArray> {
    const pathPattern: RegExp = /^\/[a-z0-9_/@-]+(?:\?[a-z0-9_=&.-]+)?$/i;
    if (!data.authToken || !pathPattern.test(data.path)) {
      throw new BadDataException("Invalid Discord API request.");
    }
    const reasonPattern: RegExp =
      /^oneuptime:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (data.auditLogReason && !reasonPattern.test(data.auditLogReason)) {
      throw new BadDataException("Invalid Discord audit log reason.");
    }

    for (let attempt: number = 0; attempt < 3; attempt++) {
      let response: HTTPResponse<JSONObject | JSONArray> | HTTPErrorResponse;
      try {
        response = await API.fetch({
          method: data.method,
          url: URL.fromString(this.BASE_URL + data.path),
          ...(data.body ? { data: data.body } : {}),
          headers: {
            Authorization: `Bot ${data.authToken}`,
            ...(data.auditLogReason
              ? { "X-Audit-Log-Reason": data.auditLogReason }
              : {}),
          },
          ...(data.params ? { params: data.params } : {}),
          /*
           * Retrying an ambiguous network failure could duplicate a message or
           * channel. Only a definite rate-limit rejection is safe to retry here.
           */
          options: { retries: 0, timeout: 10_000, doNotFollowRedirects: true },
        });
      } catch {
        throw new DiscordAmbiguousOutcomeError();
      }

      if (response.statusCode === 429 && attempt < 2) {
        const retryAfter: unknown = (response.data as JSONObject)[
          "retry_after"
        ];
        if (
          typeof retryAfter === "number" &&
          Number.isFinite(retryAfter) &&
          retryAfter >= 0 &&
          retryAfter <= 10
        ) {
          await new Promise<void>((resolve: () => void): void => {
            setTimeout(resolve, Math.ceil(retryAfter * 1000));
          });
          continue;
        }
      }
      if (response instanceof HTTPErrorResponse || response.statusCode >= 300) {
        // Do not propagate request headers, tokens or message bodies into logs.
        throw new DiscordAPIError(response.statusCode);
      }
      return response.data;
    }
    throw new BadDataException("Discord rate limit exceeded.");
  }

  public static async sendMessage(data: {
    authToken: string;
    channelId: string;
    message: JSONObject;
  }): Promise<string> {
    const response: JSONObject = (await this.request({
      authToken: data.authToken,
      method: HTTPMethod.POST,
      path: `/channels/${this.snowflake(data.channelId)}/messages`,
      body: data.message,
    })) as JSONObject;
    return this.snowflake(String(response["id"] || ""));
  }

  public static async openDirectMessage(data: {
    authToken: string;
    userId: string;
  }): Promise<string> {
    const response: JSONObject = (await this.request({
      authToken: data.authToken,
      method: HTTPMethod.POST,
      path: "/users/@me/channels",
      body: { recipient_id: this.snowflake(data.userId) },
    })) as JSONObject;
    return this.snowflake(String(response["id"] || ""));
  }

  public static encodePathSegment(value: string): string {
    if (!value || value.length > 1024) {
      throw new BadDataException("Invalid Discord path segment.");
    }
    return encodeURIComponent(value);
  }
  /*
   * One page of the users who reacted with a given emoji. type=0 is the
   * normal reaction type (not super-reactions), and limit=100 is the API
   * maximum. Reaction users carry no timestamps, so there is no "after" to
   * page past a user already seen.
   */
  public static async getChannelReactions(data: {
    authToken: string;
    channelId: string;
    messageId: string;
    emoji: string;
    after?: string;
  }): Promise<JSONArray> {
    const emojiPath: string = this.encodePathSegment(data.emoji);
    const afterQuery: string = data.after
      ? `&after=${this.snowflake(data.after)}`
      : "";
    return (await this.request({
      authToken: data.authToken,
      method: HTTPMethod.GET,
      path: `/channels/${this.snowflake(data.channelId)}/messages/${this.snowflake(
        data.messageId,
      )}/reactions/${emojiPath}?limit=100&type=0${afterQuery}`,
    })) as JSONArray;
  }

  /*
   * The most recent channel messages, newest first, with their reaction
   * summaries. limit=100 is the API maximum; callers bound it further and
   * may pass `before` to walk pages.
   */
  public static async getChannelMessages(data: {
    authToken: string;
    channelId: string;
    limit?: number;
    before?: string;
  }): Promise<JSONArray> {
    const limit: number = data.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadDataException("Discord message limit must be 1–100.");
    }
    const query: string = `?limit=${limit}${
      data.before ? `&before=${this.snowflake(data.before)}` : ""
    }`;
    return (await this.request({
      authToken: data.authToken,
      method: HTTPMethod.GET,
      path: `/channels/${this.snowflake(data.channelId)}/messages${query}`,
    })) as JSONArray;
  }

  /*
   * Posts a reply in the message's thread (or the channel itself for a
   * top-level message). Used for note confirmations and permission replies.
   */
  public static async replyToMessage(data: {
    authToken: string;
    channelId: string;
    messageId: string;
    content: string;
  }): Promise<string> {
    const response: JSONObject = (await this.request({
      authToken: data.authToken,
      method: HTTPMethod.POST,
      path: `/channels/${this.snowflake(data.channelId)}/messages`,
      body: {
        content: data.content,
        message_reference: { message_id: this.snowflake(data.messageId) },
        allowed_mentions: { parse: [] },
      },
    })) as JSONObject;
    return this.snowflake(String(response["id"] || ""));
  }

  /*
   * One channel message, used to read a pinned message's text. 404s throw
   * DiscordAPIError with the status code attached.
   */
  public static async getChannelMessage(data: {
    authToken: string;
    channelId: string;
    messageId: string;
  }): Promise<JSONObject> {
    return (await this.request({
      authToken: data.authToken,
      method: HTTPMethod.GET,
      path: `/channels/${this.snowflake(data.channelId)}/messages/${this.snowflake(
        data.messageId,
      )}`,
    })) as JSONObject;
  }

  /*
   * The guild audit log, filtered to one action type (MESSAGE_PIN for pin
   * attribution). Requires VIEW_AUDIT_LOG; a missing permission surfaces as
   * DiscordAPIError(403), which callers treat as "pin capture disabled".
   */
  public static async getGuildAuditLog(data: {
    authToken: string;
    guildId: string;
    actionType: number;
    limit?: number;
  }): Promise<JSONObject> {
    const limit: number = data.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadDataException("Discord audit log limit must be 1–100.");
    }
    return (await this.request({
      authToken: data.authToken,
      method: HTTPMethod.GET,
      path: `/guilds/${this.snowflake(
        data.guildId,
      )}/audit-logs?action_type=${data.actionType}&limit=${limit}`,
    })) as JSONObject;
  }
}
