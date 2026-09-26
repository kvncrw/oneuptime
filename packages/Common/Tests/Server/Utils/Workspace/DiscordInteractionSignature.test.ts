import { generateKeyPairSync, sign, KeyObject } from "crypto";
import DiscordInteractionSignature from "../../../../Server/Utils/Workspace/Discord/DiscordInteractionSignature";

describe("Discord interaction signature verification", () => {
  const keyPair: { publicKey: KeyObject; privateKey: KeyObject } =
    generateKeyPairSync("ed25519");
  const publicKey: string = keyPair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  const privateKey: KeyObject = keyPair.privateKey;
  const timestamp: string = "1790321000";
  const rawBody: Buffer = Buffer.from('{ "type": 1 }');
  const signature: string = sign(
    null,
    Buffer.concat([Buffer.from(timestamp), rawBody]),
    privateKey,
  ).toString("hex");
  const data: Parameters<typeof DiscordInteractionSignature.verify>[0] & {
    now: number;
  } = {
    publicKey,
    signature,
    timestamp,
    rawBody,
    now: Number(timestamp) * 1000,
  };

  test("accepts a signed PING with its exact raw bytes", () => {
    expect(DiscordInteractionSignature.verify(data)).toBe(true);
  });
  test("rejects reserialized bodies and forged signatures", () => {
    expect(
      DiscordInteractionSignature.verify({
        ...data,
        rawBody: Buffer.from('{"type":1}'),
      }),
    ).toBe(false);
    expect(
      DiscordInteractionSignature.verify({
        ...data,
        signature: "00".repeat(64),
      }),
    ).toBe(false);
  });
  test("rejects malformed keys, malformed timestamps, and expired signatures", () => {
    expect(
      DiscordInteractionSignature.verify({ ...data, publicKey: "bad" }),
    ).toBe(false);
    expect(
      DiscordInteractionSignature.verify({ ...data, timestamp: "NaN" }),
    ).toBe(false);
    expect(
      DiscordInteractionSignature.verify({ ...data, now: data.now + 301_000 }),
    ).toBe(false);
  });
});
