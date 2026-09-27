# Resolves the compose project name shared by every launcher script.
# Before prepare, E2E_PROJECT picks the name (default: the historical shared
# name). After prepare, the COMPOSE_PROJECT_NAME recorded in config.env wins,
# so a later shell without E2E_PROJECT can never address another project's
# volumes or images by falling back to the default. A disagreement is an error.
e2e_project() {
  local env_file=$1 recorded=""
  if [[ -f "$env_file" ]]; then
    recorded=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$env_file" | tail -1)
  fi
  if [[ -n "$recorded" && -n "${E2E_PROJECT:-}" && "$recorded" != "$E2E_PROJECT" ]]; then
    echo "E2E_PROJECT=$E2E_PROJECT disagrees with the prepared project $recorded" >&2
    return 1
  fi
  local name=${recorded:-${E2E_PROJECT:-oneuptime-discord-e2e}}
  [[ "$name" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || { echo "Invalid project name: $name" >&2; return 1; }
  printf '%s' "$name"
}
