import Express, {
  ExpressRequest,
  ExpressResponse,
  ExpressRouter,
} from "../Utils/Express";
import Response from "../Utils/Response";
import LlmRelay, {
  LLM_RELAY_MAX_CLAIM_WAIT_SECONDS,
} from "../Utils/LLM/LlmRelay";
import BadDataException from "../../Types/Exception/BadDataException";
import Exception from "../../Types/Exception/Exception";
import NotAuthenticatedException from "../../Types/Exception/NotAuthenticatedException";
import NotFoundException from "../../Types/Exception/NotFoundException";
import { JSONObject } from "../../Types/JSON";

/*
 * The worker side of the LLM relay (Utils/LLM/LlmRelay.ts). Both routes are
 * authenticated by the shared LLM_RELAY_TOKEN in x-llm-relay-token, not by a
 * user session: the worker is a headless process beside the model gateway.
 * With the token unset the routes do not exist (404), so an unconfigured
 * server exposes nothing to probe.
 */
export const LLM_RELAY_TOKEN_HEADER: string = "x-llm-relay-token";

export default class LlmRelayAPI {
  private static authorize(req: ExpressRequest): void {
    if (!LlmRelay.isEnabled()) {
      throw new NotFoundException("Not found.");
    }

    if (!LlmRelay.isTokenValid(req.headers[LLM_RELAY_TOKEN_HEADER])) {
      throw new NotAuthenticatedException("Invalid relay token.");
    }
  }

  public getRouter(): ExpressRouter {
    const router: ExpressRouter = Express.getRouter();

    /*
     * Long-poll for the next job. {waitSeconds} is clamped to 0..25 so the
     * request always returns inside the proxies' idle timeouts; an empty
     * queue answers 204 and the worker simply asks again.
     */
    router.post(
      "/llm-relay/claim",
      async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
        try {
          LlmRelayAPI.authorize(req);

          const body: JSONObject = (req.body || {}) as JSONObject;
          const requested: number = Number(body["waitSeconds"]);
          const waitSeconds: number = Number.isFinite(requested)
            ? requested
            : LLM_RELAY_MAX_CLAIM_WAIT_SECONDS;

          const job: { id: string; body: JSONObject } | null =
            await LlmRelay.claim(waitSeconds);

          if (!job) {
            res.status(204).end();
            return;
          }

          Response.sendJsonObjectResponse(req, res, {
            id: job.id,
            body: job.body,
          });
        } catch (error) {
          Response.sendErrorResponse(req, res, error as Exception);
        }
      },
    );

    /*
     * The model's raw answer for a claimed job: {status, json} as the worker
     * received them. Accepted even when nobody is waiting any more; the value
     * expires on its own.
     */
    router.post(
      "/llm-relay/result/:id",
      async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
        try {
          LlmRelayAPI.authorize(req);

          const id: string = String(req.params["id"] || "");
          const body: JSONObject = (req.body || {}) as JSONObject;
          const status: number = Number(body["status"]);
          const json: unknown = body["json"];

          if (!LlmRelay.isValidJobId(id)) {
            throw new BadDataException(`"${id}" is not a relay job id.`);
          }

          if (!Number.isInteger(status) || status < 100 || status > 599) {
            throw new BadDataException(
              "status must be the upstream HTTP status code (100-599).",
            );
          }

          if (!json || typeof json !== "object" || Array.isArray(json)) {
            throw new BadDataException(
              "json must be the upstream response body as a JSON object.",
            );
          }

          await LlmRelay.publishResult(id, {
            status,
            json: json as JSONObject,
          });

          Response.sendJsonObjectResponse(req, res, { accepted: true, id });
        } catch (error) {
          Response.sendErrorResponse(req, res, error as Exception);
        }
      },
    );

    return router;
  }
}
