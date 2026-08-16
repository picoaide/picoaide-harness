# Agent Note: Desktop file logging

Status: implemented

English | [中文](2026-08-16-desktop-logging.zh.md)

## Problem

The desktop Host runs the Cordis root inside the Electron main process, so every log line — `ctx.logger` output through `logger-console` and the explicit `process.stderr.write` calls in the bootstrap and Electron adapter — lands on the process stdout/stderr. In a packaged GUI application that stream is invisible, so developers and reporters cannot retrieve the logs.

## Decision

Add a Cordis `Exporter` that writes formatted log records to files under `app.getPath('userData')/logs/`, registered through `ctx.logger.exporter(...)` in the desktop bootstrap. It does not wrap or redirect `console.*`, `process.stdout`, or `process.stderr`.

Three modules implement it:

- `log-level.ts` — pure verbosity helpers: `LogType`, `LogLevel`, `shouldEmit(type, threshold)`, `isErrorType(type)`.
- `log-files.ts` — a synchronous append-only sink (`appendFileSync`) that writes `dsh-YYYY-MM-DD.log` (all levels) and `dsh-YYYY-MM-DD.error.log` (warn and error), rotates a file past 10MB into `.1`, `.2`, …, switches files when the local date changes, and deletes oldest files while the directory exceeds 200MB.
- `file-exporter.ts` — `FileExporter implements Exporter`, rendering each `Message` as `<local timestamp> [LEVEL] [name] <body>` via `Logger.format`, filtering by the configured threshold, and routing to the sink.

The `dsh-desktop.logLevel` settings field (`debug | info | warn | error`, default `info`) extends the existing `dsh-desktop` namespace. The bootstrap reads it once after `boot()` and subscribes to `settings/updated` to update the exporter threshold in place.

## Alternatives considered

**Wrap `console.*` or `process.stdout` / `process.stderr`.** This causes recursion when the sink itself logs, duplicates every `ctx.logger` line (once from the console exporter, once from the stream wrap), and breaks Electron's devtools and attached-debugger console. The Cordis `Exporter` seam receives structured `Message` records with type, level, timestamp, and name, so a file target needs none of that.

**A single unbounded log file.** Without per-file and directory caps, a long-running session or a noisy plugin fills the disk. The per-day naming plus 10MB rotation plus 200MB directory cap bound growth while keeping logs inspectable by date and severity.

**Reuse the console exporter's renderer.** Its colored, label-aligned output is tuned for a terminal; the file target renders a plainer timestamped line so the file stays readable in editors and paste-through.

## Consequences

Logs persist under the desktop user-data directory and can be inspected after a packaged run. The verbosity threshold is configurable per the standard settings service and applies to both the full and error files. The `logLevel` field is read at startup and on `settings/updated`, so a change applies without a restart.

The desktop bootstrap's own `process.stderr.write` error messages and a settings-page log viewer with manual clear are not yet routed through the sink; they are separate follow-ups.
