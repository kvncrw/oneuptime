import GitHubUtil, {
  GitHubInstallationToken,
} from "../CodeRepository/GitHub/GitHub";
import HTTPErrorResponse from "../../../Types/API/HTTPErrorResponse";
import HTTPResponse from "../../../Types/API/HTTPResponse";
import Headers from "../../../Types/API/Headers";
import URL from "../../../Types/API/URL";
import { JSONArray, JSONObject } from "../../../Types/JSON";
import API from "../../../Utils/API";
import CaptureSpan from "../Telemetry/CaptureSpan";

/*
 * The GitHub REST calls the CI watch makes, and nothing else. Every call
 * mints its own short-lived installation token with only the permission it
 * needs, so a GitHub App that lacks "Actions: Read" or "Issues: Write" fails
 * here, loudly, and nowhere else.
 *
 * Base URLs are the literal https://api.github.com on purpose: the E2E
 * fixture intercepts that hostname.
 */

const REQUEST_TIMEOUT_MS: number = 30_000;
const MAX_LOG_BYTES: number = 5 * 1024 * 1024;

export interface GitHubRepositoryRef {
  installationId: string;
  organizationName: string;
  repositoryName: string;
}

export interface GitHubActionsRun {
  id: string;
  name: string;
  workflowId: string;
  headBranch: string;
  headSha: string;
  status: string;
  conclusion: string;
  htmlUrl: string;
  completedAt: Date | undefined;
}

export interface GitHubActionsJobStep {
  name: string;
  conclusion: string;
}

export interface GitHubActionsJob {
  id: string;
  name: string;
  conclusion: string;
  htmlUrl: string;
  steps: Array<GitHubActionsJobStep>;
}

export interface GitHubWorkflowFile {
  path: string;
  content: string;
}

/*
 * One error type for "GitHub did not give us a usable answer": a non-2xx, a
 * network failure, or a 2xx whose body is not the shape the endpoint
 * documents. The reconcile sweep treats every one of them the same way — as
 * a monitor failure, never as "all green".
 */
export class GitHubActionsError extends Error {
  public readonly statusCode: number | undefined;

  public constructor(message: string, statusCode?: number | undefined) {
    super(message);
    this.name = "GitHubActionsError";
    this.statusCode = statusCode;
  }
}

export default class GitHubActions {
  public static runFromPayload(raw: JSONObject): GitHubActionsRun | null {
    const id: unknown = raw["id"];
    const workflowId: unknown = raw["workflow_id"];

    if (
      (typeof id !== "number" && typeof id !== "string") ||
      (typeof workflowId !== "number" && typeof workflowId !== "string")
    ) {
      return null;
    }

    const completed: unknown = raw["updated_at"];
    const completedAt: Date | undefined =
      typeof completed === "string" && !isNaN(Date.parse(completed))
        ? new Date(completed)
        : undefined;

    return {
      id: String(id),
      name: String(raw["name"] || raw["display_title"] || "workflow"),
      workflowId: String(workflowId),
      headBranch: String(raw["head_branch"] || ""),
      headSha: String(raw["head_sha"] || ""),
      status: String(raw["status"] || ""),
      conclusion: String(raw["conclusion"] || ""),
      htmlUrl: String(raw["html_url"] || ""),
      completedAt,
    };
  }

  /*
   * Newest-first completed runs on one branch, across all workflows. 50 is
   * enough to see every workflow's newest run on a normally active branch.
   */
  @CaptureSpan()
  public static async listCompletedRuns(
    repository: GitHubRepositoryRef & { branchName: string },
  ): Promise<Array<GitHubActionsRun>> {
    const body: JSONObject = await GitHubActions.getJson({
      repository,
      path: `/actions/runs?branch=${encodeURIComponent(repository.branchName)}&status=completed&per_page=50`,
    });

    return GitHubActions.runsFromList(body);
  }

  // Recent runs of ONE workflow on one branch, newest first.
  @CaptureSpan()
  public static async listWorkflowRuns(
    repository: GitHubRepositoryRef & {
      branchName: string;
      workflowId: string;
      perPage: number;
    },
  ): Promise<Array<GitHubActionsRun>> {
    const body: JSONObject = await GitHubActions.getJson({
      repository,
      path: `/actions/workflows/${encodeURIComponent(repository.workflowId)}/runs?branch=${encodeURIComponent(repository.branchName)}&per_page=${repository.perPage}`,
    });

    return GitHubActions.runsFromList(body);
  }

