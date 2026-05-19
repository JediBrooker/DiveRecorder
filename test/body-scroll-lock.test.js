// Unit tests for useBodyScrollLock. We stub document/window
// directly rather than spin up jsdom — the composable's surface
// area is small (two functions setting body styles, one
// counter) and a hand-stubbed DOM stays the same shape as the
// real thing for the cases we care about.
//
// What we want to prove:
//   * lock() / unlock() reference-count correctly (a 2nd lock
//     does NOT re-apply DOM state; a 1st unlock from a 2-deep
//     stack does NOT release the body)
//   * the body styles are populated on the 0->1 transition and
//     restored on the 1->0 transition, including the saved
//     scroll position
//   * unlock() with no preceding lock is a no-op (no underflow)
//   * SSR safety — calling without a document/window does not
//     throw

const { test, beforeEach } = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const Module = require("node:module")

// The composable is ESM; require() it via dynamic import wrapped
// in a sync IIFE pattern that node:test handles fine.
const composablePath = path.join(
  __dirname, "..", "src", "composables", "useBodyScrollLock.js",
)

// Tiny stubs for the DOM globals the composable reads. Vue's
// onUnmounted is not called in these tests because the composable
// itself only registers it when invoked inside a setup() — at
// module level (which is where __internal lives) the watch/
// onUnmounted hooks aren't fired. We test the module-level
// applyLock/applyUnlock through the lock()/unlock() returned by
// useBodyScrollLock(), which DOES register an onUnmounted, but
// since we never trigger an unmount the hook stays dormant.

function makeFakeDom({ scrollY = 0 } = {}) {
  const body = {
    style: {
      position: "",
      top: "",
      left: "",
      right: "",
      width: "",
    },
  }
  const documentEl = { style: { overflow: "" } }
  const fake = {
    document: { body, documentElement: documentEl },
    window: {
      scrollY,
      pageYOffset: scrollY,
      scrollTo: (x, y) => { fake.window.scrollY = y; fake.window.pageYOffset = y },
    },
  }
  return fake
}

function loadComposableWithDom(fake) {
  // Stash and replace globals around the require.
  const origDocument = global.document
  const origWindow = global.window
  global.document = fake.document
  global.window = fake.window
  // Drop the require cache so each test loads a clean module.
  delete require.cache[composablePath]
  // Vue is a hard dep — stub the minimal API the composable touches.
  const vuePath = require.resolve("vue", { paths: [path.join(__dirname, "..")] })
  delete require.cache[vuePath]
  Module._cache[vuePath] = {
    id: vuePath, filename: vuePath, loaded: true,
    exports: {
      onUnmounted: () => {},  // no-op; we don't fire unmount in tests
      watch: () => {},        // no-op; we use lock/unlock directly
    },
  }
  // The composable is ESM. Use the experimental loader via
  // dynamic import.
  return import("file://" + composablePath).then((mod) => {
    global.document = origDocument
    global.window = origWindow
    return mod
  })
}

test("lock() applies body styles on 0->1 transition", async () => {
  const fake = makeFakeDom({ scrollY: 420 })
  const mod = await loadComposableWithDom(fake)
  mod.__internal.reset()
  const { lock } = mod.useBodyScrollLock()
  // Re-stub globals because loadComposableWithDom restores them.
  global.document = fake.document
  global.window = fake.window
  lock()
  assert.equal(fake.document.body.style.position, "fixed")
  assert.equal(fake.document.body.style.top, "-420px")
  assert.equal(fake.document.body.style.width, "100%")
  assert.equal(fake.document.documentElement.style.overflow, "hidden")
  assert.equal(mod.__internal.getLockCount(), 1)
})

test("nested lock() / unlock() reference-counts (2 locks, 1 unlock keeps body locked)", async () => {
  const fake = makeFakeDom({ scrollY: 100 })
  const mod = await loadComposableWithDom(fake)
  mod.__internal.reset()
  global.document = fake.document
  global.window = fake.window
  const { lock: lockA, unlock: unlockA } = mod.useBodyScrollLock()
  const { lock: lockB, unlock: unlockB } = mod.useBodyScrollLock()
  lockA()
  lockB()
  assert.equal(mod.__internal.getLockCount(), 2)
  // First unlock: still locked.
  unlockB()
  assert.equal(mod.__internal.getLockCount(), 1)
  assert.equal(fake.document.body.style.position, "fixed",
    "body should still be locked while one consumer holds the lock")
  // Second unlock: now released, body styles restored.
  unlockA()
  assert.equal(mod.__internal.getLockCount(), 0)
  assert.equal(fake.document.body.style.position, "",
    "body position should be cleared once the last lock releases")
  assert.equal(fake.window.scrollY, 100,
    "scroll position should be restored after final unlock")
})

test("unlock() without a preceding lock is a no-op (does not underflow)", async () => {
  const fake = makeFakeDom()
  const mod = await loadComposableWithDom(fake)
  mod.__internal.reset()
  global.document = fake.document
  global.window = fake.window
  const { unlock } = mod.useBodyScrollLock()
  assert.doesNotThrow(() => { unlock(); unlock(); unlock() })
  assert.equal(mod.__internal.getLockCount(), 0)
})

test("works in SSR-ish environment (no document/window) without throwing", async () => {
  // Reload with NO document/window stubs.
  delete require.cache[composablePath]
  delete global.document
  delete global.window
  const mod = await import("file://" + composablePath + "?ssr=" + Date.now())
  mod.__internal.reset()
  const { lock, unlock } = mod.useBodyScrollLock()
  assert.doesNotThrow(() => { lock(); unlock() },
    "lock/unlock should be silent no-ops in SSR")
})
