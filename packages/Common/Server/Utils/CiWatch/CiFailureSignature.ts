import * as crypto from "crypto";

/*
 * A failure signature is what lets the watch tell "the same red, again" from
 * "a different red": firstFailingJob / firstFailingStep / normalized error
 * lines, SHA-256, first 16 hex characters.
 *
 * Normalizing strips the things that change between two runs of the same
 * failure (timestamps, GitHub's ##[group] prefixes, hashes, ids, counters)
 * and keeps only the last 20 lines that look like an error, so a longer log
 * or a re-run does not produce a new signature for an unchanged failure.
 */

const SIGNATURE_LENGTH: number = 16;
const ERROR_LINE_LIMIT: number = 20;
const ERROR_LINE_PATTERN: RegExp = /error|fail|exception|assert/i;
const ISO_TIMESTAMP: RegExp =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const COMMAND_PREFIX: RegExp = /##\[[^\]]*\]/g;
const UUID: RegExp =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HEX: RegExp = /\b[0-9a-f]{7,}\b/gi;
const DIGITS: RegExp = /\d+/g;

export interface CiFailureSignatureInput {
  firstFailingJob: string;
  firstFailingStep: string;
  logTail: string;
}

export default class CiFailureSignature {
  public static normalizeLine(line: string): string {
    return line
      .replace(ISO_TIMESTAMP, "")
      .replace(COMMAND_PREFIX, "")
      .replace(UUID, "")
      .replace(LONG_HEX, "")
      .replace(DIGITS, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // The last 20 error-looking lines, normalized, in their original order.
  public static normalizedErrorLines(logTail: string): Array<string> {
    const lines: Array<string> = (logTail || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .filter((line: string) => {
        return ERROR_LINE_PATTERN.test(line);
      })
      .slice(-ERROR_LINE_LIMIT)
      .map((line: string) => {
        return CiFailureSignature.normalizeLine(line);
      })
      .filter((line: string) => {
        return Boolean(line);
      });

    return lines;
  }

  public static compute(input: CiFailureSignatureInput): string {
    const material: string = [
      (input.firstFailingJob || "").trim(),
      (input.firstFailingStep || "").trim(),
      CiFailureSignature.normalizedErrorLines(input.logTail).join("\n"),
    ].join(" / ");

    return crypto
      .createHash("sha256")
      .update(material)
      .digest("hex")
      .substring(0, SIGNATURE_LENGTH);
  }
}