  @CaptureSpan()
  public static async listRunJobs(
    repository: GitHubRepositoryRef & { runId: string },
  ): Promise<Array<GitHubActionsJob>> {
    const body: JSONObject = await GitHubActions.getJson({
      repository,
      path: `/actions/runs/${encodeURIComponent(repository.runId)}/jobs?per_page=100`,
    });

    const jobs: unknown = body["jobs"];

    if (!Array.isArray(jobs)) {
      throw new GitHubActionsError("GitHub jobs response had no jobs list.");
    }

    return (jobs as JSONArray).map((raw: unknown): GitHubActionsJob => {
      const job: JSONObject = raw as JSONObject;
      const steps: unknown = job["steps"];

      return {
        id: String(job["id"] || ""),
        name: String(job["name"] || ""),
        conclusion: String(job["conclusion"] || ""),
        htmlUrl: String(job["html_url"] || ""),
        steps: Array.isArray(steps)
          ? (steps as JSONArray).map((step: unknown): GitHubActionsJobStep => {
              return {
                name: String((step as JSONObject)["name"] || ""),
                conclusion: String((step as JSONObject)["conclusion"] || ""),
              };
            })
          : [],
      };
    });
  }

  /*
   * The raw log of one job. GitHub answers with a 302 to a signed blob URL;
   * the HTTP client follows it (and, being cross-host, drops our
   * Authorization header on the way). The E2E fixture answers the text
   * inline instead, so both a redirect and a direct body are accepted.
   */
  @CaptureSpan()
  public static async getJobLog(
    repository: GitHubRepositoryRef & { jobId: string },
  ): Promise<string> {
    const token: GitHubInstallationToken = await GitHubActions.token(
      repository,
      { actions: "read" },
    );

    const result: HTTPErrorResponse | HTTPResponse<JSONObject> = await API.get({
      url: URL.fromString(
        `https://api.github.com/repos/${repository.organizationName}/${repository.repositoryName}/actions/jobs/${encodeURIComponent(repository.jobId)}/logs`,
      ),
      headers: GitHubActions.headers(token.token),
      options: {
        timeout: REQUEST_TIMEOUT_MS,
        maxContentLength: MAX_LOG_BYTES,
      },
    });

    if (result instanceof HTTPErrorResponse) {
      throw new GitHubActionsError(
        `GitHub job log request failed (HTTP ${result.statusCode}).`,
        result.statusCode,
      );
    }

    return GitHubActions.textOf(result.data);
  }

  // The workflow's file path in the repository, e.g. ".github/workflows/ci.yml".
  @CaptureSpan()
  public static async getWorkflowPath(
    repository: GitHubRepositoryRef & { workflowId: string },
  ): Promise<string> {
    const body: JSONObject = await GitHubActions.getJson({
      repository,
      path: `/actions/workflows/${encodeURIComponent(repository.workflowId)}`,
    });

    const path: unknown = body["path"];

    if (typeof path !== "string" || !path) {
      throw new GitHubActionsError("GitHub workflow response had no path.");
    }

    return path;
  }

  // A file's decoded contents at a ref. Contents: Read.
  @CaptureSpan()
  public static async getFileContents(
    repository: GitHubRepositoryRef & { path: string; ref: string },
  ): Promise<GitHubWorkflowFile> {
    const encodedPath: string = repository.path
      .split("/")
      .map((segment: string) => {
        return encodeURIComponent(segment);
      })
      .join("/");

    const body: JSONObject = await GitHubActions.getJson({
      repository,
      path: `/contents/${encodedPath}?ref=${encodeURIComponent(repository.ref)}`,
      permissions: { contents: "read" },
    });

    const content: unknown = body["content"];
    const encoding: unknown = body["encoding"];

    if (typeof content !== "string") {
      throw new GitHubActionsError("GitHub contents response had no content.");
    }

    return {
      path: repository.path,
      content:
        encoding === "base64"
          ? Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8")
          : content,
    };
  }

