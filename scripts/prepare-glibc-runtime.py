#!/usr/bin/env python3
"""Prepare one pinned compatibility runtime for app bundles and npm images.

All glibc libraries come from the same patched Debian build. The historical
carrier supplies only GCC's two runtime libraries, never libc or pthread.
"""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = json.loads((ROOT / 'backend/data/glibc-runtime-source.json').read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(path):
    if not path.is_file() or digest(path) != SOURCE['archiveSha256']:
        raise RuntimeError('Private glibc runtime integrity mismatch: ' + str(path))


def download(source, destination):
    subprocess.run(['curl', '-fsSL', '--connect-timeout', '20', '--max-time', '300',
                    source['url'], '-o', str(destination)], check=True, timeout=310)
    if digest(destination) != source['sha256']:
        raise RuntimeError('Compatibility runtime source checksum mismatch')


def deb_payload(data):
    if data[:8] != b'!<arch>\n':
        raise RuntimeError('Invalid Debian archive')
    offset = 8
    while offset + 60 <= len(data):
        header = data[offset:offset + 60]
        size = int(header[48:58])
        offset += 60
        if header[:16].decode().strip().rstrip('/') == 'data.tar.xz':
            return data[offset:offset + size]
        offset += size + size % 2
    raise RuntimeError('Debian runtime payload missing')


def assemble(libc, carrier, output):
    entries = {}
    with tarfile.open(fileobj=io.BytesIO(deb_payload(libc.read_bytes())), mode='r:xz') as archive:
        for member in archive.getmembers():
            # Dereference only this package's exact SONAMEs. Never extract paths.
            if not member.name.startswith('./lib/x86_64-linux-gnu/'):
                continue
            name = member.name.rsplit('/', 1)[-1]
            if name == 'ld-2.28.so' or re.fullmatch(r'[^/]+\.so\.[0-9]+', name):
                entries['lib/' + name] = archive.extractfile(member).read()
    with tarfile.open(carrier, 'r:gz') as archive:
        for name in ['libgcc_s.so.1', 'libstdc++.so.6']:
            matches = [member for member in archive.getmembers()
                       if member.name.rsplit('/', 1)[-1] == name]
            if len(matches) != 1:
                raise RuntimeError('GCC runtime is missing or ambiguous: ' + name)
            entries['lib/' + name] = archive.extractfile(matches[0]).read()
    for name in ['ld-2.28.so', 'libc.so.6', 'libpthread.so.0', 'libm.so.6',
                 'libdl.so.2', 'librt.so.1', 'libgcc_s.so.1', 'libstdc++.so.6']:
        if 'lib/' + name not in entries:
            raise RuntimeError('Required compatibility library missing: ' + name)
    for name in ['LICENSE.glibc', 'LICENSE.gcc', 'LICENSE.gcc-runtime']:
        entries[name] = (ROOT / 'backend/data' / name).read_bytes()
    entries['NOTICE'] = (
        'GNU C Library 2.28-10+deb10u4 (LGPL-2.1-or-later), including Bug 23844 fixes.\n'
        'Source: https://archive.debian.org/debian-security/pool/updates/main/g/glibc/\n'
        'GCC runtime libraries: GPL-3.0 with GCC Runtime Library Exception.\n'
        'GCC carrier: ' + SOURCE['gccCarrier']['url'] + '\n'
        'Recipe: ' + SOURCE['recipe'] + '\n'
    ).encode()
    # Fixed metadata makes the complete archive independently hash-verifiable.
    with output.open('wb') as raw:
        with gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for name, data in sorted(entries.items()):
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    member.mode = 0o755 if name.startswith('lib/') else 0o644
                    archive.addfile(member, io.BytesIO(data))


def check_runtime(archive_path, temporary):
    if platform.system() != 'Linux' or platform.machine() not in ['x86_64', 'amd64']:
        return
    runtime = temporary / 'runtime'
    runtime.mkdir()
    with tarfile.open(archive_path, 'r:gz') as archive:
        for member in archive.getmembers():
            if member.name.startswith('lib/') and member.isfile():
                target = runtime / member.name.rsplit('/', 1)[-1]
                target.write_bytes(archive.extractfile(member).read())
                target.chmod(0o755)
    subprocess.run(['bash', str(ROOT / 'scripts/check-glibc-rwlock.sh'), str(runtime)],
                   check=True, timeout=30)


def main():
    if len(sys.argv) != 2:
        raise RuntimeError('Usage: prepare-glibc-runtime.py OUTPUT_ARCHIVE')
    explicit = os.environ.get('FARMING_GLIBC_RUNTIME_BUNDLE')
    cache_base = os.environ.get('FARMING_GLIBC_RUNTIME_CACHE')
    # Never overwrite or reinterpret a cache used by an older Farming build.
    output = Path(explicit or (cache_base + '.' + SOURCE['recipe'] if cache_base else sys.argv[1])).resolve()
    if explicit or output.exists():
        verify(output)
    else:
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.glibc-prepare-', dir=output.parent) as directory:
            temporary = Path(directory)
            libc, carrier = temporary / 'libc.deb', temporary / 'gcc.tgz'
            download(SOURCE['libc'], libc)
            download(SOURCE['gccCarrier'], carrier)
            staged = temporary / 'runtime.tar.gz'
            assemble(libc, carrier, staged)
            verify(staged)
            os.replace(staged, output)
    with tempfile.TemporaryDirectory(prefix='farming-glibc-check-') as directory:
        check_runtime(output, Path(directory))
    print(output)


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError, tarfile.TarError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
