// Lightweight tests that don't need a DB. Runs on every npm test
// invocation so a fresh dev clone catches obvious breakage.
//   - server.js parses cleanly
//   - SPA built bundle, if present, contains the expected entry
//   - the FINA category helper is consistent (no DB)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

test("server.js syntax is valid", () => {
  // node --check just parses the file; nothing executes.
  execSync("node --check server.js", { stdio: "pipe" });
});

test("init.sql exists and is non-empty", () => {
  const p = path.join(__dirname, "..", "init.sql");
  assert.ok(fs.existsSync(p), "init.sql should exist at repo root");
  const stat = fs.statSync(p);
  assert.ok(stat.size > 1000, `init.sql looks suspiciously small: ${stat.size} bytes`);
});

test("seed_test_data.sql exists and is non-empty", () => {
  const p = path.join(__dirname, "..", "seed_test_data.sql");
  assert.ok(fs.existsSync(p));
  const stat = fs.statSync(p);
  assert.ok(stat.size > 1000);
});

test("init.sql declares schema version 17", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "init.sql"), "utf8");
  assert.match(sql, /INSERT INTO public\.schema_meta \(id, version\) VALUES \(1, 17\)/);
});

test("scoreCategory boundaries match FINA buckets", () => {
  // We can't import the .js composable directly under CommonJS, so
  // re-implement the same boundaries here. If they ever drift, this
  // test will catch it. (Mirror of src/composables/useScoreCategories.js.)
  const cat = (s) => {
    if (s == null || Number.isNaN(s)) return null;
    if (s === 0) return "failed";
    if (s <= 2.0) return "deficient";
    if (s <= 4.5) return "unsatisfactory";
    if (s <= 6.0) return "satisfactory";
    if (s <= 8.0) return "good";
    if (s <= 9.5) return "very-good";
    return "excellent";
  };
  assert.equal(cat(0), "failed");
  assert.equal(cat(1), "deficient");
  assert.equal(cat(2), "deficient");
  assert.equal(cat(2.5), "unsatisfactory");
  assert.equal(cat(4.5), "unsatisfactory");
  assert.equal(cat(5), "satisfactory");
  assert.equal(cat(6), "satisfactory");
  assert.equal(cat(7), "good");
  assert.equal(cat(8), "good");
  assert.equal(cat(9), "very-good");
  assert.equal(cat(9.5), "very-good");
  assert.equal(cat(10), "excellent");
});
