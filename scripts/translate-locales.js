#!/usr/bin/env node
//
// translate-locales.js — AI-assisted i18n translation pipeline.
//
// Reads src/locales/en.json (the source of truth) and emits
// translated dictionaries for every other supported locale by
// asking Claude API to translate the leaf strings, preserving
// JSON structure + ICU MessageFormat placeholders verbatim.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-… node scripts/translate-locales.js
//
//   # Limit to specific locales
//   ANTHROPIC_API_KEY=sk-… node scripts/translate-locales.js --locales es,fr
//
//   # Don't overwrite — write to .new.json side-files for diff/proofread
//   ANTHROPIC_API_KEY=sk-… node scripts/translate-locales.js --diff
//
// Design notes:
//
// • We send the WHOLE flattened dictionary in ONE prompt per locale.
//   At <2000 keys this fits comfortably in a single Claude call,
//   keeps surrounding-key context (so e.g. "Submit" near "Save"
//   gets the right verb tense), and costs ~$0.02 per locale.
//
// • Placeholders ({minutes}, {n}, etc.) are preserved verbatim —
//   we explicitly tell the model not to translate or reorder them.
//
// • The model's JSON output is parsed strictly; any malformed
//   response aborts that locale so a half-translated file never
//   lands in src/locales/.
//
// • Federations who'd rather hand-translate can skip this script
//   and edit the per-locale JSON directly. The script never blows
//   away their work without --force.

const fs = require("fs");
const path = require("path");

const LOCALES_DIR = path.join(__dirname, "..", "src", "locales");
const SOURCE_LOCALE = "en";
const TARGET_LANGUAGES = {
  es: "Spanish (Spain — castellano)",
  fr: "French (international)",
  de: "German (standard German, formal Sie)",
};

const args = process.argv.slice(2);
const filterLocales = parseListArg(args, "--locales");
const diffMode = args.includes("--diff");
const force = args.includes("--force");

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    fail("ANTHROPIC_API_KEY env var is required.");
  }

  const sourceFile = path.join(LOCALES_DIR, `${SOURCE_LOCALE}.json`);
  if (!fs.existsSync(sourceFile)) {
    fail(`Missing source dictionary: ${sourceFile}`);
  }
  const sourceJson = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  console.log(`Source: ${SOURCE_LOCALE}.json (${countLeaves(sourceJson)} strings)`);

  const targets = Object.entries(TARGET_LANGUAGES).filter(([code]) =>
    !filterLocales.length || filterLocales.includes(code));

  for (const [code, languageName] of targets) {
    const outFile = path.join(
      LOCALES_DIR,
      diffMode ? `${code}.new.json` : `${code}.json`,
    );

    if (!diffMode && !force && fs.existsSync(outFile)) {
      // Compare to source — if every key is already present we
      // ASSUME hand-translated and skip unless --force. New keys
      // added to en.json since the last run will still get filled.
      const existing = safeParse(outFile);
      const missing = findMissingKeys(sourceJson, existing);
      if (!missing.length) {
        console.log(`✓ ${code}.json — up to date (${countLeaves(existing)} keys)`);
        continue;
      }
      console.log(`+ ${code}.json — ${missing.length} missing key(s), translating just those…`);
      const translated = await translateSubset(sourceJson, missing, code, languageName, apiKey);
      const merged = deepMerge(existing, translated);
      fs.writeFileSync(outFile, JSON.stringify(merged, null, 2) + "\n");
      console.log(`✓ ${code}.json — merged ${missing.length} new key(s)`);
      continue;
    }

    console.log(`→ Translating ${code} (${languageName})…`);
    const translated = await translateWhole(sourceJson, code, languageName, apiKey);
    fs.writeFileSync(outFile, JSON.stringify(translated, null, 2) + "\n");
    console.log(`✓ ${path.basename(outFile)} — wrote ${countLeaves(translated)} strings`);
  }

  console.log("\nDone.");
  if (diffMode) {
    console.log("Tip: diff the .new.json files against the current dictionaries");
    console.log("     before promoting them with `mv src/locales/{xx,xx}.new.json src/locales/xx.json`.");
  }
}

async function translateWhole(source, locale, languageName, apiKey) {
  const prompt = [
    `Translate the following JSON dictionary from English into ${languageName}.`,
    ``,
    `Rules:`,
    `1. Preserve the JSON structure EXACTLY — same keys, same nesting.`,
    `2. Translate ONLY the string VALUES, never the keys.`,
    `3. Preserve ALL placeholders verbatim: {n}, {minutes}, {round}, {name}, {event}, {date}, {rounds}, {height}, {total}, etc. Do NOT translate or reorder them.`,
    `4. Preserve emoji and special characters (✓, →, ←, …, ↻, R{round}) verbatim.`,
    `5. Use the formal/respectful register that fits a sports federation context. In Spanish use second-person plural address (tu/tus) as it reads warmer for an athlete community. In German use the formal Sie form.`,
    `6. Output ONLY the translated JSON object. No prose before or after. No markdown fences.`,
    ``,
    `Source dictionary:`,
    JSON.stringify(source, null, 2),
  ].join("\n");

  const text = await callClaude(prompt, apiKey);
  const json = safeJsonParse(text);
  if (!json || typeof json !== "object") {
    fail(`Claude returned malformed JSON for locale ${locale}:\n${text.slice(0, 500)}…`);
  }
  return json;
}

async function translateSubset(source, missingPaths, locale, languageName, apiKey) {
  // Build a minimal subset object containing just the missing
  // paths. Translate that, then merge with the existing dict.
  const subset = {};
  for (const pathArr of missingPaths) {
    setAtPath(subset, pathArr, getAtPath(source, pathArr));
  }
  return translateWhole(subset, locale, languageName, apiKey);
}

async function callClaude(prompt, apiKey) {
  // Use the public Anthropic messages API. Model picked for cost +
  // quality on short translation tasks. Increase max_tokens if a
  // future dictionary outgrows the default.
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-latest",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    fail(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }
  const body = await res.json();
  const text = body?.content?.[0]?.text;
  if (!text) {
    fail(`Anthropic API returned no text:\n${JSON.stringify(body).slice(0, 500)}`);
  }
  return text;
}

// ---------- Helpers ----------

function safeJsonParse(text) {
  // Strip markdown code fences if the model added them.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function safeParse(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return {}; }
}

function countLeaves(obj) {
  let n = 0;
  walk(obj, () => { n++; });
  return n;
}

function walk(obj, cb, pathArr = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) walk(v, cb, [...pathArr, k]);
    else cb([...pathArr, k], v);
  }
}

function findMissingKeys(source, target) {
  const missing = [];
  walk(source, (pathArr) => {
    if (getAtPath(target, pathArr) === undefined) missing.push(pathArr);
  });
  return missing;
}

function getAtPath(obj, pathArr) {
  let cur = obj;
  for (const seg of pathArr) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setAtPath(obj, pathArr, value) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    if (cur[pathArr[i]] == null) cur[pathArr[i]] = {};
    cur = cur[pathArr[i]];
  }
  cur[pathArr[pathArr.length - 1]] = value;
}

function deepMerge(base, overlay) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object") {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function parseListArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1]) return [];
  return args[idx + 1].split(",").map(s => s.trim()).filter(Boolean);
}

function fail(msg) {
  console.error("✗", msg);
  process.exit(1);
}

main().catch((err) => fail(err.message || String(err)));
