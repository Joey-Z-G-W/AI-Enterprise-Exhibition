"""Small loopback deployment gateway; route changes are atomic host file updates."""
import http.client
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade'}


class Proxy(BaseHTTPRequestHandler):
    def forward(self):
        connection = None
        try:
            route = json.loads(Path('/route/route.json').read_text())
            connection = http.client.HTTPConnection(route['target'], 8080, timeout=30)
            length = int(self.headers.get('Content-Length', '0'))
            if length > 131072:
                self.send_error(413)
                return
            body = self.rfile.read(length) if length else None
            headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
            connection.request(self.command, self.path, body, headers)
            response = connection.getresponse()
            data = response.read()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in HOP | {'content-length'}:
                    self.send_header(key, value)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (OSError, ValueError, http.client.HTTPException):
            self.send_error(503, 'Guide temporarily unavailable')
        finally:
            if connection:
                connection.close()

    do_GET = do_POST = do_DELETE = do_PUT = do_PATCH = do_HEAD = forward

    def log_message(self, *_):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8080), Proxy).serve_forever()