  // Issues: Write. Returns the new issue's HTML URL.
  @CaptureSpan()
  public static async createIssue(
    repository: GitHubRepositoryRef & { title: string; body: string },
  ): Promise<string> {
    const token: GitHubInstallationToken = await GitHubActions.token(
      repository,
      { issues: "write" },
    );

    const result: HTTPErrorResponse | HTTPResponse<JSONObject> = await API.post(
      {
        url: URL.fromString(
          `https://api.github.com/repos/${repository.organizationName}/${repository.repositoryName}/issues`,
        ),
        data: { title: repository.title, body: repository.body },
        headers: GitHubActions.headers(token.token),
        options: { timeout: REQUEST_TIMEOUT_MS },
      },
    );

    if (result instanceof HTTPErrorResponse) {
      throw new GitHubActionsError(
        `GitHub refused to create the issue (HTTP ${result.statusCode}).`,
        result.statusCode,
      );
    }

    const url: unknown = (result.data as JSONObject)["html_url"];

    if (typeof url !== "string" || !url) {
      throw new GitHubActionsError("GitHub issue response had no html_url.");
    }

    return url;
  }

  private static runsFromList(body: JSONObject): Array<GitHubActionsRun> {
    const runs: unknown = body["workflow_runs"];

    if (!Array.isArray(runs)) {
      throw new GitHubActionsError(
        "GitHub runs response had no workflow_runs list.",
      );
    }

    return (runs as JSONArray)
      .map((raw: unknown) => {
        return GitHubActions.runFromPayload(raw as JSONObject);
      })
      .filter((run: GitHubActionsRun | null): run is GitHubActionsRun => {
        return run !== null;
      });
  }

  private static async token(
    repository: GitHubRepositoryRef,
    permissions: {
      actions?: "read";
      contents?: "read";
      issues?: "write";
    },
  ): Promise<GitHubInstallationToken> {
    try {
      return await GitHubUtil.getInstallationAccessToken(
        repository.installationId,
        { permissions: { ...permissions, metadata: "read" } },
      );
    } catch (error) {
      const statusCode: number | undefined =
        error instanceof HTTPErrorResponse ? error.statusCode : undefined;
      const wanted: string = Object.keys(permissions)
        .map((key: string) => {
          return `${key}: ${permissions[key as keyof typeof permissions]}`;
        })
        .join(", ");

      throw new GitHubActionsError(
        `Could not get a GitHub token with ${wanted}. Check the GitHub App's permissions${statusCode ? ` (HTTP ${statusCode})` : ""}.`,
        statusCode,
      );
    }
  }

  private static async getJson(data: {
    repository: GitHubRepositoryRef;
    path: string;
    permissions?: { contents?: "read" } | undefined;
  }): Promise<JSONObject> {
    const token: GitHubInstallationToken = await GitHubActions.token(
      data.repository,
      data.permissions || { actions: "read" },
    );

    let result: HTTPErrorResponse | HTTPResponse<JSONObject>;

    try {
      result = await API.get({
        url: URL.fromString(
          `https://api.github.com/repos/${data.repository.organizationName}/${data.repository.repositoryName}${data.path}`,
        ),
        headers: GitHubActions.headers(token.token),
        options: { timeout: REQUEST_TIMEOUT_MS },
      });
    } catch (error) {
      throw new GitHubActionsError(
        `GitHub request failed: ${(error as Error).message}`,
      );
    }

    if (result instanceof HTTPErrorResponse) {
      throw new GitHubActionsError(
        `GitHub answered HTTP ${result.statusCode} for ${data.path}.`,
        result.statusCode,
      );
    }

    const body: unknown = result.data;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new GitHubActionsError(
        `GitHub answered an empty body for ${data.path}.`,
      );
    }

    return body as JSONObject;
  }

  private static headers(token: string): Headers {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  /*
   * HTTPResponse wraps a plain-text body as { data: "<text>" }. A log served
   * as JSON (the fixture) or as raw text (GitHub's blob store) both land here.
   */
  private static textOf(data: unknown): string {
    if (typeof data === "string") {
      return data;
    }

    if (data && typeof data === "object" && !Array.isArray(data)) {
      const inner: unknown = (data as JSONObject)["data"];

      if (typeof inner === "string") {
        return inner;
      }

      if (Object.keys(data as JSONObject).length === 0) {
        return "";
      }

      return JSON.stringify(data);
    }

    return "";
  }
}
