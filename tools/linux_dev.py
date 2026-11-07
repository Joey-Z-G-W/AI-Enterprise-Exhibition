"""Own and supervise a local Linux backend + Vite development process group."""
from pathlib import Path
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    os.chdir(ROOT)
    with_opentalking = '--with-opentalking' in sys.argv[1:]
    business = os.environ.get('GUIDE_BUSINESS_PORT', '8010')
    frontend = os.environ.get('GUIDE_FRONTEND_PORT', '5290')
    if business not in {'8010', '8011'}:
        print('GUIDE_BUSINESS_PORT 必须为 8010 或 8011', file=sys.stderr)
        return 2
    if not frontend.isascii() or not frontend.isdecimal() or not 1024 <= int(frontend) <= 65535:
        print('GUIDE_FRONTEND_PORT 必须为 1024–65535', file=sys.stderr)
        return 2
    ports = [int(business), int(frontend)] + ([8210, 8220] if with_opentalking else [])
    if len(set(ports)) != len(ports):
        print('服务端口不能相同', file=sys.stderr)
        return 2
    for port in ports:
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(('127.0.0.1', port))
            except OSError:
                print(f'端口已占用: {port}，请停止原服务或调整 GUIDE_BUSINESS_PORT / GUIDE_FRONTEND_PORT', file=sys.stderr)
                return 1
    children = []
    stopped = False

    def stop(_signum, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    env = {**os.environ, 'GUIDE_BUSINESS_PORT': business}
    try:
        subprocess.run(['node', 'frontend/scripts/prepare-vad-assets.mjs'], check=True, env=env)
        commands = [
            ([sys.executable, '-m', 'uvicorn', 'exhibition_guide.main:create_production_app', '--factory', '--host', '127.0.0.1', '--port', business], ROOT),
            (['node', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', frontend, '--strictPort'], ROOT / 'frontend'),
        ]
        if with_opentalking:
            commands.append((['bash', 'tools/linux.sh', 'embedding'], ROOT))
            commands.append((['bash', 'tools/linux.sh', 'opentalking', 'dev'], ROOT))
        for command, cwd in commands:
            if stopped:
                return 0
            children.append(subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True))
        deadline = time.monotonic() + (180 if with_opentalking else 30)
        ready = False
        while not stopped:
            for child in children:
                if child.poll() is not None:
                    print(f'服务提前退出，退出码 {child.returncode}', file=sys.stderr)
                    return 1
            if not ready:
                try:
                    urls = [f'http://127.0.0.1:{frontend}/guide/health']
                    if with_opentalking:
                        urls.extend(['http://127.0.0.1:8210/health', 'http://127.0.0.1:8220/health'])
                    for url in urls:
                        with client.open(url, timeout=.5) as response:
                            if response.status != 200:
                                raise OSError('service not ready')
                    ready = True
                except OSError:
                    pass
                if ready:
                    print(f'Linux 服务已就绪: http://127.0.0.1:{frontend} （后端 {business}，Ctrl+C 停止）', flush=True)
                elif time.monotonic() > deadline:
                    print('启动超时，请检查上方日志', file=sys.stderr)
                    return 1
            time.sleep(.1)
        return 0
    finally:
        # Only signal process groups created by this invocation.
        for child in children:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


if __name__ == '__main__':
    raise SystemExit(main())
