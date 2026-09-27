/*
 * Secret scrubbing for CI job logs before they are stored, sent to an LLM,
 * or posted to Discord. GitHub masks registered secrets as "***", but a token
 * echoed by a build step, printed by a debug line, or pasted into a test
 * fixture is not registered anywhere and arrives in plain text.
 *
 * The patterns are the contract's list, applied in order. Anything matched is
 * replaced with a fixed marker rather than a partial reveal.
 */

const REDACTED: string = "[redacted]";

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ and fine-grained PATs.
  /gh[pousr]_\w+/g,
  /github_pat_\w+/g,
  // OpenAI-style keys.
  /sk-[\w-]{20,}/g,
  // Slack tokens.
  /xox[abp]-[\w-]+/g,
  // AWS access key ids.
  /AKIA[0-9A-Z]{16}/g,
  // JWTs.
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  // Bearer credentials of any shape.
  /Bearer \S+/g,
];

export default class CiLogScrubber {
  public static scrub(text: string): string {
    let scrubbed: string = text || "";

    for (const pattern of SECRET_PATTERNS) {
      scrubbed = scrubbed.replace(pattern, (match: string): string => {
        // Keep the "Bearer " prefix so the line still reads as an auth header.
        return match.startsWith("Bearer ") ? `Bearer ${REDACTED}` : REDACTED;
      });
    }

    return scrubbed;
  }

  // The last `count` lines of a log, scrubbed. Blank trailing lines are dropped.
  public static tail(text: string, count: number): string {
    const lines: Array<string> = (text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n");

    while (lines.length && !lines[lines.length - 1]!.trim()) {
      lines.pop();
    }

    return CiLogScrubber.scrub(lines.slice(-count).join("\n"));
  }
}
