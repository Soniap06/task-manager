#!/bin/bash
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run with sudo bash'; exit 1; }
BASE=$(cd -- "$(dirname -- "$0")" && pwd)
install -m 700 -o root -g root "$BASE/backup.py" /usr/local/libexec/task-manager-backup.py
install -m 700 -o root -g root "$BASE/publish-backup.py" /usr/local/libexec/task-manager-publish-backup.py
install -d -m 755 /etc/systemd/system/task-manager-backup.service.d
cat > /etc/systemd/system/task-manager-backup.service.d/export.conf <<'UNIT'
[Service]
ReadWritePaths=/var/lib/task-manager-export
ExecStartPost=/usr/bin/python3 /usr/local/libexec/task-manager-publish-backup.py
UNIT
install -d -m 750 -o root -g karina /var/lib/task-manager-export
systemctl daemon-reload
systemctl start task-manager-backup.service
systemctl is-enabled task-manager-backup.timer
systemctl show task-manager-backup.service -p Result -p ExecMainStatus
sudo -u karina test -r /var/lib/task-manager-export/latest.json
echo 'Maintenance ready: daily backup exports accessible through existing SSH account only.'
