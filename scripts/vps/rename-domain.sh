#!/bin/bash
# Switch the existing HTTPS deployment; preserve old URL as a redirect.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run with sudo bash'; exit 1; }
OLD=task-manager-karina-sonia.duckdns.org
NEW=tm-project.duckdns.org
grep -qx "SHARED_ORIGIN=https://$OLD" /etc/task-manager/server.env
getent ahostsv4 "$NEW" | awk '{print $1}' | grep -qx 78.153.149.128
/usr/bin/python3 /usr/local/libexec/task-manager-backup.py
SNAPSHOT=$(mktemp -d /var/backups/task-manager/domain-XXXXXXXX)
cp -a /etc/caddy/Caddyfile "$SNAPSHOT/Caddyfile"
cp -a /etc/task-manager/server.env "$SNAPSHOT/server.env"
rollback() {
    echo 'Restoring previous domain configuration.'
    cp -a "$SNAPSHOT/Caddyfile" /etc/caddy/Caddyfile
    cp -a "$SNAPSHOT/server.env" /etc/task-manager/server.env
    systemctl restart task-manager || true
    systemctl reload caddy || true
}
trap rollback ERR
# Obtain the new certificate while the old application remains available.
cat >> /etc/caddy/Caddyfile <<'CADDY'

tm-project.duckdns.org {
    respond "Preparing domain" 503
}
CADDY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
READY=0
for attempt in $(seq 1 30); do
    # Do not use --insecure: a trusted certificate must exist before switching.
    if curl -sS --max-time 5 -o /dev/null "https://$NEW/"; then READY=1; break; fi
    sleep 2
done
test "$READY" = 1
sed -i "s|^SHARED_ORIGIN=https://$OLD$|SHARED_ORIGIN=https://$NEW|" /etc/task-manager/server.env
cat > /etc/caddy/Caddyfile <<'CADDY'
tm-project.duckdns.org {
    header Strict-Transport-Security "max-age=31536000"
    request_body {
        max_size 1MB
    }
    reverse_proxy 127.0.0.1:3300
}
task-manager-karina-sonia.duckdns.org {
    redir https://tm-project.duckdns.org{uri} 308
}
CADDY
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl restart task-manager
READY=0
for attempt in $(seq 1 20); do
    if curl -fsS --max-time 3 http://127.0.0.1:3300/api/health; then READY=1; break; fi
    sleep 1
done
test "$READY" = 1
systemctl reload caddy
curl -fsS --retry 3 --retry-delay 2 --max-time 10 "https://$NEW/api/health"
CODE=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "https://$NEW/api/projects")
test "$CODE" = 401
CODE=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "https://$OLD/login")
test "$CODE" = 308
trap - ERR
echo "Domain switched: https://$NEW/login. Previous URL redirects."
