import { createHash, timingSafeEqual } from "crypto";
import { LlmRelayToken } from "../../EnvironmentConfig";
import Redis, { ClientType } from "../../Infrastructure/Redis";
import BadDataException from "../../../Types/Exception/BadDataException";
import ServiceUnavailableException from "../../../Types/Exception/ServiceUnavailableException";
import { JSONObject } from "../../../Types/JSON";
import ObjectID from "../../../Types/ObjectID";
import logger from "../Logger";
import CaptureSpan from "../Telemetry/CaptureSpan";

/*
 * Transport for LlmType.Relay. The server cannot reach the model, so instead
 * of an HTTP POST the finished OpenAI chat-completions body goes onto a Redis
 * list and the caller blocks on a per-request result key. A worker that can
 * reach the model long-polls POST /api/llm-relay/claim, posts the body to the
 * model verbatim, and returns the raw answer on POST /api/llm-relay/result/:id.
 *
 * Keys:
 *   llm-relay:pending        RPUSH {id, body, expiresAt}; the claim route BLPOPs.
 *   llm-relay:result:<id>    RPUSH {status, json} + EXPIRE 120; the caller BLPOPs.
 *
 * Blocking commands run on a duplicated connection so they never stall the
 * shared client that the rest of the process depends on.
 */

export const LLM_RELAY_PENDING_KEY: string = "llm-relay:pending";
export const LLM_RELAY_RESULT_KEY_PREFIX: string = "llm-relay:result:";
export const LLM_RELAY_MAX_BODY_BYTES: number = 1024 * 1024;
export const LLM_RELAY_RESULT_TTL_SECONDS: number = 120;
export const LLM_RELAY_MAX_CLAIM_WAIT_SECONDS: number = 25;

export interface LlmRelayJob {
  id: string;
  body: JSONObject;
  // Unix ms. The caller has stopped waiting after this; do not send upstream.
  expiresAt: number;
}

export interface LlmRelayResult {
  // The upstream HTTP status. Anything outside 2xx is a provider error.
  status: number;
  // The upstream response body, untouched.
  json: JSONObject;
}

export default class LlmRelay {
  public static isEnabled(): boolean {
    return Boolean(LlmRelayToken);
  }

  /*
   * Constant time over fixed-length digests, so neither the token length nor
   * a matching prefix leaks through response timing.
   */
  public static isTokenValid(candidate: unknown): boolean {
    if (!LlmRelayToken || typeof candidate !== "string" || !candidate) {
      return false;
    }

    const expected: Buffer = createHash("sha256")
      .update(LlmRelayToken)
      .digest();
    const presented: Buffer = createHash("sha256").update(candidate).digest();

    return timingSafeEqual(expected, presented);
  }

  public static isValidJobId(id: string): boolean {
    return ObjectID.isValidUUID(id);
  }

  private static getClientOrThrow(): ClientType {
    const client: ClientType | null = Redis.getClient();

    if (!client || !Redis.isConnected()) {
      throw new ServiceUnavailableException(
        "LLM relay: Redis is not connected, so the request cannot be queued for the relay worker.",
      );
    }

    return client;
  }

  /*
   * A connection of its own for one blocking pop. Offline queueing stays on so
   * the first command opens the lazy connection; a single retry keeps a dead
   * Redis from turning into a hang, and the caller's own deadline timer is the
   * backstop for a pop that never returns.
   */
  private static openBlockingClient(shared: ClientType): ClientType {
    return shared.duplicate({
      lazyConnect: true,
      enableOfflineQueue: true,
      maxRetriesPerRequest: 1,
    });
  }

  private static closeQuietly(client: ClientType): void {
    try {
      client.disconnect();
    } catch {
      // Already closed.
    }
  }

  private static sleep(ms: number): Promise<null> {
    return new Promise((resolve: (value: null) => void): void => {
      setTimeout((): void => {
        resolve(null);
      }, ms);
    });
  }

  /**
   * Queue one completion request and wait for the worker's answer, up to
   * timeoutInMs. Throws a readable error when the relay is off, the body is
   * too large, Redis is down, or nobody answers in time.
   */
  @CaptureSpan()
  public static async enqueueAndWait(data: {
    body: JSONObject;
    timeoutInMs: number;
  }): Promise<LlmRelayResult> {
    if (!this.isEnabled()) {
      throw new BadDataException(
        "LLM relay is not configured on this server: set LLM_RELAY_TOKEN and run a relay worker before using a Relay provider.",
      );
    }

    const id: string = ObjectID.generate().toString();
    const expiresAt: number = Date.now() + data.timeoutInMs;
    const serialized: string = JSON.stringify({
      id,
      body: data.body,
      expiresAt,
    } as LlmRelayJob);
    const bytes: number = Buffer.byteLength(serialized, "utf8");

    if (bytes > LLM_RELAY_MAX_BODY_BYTES) {
      throw new BadDataException(
        `LLM relay request body is ${bytes} bytes; the limit is ${LLM_RELAY_MAX_BODY_BYTES} bytes (1 MB). Shorten the prompt or the provider's additional parameters.`,
      );
    }

    const client: ClientType = this.getClientOrThrow();
    const resultKey: string = `${LLM_RELAY_RESULT_KEY_PREFIX}${id}`;
    const waitSeconds: number = Math.max(1, Math.ceil(data.timeoutInMs / 1000));

    const blocking: ClientType = this.openBlockingClient(client);

    try {
      await client.rpush(LLM_RELAY_PENDING_KEY, serialized);

      /*
       * The BLPOP timeout is Redis-side; the sleep is the JS-side backstop
       * for a connection that drops mid-wait and re-queues the pop.
       */
      const popped: [string, string] | null = await Promise.race([
        blocking.blpop(resultKey, waitSeconds).catch((error: Error) => {
          logger.error(`LLM relay: waiting for result ${id} failed: ${error}`);
          return null;
        }),
        this.sleep(data.timeoutInMs + 2000),
      ]);

      if (!popped) {
        throw new BadDataException(
          `LLM relay did not answer within ${waitSeconds} s: no relay worker claimed the request, or it did not post a result in time.`,
        );
      }

      return this.parseResult(popped[1]);
    } finally {
      this.closeQuietly(blocking);
    }
  }

