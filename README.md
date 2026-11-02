# MacDry

MacDry is an offline, first-pass diagnostic for Apple Silicon Macs, including machines that have experienced liquid damage. It combines local system observations with optional guided browser tests. It cannot locate corrosion, prove that a Mac is healthy, or replace Apple Diagnostics and a professional hardware inspection.

## What the first version checks

- macOS version, model, CPU, memory and GPU inventory; available Data volume space.
- macOS-reported battery condition, maximum capacity and cycle count; current battery charge and charger connection when available; and NVMe SMART status when macOS reports it.
- A single system-wide memory-pressure observation and macOS thermal warning level when available. Memory pressure uses a private macOS interface that can change; a thermal warning level is not a temperature. Missing or unsupported values are unavailable, not normal.
- Guided checks for keyboard input, pointer movement and scrolling, camera preview, microphone level, left/right audio and WebGL rendering. Guided results are confirmed by the user.
- A session summary and local JSON report with filtered observations, recommendations and human responses. Review the report before sharing: even filtered system information can be sensitive.

Inventory, memory pressure, charger status and thermal warning levels are not hardware health tests. A SMART `Verified` status does not rule out SSD failure. macOS and browsers may not expose every signal on every model. An unavailable check is not a pass. MacDry also offers an optional, explicitly confirmed, approximately 20-second browser workload: two CPU workers, a 16 MiB memory pattern check and a short WebGL workload. It performs no intentional file writes and does not test storage; macOS may still manage or page memory normally. The memory sample covers only a small portion of installed memory; WebGL may use software rendering, so physical GPU acceleration is not verified. A completed run can report only that nothing unusual was detected during that test; it cannot establish that the Mac is healthy.

The load test starts only when a local preflight reports normal memory pressure, no known thermal warning, and the user confirms a safety checklist. A missing thermal-warning record remains `unavailable`, never normal; in that case MacDry explicitly warns that it cannot monitor heat and requires manual confirmation that the Mac is cool. Periodic checks stop the run if memory pressure becomes abnormal or a thermal warning appears; if thermal monitoring was unavailable at the start, the user must watch for heat or macOS warnings and stop manually. The snapshots do not provide temperature readings. The test also stops when the user asks, the page is hidden or closed, the graphics context is lost, a workload reports an issue, or its fixed time limit is reached. Do not run it if the Mac is unusually warm, on an unstable surface, recently exposed to liquid, or showing electrical or thermal warnings. Save important work first; connect a laptop to power.

The versioned JSON report distinguishes local-check states and guided-test responses and includes a separate `hardware_load_test` outcome with per-component results and limitations. A guided pass or fail records a human response to a limited test, not a component diagnosis. Report version 2 adds the bounded-load-test result; consumers of earlier report versions must handle the new version.

## Run the standalone executable

Build `dist/macdry` as described below, or obtain a trusted build, then run it in Terminal:

```sh
./macdry
```

The program opens the browser at a local address and prints the same address in Terminal. Keep that URL private: it contains the session token. If the browser does not open, copy the complete URL from Terminal. Press `Ctrl+C` in Terminal to stop the server. Use `./macdry --no-open` to open the printed URL manually.

This is a **single executable with a browser interface**, not a native `.app`. Gleam and Deno are not required on the target Mac. Only Apple Silicon macOS is supported; compatibility across all macOS releases is not yet established. Builds are not signed or notarized, so macOS Gatekeeper may block a downloaded executable. Only run builds you trust; a public release needs an Apple Developer ID signature and notarization for a smoother experience.

## Download a release

Pushing a version tag matching `v*` (for example, `v1.2.0`) runs the GitHub Actions release workflow. It runs the checks, builds the Apple Silicon executable, and publishes `macdry-macos-arm64.tar.gz` plus its SHA-256 checksum on the matching GitHub Release.

```sh
git tag v1.2.0
git push origin v1.2.0
```

Download both release assets into the same directory, then verify and extract the archive:

```sh
shasum -a 256 -c macdry-macos-arm64.tar.gz.sha256
tar -xzf macdry-macos-arm64.tar.gz
./macdry
```

The executable is not signed or notarized; macOS Gatekeeper may block it. See [Safety](#safety) and run only builds you trust.

Camera and microphone access is requested only when you start those tests. Grant permission to your browser in macOS and browser privacy settings if needed. No media is recorded or sent anywhere. The server and all application assets work offline; the browser may independently have its own network activity.

## Build

On an Apple Silicon Mac, install Gleam and Deno, then from the repository root:

```sh
bash scripts/build.sh
./dist/macdry
```

Tested with Gleam 1.19.2 and Deno 2.9.8. The initial Deno compilation may download its target runtime, so building is not guaranteed to be offline. Running the resulting binary is offline. The project currently has no Gleam package dependencies.

## Development and verification

```sh
gleam format --check src test
gleam test --target javascript --runtime deno
deno test --no-remote --no-npm test/server_test.mjs
node --test test/ui_test.mjs
```

The UI tests require Node.js and Chrome or Chromium; set `CHROME_BIN` to the browser executable if it is not found automatically. The tests use a headless browser with simulated devices, so they do not replace testing actual peripherals.

The integration test builds and runs a standalone executable after removing its source files and static assets in an isolated temporary directory:

```sh
deno run --no-prompt --no-remote --no-npm --allow-read --allow-write=test --allow-net=127.0.0.1 --allow-run test/integration_test.mjs --real-assets
```

This invokes local system commands and can require the Deno compilation runtime on first use. Tests have been run on macOS 27.0.1 on Apple Silicon; validate on other macOS releases and hardware before distributing.

See [architecture](docs/architecture.md) for boundaries, privacy and limitations, and [agent instructions](AGENTS.md) for working in this repository with coding agents.

## Safety

If liquid exposure is recent, the Mac is still wet, or there are signs of electrical damage, switch it off and disconnect power rather than running diagnostics. Do not run the controlled load test if the Mac is unusually warm or showing thermal warnings. Before that test, save important work, use a hard flat surface and connect a laptop to power. After cleaning, back up important data before relying on any test result. MacDry cannot verify that liquid damage has been fully repaired.

MIT licensed; see [LICENSE](LICENSE).
