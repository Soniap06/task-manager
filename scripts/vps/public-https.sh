#!/bin/bash
# Reviewed one-time public deployment; run as root on the existing closed VPS.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run with sudo bash'; exit 1; }
BASE=$(cd -- "$(dirname -- "$0")" && pwd)
DOMAIN=task-manager-karina-sonia.duckdns.org
# Refuse to overwrite an unrelated proxy or existing public firewall configuration.
! test -e /etc/caddy/Caddyfile || { echo 'Existing Caddy configuration: review manually.'; exit 1; }
! ufw status | grep -Eq '^(80|443)(/tcp)?[[:space:]]+ALLOW' || { echo 'Existing web firewall rules: review manually.'; exit 1; }
/usr/local/bin/node - <<'JS'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const env = parseEnv(fs.readFileSync('/etc/task-manager/server.env', 'utf8'));
if (!env.DEMO_USERNAME || (env.DEMO_PASSWORD || '').length < 12 || (env.SESSION_SECRET || '').length < 32 || env.PORT !== '3300') {
    throw new Error('Public deployment requires a board password of at least 12 characters, a session secret of 32+ characters and PORT=3300. No credentials changed.');
}
JS
/usr/bin/python3 /usr/local/libexec/task-manager-backup.py
apt-get update
apt-get install -y caddy
systemctl stop caddy
RELEASE=$(mktemp -d /var/backups/task-manager/public-release-XXXXXXXX)
cp -a /opt/task-manager/server.js "$RELEASE/server.js"
cp -a /opt/task-manager/lib/config.js "$RELEASE/config.js"
cp -a /etc/task-manager/server.env "$RELEASE/server.env"
if test -e /opt/task-manager/lib/request-limits.js; then cp -a /opt/task-manager/lib/request-limits.js "$RELEASE/request-limits.js"; fi
rollback() {
    echo 'Deployment failed; restoring closed application configuration.'
    systemctl stop caddy || true
    ufw delete allow 80/tcp || true
    ufw delete allow 443/tcp || true
    cp -a "$RELEASE/server.js" /opt/task-manager/server.js
    cp -a "$RELEASE/config.js" /opt/task-manager/lib/config.js
    cp -a "$RELEASE/server.env" /etc/task-manager/server.env
    if test -e "$RELEASE/request-limits.js"; then cp -a "$RELEASE/request-limits.js" /opt/task-manager/lib/request-limits.js; fi
    systemctl restart task-manager || true
    echo "Rollback copy: $RELEASE. Caddy remains stopped; inspect before retry."
}
trap rollback ERR
install -m 640 -o root -g task-manager "$BASE/server.js" /opt/task-manager/server.js
install -m 640 -o root -g task-manager "$BASE/config.js" /opt/task-manager/lib/config.js
install -m 640 -o root -g task-manager "$BASE/request-limits.js" /opt/task-manager/lib/request-limits.js
python3 - <<'PY'
from pathlib import Path
path = Path('/etc/task-manager/server.env')
lines = [line for line in path.read_text().splitlines() if not line.startswith('SHARED_ORIGIN=')]
lines.append('SHARED_ORIGIN=https://task-manager-karina-sonia.duckdns.org')
path.write_text('\n'.join(lines) + '\n')
PY
# No file server or secret-bearing access log; proxy only to the loopback application.
cat > /etc/caddy/Caddyfile <<'CADDY'
task-manager-karina-sonia.duckdns.org {
    header Strict-Transport-Security "max-age=31536000"
    request_body {
        max_size 1MB
    }
    reverse_proxy 127.0.0.1:3300
}
CADDY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl restart task-manager
for attempt in $(seq 1 20); do
    if curl -fsS --max-time 3 http://127.0.0.1:3300/api/health; then break; fi
    sleep 1
done
curl -fsS --max-time 3 http://127.0.0.1:3300/api/health
CODE=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3300/api/projects)
test "$CODE" = 401
ufw allow 80/tcp
ufw allow 443/tcp
systemctl enable --now caddy
SUCCESS=0
for attempt in $(seq 1 30); do
    if curl -fsS --max-time 5 "https://$DOMAIN/api/health"; then SUCCESS=1; break; fi
    sleep 2
done
test "$SUCCESS" = 1
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/projects")
test "$CODE" = 401
trap - ERR
systemctl is-active task-manager caddy
ufw status
echo "HTTPS ready: https://$DOMAIN/login; rollback files: $RELEASE"
