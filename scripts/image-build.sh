#!/usr/bin/env bash
# Sourced by the deployment smokes: `nexa_build_image <tag> [docker build args...]`
# builds the production image from the current directory and loads it into the
# local daemon under <tag>.
#
# In CI the jobs set up buildx and prime the layer cache with
# docker/build-push-action (`.github/workflows/ci.yml`, "Warm the image cache"),
# so the builder this script reaches already holds the `deps` and `system`
# stages, and the GitHub Actions cache (scopes `nexa-image-deps`,
# `nexa-image-system`) is read too when the runner exposes its cache
# credentials to a `run` step. Anywhere else (a laptop, the botctl fakes) it is the plain
# `docker build` it always was. Either way the image is the same; only the time
# differs.

nexa_build_image() {
  local tag="$1"
  shift
  if [ "${NEXA_CI_BUILDX:-}" = "1" ] && docker buildx version >/dev/null 2>&1; then
    local cache=()
    if [ -n "${ACTIONS_RUNTIME_TOKEN:-}" ] && { [ -n "${ACTIONS_CACHE_URL:-}" ] || [ -n "${ACTIONS_RESULTS_URL:-}" ]; }; then
      cache=(--cache-from "type=gha,scope=nexa-image-deps" --cache-from "type=gha,scope=nexa-image-system")
    fi
    docker buildx build --load ${cache[@]+"${cache[@]}"} -t "$tag" "$@" .
  else
    docker build -t "$tag" "$@" .
  fi
}
