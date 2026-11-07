"""Credential-free sample guide: real SQLite persistence and local fact retrieval.

This intentionally separate factory leaves the existing GPU application unchanged.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator


class QuestionInput(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    request_id: str = Field(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
    question: str = Field(min_length=1, max_length=2000)
    exhibit_id: str | None = Field(default=None, max_length=64)

    @field_validator('question')
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError('Question must not be blank')
        return value


class FeedbackInput(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    request_id: str = Field(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
    rating: int = Field(ge=1, le=5)


def create_demo_app() -> FastAPI:
    database = Path(os.environ.get('GUIDE_DEMO_DB', 'data/demo/guide.sqlite3')).resolve()
    database.parent.mkdir(parents=True, exist_ok=True)
    cookie_name = os.environ.get('GUIDE_DEMO_COOKIE_NAME', 'guide_demo_visitor')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', cookie_name):
        raise RuntimeError('Invalid demo cookie name')
    secure_cookie = os.environ.get('GUIDE_DEMO_COOKIE_SECURE', '0') == '1'
    release = os.environ.get('GUIDE_RELEASE_ID', 'local-development')[:128]
    static_dir = Path(os.environ['GUIDE_STATIC_DIR']).resolve() if os.environ.get('GUIDE_STATIC_DIR') else None
    sample_dir = Path(__file__).parent / 'sample_data'
    sample_bytes = (sample_dir / 'catalog.json').read_bytes()
    manifest = json.loads((sample_dir / 'manifest.json').read_text())
    digest = hashlib.sha256(sample_bytes).hexdigest()
    if digest != manifest['sha256']:
        raise RuntimeError('Sample catalog checksum verification failed')
    catalog = json.loads(sample_bytes)
    exhibits = {item['id']: item for item in catalog['exhibits']}

    @contextmanager
    def connection(write=False):
        conn = sqlite3.connect(database, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        try:
            if write:
                conn.execute('BEGIN IMMEDIATE')
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    with connection() as conn:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, visitor_id TEXT UNIQUE NOT NULL,
                active INTEGER NOT NULL DEFAULT 1, epoch INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS questions (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(token_hash),
                request_id TEXT NOT NULL, question TEXT NOT NULL, exhibit_id TEXT,
                answer TEXT NOT NULL, feedback INTEGER CHECK(feedback BETWEEN 1 AND 5),
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS questions_session ON questions(session_id, created_at);
            CREATE TABLE IF NOT EXISTS operations (
                session_id TEXT NOT NULL REFERENCES sessions(token_hash), request_id TEXT NOT NULL,
                body_hash TEXT NOT NULL, response TEXT NOT NULL, epoch INTEGER NOT NULL,
                PRIMARY KEY(session_id, request_id)
            );
        ''')

    app = FastAPI(title='Future Commons Sample Guide', docs_url=None, redoc_url=None)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request, _error):
        # Pydantic's default response echoes input; do not publish arbitrary content.
        return JSONResponse({'detail': 'Invalid request: check required fields, length and rating (1-5).'}, status_code=422)

    @app.exception_handler(sqlite3.Error)
    async def storage_error(_request, _error):
        return JSONResponse({'detail': 'Storage is temporarily unavailable. Retry the same submission.'}, status_code=503)

    @app.middleware('http')
    async def browser_boundary(request, call_next):
        if request.url.path.startswith('/api/'):
            origin = request.headers.get('origin')
            if origin:
                try:
                    parsed = urlsplit(origin)
                except ValueError:
                    return JSONResponse({'detail': 'Cross-origin requests are not allowed.'}, status_code=403)
                if parsed.scheme != request.url.scheme or parsed.netloc != request.url.netloc:
                    return JSONResponse({'detail': 'Cross-origin requests are not allowed.'}, status_code=403)
            if request.headers.get('sec-fetch-site') == 'cross-site':
                return JSONResponse({'detail': 'Cross-site requests are not allowed.'}, status_code=403)
            length = request.headers.get('content-length', '0')
            if not length.isdigit() or int(length) > 16384:
                return JSONResponse({'detail': 'Request body is too large.'}, status_code=413)
        response = await call_next(request)
        if request.url.path.startswith('/api/') or request.url.path == '/health':
            response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    def session(conn, request):
        token = request.cookies.get(cookie_name, '')
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        row = conn.execute('SELECT * FROM sessions WHERE token_hash=? AND active=1', (token_hash,)).fetchone()
        if row is None:
            raise HTTPException(401, 'Start or refresh your visitor session before submitting.')
        return row

    def create_session(conn, response):
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        visitor_id = str(uuid4())
        conn.execute('INSERT INTO sessions(token_hash, visitor_id, created_at) VALUES (?, ?, ?)', (token_hash, visitor_id, datetime.now(timezone.utc).isoformat()))
        response.set_cookie(cookie_name, token, max_age=365 * 24 * 3600, httponly=True, secure=secure_cookie, samesite='strict', path='/')
        return {'visitor_id': visitor_id, 'history': []}

    def record(row):
        return {'id': row['id'], 'request_id': row['request_id'], 'question': row['question'], 'exhibit_id': row['exhibit_id'], 'answer': json.loads(row['answer']), 'feedback': row['feedback'], 'created_at': row['created_at']}

    def replay(conn, visitor, request_id, body):
        body_hash = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        prior = conn.execute('SELECT * FROM operations WHERE session_id=? AND request_id=?', (visitor['token_hash'], request_id)).fetchone()
        if prior:
            if prior['body_hash'] != body_hash or prior['epoch'] != visitor['epoch']:
                raise HTTPException(409, 'This submission ID was already used or its history was cleared. Start a new submission.')
            return body_hash, json.loads(prior['response'])
        return body_hash, None

    def remember(conn, visitor, request_id, body_hash, result):
        conn.execute('INSERT INTO operations VALUES (?, ?, ?, ?, ?)', (visitor['token_hash'], request_id, body_hash, json.dumps(result), visitor['epoch']))

    def retrieve(question, exhibit_id):
        tokens = set(re.findall(r'[a-z0-9]+', question.lower()))
        if exhibit_id:
            candidates = [exhibits[exhibit_id]]
        else:
            # A distinct exhibit name takes precedence over a shared noun.
            distinct = [e for e in exhibits.values() if e['id'].split('-')[0] in tokens]
            candidates = distinct or [e for e in exhibits.values() if tokens.intersection(e['aliases']) or any(tokens.intersection(f['keywords']) for f in e['facts'])]
        empty = {'status': 'unknown', 'text': 'The public sample catalog does not contain enough information to answer this question.', 'citations': []}
        if not candidates:
            return empty
        if len(candidates) > 1:
            return {'status': 'ambiguous', 'text': 'Please select an exhibit: ' + ', '.join(e['name'] for e in candidates) + '.', 'citations': []}
        exhibit = candidates[0]
        facts = [f for f in exhibit['facts'] if tokens.intersection(f['keywords'])]
        if not facts:
            return empty
        citations = [{'fact_id': f['id'], 'exhibit_id': exhibit['id'], 'exhibit_name': exhibit['name'], 'excerpt': f['text'], 'source_id': catalog['provenance']['source_id'], 'sha256': digest, 'license': catalog['license']['id']} for f in facts]
        if any(f.get('conflict_group') for f in facts):
            return {'status': 'conflicting', 'text': 'The fictional source notes conflict about the opening date. The correct date cannot be confirmed from this catalog.', 'citations': citations}
        return {'status': 'supported', 'text': ' '.join(f['text'] for f in facts), 'citations': citations}

    @app.get('/health')
    def health():
        with connection() as conn:
            conn.execute('SELECT 1 FROM sessions LIMIT 1').fetchone()
        return {'status': 'ok', 'release': release}

    @app.get('/api/exhibits')
    def get_exhibits():
        return {**catalog, 'sha256': digest, 'mode': 'local-sample-retrieval'}

    @app.get('/api/session')
    def get_session(request: Request, response: Response):
        with connection(write=True) as conn:
            try:
                visitor = session(conn, request)
            except HTTPException:
                return create_session(conn, response)
            rows = conn.execute('SELECT * FROM questions WHERE session_id=? ORDER BY created_at, rowid', (visitor['token_hash'],)).fetchall()
            return {'visitor_id': visitor['visitor_id'], 'history': [record(row) for row in rows]}

    @app.post('/api/questions', status_code=201)
    def ask(body: QuestionInput, request: Request):
        if body.exhibit_id is not None and body.exhibit_id not in exhibits:
            raise HTTPException(422, 'Choose an exhibit from the public catalog.')
        with connection(write=True) as conn:
            visitor = session(conn, request)
            body_hash, previous = replay(conn, visitor, body.request_id, {'operation': 'question', **body.model_dump()})
            if previous is not None:
                return previous
            result = {'id': str(uuid4()), 'request_id': body.request_id, 'question': body.question.strip(), 'exhibit_id': body.exhibit_id, 'answer': retrieve(body.question, body.exhibit_id), 'feedback': None, 'created_at': datetime.now(timezone.utc).isoformat()}
            conn.execute('INSERT INTO questions VALUES (?, ?, ?, ?, ?, ?, ?, ?)', (result['id'], visitor['token_hash'], body.request_id, result['question'], body.exhibit_id, json.dumps(result['answer']), None, result['created_at']))
            remember(conn, visitor, body.request_id, body_hash, result)
            return result

    @app.post('/api/questions/{question_id}/feedback')
    def feedback(question_id: str, body: FeedbackInput, request: Request):
        with connection(write=True) as conn:
            visitor = session(conn, request)
            row = conn.execute('SELECT id FROM questions WHERE id=? AND session_id=?', (question_id, visitor['token_hash'])).fetchone()
            if row is None:
                raise HTTPException(404, 'Question not found for this visitor.')
            body_hash, previous = replay(conn, visitor, body.request_id, {'operation': 'feedback', 'question_id': question_id, **body.model_dump()})
            if previous is not None:
                return previous
            conn.execute('UPDATE questions SET feedback=? WHERE id=?', (body.rating, question_id))
            result = {'question_id': question_id, 'rating': body.rating, 'request_id': body.request_id}
            remember(conn, visitor, body.request_id, body_hash, result)
            return result

    @app.delete('/api/history')
    def clear_history(request: Request):
        with connection(write=True) as conn:
            visitor = session(conn, request)
            count = conn.execute('DELETE FROM questions WHERE session_id=?', (visitor['token_hash'],)).rowcount
            conn.execute('UPDATE sessions SET epoch=epoch+1 WHERE token_hash=?', (visitor['token_hash'],))
            # Retain only a retry tombstone, not cleared question/answer content.
            conn.execute("UPDATE operations SET response='{}' WHERE session_id=?", (visitor['token_hash'],))
            return {'deleted': count}

    @app.post('/api/visitors/new')
    def new_visitor(request: Request, response: Response):
        with connection(write=True) as conn:
            visitor = session(conn, request)
            conn.execute('UPDATE sessions SET active=0 WHERE token_hash=?', (visitor['token_hash'],))
            return create_session(conn, response)

    @app.get('/{path:path}')
    def frontend(path: str):
        if path == 'api' or path.startswith('api/') or static_dir is None:
            raise HTTPException(404, 'Not found')
        target = (static_dir / path).resolve()
        if not target.is_relative_to(static_dir):
            raise HTTPException(404, 'Not found')
        if target.is_file():
            return FileResponse(target)
        index = static_dir / 'index.html'
        if index.is_file() and not Path(path).suffix:
            return FileResponse(index)
        raise HTTPException(404, 'Not found')

    return app
