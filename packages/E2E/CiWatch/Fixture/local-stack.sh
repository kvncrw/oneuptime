#!/usr/bin/env bash
# CI watch acceptance stack. Reuses the Discord fixture's isolated compose
# project (.scratch/discord-e2e) and layers ci-watch.yml on it: same network,
# same disposable CA, plus the GitHub and LLM fixtures.
#
# Order: Discord prepare + build first (build regenerates the certificate with
# the GitHub SANs), then this script's prepare, start, test.
set -euo pipefail
repo_dir=$(git rev-parse --show-toplevel)
fixture_dir="$repo_dir/.scratch/discord-e2e"
source_dir="$repo_dir/packages/E2E/CiWatch/Fixture"
cd "$repo_dir"
source "$repo_dir/packages/E2E/Discord/Fixture/LocalStack/project.sh"
project=$(e2e_project "$fixture_dir/config.env")

compose() {
  env -i PATH="$PATH" HOME="$HOME" docker compose \
    --project-directory "$fixture_dir" --project-name "$project" --profile test \
    --env-file "$fixture_dir/config.env" \
    -f "$fixture_dir/compose.yml" -f "$fixture_dir/protocol.yml" -f "$fixture_dir/ci-watch.yml" "$@"
}

case "${1:-help}" in
  prepare)
    node "$source_dir/setup-ci-watch.cjs"
    compose config --quiet
    # Same isolation gate the Discord launcher applies, extended to the CiWatch binds.
    compose config --format json | node -e '
const project=process.argv[1];
let text="";process.stdin.on("data",x=>text+=x);process.stdin.on("end",()=>{
 const c=JSON.parse(text);
 if(c.name!==project || !c.networks.oneuptime.internal)throw Error("Wrong project or network");
 for(const [name,s]of Object.entries(c.services)){
  if(s.ports?.length || s.network_mode || s.container_name || s.image?.includes("alpine"))throw Error("Unsafe service: "+name);
  for(const v of s.volumes||[])if(v.type==="bind"&&!v.source.includes("/.scratch/discord-e2e/Clickhouse/")&&!v.source.includes("/packages/E2E/Discord")&&!v.source.includes("/packages/E2E/CiWatch")&&!v.source.endsWith("/packages/E2E/playwright.discord.config.ts")&&!v.source.endsWith("/packages/E2E/playwright.ci-watch.config.ts"))throw Error("Unexpected bind: "+name+" "+v.source);
 }
 for(const v of Object.values(c.volumes||{}))if(v.external)throw Error("External volume");
 console.log("Verified isolated project "+project+", internal network, zero published ports, dedicated volumes");
});' "$project"
    ;;
  start)
    # `up` re-creates the app container so it picks up the GITHUB_APP_* env.
    compose up -d --no-build app ingress discord-fixture github-fixture llm-fixture
    ;;
  test)
    shift
    compose run --rm --no-deps \
      -e PLAYWRIGHT_HTML_REPORT=/evidence/ci-watch/html \
      -e PLAYWRIGHT_JSON_OUTPUT_NAME=/evidence/ci-watch/results.json \
      -e CI_WATCH_E2E_OUTPUT=/evidence/ci-watch/test-results \
      e2e npx playwright test --config playwright.ci-watch.config.ts "$@"
    ;;
  stop) compose stop ;;
  *) echo "Usage: bash packages/E2E/CiWatch/Fixture/local-stack.sh prepare|start|test [Playwright args]|stop" ;;
esac
