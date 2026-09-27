#!/bin/bash
set -euo pipefail
fixture_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(git -C "$fixture_dir" rev-parse --show-toplevel)
source "$fixture_dir/project.sh"
project=$(e2e_project "$fixture_dir/config.env")
export BUILDX_CONFIG="$fixture_dir/buildx"
mkdir -p "$BUILDX_CONFIG"
target=${1:?Use App or E2E}
case "$target" in App) image="$project-app:local";; E2E) image="$project-tests:local";; *) exit 2;; esac
# 14.x builds the community stage of a multi-stage App Dockerfile; 13.0.8 has one stage.
target_args=()
if [[ "$target" = App ]] && grep -qE '^FROM .* AS community' "$fixture_dir/App.Dockerfile"; then target_args=(--target community); fi
source_sha=$(node -p "require('$fixture_dir/source.json').head")
source_version=$(node -p "require('$fixture_dir/source.json').appVersion")
set +e
docker run --rm --network none -v "${project}_source:/source:ro" redis:7-bookworm tar -C /source -cf - . \
  | docker build --progress plain "${target_args[@]}" --build-arg "GIT_SHA=$source_sha" --build-arg "APP_VERSION=$source_version" -f ".fixture/$target.Dockerfile" -t "$image" - 2>&1 \
  | docker run --rm -i --network none -v "${project}_evidence:/evidence" redis:7-bookworm sh -c 'cat > "/evidence/$1-build.log"' sh "$target"
build_status=$?
set -e
printf '%s build exit=%s image=%s source=%s\n' "$target" "$build_status" "$image" "$source_sha"
exit "$build_status"
