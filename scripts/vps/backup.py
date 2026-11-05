#!/usr/bin/python3
"""Root-only snapshot of the single-process JSON/SQLite workspace and configuration."""
import datetime
import hashlib
import json
import os
import sqlite3
import tarfile
import tempfile
from pathlib import Path

os.umask(0o077)
source = Path('/var/lib/task-manager')
target = Path('/var/backups/task-manager')
target.mkdir(mode=0o700, parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='task-manager-backup-') as temporary:
    stage = Path(temporary)
    for attempt in range(3):
        raw = (source / 'tasks.json').read_bytes()
        workspace = json.loads(raw)
        if workspace.get('version') != 2:
            raise RuntimeError('Unexpected workspace format; original data preserved')
        database = stage / 'task-manager.sqlite'
        database.unlink(missing_ok=True)
        with sqlite3.connect((source / 'task-manager.sqlite').as_uri() + '?mode=ro', uri=True) as src:
            with sqlite3.connect(database) as dst:
                src.backup(dst)
                if dst.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise RuntimeError('SQLite integrity check failed')
                if dst.execute('PRAGMA foreign_key_check').fetchall():
                    raise RuntimeError('SQLite foreign keys invalid')
        if raw == (source / 'tasks.json').read_bytes():
            break
    else:
        raise RuntimeError('Workspace changed during snapshot; retry later')
    (stage / 'tasks.json').write_bytes(raw)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    archive = target / ('workspace-' + stamp + '.tar.gz')
    partial = archive.with_suffix('.partial')
    with tarfile.open(partial, 'w:gz') as tar:
        for name in ['tasks.json', 'task-manager.sqlite']:
            tar.add(stage / name, arcname='data/' + name)
        for filename in [Path('/etc/task-manager/server.env'), Path('/etc/task-manager/github.env'), Path('/etc/task-manager/github-app.private-key.pem'), Path('/opt/task-manager/ai.config.json'), Path('/etc/systemd/system/task-manager.service'), Path('/etc/systemd/system/task-manager.service.d/github.conf'), Path('/etc/caddy/Caddyfile'), Path('/etc/systemd/system/task-manager-backup.service'), Path('/etc/systemd/system/task-manager-backup.timer'), Path('/etc/systemd/system/task-manager-backup.service.d/export.conf')]:
            if filename.is_file():
                tar.add(filename, arcname='configuration/' + str(filename).lstrip('/'))
    # Restore the data into a temporary directory and verify the archive, without touching live data.
    with tarfile.open(partial, 'r:gz') as tar:
        if tar.extractfile('data/tasks.json').read() != raw:
            raise RuntimeError('Archived JSON differs from snapshot')
        restored = stage / 'restored.sqlite'
        restored.write_bytes(tar.extractfile('data/task-manager.sqlite').read())
    with sqlite3.connect(restored) as check:
        if check.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise RuntimeError('Restore verification failed')
    partial.rename(archive)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(archive.suffix + '.sha256').write_text(digest + '  ' + archive.name + '\n')
    print('Backup verified:', archive.name, '; tasks:', len(workspace.get('tasks', [])), '; projects:', len(workspace.get('projects', [])))
