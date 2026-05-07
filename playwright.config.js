// Playwright config — drives the SPA + API end-to-end through a
// real browser. Complements the Node test runner suite:
//
//   npm test           → 38 fast tests (unit + integration via
//                        HTTP API). No browser, no SPA.
//   npm run test:e2e   → this file. Boots the production build,
//                        clicks through the actual UI, asserts
//                        what the user sees.
//
// Convention: tests live in test/e2e/. The default test/ dir is
// covered by `npm test` (Node test runner), so the two suites
// don't interfere.

const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./test/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,        // fail the build if .only slipped in
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  // Long enough for `npm run build` (~1s) + the server's first
  // boot read of schema_meta + audit purge (~200ms). The
  // `npm start` script serves dist/ statically, so no Vite dev
  // server in the loop.
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3097",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // Boots a server on :3097 if one isn't already running. We
  // run on a non-default port so a developer with `npm start`
  // already going on :3000 can run e2e in parallel without a
  // port collision. PORT + DB_DATABASE are passed through the
  // env so the e2e suite uses the same Postgres the integration
  // tests use (diverecorder_test).
  webServer: {
    command: "npm run build && PORT=3097 node server.js",
    url: "http://127.0.0.1:3097/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: "3097",
      // Point at the local test DB created in `npm test` setup.
      DB_DATABASE: process.env.DB_DATABASE || "diverecorder_test",
      // Disable the auth + bulk-write rate limiters for the suite.
      // Every request comes from 127.0.0.1 so the production limit
      // (20 auth req / 15 min / IP) trips after a few tests and
      // poisons the rest with 429s. The bypass is opt-in via env
      // var — production .env never sets it.
      RATE_LIMIT_DISABLED: "true",
    },
  },
});
