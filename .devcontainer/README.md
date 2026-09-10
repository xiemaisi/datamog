# Project-specific container setup

These files extend a base Docker image and stack with what datamog needs at runtime.

## Files

- **`Dockerfile`** — built from `node:lts-slim`; adds chromium (for playwright), Z3 (for refinement verification), the Postgres client, bun, Claude Code, and the tooling Claude reaches for (gh, ripgrep, fd, jq, less, …). The installed claude launcher is renamed to `claude.real` and replaced with a wrapper that always passes `--dangerously-skip-permissions`; auto-update is disabled so the wrapper survives across sessions (rebuild the container to refresh claude). First-run prompts for theme and workspace trust are pre-answered via a minimal `~/.claude.json` baked into the image; the bypass-permissions warning is suppressed by the host's own `~/.claude/settings.json`, which is bind-mounted in (see below).
- **`docker-compose.yml`** — declares the `claude` service (with `build:` from the Dockerfile) plus the postgres sidecar, the tmpfs for `/tmp`, the seccomp relaxation chromium needs, the `..:/work` workspace bind mount, the `${HOME}/.claude` and `${HOME}/.config/gh` mounts, the `GH_TOKEN` and `ANTHROPIC_API_KEY` passthroughs, and a `sleep infinity` command so the container stays alive for VS Code to exec into.
- **`devcontainer.json`** — VS Code Dev Containers config. Points at `docker-compose.yml`, attaches to the `claude` service, sets `workspaceFolder: /work`. Project-level config under `.claude/` in the repo is picked up via the workspace mount. VS Code extensions (`anthropic.claude-code`, `biomejs.biome`, `ms-python.python`, `ms-toolsai.jupyter`) are auto-installed in the container on first attach.

The host's `~/.claude` is bind-mounted into the container by `docker-compose.yml`, so login, global agents/skills/CLAUDE.md, memory, and conversation history persist across rebuilds. **`~/.claude` must already exist on the host with your ownership** before the container is created — running `claude` on the host once is enough. Otherwise Docker auto-creates the mount source, and on Linux with rootful Docker it ends up root-owned and the container's `node` user can't write to it.

### GitHub CLI (`gh`) auth

Sharing `gh` across the boundary takes **two** pieces, because `gh` splits config from credentials:

1. **Config mount** — `${HOME}/.config/gh` is bind-mounted in, carrying your `config.yml` preferences (editor, protocol, aliases) and the `hosts.yml` host entries. Same host-dir-must-exist caveat as `~/.claude`.
2. **Token** — where the token lives depends on how you ran `gh auth login`:
   - **Plaintext in `hosts.yml`** (common on Linux hosts without a keyring) — the config mount already carries it; nothing else needed.
   - **OS keyring** (macOS Keychain, gnome-keyring — gh's default when a keyring is available) — the token is *not* in any file, so the mount can't carry it. `gh` reads `GH_TOKEN` before any config file, so the `GH_TOKEN: ${GH_TOKEN:-}` passthrough in `docker-compose.yml` covers this. Supply it one of two ways:
     - Export it in the shell you launch VS Code from: `export GH_TOKEN=$(gh auth token) && code .` — but a GUI launch (Dock/Spotlight) won't inherit your shell env.
     - More robust: drop it in `.devcontainer/.env` (gitignored) as `GH_TOKEN=<token>`, which Compose loads automatically. Refresh it when the token rotates.

   Check which case you're in: `grep -q oauth_token ~/.config/gh/hosts.yml && echo "in file" || echo "in keyring"`.

## What runs

- `claude` (the main container, dropping into Claude Code) starts only after `pg_isready` passes against the sidecar.
- `postgres:16` listens on `postgres:5432` inside the compose network. Setup creates `datamog_test` and `datamog_examples`; `DATABASE_URL` and
  `DATAMOG_EXAMPLES_DATABASE_URL` point to those separate databases. The original
  `app` database remains available for manual use.
- The `pgdata` named volume persists between sessions; `shutdownAction: stopCompose` in `devcontainer.json` stops the stack on disconnect without removing named volumes, so the database survives.

## Tests in Codespaces and Dev Containers

After changing this setup, use **Codespaces: Rebuild Container** (or **Dev
Containers: Rebuild Container** locally). The post-create script installs the
locked Bun dependencies, creates any missing test databases, and checks Z3 and
both database connections. It also works with an existing `pgdata` volume.

Run `bun test` normally: Z3 verification and Postgres tests are enabled without
additional environment setup. `DATAMOG_REQUIRE_POSTGRES=1` makes a missing database
configuration or connection a test failure. The two suites use separate databases
because they drop and recreate `public`; reserve these databases for tests.
Examples unsupported by SQL backends still skip on those backends.

## Notebook environment

The Dockerfile pre-bakes a Python venv at `/opt/datamog-venv` with `jupyter`, `ipykernel`, `pandas`, and `matplotlib`, and registers a kernel called **Python (datamog)** under `/usr/local/share/jupyter/kernels/datamog`. The venv's `bin/` is on the PATH, so `python`, `pip`, and `jupyter` all resolve to the venv inside the container.

The `datamog-magic` package itself is editable-installed by `devcontainer.json`'s `postCreateCommand`, since its source lives under the bind-mounted workspace and isn't visible at image-build time. After first attach, run:

```bash
jupyter lab --no-browser --ip=0.0.0.0
```

VS Code auto-forwards port 8888 (declared in `forwardPorts`); open the URL it surfaces and pick **Python (datamog)** as the kernel.

## Why the tweaks

- **`tmpfs: /tmp`** — chromium writes a lot to `/tmp`; backing it with memory keeps churn off the host disk and leaves nothing behind.
- **`security_opt: seccomp=unconfined`** — docker's default seccomp profile blocks the `clone()` namespace flags chromium's sandbox needs to initialise. Without this, headless chromium fails with "No usable sandbox!". The container itself is the isolation boundary.
- **World-writable `/opt/datamog-venv`** — the venv is created by root at build time but `pip install -e` runs as the container's runtime user. Marking it `a+rwX` once at the end of the build sidesteps any UID mismatch from `updateRemoteUserUID`.

## Troubleshooting

**Build dies with `cannot allocate memory` / `Killed` during the Claude Code install step.** The native installer's self-extract phase needs more memory than minimal container-engine VM defaults provide. Bump the VM's memory ceiling:

- **colima** — default is 2 GiB, which isn't enough. Run `colima stop && colima start --memory 8` (8 GiB is a comfortable baseline). The setting persists in `~/.colima/default/colima.yaml`.
- **Docker Desktop** — Settings → Resources → Memory.
- **OrbStack** — Settings → Resources → Memory.

Then "Rebuild Container" in VS Code.
