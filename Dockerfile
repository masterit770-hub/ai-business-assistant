# Nucleus — Fly.io Dockerfile (agent-sdk branch)
# Runs the Next.js app with `pnpm start` (NOT standalone mode) so the full
# pnpm node_modules tree — including the Claude Agent SDK and its bundled
# linux-x64 binary — is available at runtime exactly as in development.
#
# The Claude Agent SDK (@anthropic-ai/claude-agent-sdk) spawns a bundled
# Claude Code binary (~224 MB linux-x64 ELF) as a subprocess.  The binary
# lives at:
#   node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@<ver>/
#     node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude
# It is resolved by the SDK via the pnpm peer-symlink inside the SDK's own
# node_modules.  Keeping the full node_modules intact preserves this.
#
# Python3 + pandas + openpyxl are installed so the Claude agent can read .xlsx
# files via:
#   python3 -c "import pandas as pd; df=pd.read_excel('f.xlsx', sheet_name=None)"

FROM node:24-bookworm-slim AS builder

# ── System deps ───────────────────────────────────────────────────────────────
# build-essential + python3-dev: required to compile native modules (better-sqlite3,
# canvas, etc.) during pnpm install.
# python3 + pip + pandas + openpyxl: for xlsx reading by the Claude agent at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential python3 python3-pip python3-dev \
        pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && pip3 install --break-system-packages pandas openpyxl \
    && rm -rf /var/lib/apt/lists/*

# ── pnpm ─────────────────────────────────────────────────────────────────────
RUN npm install -g pnpm@11.5.2

WORKDIR /app

# Copy workspace config + lockfile first so we can cache the install layer
COPY pnpm-workspace.yaml ./
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including the optional linux-x64 claude binary package)
# --frozen-lockfile: fail if lockfile is out of date
RUN pnpm install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────────────────
# Copy the rest of the source
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV SKIP_ENV_VALIDATION=1

# Bake NEXT_PUBLIC_* into the browser bundle at build time.
# These are the public anon key + project URL — safe to embed in the image.
ARG NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

RUN pnpm build

# ── Runtime ──────────────────────────────────────────────────────────────────
# Re-use the same image (no separate runner stage) — the node_modules with the
# Claude binary must stay on disk, so a standalone copy would need special
# handling for the 224 MB optional binary.  Keep it simple: same image,
# same node_modules, `next start`.

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# The Claude Agent SDK subprocess (the Claude Code binary) spawns Python3 and
# shell commands.  The binary writes temporary files to $HOME and to /tmp.
# A system user with HOME=/nonexistent breaks this.  We create a real home dir
# and a non-root user whose HOME is writable so the SDK runs cleanly.
RUN addgroup --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --home-dir /home/nextjs --create-home nextjs \
    && chown -R nextjs:nodejs /app /home/nextjs

# Give the Claude binary's TMPDIR a known writable location
ENV HOME=/home/nextjs
ENV CLAUDE_CODE_TMPDIR=/tmp

USER nextjs

EXPOSE 3000

CMD ["pnpm", "start"]
