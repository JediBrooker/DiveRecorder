// Structured logging — Pino-backed.
//
// Why Pino: every event is one JSON line, parseable by every log
// aggregator on the planet. The hot path is ~10× faster than
// console.log because it doesn't have to format. In dev we pipe
// through pino-pretty so the output stays human-readable.
//
// Usage:
//   const logger = require("./lib/logger");
//   logger.info({ event_id: "...", judge_id: "..." }, "score submitted");
//   logger.warn({ err }, "audit log skipped");
//
// Per-module loggers are first-class — pass a `module` field once
// and every child log inherits it:
//   const log = logger.child({ module: "socket" });
//
// LOG_LEVEL env (trace|debug|info|warn|error|fatal) controls
// verbosity. Default `info` in production, `debug` in dev.
//
// We intentionally KEEP existing console.* calls in route
// handlers for now — Pino runs alongside as the structured
// channel, and the pretty-printed dev output is byte-for-byte
// compatible with what an operator already expects to see.
// Future commits can migrate hot paths file-by-file.

const pino = require("pino");

const isDev = process.env.NODE_ENV !== "production";
const level = process.env.LOG_LEVEL || (isDev ? "debug" : "info");

const logger = pino({
  level,
  // Strip the host's PID + hostname from every record — they're
  // not useful in container deploys and they double the log
  // volume on noisy boxes. The container orchestrator (PM2,
  // systemd, k8s) attaches its own metadata.
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact any field that might leak credentials. Pino's redactor
  // is path-based and runs before serialization.
  redact: {
    paths: [
      "req.headers.authorization",
      "headers.authorization",
      "*.password",
      "*.token",
      "*.jwt",
      "*.secret",
    ],
    censor: "[redacted]",
  },
  // Pretty-print in dev. Production stdout stays raw JSON so the
  // log shipper can parse it without a shell pipe.
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      }
    : undefined,
});

module.exports = logger;
