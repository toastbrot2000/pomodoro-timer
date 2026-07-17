#!/usr/bin/env python3
"""Tiny self-hosted Pomodoro backend.

Serves the static app from ./public and persists settings + tasks in a SQLite
database. The database path defaults to ./data/pomodoro.db and is overridable
with POMODORO_DB — in Docker that directory is a mounted volume, so data
survives container rebuilds.

Standard library only: no third-party dependencies.
"""

import json
import os
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
DB_PATH = os.environ.get("POMODORO_DB", os.path.join(ROOT, "data", "pomodoro.db"))
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))

DEFAULT_SETTINGS = {
    "pomodoro": 25,
    "shortBreak": 5,
    "longBreak": 15,
    "autoBreak": False,
    "autoPomo": False,
    "interval": 4,
    "sound": True,
    "volume": 50,
}

# server-side clamps mirror the client's, so bad input can't corrupt the DB
INT_BOUNDS = {
    "pomodoro": (1, 180),
    "shortBreak": (1, 180),
    "longBreak": (1, 180),
    "interval": (1, 12),
    "volume": (0, 100),
}
BOOL_KEYS = ("autoBreak", "autoPomo", "sound")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".json": "application/json",
    ".md": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}


# --------------------------------------------------------------------------- db
def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=3000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with connect() as c:
        c.execute(
            "CREATE TABLE IF NOT EXISTS settings("
            "key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        c.execute(
            "CREATE TABLE IF NOT EXISTS tasks("
            "id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "name TEXT NOT NULL,"
            "est INTEGER NOT NULL DEFAULT 1,"
            "done_count INTEGER NOT NULL DEFAULT 0,"
            "done INTEGER NOT NULL DEFAULT 0,"
            "position INTEGER NOT NULL DEFAULT 0)"
        )
        row = c.execute("SELECT value FROM settings WHERE key='settings'").fetchone()
        if row is None:
            c.execute(
                "INSERT INTO settings(key, value) VALUES('settings', ?)",
                (json.dumps(DEFAULT_SETTINGS),),
            )


def get_settings():
    with connect() as c:
        row = c.execute("SELECT value FROM settings WHERE key='settings'").fetchone()
    saved = json.loads(row["value"]) if row else {}
    merged = dict(DEFAULT_SETTINGS)
    merged.update({k: saved[k] for k in DEFAULT_SETTINGS if k in saved})
    return merged


def clamp_settings(data):
    out = dict(DEFAULT_SETTINGS)
    for k in DEFAULT_SETTINGS:
        if k not in data:
            continue
        v = data[k]
        if k in BOOL_KEYS:
            out[k] = bool(v)
        else:
            try:
                n = int(v)
            except (TypeError, ValueError):
                continue
            lo, hi = INT_BOUNDS[k]
            out[k] = max(lo, min(hi, n))
    return out


def save_settings(data):
    merged = clamp_settings(data)
    with connect() as c:
        c.execute(
            "INSERT INTO settings(key, value) VALUES('settings', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (json.dumps(merged),),
        )
    return merged


def task_dict(r):
    return {
        "id": r["id"],
        "name": r["name"],
        "est": r["est"],
        "done_count": r["done_count"],
        "done": bool(r["done"]),
    }


def list_tasks():
    with connect() as c:
        rows = c.execute("SELECT * FROM tasks ORDER BY position, id").fetchall()
    return [task_dict(r) for r in rows]


def create_task(data):
    name = str(data.get("name", "")).strip()[:120]
    if not name:
        return None
    est = max(1, min(99, int(data.get("est", 1) or 1)))
    with connect() as c:
        cur = c.execute(
            "INSERT INTO tasks(name, est, position) VALUES(?, ?, "
            "(SELECT COALESCE(MAX(position), 0) + 1 FROM tasks))",
            (name, est),
        )
        row = c.execute("SELECT * FROM tasks WHERE id=?", (cur.lastrowid,)).fetchone()
    return task_dict(row)


def update_task(task_id, data):
    fields, values = [], []
    if "name" in data:
        name = str(data["name"]).strip()[:120]
        if name:
            fields.append("name=?")
            values.append(name)
    if "est" in data:
        fields.append("est=?")
        values.append(max(1, min(99, int(data["est"] or 1))))
    if "done" in data:
        fields.append("done=?")
        values.append(1 if data["done"] else 0)
    if "done_count" in data:
        fields.append("done_count=?")
        values.append(max(0, int(data["done_count"] or 0)))
    if not fields:
        return None
    values.append(task_id)
    with connect() as c:
        c.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id=?", values)
        row = c.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    return task_dict(row) if row else None


def delete_task(task_id):
    with connect() as c:
        c.execute("DELETE FROM tasks WHERE id=?", (task_id,))


def clear_done_tasks():
    with connect() as c:
        c.execute("DELETE FROM tasks WHERE done=1")
    return list_tasks()


# ---------------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    server_version = "Pomodoro/1.0"

    # -- helpers --
    def _json(self, code, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    def _task_id(self, path):
        try:
            return int(path.rsplit("/", 1)[1])
        except (ValueError, IndexError):
            return None

    # -- static files --
    def serve_static(self, path):
        rel = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(PUBLIC, rel))
        # confine to PUBLIC (block path traversal)
        if os.path.commonpath([full, PUBLIC]) != PUBLIC:
            self.send_error(403)
            return
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            self.send_error(404)
            return
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        if ext == ".woff2":
            self.send_header("Cache-Control", "public, max-age=604800, immutable")
        elif ext in (".css", ".js"):
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    # -- routing --
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/state":
            return self._json(200, {"settings": get_settings(), "tasks": list_tasks()})
        if path == "/api/settings":
            return self._json(200, get_settings())
        if path == "/api/tasks":
            return self._json(200, list_tasks())
        if path.startswith("/api/"):
            return self.send_error(404)
        return self.serve_static(path)

    do_HEAD = do_GET

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/tasks":
            task = create_task(self._read_json())
            return self._json(201, task) if task else self._json(
                400, {"error": "name required"}
            )
        if path == "/api/tasks/clear-done":
            return self._json(200, {"tasks": clear_done_tasks()})
        return self.send_error(404)

    def do_PUT(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/settings":
            return self._json(200, save_settings(self._read_json()))
        return self.send_error(404)

    def do_PATCH(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/tasks/"):
            task_id = self._task_id(path)
            if task_id is None:
                return self.send_error(400)
            task = update_task(task_id, self._read_json())
            return self._json(200, task) if task else self.send_error(404)
        return self.send_error(404)

    def do_DELETE(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/tasks/"):
            task_id = self._task_id(path)
            if task_id is None:
                return self.send_error(400)
            delete_task(task_id)
            self.send_response(204)
            self.end_headers()
            return
        return self.send_error(404)

    def log_message(self, fmt, *args):
        # concise single-line access log
        print(f"{self.address_string()} {self.command} {self.path}")


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Pomodoro running on http://{HOST}:{PORT}  (db: {DB_PATH})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
