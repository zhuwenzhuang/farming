#!/usr/bin/env python3
"""Offline regression for compatibility source ownership and cache integrity."""
import importlib.util
import io
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
OWNER = ROOT / 'scripts/prepare-glibc-runtime.py'
spec = importlib.util.spec_from_file_location('glibc_runtime', OWNER)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def tar_bytes(entries, mode):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode=mode) as archive:
        for name, content in entries.items():
            member = tarfile.TarInfo(name)
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
    return data.getvalue()


class RuntimeTests(unittest.TestCase):
    @unittest.skipUnless(platform.system() == 'Linux', 'legacy glibc installation is Linux-only')
    def test_installer_preserves_old_runtime_and_publishes_digest_siblings(self):
        with tempfile.TemporaryDirectory(prefix='farming-glibc-install-') as directory:
            root = Path(directory)
            release, installed, base = root / 'release', root / 'installed', root / 'runtime'
            (release / 'scripts').mkdir(parents=True)
            (release / 'vendor').mkdir()
            installed.mkdir()
            (base / 'lib').mkdir(parents=True)
            (base / 'lib/ld-2.28.so').write_bytes(b'old-runtime-must-survive')
            installer = release / 'scripts/install-release.sh'
            shutil.copyfile(ROOT / 'scripts/install-release.sh', installer)
            env = {key: value for key, value in os.environ.items() if not key.startswith('FARMING_')}
            env.update(HOME=str(root), FARMING_INSTALL_DIR=str(installed), FARMING_USE_GLIBC_RUNTIME='1')
            bundle = release / 'vendor/glibc228-lib.tar.gz'

            def archive(version):
                with tarfile.open(bundle, 'w:gz') as target:
                    member = tarfile.TarInfo('lib/ld-2.28.so')
                    data = ('fixture-loader-' + version).encode()
                    member.size, member.mode = len(data), 0o755
                    target.addfile(member, io.BytesIO(data))
                return runtime.digest(bundle)

            command = ['bash', '-c', 'set -- stop; source "$0"; ensure_glibc_runtime; printf "%s\\n" "$GLIBC_RUNTIME_ROOT"', str(installer)]
            first_sha = archive('first')
            first_env = {**env, 'FARMING_GLIBC_RUNTIME_ROOT': str(base)}
            first = subprocess.run(command, env=first_env, capture_output=True, check=True, timeout=10)
            first_root = base / first_sha
            self.assertEqual(first.stdout.decode().splitlines()[-1], str(first_root))
            self.assertEqual((base / 'lib/ld-2.28.so').read_bytes(), b'old-runtime-must-survive')
            first_bytes = (first_root / 'lib/ld-2.28.so').read_bytes()
            # A persisted launcher points to the exact old runtime. Upgrading
            # must publish a sibling, and must prefer the incoming archive.
            (installed / '.farming-install-env').write_text('export FARMING_GLIBC_RUNTIME_ROOT=' + str(first_root) + '\n')
            (installed / 'vendor').mkdir()
            shutil.copyfile(bundle, installed / 'vendor/glibc228-lib.tar.gz')
            second_sha = archive('second')
            processes = [subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(2)]
            try:
                for process in processes:
                    stdout, stderr = process.communicate(timeout=10)
                    self.assertEqual(process.returncode, 0, stderr.decode())
                    self.assertEqual(stdout.decode().splitlines()[-1], str(base / second_sha))
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.kill()
                    process.communicate()
            repeated = subprocess.run(command, env=env, capture_output=True, check=True, timeout=10)
            self.assertEqual(repeated.stdout.decode().splitlines()[-1], str(base / second_sha))
            self.assertEqual((first_root / 'lib/ld-2.28.so').read_bytes(), first_bytes)
            self.assertEqual(sorted(item.name for item in base.iterdir()), sorted(['lib', first_sha, second_sha]))
            (base / second_sha / '.archive-sha256').write_text('corrupted')
            rejected = subprocess.run(command, env=env, capture_output=True, timeout=10)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn(b'no matching identity', rejected.stderr)

    def test_glibc_never_comes_from_gcc_carrier(self):
        with tempfile.TemporaryDirectory(prefix='farming-glibc-owner-') as directory:
            root = Path(directory)
            names = ['ld-2.28.so', 'libc.so.6', 'libpthread.so.0', 'libm.so.6',
                     'libdl.so.2', 'librt.so.1']
            entries = {'./lib/x86_64-linux-gnu/' + name: ('patched:' + name).encode()
                       for name in names}
            entries['./lib/x86_64-linux-gnu/libc-2.28.so'] = b'duplicate-versioned-file'
            payload = tar_bytes(entries, 'w:xz')
            header = ('data.tar.xz/    '.ljust(16) + '0'.ljust(12) + '0'.ljust(6)
                      + '0'.ljust(6) + '100644'.ljust(8) + str(len(payload)).ljust(10) + '`\n')
            libc = root / 'libc.deb'
            libc.write_bytes(b'!<arch>\n' + header.encode() + payload)
            carrier = root / 'gcc.tgz'
            carrier.write_bytes(tar_bytes({
                **{'lib/' + name: b'BROKEN-OLD-GLIBC' for name in names},
                'lib/libgcc_s.so.1': b'gcc', 'lib/libstdc++.so.6': b'stdcpp',
                '../must-not-extract': b'outside',
            }, 'w:gz'))
            first, second = root / 'first.tgz', root / 'second.tgz'
            runtime.assemble(libc, carrier, first)
            runtime.assemble(libc, carrier, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with tarfile.open(first) as archive:
                self.assertTrue(all(member.isfile() for member in archive.getmembers()))
                for name in names:
                    self.assertEqual(archive.extractfile('lib/' + name).read(), ('patched:' + name).encode())
                self.assertEqual(archive.extractfile('lib/libgcc_s.so.1').read(), b'gcc')
                self.assertEqual(archive.extractfile('lib/libstdc++.so.6').read(), b'stdcpp')
                self.assertNotIn('lib/libc-2.28.so', archive.getnames())
            self.assertFalse((root.parent / 'must-not-extract').exists())

    def test_corrupt_explicit_and_cache_fail_without_replacing_bytes(self):
        with tempfile.TemporaryDirectory(prefix='farming-glibc-integrity-') as directory:
            root = Path(directory)
            env = {key: value for key, value in os.environ.items()
                   if key not in ['FARMING_GLIBC_RUNTIME_CACHE', 'FARMING_GLIBC_RUNTIME_BUNDLE']}
            for variable in ['FARMING_GLIBC_RUNTIME_BUNDLE', 'FARMING_GLIBC_RUNTIME_CACHE']:
                base = root / variable
                target = Path(str(base) + '.' + runtime.SOURCE['recipe']) if variable.endswith('CACHE') else base
                target.write_bytes(b'corrupt cached runtime')
                result = subprocess.run(['python3', '-B', str(OWNER), str(root / 'unused')],
                                        env={**env, variable: str(base)}, capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'integrity mismatch', result.stderr)
                self.assertEqual(target.read_bytes(), b'corrupt cached runtime')
                self.assertFalse((root / 'unused').exists())


if __name__ == '__main__':
    unittest.main()
