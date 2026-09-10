FROM node:lts-slim

# Base tooling: chromium for playwright; python3+venv backs the notebook
# integration (datamog-magic / Appendix F); the rest is general shell hygiene
# and what Claude Code reaches for. Image-build steps run as root; runtime
# drops to the (UID-remapped) node user.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      curl \
      fd-find \
      git \
      jq \
      less \
      openssh-client \
      procps \
      postgresql-client \
      python3 \
      python3-pip \
      python3-venv \
      ripgrep \
      sudo \
      unzip \
      z3 \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (official apt repo).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Debian ships fd as `fdfind`; give it the expected name.
RUN ln -s "$(command -v fdfind)" /usr/local/bin/fd

# Enable corepack so pnpm (and yarn) are available without a global install.
RUN corepack enable

# bun via the official installer. BUN_INSTALL keeps the binary out of /root
# so the unprivileged container user can reach it.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local/bun bash
ENV PATH="/usr/local/bun/bin:${PATH}"

# Install Claude Code + a wrapper that always passes --dangerously-skip-permissions.
# The installer writes its launcher to $HOME/.local/bin/claude AND prepends
# $HOME/.local/bin to PATH via shell rc files, so a wrapper at /usr/local/bin/claude
# gets shadowed in interactive shells. We rename the launcher to claude.real and
# replace it with the wrapper at the same path, then symlink /usr/local/bin/claude
# to the wrapper for non-interactive shells where the rc-file PATH manipulation
# doesn't run. Auto-update is disabled so updates don't clobber the wrapper between
# sessions — use VS Code's "Rebuild Container" to refresh claude. claude resolves
# its versioned launchers under $HOME/.local/share/claude, so the install HOME must
# equal the runtime HOME.
#
# We also pre-seed a minimal ~/.claude.json so first launch skips the theme picker
# and the workspace-trust dialog for /work. lastOnboardingVersion is set to a high
# sentinel so version bumps don't re-trigger onboarding. claude rewrites ~/.claude.json
# on normal use; its additional fields are layered on top via copy-on-write.
#
# We deliberately do NOT seed ~/.claude/settings.json: docker-compose.yml bind-mounts
# the host's ~/.claude over that directory, so anything baked in here would be shadowed.
# The bypass-permissions warning is instead suppressed by the host's own settings.json.
RUN curl -fsSL https://claude.ai/install.sh -o /tmp/install.sh \
 && HOME=/home/node bash /tmp/install.sh \
 && rm /tmp/install.sh \
 && mv /home/node/.local/bin/claude /home/node/.local/bin/claude.real \
 && printf '#!/bin/sh\nexec /home/node/.local/bin/claude.real --dangerously-skip-permissions "$@"\n' \
      > /home/node/.local/bin/claude \
 && chmod +x /home/node/.local/bin/claude \
 && ln -sf /home/node/.local/bin/claude /usr/local/bin/claude \
 && printf '%s\n' '{"theme":"auto","hasCompletedOnboarding":true,"lastOnboardingVersion":"9999.0.0","projects":{"/work":{"hasTrustDialogAccepted":true}}}' \
      > /home/node/.claude.json \
 && chown -R node:node /home/node
ENV DISABLE_AUTOUPDATER=1

# Pre-build a Python venv for the Jupyter notebook tutorial (doc/jupyter/).
# Lives outside /work so the host bind mount doesn't shadow it, and is
# made world-writable so `pip install -e` from the unprivileged runtime
# user works regardless of how `updateRemoteUserUID` ends up rewriting
# the node user's UID.
#
# The kernelspec is installed under /usr/local so it's discoverable by
# any `jupyter` invocation, not just one launched from the venv. Its
# `kernel.json` still points at /opt/datamog-venv/bin/python, so opening
# "Python (datamog)" spawns the venv's interpreter as expected.
#
# datamog-magic itself is *not* installed at build time — its source
# lives under /work/python/datamog-magic, which isn't mounted yet. The
# editable install is deferred to devcontainer.json's postCreateCommand.
ENV DATAMOG_VENV=/opt/datamog-venv
RUN python3 -m venv "${DATAMOG_VENV}" \
 && "${DATAMOG_VENV}/bin/pip" install --no-cache-dir --upgrade pip \
 && "${DATAMOG_VENV}/bin/pip" install --no-cache-dir \
      ipykernel \
      jupyter \
      matplotlib \
      pandas \
 && "${DATAMOG_VENV}/bin/python" -m ipykernel install \
      --prefix=/usr/local \
      --name datamog \
      --display-name "Python (datamog)" \
 && mkdir -p "${DATAMOG_VENV}/.mplconfig" \
 && chmod -R a+rwX "${DATAMOG_VENV}"

ENV PATH="/opt/datamog-venv/bin:${PATH}"

# matplotlib defaults its cache to ~/.config/matplotlib, which the
# unprivileged runtime user can't create (/home/node/.config is
# root-owned once the gh config bind mount lands). Point it at the
# world-writable venv dir instead — writable, persistent across
# container restarts, and faster than matplotlib's /tmp fallback.
ENV MPLCONFIGDIR=/opt/datamog-venv/.mplconfig
