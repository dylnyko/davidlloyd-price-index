// @ts-check
const { defineConfig, devices } = require("@playwright/test");

/* Serves the static site as-is and runs the E2E suite against it. The David
   Lloyd API is mocked from tests/fixtures, so tests are hermetic (no live
   network) and assert app.js exactly as shipped — no refactor of the site. */
module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 15000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  webServer: {
    // Threaded server: the default http.server is single-threaded and stalls the
    // JSON fetches under parallel workers. ThreadingHTTPServer handles them concurrently.
    command:
      "python3 -c \"from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler; ThreadingHTTPServer(('127.0.0.1', 4173), SimpleHTTPRequestHandler).serve_forever()\"",
    url: "http://127.0.0.1:4173/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
