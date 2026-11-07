#!/usr/bin/env python3
"""Download exact successful CI image artifacts; this command never deploys."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = 'Joey-Z-G-W/AI-Enterprise-Exhibition'
WORKFLOW = '.github/workflows/ci.yml'
BLOCK_BYTES = 1024 * 1024
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def gh(*arguments):
    result = subprocess.run(['gh', *arguments], capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError('GitHub CLI authentication or metadata request failed')
    return result.stdout.strip()


def metadata(run_id, sha, name):
    run = json.loads(gh('api', '--hostname', 'github.com', f'repos/{REPOSITORY}/actions/runs/{run_id}'))
    if not (run.get('id') == run_id and run.get('status') == 'completed' and run.get('conclusion') == 'success'
            and run.get('path') == WORKFLOW
            and name in {f'course-image-{sha}', f'course-qa-image-{sha}'}
            and run.get('head_repository', {}).get('full_name') == REPOSITORY
            and re.fullmatch(r'[0-9a-f]{40}', sha)):
        raise RuntimeError('Artifact requires exact successful fixed-repository Course CI')
    items = json.loads(gh('api', '--hostname', 'github.com', f'repos/{REPOSITORY}/actions/runs/{run_id}/artifacts?per_page=100'))['artifacts']
    selected = [item for item in items if item.get('name') == name and not item.get('expired')]
    if len(selected) != 1:
        raise RuntimeError('Expected one unexpired image artifact from the exact CI run')
    artifact = selected[0]
    source = artifact.get('workflow_run', {})
    if (source.get('id') != run_id or source.get('head_sha') != run['head_sha'] or source.get('head_branch') != run['head_branch']
            or not isinstance(source.get('repository_id'), int)
            or source['repository_id'] != run.get('repository', {}).get('id')
            or source.get('head_repository_id') != source['repository_id']
            or not isinstance(artifact.get('id'), int) or artifact['id'] <= 0
            or not re.fullmatch(r'sha256:[0-9a-f]{64}', artifact.get('digest', ''))
            or not isinstance(artifact.get('size_in_bytes'), int)
            or not 0 < artifact['size_in_bytes'] <= MAX_ARCHIVE_BYTES):
        raise RuntimeError('Artifact source, checksum or size metadata is invalid')
    return artifact


def archive_url(artifact_id):
    token = gh('auth', 'token', '--hostname', 'github.com')
    request = urllib.request.Request(
        f'https://api.github.com/repos/{REPOSITORY}/actions/artifacts/{artifact_id}/zip',
        headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'})
    # Capture the API redirect without following it or forwarding Authorization.
    try:
        response = urllib.request.build_opener(NoRedirect()).open(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    try:
        if response.code != 302:
            raise RuntimeError('GitHub did not return the expected artifact redirect')
        location = response.headers.get('Location', '')
    finally:
        response.close()
    parsed = urllib.parse.urlsplit(location)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError('Artifact redirect must use HTTPS without userinfo')
    return location


def read_range(url, first, last, total):
    # Fresh request: never reuse the API authorization header or cookies.
    request = urllib.request.Request(url, headers={'Range': f'bytes={first}-{last}', 'Accept-Encoding': 'identity'})
    deadline = time.monotonic() + 180
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        if response.status != 206 or response.headers.get('Content-Range') != f'bytes {first}-{last}/{total}':
            raise RuntimeError('Artifact server returned an incorrect byte range')
        expected = last - first + 1
        content = bytearray()
        while len(content) <= expected:
            if time.monotonic() > deadline:
                raise RuntimeError('Artifact range exceeded its time budget')
            block = response.read(min(65536, expected + 1 - len(content)))
            if not block:
                break
            content.extend(block)
        if len(content) != expected:
            raise RuntimeError('Artifact range length mismatch')
        return content


def checksum(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(BLOCK_BYTES), b''):
            result.update(block)
    return result.hexdigest()


def extract_verified(archive, expected_digest, destination):
    if checksum(archive) != expected_digest.removeprefix('sha256:'):
        raise RuntimeError('GitHub archive SHA256 mismatch; refusing extraction')
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) != 2 or {item.filename for item in entries} != {'image.tar', 'manifest.json'}:
            raise RuntimeError('Artifact archive must contain exactly image.tar and manifest.json')
        for item in entries:
            if (stat.S_ISLNK(item.external_attr >> 16) or item.is_dir() or item.flag_bits & 1
                    or item.file_size > (MAX_ARCHIVE_BYTES if item.filename == 'image.tar' else BLOCK_BYTES)):
                raise RuntimeError('Unsafe or oversized artifact archive entry')
        for item in entries:
            with bundle.open(item) as source, (destination / item.filename).open('wb') as target:
                shutil.copyfileobj(source, target, BLOCK_BYTES)
                target.flush()
                os.fsync(target.fileno())


def download_release(run_id, sha, destination, name=None):
    """Publish a complete cache only after metadata, range and archive checks."""
    try:
        artifact = metadata(run_id, sha, name or f'course-image-{sha}')
        identity = {'run_id': run_id, 'sha': sha, 'artifact_id': artifact['id'], 'digest': artifact['digest']}
        if destination.is_symlink() or destination.exists() and not destination.is_dir():
            raise RuntimeError('Artifact cache path is not a directory')
        allowed = {'image.tar', 'manifest.json', 'verified-artifact.json', 'artifact.zip'}
        if destination.exists() and any(item.name not in allowed or item.is_symlink() for item in destination.iterdir()):
            raise RuntimeError('Refusing an unexpected or symlinked artifact cache entry')
        marker = destination / 'verified-artifact.json'
        if marker.exists() and json.loads(marker.read_text()) == identity:
            if (destination / 'manifest.json').is_file() and (destination / 'image.tar').is_file():
                return
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=f'.{run_id}-', dir=destination.parent) as temporary:
            staging = Path(temporary)
            archive = staging / 'archive.zip'
            url = archive_url(artifact['id'])
            total = artifact['size_in_bytes']
            # Establish strict range support before creating a parallel transfer.
            read_range(url, 0, 0, total)
            with archive.open('wb') as output:
                output.truncate(total)
                descriptor = output.fileno()

                def fetch(first, last):
                    for attempt in range(3):
                        try:
                            content = read_range(url, first, last, total)
                            if os.pwrite(descriptor, content, first) != len(content):
                                raise RuntimeError('Incomplete artifact file write')
                            return
                        except Exception:
                            if attempt == 2:
                                raise RuntimeError('Artifact byte range failed after three attempts') from None
                            time.sleep(attempt + 1)

                with ThreadPoolExecutor(max_workers=16) as pool:
                    futures = [pool.submit(fetch, first, min(first + BLOCK_BYTES, total) - 1)
                               for first in range(0, total, BLOCK_BYTES)]
                    for future in as_completed(futures):
                        future.result()
                output.flush()
                os.fsync(descriptor)
            complete = staging / 'complete'
            complete.mkdir()
            extract_verified(archive, artifact['digest'], complete)
            (complete / 'verified-artifact.json').write_text(json.dumps(identity) + '\n')
            # Readers can never observe an early manifest or partially extracted tar.
            previous = staging / 'previous-cache'
            if destination.exists():
                destination.rename(previous)
            try:
                complete.rename(destination)
            except OSError:
                if previous.exists():
                    previous.rename(destination)
                raise
        print(json.dumps({'artifact_download': 'verified', **identity}), flush=True)
    except RuntimeError:
        raise
    except Exception:
        # Network exceptions can embed signed URLs. Never leak their message.
        raise RuntimeError('Artifact transfer or verification failed; cache was not published') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', type=int, required=True)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--name', help='Exact image artifact name; defaults to course-image-<sha>')
    args = parser.parse_args()
    download_release(args.run_id, args.sha, args.output, args.name)


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        print(f'Artifact download failed: {error}', file=__import__('sys').stderr)
        raise SystemExit(1)
