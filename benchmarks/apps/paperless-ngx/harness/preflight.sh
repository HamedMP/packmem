#!/usr/bin/env bash
# Read-only checks on the server. Run as: ssh bench-server 'bash -s' < harness/preflight.sh
set -uo pipefail
echo "host:      $(uname -srm)"
echo "glibc:     $(ldd --version 2>&1 | head -1)"
echo "cpus:      $(nproc)"
echo "loadavg:   $(cut -d' ' -f1-3 /proc/loadavg)"
free -g | sed 's/^/mem:       /'
df -h "$HOME" | tail -1 | sed 's/^/disk home: /'
echo "docker root: $(docker info -f '{{.DockerRootDir}}' 2>&1)"
df -h "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /)" | tail -1 | sed 's/^/disk docker: /'
echo "docker:    $(docker version -f '{{.Server.Version}}' 2>&1)"
echo "compose:   $(docker compose version --short 2>&1) (needs >= 2.24 for !reset)"
echo "cc:        $(cc --version 2>&1 | head -1)"
echo "python3:   $(python3 --version 2>&1)"
echo "curl:      $(curl --version 2>&1 | head -1)"
echo "systemd-run --user: $(systemd-run --user --scope -q true 2>&1 && echo ok || echo unavailable)"
echo "existing project containers:"; docker ps -a --filter label=com.docker.compose.project=packmem-paperless --format '  {{.Names}} {{.Status}}'
echo "workdir:   $(ls -d "$HOME/packmem-paperless" 2>/dev/null || echo absent)"
echo "images already present (not to be removed at teardown):"
docker image ls --format '  {{.Repository}}:{{.Tag}} {{.ID}}' | grep -E 'paperless-ngx|postgres|valkey' || echo "  none"
