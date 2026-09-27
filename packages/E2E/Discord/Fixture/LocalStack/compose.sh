#!/bin/bash
set -euo pipefail
fixture_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(git -C "$fixture_dir" rev-parse --show-toplevel)
source "$fixture_dir/project.sh"
project=$(e2e_project "$fixture_dir/config.env")
exec env -i PATH="$PATH" HOME="$HOME" docker compose \
  --project-directory "$fixture_dir" --project-name "$project" --profile test \
  --env-file "$fixture_dir/config.env" -f "$fixture_dir/compose.yml" -f "$fixture_dir/protocol.yml" "$@"
