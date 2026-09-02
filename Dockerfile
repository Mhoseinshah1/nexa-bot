# The production image. One image, several process roles.
#
# `api` and `worker` are the same code with different entrypoints — see
# ADR-0022 — so they are the same image with different commands. The
# maintenance CLIs (migrate, seed, provision-installation, bootstrap-owner) run
# as one-off containers from this image too, which is what makes "the migration
# runs from the TARGET release" mechanical rather than aspirational.
#
# The Web Admin is not a process. Its built bundle ships inside this image at
# /app/web and is copied out to a volume the edge serves from, so no Node
# process sits in the request path for files that never change within a release.
#
# NOTHING here may contain a secret. Build arguments land in image metadata and
# every layer is readable by anyone who can pull the image; the three arguments
# below are a version, a commit and a timestamp, which are facts about the
# build rather than credentials.

# Pinned by digest, not by tag. A tag is a moving pointer: the same Dockerfile
# built twice would otherwise produce two different base layers, which is the
# opposite of what an immutable release identity is for. The comment names the
# tag so an update stays legible.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS base

# Corepack pins pnpm to the version in the root manifest's `packageManager`
# field. Installing pnpm any other way is how a lockfile resolves differently in
# CI than on a developer's machine.
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable


# ---------------------------------------------------------------------------
# Builder: install the whole workspace, build every package, then resolve the
# api's PRODUCTION graph into a self-contained tree.
# ---------------------------------------------------------------------------
FROM base AS builder

WORKDIR /src

# Manifests and the lockfile first, so a source-only change reuses the install
# layer. `--frozen-lockfile` refuses to resolve anything the lockfile does not
# already name.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/i18n/package.json packages/i18n/
RUN pnpm install --frozen-lockfile

COPY . .

# Build metadata is stamped at BUILD time and read by the application's config
# schema (BUILD_VERSION / BUILD_COMMIT / BUILD_TIME). `botctl version` and
# `/health/info` report these, so a running container can be tied back to the
# exact source it came from.
ARG BUILD_VERSION=0.0.0-dev
ARG BUILD_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV BUILD_VERSION=${BUILD_VERSION}
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV BUILD_TIME=${BUILD_TIME}

RUN pnpm build

# `pnpm deploy` resolves the workspace graph — including @nexa/contracts and
# @nexa/i18n — into one tree with a real node_modules.
#
# `--prod` drops tsx, drizzle-kit, typescript and the test runner. `--legacy`
# because pnpm 10 otherwise refuses to deploy a workspace that has not opted
# into injected dependencies, which this one has not.
RUN pnpm --filter @nexa/api deploy --prod --legacy /deploy


# ---------------------------------------------------------------------------
# Runtime: artefacts and production dependencies. Nothing else.
# ---------------------------------------------------------------------------
FROM base AS runtime

ARG BUILD_VERSION=0.0.0-dev
ARG BUILD_COMMIT=unknown
ARG BUILD_TIME=unknown

LABEL org.opencontainers.image.title="nexa-bot" \
      org.opencontainers.image.source="https://github.com/Mhoseinshah1/nexa-bot" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.created="${BUILD_TIME}"

ENV NODE_ENV=production \
    BUILD_VERSION=${BUILD_VERSION} \
    BUILD_COMMIT=${BUILD_COMMIT} \
    BUILD_TIME=${BUILD_TIME}

WORKDIR /app

# FOUR things out of the deploy tree, not the tree itself.
#
# `pnpm deploy` also copies src/, the tsconfigs and drizzle.config.ts, because
# apps/api declares no `files` field. A production image has no use for any of
# them, and shipping source into a runtime is how a "no TypeScript in
# production" claim quietly stops being true.
#
# `drizzle/` sits BESIDE `dist/` deliberately: migrate.js resolves its migration
# folder as dist/infrastructure/persistence/../../../drizzle, so this exact
# relationship is what makes the compiled migrator find its migrations. A
# layout that nests one level differently points it at an empty path and it
# applies zero migrations without complaining.
COPY --from=builder --chown=node:node /deploy/dist ./dist
COPY --from=builder --chown=node:node /deploy/drizzle ./drizzle
COPY --from=builder --chown=node:node /deploy/node_modules ./node_modules
COPY --from=builder --chown=node:node /deploy/package.json ./package.json

# The Web Admin bundle. Copied out to a volume at start-up; see deploy/compose.
COPY --from=builder --chown=node:node /src/apps/web/dist ./web

# The `node` user (uid 1000) ships with the base image. The application never
# needs to write to its own filesystem, so nothing here is owned by it for
# writing — only for reading.
USER node

# Exec form, so the process replaces the shell and receives signals directly.
# The API and worker both install SIGTERM handlers and drain in-flight work;
# a shell wrapper would swallow the signal and every deployment would be a hard
# kill. Compose additionally runs these with an init process for reaping.
CMD ["node", "dist/main.js"]
