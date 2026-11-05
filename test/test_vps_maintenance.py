"""Run with python3 -m unittest discover -s test -p 'test_vps*.py'."""
import hashlib
import importlib.util
import json
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import subprocess
from pathlib import Path

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).parents[1] / 'scripts/vps/mac-maintenance.py')
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


class RestoreChecks(unittest.TestCase):
    def test_restore_and_checksum(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'tasks.json').write_text(json.dumps({'version': 2, 'tasks': [{'id': 'one'}]}))
            with sqlite3.connect(root / 'db.sqlite') as db:
                db.execute('CREATE TABLE employees (id TEXT PRIMARY KEY)')
            archive = root / 'backup.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                tar.add(root / 'tasks.json', arcname='data/tasks.json')
                tar.add(root / 'db.sqlite', arcname='data/task-manager.sqlite')
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            self.assertEqual(maintenance.verify(archive, digest), 1)
            with self.assertRaisesRegex(ValueError, 'checksum'):
                maintenance.verify(archive, '0' * 64)

    def test_invalid_database_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'tasks.json').write_text('{"version":2,"tasks":[]}')
            (root / 'db.sqlite').write_bytes(b'not a database')
            archive = root / 'backup.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                tar.add(root / 'tasks.json', arcname='data/tasks.json')
                tar.add(root / 'db.sqlite', arcname='data/task-manager.sqlite')
            with self.assertRaises(sqlite3.DatabaseError):
                maintenance.verify(archive, hashlib.sha256(archive.read_bytes()).hexdigest())


class NetworkRetry(unittest.TestCase):
    def test_temporary_connection_failure_is_retried(self):
        failure = subprocess.CalledProcessError(255, ['ssh'])
        success = subprocess.CompletedProcess(['ssh'], 0, stdout=b'ok')
        with patch.object(maintenance.subprocess, 'run', side_effect=[failure, success]) as run, patch.object(maintenance.time, 'sleep'):
            self.assertEqual(maintenance.run(['ssh']), b'ok')
            self.assertEqual(run.call_count, 2)

    def test_persistent_failure_is_bounded(self):
        with patch.object(maintenance.subprocess, 'run', side_effect=subprocess.TimeoutExpired(['ssh'], 1)) as run, patch.object(maintenance.time, 'sleep'):
            with self.assertRaises(subprocess.TimeoutExpired):
                maintenance.run(['ssh'])
            self.assertEqual(run.call_count, 3)
