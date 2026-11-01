#!/usr/bin/env python3
"""Mac-side offsite copy and bounded health checks. Never log secrets."""
import datetime
import fcntl
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path

BASE = Path.home() / 'Library/Application Support/TaskManager'
REMOTE = 'karina@78.153.149.128'
KEY = str(Path.home() / '.ssh/task_manager_vps')
SSH = ['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'UseKeychain=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', '-i', KEY]


def run(command, timeout=60):
    return subprocess.run(command, check=True, capture_output=True, timeout=timeout).stdout


def verify(archive, digest):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
        raise ValueError('checksum')
    with tempfile.TemporaryDirectory() as temporary:
        with tarfile.open(archive, 'r:gz') as tar:
            data = json.load(tar.extractfile('data/tasks.json'))
            if data.get('version') != 2 or not isinstance(data.get('tasks'), list):
                raise ValueError('workspace')
            db = Path(temporary) / 'restore.sqlite'
            db.write_bytes(tar.extractfile('data/task-manager.sqlite').read())
        with sqlite3.connect(db) as connection:
            if connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or connection.execute('PRAGMA foreign_key_check').fetchall():
                raise ValueError('database')
    return len(data['tasks'])


def collect():
    issues = []
    report = {'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    try:
        raw = run(['/usr/bin/curl', '-fsS', '--retry', '2', '--max-time', '10', 'https://tm-project.duckdns.org/api/health'])
        if json.loads(raw).get('ok') is not True:
            raise ValueError('health')
        report['https'] = 'ok'
    except Exception:
        issues.append('https_unavailable')
    try:
        raw = run(SSH + [REMOTE, 'df -Pk /'])
        columns = raw.decode().splitlines()[-1].split()
        used, available = int(columns[4].rstrip('%')), int(columns[3])
        report.update(disk_used_percent=used, disk_free_kib=available)
        if used >= 80 or available < 2 * 1024 * 1024:
            issues.append('disk_low')
    except Exception:
        issues.append('ssh_disk_check_failed')
    try:
        manifest = json.loads(run(SSH + [REMOTE, 'cat /var/lib/task-manager-export/latest.json']))
        name, digest = manifest['name'], manifest['sha256']
        if not re.fullmatch(r'workspace-[0-9T]+Z\.tar\.gz', name) or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('manifest')
        if time.time() - float(manifest['created']) > 48 * 3600:
            issues.append('server_backup_stale')
        directory = BASE / 'backups/vps-daily'
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        archive = directory / name
        if not archive.exists():
            partial = directory / (name + '.partial')
            try:
                with partial.open('wb') as output:
                    subprocess.run(SSH + [REMOTE, 'cat /var/lib/task-manager-export/' + name], stdout=output, stderr=subprocess.PIPE, check=True, timeout=120)
                verify(partial, digest)
                partial.replace(archive)
            finally:
                partial.unlink(missing_ok=True)
        tasks = verify(archive, digest)
        archive.with_suffix(archive.suffix + '.sha256').write_text(digest + '  ' + name + '\n')
        report.update(backup=name, backup_created=manifest['created'], restored_tasks=tasks, offsite='verified')
    except Exception:
        issues.append('offsite_backup_failed')
    report['issues'] = issues
    return report


def main():
    os.umask(0o077)
    BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (BASE / 'maintenance.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        report = collect()
        stage = BASE / 'maintenance-status.json.partial'
        stage.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        stage.replace(BASE / 'maintenance-status.json')
        print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
