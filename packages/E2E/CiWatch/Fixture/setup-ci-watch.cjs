/*
 * Writes the GitHub App and fixture-control settings for the CI watch suite
 * into the Discord fixture's config.env (.scratch/discord-e2e/config.env,
 * ignored, mode 600). Public identifiers come from identities.json; every
 * secret is generated here and never printed or committed.
 *
 * The App private key is a throwaway RSA-2048 key. It is stored base64
 * encoded on one line because docker compose env files are line based;
 * packages/Common/Server/EnvironmentConfig.ts decodes base64 PEM.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ids = require("./identities.json");

const root = process.cwd();
const scratch = path.join(root, ".scratch", "discord-e2e");
const envPath = path.join(scratch, "config.env");
if (!fs.existsSync(envPath)) {
  throw new Error(
    "Prepare and build the Discord fixture first: bash packages/E2E/Discord/Fixture/local-stack.sh prepare && ... build",
  );
}

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const pem = privateKey.export({ type: "pkcs1", format: "pem" });

let env = fs.readFileSync(envPath, "utf8");
const values = {
  GITHUB_APP_ID: ids.appId,
  GITHUB_APP_NAME: ids.appName,
  GITHUB_APP_CLIENT_ID: ids.clientId,
  GITHUB_APP_CLIENT_SECRET: crypto.randomBytes(24).toString("hex"),
  GITHUB_APP_PRIVATE_KEY: Buffer.from(pem).toString("base64"),
  GITHUB_APP_WEBHOOK_SECRET: crypto.randomBytes(32).toString("hex"),
  CI_WATCH_FIXTURE_CONTROL_TOKEN: crypto.randomBytes(32).toString("hex"),
};
for (const [key, value] of Object.entries(values)) {
  env = env.replace(new RegExp("^" + key + "=.*\\n?", "gm"), "");
  env += "\n" + key + "=" + value + "\n";
}
fs.writeFileSync(envPath, env, { mode: 0o600 });
fs.copyFileSync(
  path.join(__dirname, "ci-watch.yml"),
  path.join(scratch, "ci-watch.yml"),
);
console.log(
  "CI watch fixture settings written to .scratch/discord-e2e/config.env; secrets are not printed.",
);
