#!/usr/bin/python3
"""Publish verified archives for the existing SSH administrator, never for HTTP."""
import grp
import hashlib
import json
import os
import shutil
from pathlib import Path

os.umask(0o077)
source = Path('/var/backups/task-manager')
target = Path('/var/lib/task-manager-export')
group = grp.getgrnam('karina').gr_gid
target.mkdir(mode=0o750, exist_ok=True)
os.chown(target, 0, group)
os.chmod(target, 0o750)
archives = sorted(source.glob('workspace-*.tar.gz'))
if not archives:
    raise RuntimeError('No verified archive')
archive = archives[-1]
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
if archive.with_suffix(archive.suffix + '.sha256').read_text().split()[0] != digest:
    raise RuntimeError('Checksum mismatch')
# Immutable names avoid racing the downloader; manifest is published last.
if not (target / archive.name).exists():
    stage = target / (archive.name + '.partial')
    shutil.copyfile(archive, stage)
    os.chown(stage, 0, group)
    os.chmod(stage, 0o640)
    stage.replace(target / archive.name)
manifest = target / 'latest.json.partial'
manifest.write_text(json.dumps({'name': archive.name, 'sha256': digest, 'created': archive.stat().st_mtime}))
os.chown(manifest, 0, group)
os.chmod(manifest, 0o640)
manifest.replace(target / 'latest.json')
print('Verified backup export ready')