  private static parseResult(raw: string): LlmRelayResult {
    let parsed: JSONObject;

    try {
      parsed = JSON.parse(raw) as JSONObject;
    } catch {
      throw new BadDataException(
        "LLM relay: the worker posted a result that is not JSON.",
      );
    }

    const status: number = Number(parsed["status"]);
    const json: unknown = parsed["json"];

    if (
      !Number.isInteger(status) ||
      !json ||
      typeof json !== "object" ||
      Array.isArray(json)
    ) {
      throw new BadDataException(
        "LLM relay: the worker posted a malformed result (expected {status, json}).",
      );
    }

    return { status, json: json as JSONObject };
  }

  /**
   * Hand the oldest live job to a worker, waiting up to waitSeconds for one
   * to appear. Jobs whose caller has already given up are dropped here, so
   * they never cost a model call. Returns null when the queue stays empty.
   */
  @CaptureSpan()
  public static async claim(
    waitSeconds: number,
  ): Promise<{ id: string; body: JSONObject } | null> {
    const client: ClientType = this.getClientOrThrow();
    const boundedWait: number = Math.min(
      Math.max(Math.floor(waitSeconds), 0),
      LLM_RELAY_MAX_CLAIM_WAIT_SECONDS,
    );
    const deadline: number = Date.now() + boundedWait * 1000;
    const blocking: ClientType | null =
      boundedWait > 0 ? this.openBlockingClient(client) : null;

    try {
      for (;;) {
        const remainingMs: number = deadline - Date.now();
        let raw: string | null = null;

        if (remainingMs <= 0 || !blocking) {
          raw = await client.lpop(LLM_RELAY_PENDING_KEY);
        } else {
          const popped: [string, string] | null = await Promise.race([
            blocking
              .blpop(LLM_RELAY_PENDING_KEY, Math.ceil(remainingMs / 1000))
              .catch((error: Error) => {
                logger.error(`LLM relay: claim wait failed: ${error}`);
                return null;
              }),
            this.sleep(remainingMs + 2000),
          ]);
          raw = popped ? popped[1] : null;
        }

        if (raw === null) {
          return null;
        }

        const job: LlmRelayJob | null = this.parseJob(raw);

        if (!job) {
          continue;
        }

        if (job.expiresAt <= Date.now()) {
          logger.debug(
            `LLM relay: dropped job ${job.id}; its caller stopped waiting ${Date.now() - job.expiresAt} ms ago.`,
          );
          continue;
        }

        return { id: job.id, body: job.body };
      }
    } finally {
      if (blocking) {
        this.closeQuietly(blocking);
      }
    }
  }

  private static parseJob(raw: string): LlmRelayJob | null {
    try {
      const parsed: JSONObject = JSON.parse(raw) as JSONObject;
      const id: string = String(parsed["id"] || "");
      const expiresAt: number = Number(parsed["expiresAt"]);
      const body: unknown = parsed["body"];

      if (
        !this.isValidJobId(id) ||
        !Number.isFinite(expiresAt) ||
        !body ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        logger.error("LLM relay: discarded a malformed job from the queue.");
        return null;
      }

      return { id, body: body as JSONObject, expiresAt };
    } catch {
      logger.error("LLM relay: discarded a non-JSON job from the queue.");
      return null;
    }
  }

  /**
   * Store the worker's answer for the caller blocked on it. Unknown or
   * already-answered ids are accepted too: the value simply expires unread.
   */
  @CaptureSpan()
  public static async publishResult(
    id: string,
    result: LlmRelayResult,
  ): Promise<void> {
    if (!this.isValidJobId(id)) {
      throw new BadDataException(`"${id}" is not a relay job id.`);
    }

    const client: ClientType = this.getClientOrThrow();
    const resultKey: string = `${LLM_RELAY_RESULT_KEY_PREFIX}${id}`;

    await client
      .multi()
      .rpush(resultKey, JSON.stringify(result))
      .expire(resultKey, LLM_RELAY_RESULT_TTL_SECONDS)
      .exec();
  }
}
