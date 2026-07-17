# Pomodoro

A self-hosted Pomodoro timer I made for myself. Your settings and
tasks are stored in a **SQLite database on a Docker volume**, so they survive
container rebuilds and redeploys.

Backend is **Python standard library only** (no third-party dependencies).

## Features

- **Analog dial** engraved minute ticks and a depleting arc that unwinds as
  time runs down
- **Three modes** Focus, Short Break, Long Break
- **Task list** estimated pomodoros, done counts, active-task selection
- **Cycle pips** show progress toward the next long break
- **Auto-cycling** long break after a configurable number of pomodoros
- **Customizable** durations, auto-start breaks/pomodoros, alarm sound & volume
- **Synthesized alarm** via the Web Audio API (no audio files) + optional desktop notifications
- **Keyboard** — `Space` to start/pause, `Esc` to close settings
- Tab title counts down so you can track time from another tab
- Self-hosted fonts (Space Grotesk + Space Mono)

## Run it

### Docker Compose (recommended)

```bash
docker compose up -d --build
```

Open <http://localhost:8080>. Data persists in the `pomodoro-data` volume.

### Plain Docker

```bash
docker build -t pomodoro-timer .
docker run -d -p 8080:8080 -v pomodoro-data:/data --name pomodoro-timer pomodoro-timer
```

### Without Docker (needs Python 3.8+)

```bash
python server.py
```

Serves on <http://localhost:8080> and writes the database to `./data/pomodoro.db`.
Override with environment variables: `PORT`, `HOST`, `POMODORO_DB`.

## Data & persistence

The SQLite database holds two things: a `settings` row and a `tasks` table.
It lives at `POMODORO_DB` (default `/data/pomodoro.db` in the container). Because
`/data` is a named Docker volume, `docker compose down && docker compose up --build`
keeps your data. To wipe it: `docker volume rm pomodoro-data`.

## API

Small REST API (same contract the front-end uses):

| Method   | Path                    | Purpose                          |
| -------- | ----------------------- | -------------------------------- |
| `GET`    | `/api/state`            | `{ settings, tasks }` (one call) |
| `GET`    | `/api/settings`         | current settings                 |
| `PUT`    | `/api/settings`         | replace settings                 |
| `GET`    | `/api/tasks`            | list tasks                       |
| `POST`   | `/api/tasks`            | create `{ name, est }`           |
| `PATCH`  | `/api/tasks/{id}`       | update name/est/done/done_count  |
| `DELETE` | `/api/tasks/{id}`       | delete a task                    |
| `POST`   | `/api/tasks/clear-done` | delete finished tasks            |

Values are clamped server-side, so bad input can't corrupt the database.

## Project layout

```
server.py            stdlib HTTP server + SQLite persistence
public/
  index.html         markup
  style.css          styles, per-mode accents, dial
  app.js             timer, dial, tasks, settings (vanilla JS)
  fonts/             self-hosted woff2 + OFL license
Dockerfile           python:3.12-slim, non-root, /data volume
docker-compose.yml   one-command run with a named volume
data/                local SQLite db (gitignored)
```

## Design

<img width="741" height="1325" alt="image" src="https://github.com/user-attachments/assets/f8877167-9877-4c75-94f4-bdba7dcff984" />


## License

App: [MIT](LICENSE). Bundled fonts: [SIL OFL 1.1](public/fonts/LICENSE.md).
