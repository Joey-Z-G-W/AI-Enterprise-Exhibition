#!/usr/bin/env python3
"""Trusted-main artifact deployment. No self-hosted Actions runner or shell eval."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

REPOSITORY = 'Joey-Z-G-W/AI-Enterprise-Exhibition'
WORKFLOW = '.github/workflows/ci.yml'
PORTS = {'dev': 8090, 'prod': 8091}


def command(*args, capture=True):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if capture else None)
    if result.returncode:
        raise RuntimeError(f'{args[0]} {args[1]} failed: {(result.stderr or "").strip()[-1200:]}')
    return result.stdout.strip() if capture else ''


def api(path, body=None):
    args = ['gh', 'api', f'repos/{REPOSITORY}/{path}']
    if body is None:
        return json.loads(command(*args))
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as request:
        json.dump(body, request)
        request.flush()
        return json.loads(command(*args, '--method', 'POST', '--input', request.name))


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.new')
    temporary.write_text(json.dumps(data, indent=2) + '\n')
    temporary.replace(path)


def read_json(path):
    return json.loads(path.read_text()) if path.exists() else {}


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def inspect(kind, name):
    try:
        return json.loads(command('docker', kind, 'inspect', name))[0]
    except RuntimeError:
        return None


def valid_run(run_id):
    run = api(f'actions/runs/{run_id}')
    if not (run['event'] == 'push' and run['head_branch'] == 'main'
            and run['conclusion'] == 'success' and run['status'] == 'completed'
            and run['path'] == WORKFLOW and run['head_repository']['full_name'] == REPOSITORY
            and re.fullmatch(r'[0-9a-f]{40}', run['head_sha'])):
        raise RuntimeError('Release requires successful fixed-repository push/main Course CI')
    return run


def load_release(state, run_id):
    run = valid_run(run_id)
    sha = run['head_sha']
    directory = state / 'artifacts' / str(run_id)
    directory.mkdir(parents=True, exist_ok=True)
    if not (directory / 'manifest.json').exists():
        command('gh', 'run', 'download', str(run_id), '--repo', REPOSITORY,
                '--name', f'course-image-{sha}', '--dir', str(directory))
    manifest = read_json(directory / 'manifest.json')
    image = f'exhibition-course:{sha}'
    if manifest.get('sha') != sha or manifest.get('image') != image:
        raise RuntimeError('Artifact manifest does not match successful CI SHA')
    if digest(directory / 'image.tar') != manifest.get('sha256'):
        raise RuntimeError('Artifact image checksum mismatch')
    command('docker', 'load', '--input', str(directory / 'image.tar'))
    metadata = inspect('image', image)
    if (not metadata or metadata['Id'] != manifest['image_id']
            or metadata['Config']['Labels'].get('org.opencontainers.image.revision') != sha):
        raise RuntimeError('Loaded image identity does not match verified manifest')
    return {'sha': sha, 'image': image, 'image_id': metadata['Id'], 'run_id': run_id, 'run_url': run['html_url']}


def health(url, sha, seconds=75):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url + '/health', timeout=3) as response:
                result = json.load(response)
            if result.get('status') == 'ok' and result.get('release') == sha:
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError(f'Candidate health/release check failed for {sha}')


def container_health(name, sha):
    deadline = time.monotonic() + 75
    while time.monotonic() < deadline:
        metadata = inspect('container', name)
        if metadata and metadata['State'].get('Health', {}).get('Status') == 'healthy':
            data = command('docker', 'exec', name, 'python', '-c',
                           "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8080/health').read().decode())")
            if json.loads(data).get('release') == sha:
                return
        if metadata and metadata['State']['Status'] in ('exited', 'dead'):
            break
        time.sleep(1)
    raise RuntimeError(f'Candidate health/release check failed for {sha}')


def deploy_release(state, environment, release):
    prefix = f'course-{environment}'
    directory = state / environment
    directory.mkdir(parents=True, exist_ok=True)
    previous_state = read_json(directory / 'state.json')
    current = previous_state.get('current')
    target = f'{prefix}-{release["sha"][:12]}'
    release = {**release, 'container': target, 'verified_at': int(time.time())}
    if not inspect('network', prefix):
        command('docker', 'network', 'create', '--label', 'course.managed=true', prefix)
    if not inspect('volume', f'{prefix}-data'):
        command('docker', 'volume', 'create', '--label', 'course.managed=true', f'{prefix}-data')
    existing = inspect('container', target)
    created = not existing
    if existing and existing['Image'] != release['image_id']:
        raise RuntimeError('Existing candidate has a different image identity')
    if created:
        command('docker', 'run', '-d', '--name', target, '--label', 'course.managed=true',
                '--network', prefix, '--restart', 'unless-stopped', '--read-only', '--tmpfs', '/tmp',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                '--mount', f'type=volume,src={prefix}-data,dst=/data',
                '-e', f'GUIDE_DEMO_COOKIE_NAME=course_{environment}', release['image_id'])
    else:
        command('docker', 'start', target)
    try:
        container_health(target, release['sha'])
    except Exception:
        if created:
            command('docker', 'rm', '-f', target)
        raise
    # Never change the gateway until the actual candidate is healthy.
    old_route = read_json(directory / 'route.json')
    atomic_json(directory / 'route.json', {'target': target})
    gateway = f'{prefix}-gateway'
    try:
        if not inspect('container', gateway):
            command('docker', 'run', '-d', '--name', gateway, '--label', 'course.managed=true',
                    '--network', prefix, '--restart', 'unless-stopped', '--read-only', '--tmpfs', '/tmp',
                    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                    '-p', f'127.0.0.1:{PORTS[environment]}:8080',
                    '--mount', f'type=bind,src={directory.resolve()},dst=/route,readonly',
                    release['image_id'], 'python', '/app/course_proxy.py')
        health(f'http://127.0.0.1:{PORTS[environment]}', release['sha'])
    except Exception:
        if old_route:
            atomic_json(directory / 'route.json', old_route)
        if created:
            command('docker', 'rm', '-f', target)
        raise
    new_state = {'current': release, 'previous': current if current and current['sha'] != release['sha'] else previous_state.get('previous')}
    atomic_json(directory / 'state.json', new_state)
    print(json.dumps({'environment': environment, 'release': release, 'url': f'http://127.0.0.1:{PORTS[environment]}'}), flush=True)
    return release


def record_deployment(environment, release, operation, action):
    deployment = api('deployments', {'ref': release['sha'], 'environment': environment,
                      'auto_merge': False, 'required_contexts': [],
                      'description': f'Course {operation}; verified CI {release["run_id"]}',
                      'payload': {'run_id': release['run_id'], 'image_id': release['image_id'], 'operation': operation}})
    identifier = deployment['id']
    status = {'environment': environment, 'log_url': release['run_url'], 'auto_inactive': True}
    api(f'deployments/{identifier}/statuses', {**status, 'state': 'in_progress'})
    try:
        result = action()
    except Exception:
        api(f'deployments/{identifier}/statuses', {**status, 'state': 'failure', 'description': 'Candidate failed; previous verified route retained'})
        raise
    api(f'deployments/{identifier}/statuses', {**status, 'state': 'success', 'environment_url': f'http://127.0.0.1:{PORTS[environment]}', 'description': f'Healthy {result["sha"][:12]}; persistent SQLite retained'})
    return result


def perform(state, operation, environment='dev', run_id=None):
    if operation == 'deploy':
        release = load_release(state, run_id)
    elif operation == 'promote':
        release = read_json(state / 'dev/state.json').get('current')
        if not release:
            raise RuntimeError('No verified dev release to promote')
        release = load_release(state, release['run_id'])
    else:
        release = read_json(state / environment / 'state.json').get('previous')
        if not release:
            raise RuntimeError('No previous verified release available')
        # Verify the CI record again; the exact image remains local even after artifact expiry.
        run = valid_run(release['run_id'])
        image = inspect('image', release['image_id'])
        if run['head_sha'] != release['sha'] or not image or image['Id'] != release['image_id']:
            raise RuntimeError('Previous verified image is missing or mismatched')
    return record_deployment(environment, release, operation, lambda: deploy_release(state, environment, release))


def watch(state, once=False, interval=30):
    while True:
        try:
            runs = api('actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=10')['workflow_runs']
            if runs:
                run = runs[0]
                current = read_json(state / 'dev/state.json').get('current', {})
                if current.get('run_id') != run['id']:
                    perform(state, 'deploy', run_id=run['id'])
        except Exception as error:
            print(f'Deployment watch: {error}', file=sys.stderr, flush=True)
            if once:
                raise
        if once:
            return
        time.sleep(interval)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, default=Path.home() / '.local/state/exhibition-course')
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('status')
    deploy = sub.add_parser('deploy')
    deploy.add_argument('--run-id', type=int, required=True)
    deploy.add_argument('--environment', choices=PORTS, default='dev')
    sub.add_parser('promote')
    rollback = sub.add_parser('rollback')
    rollback.add_argument('--environment', choices=PORTS, default='prod')
    watcher = sub.add_parser('watch')
    watcher.add_argument('--once', action='store_true')
    watcher.add_argument('--interval', type=int, default=30)
    manifest = sub.add_parser('manifest')
    manifest.add_argument('--sha', required=True)
    manifest.add_argument('--image-tar', required=True, type=Path)
    manifest.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.action == 'status':
        print(json.dumps({environment: read_json(args.state_dir / environment / 'state.json') for environment in PORTS}, indent=2))
        return
    if args.action == 'manifest':
        if not re.fullmatch(r'[0-9a-f]{40}', args.sha):
            raise RuntimeError('Expected full 40-character commit SHA')
        image = f'exhibition-course:{args.sha}'
        metadata = inspect('image', image)
        if not metadata:
            raise RuntimeError('Image does not exist')
        atomic_json(args.output, {'sha': args.sha, 'image': image, 'image_id': metadata['Id'], 'sha256': digest(args.image_tar)})
        return
    args.state_dir.mkdir(parents=True, exist_ok=True)
    # A watcher must not hold the environment lock while sleeping; one iteration is atomic.
    if args.action == 'watch':
        while True:
            with (args.state_dir / 'controller.lock').open('w') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                try:
                    watch(args.state_dir, once=True)
                except Exception:
                    if args.once:
                        raise
            if args.once:
                return
            time.sleep(max(5, args.interval))
    else:
        with (args.state_dir / 'controller.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            perform(args.state_dir, args.action, 'prod' if args.action == 'promote' else args.environment,
                    getattr(args, 'run_id', None))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f'Deployment failed: {error}', file=sys.stderr)
        sys.exit(1)
