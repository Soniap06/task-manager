#!/bin/bash
# Run once as root on the existing VPS. Does not change login credentials or expose ports.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run with sudo bash'; exit 1; }
BASE=$(cd -- "$(dirname -- "$0")" && pwd)
test -s /etc/task-manager/server.env
test -s /etc/task-manager/github.env
test -s /etc/task-manager/github-app.private-key.pem
install -d -m 755 /usr/local/libexec
install -m 700 -o root -g root "$BASE/backup.py" /usr/local/libexec/task-manager-backup.py
# A verified snapshot precedes the configuration change.
/usr/bin/python3 /usr/local/libexec/task-manager-backup.py
/usr/bin/python3 - <<'PY'
import json
import os
from pathlib import Path
path = Path('/opt/task-manager/ai.config.json')
example = Path('/opt/task-manager/ai.config.example.json')
settings = json.loads((path if path.exists() else example).read_text())
settings.update(endpoint='http://127.0.0.1:19134/v1/chat/completions', model='qwen/qwen3.5-9b', timeoutMs=120000)
stage = path.with_suffix('.json.staged')
stage.write_text(json.dumps(settings, ensure_ascii=False, indent=4) + '\n')
os.chown(stage, 0, __import__('grp').getgrnam('task-manager').gr_gid)
os.chmod(stage, 0o640)
stage.replace(path)
PY
cat > /etc/systemd/system/task-manager-backup.service <<'EOF'
[Unit]
Description=Verify and back up Task Manager data and secrets
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/libexec/task-manager-backup.py
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/backups/task-manager
EOF
cat > /etc/systemd/system/task-manager-backup.timer <<'EOF'
[Unit]
Description=Daily Task Manager backup
[Timer]
OnCalendar=*-*-* 03:30:00 UTC
RandomizedDelaySec=600
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now task-manager-backup.timer
systemctl restart task-manager
for attempt in $(seq 1 20); do
    if curl -fsS --max-time 3 http://127.0.0.1:3300/api/health; then break; fi
    sleep 1
done
curl -fsS --max-time 3 http://127.0.0.1:3300/api/health
sudo -u task-manager /usr/local/bin/node --env-file=/etc/task-manager/server.env --env-file=/etc/task-manager/github.env /opt/task-manager/scripts/github-check.js
# A generation check writes neither cards nor GitHub branches.
sudo -u task-manager /usr/local/bin/node --env-file=/etc/task-manager/server.env --env-file=/etc/task-manager/github.env /opt/task-manager/scripts/llm-check.js 'Добавить поиск привычек по названию. Пока не выбрано, искать по префиксу или подстроке.'
systemctl start task-manager-backup.service
systemctl is-active task-manager
systemctl list-timers task-manager-backup.timer --no-pager
# One initial off-server copy can be downloaded through the existing administrator account.
LATEST=$(find /var/backups/task-manager -maxdepth 1 -type f -name 'workspace-*.tar.gz' | sort | tail -n 1)
install -m 600 -o karina -g karina "$LATEST" /home/karina/task-manager-offsite.tar.gz
sha256sum /home/karina/task-manager-offsite.tar.gz | awk '{print $1 "  task-manager-offsite.tar.gz"}' > /home/karina/task-manager-offsite.sha256
chown karina:karina /home/karina/task-manager-offsite.sha256
chmod 600 /home/karina/task-manager-offsite.sha256
echo 'VPS setup complete; initial offsite snapshot prepared.'
