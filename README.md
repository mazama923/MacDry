# MacDry

MacDry is an offline, first-pass diagnostic for Apple Silicon Macs, including machines that have experienced liquid damage. It combines local system observations with optional guided browser tests. It cannot locate corrosion, prove that a Mac is healthy, or replace Apple Diagnostics and a professional hardware inspection.

## What the first version checks

- macOS version, model, CPU, memory and GPU inventory; available Data volume space.
- macOS-reported battery condition, maximum capacity and cycle count; current battery charge and charger connection when available; and NVMe SMART status when macOS reports it.
- A single system-wide memory-pressure observation and macOS thermal warning level when available. Memory pressure uses a private macOS interface that can change; a thermal warning level is not a temperature. Missing or unsupported values are unavailable, not normal.
- Guided checks for keyboard, trackpad/pointer, camera, microphone, audio, WebGL, USB-C/Thunderbolt ports, Wi-Fi/Bluetooth and visible physical condition. Hardware-specific results require user confirmation; MacDry never tests startup, sleep, wake or restart behavior.
- Existing macOS-reported battery condition, charge, cycle count and NVMe SMART status remain observations, not component verdicts. SMART `Verified` does not rule out SSD failure.
- Optional system tests: read-only startup-volume verification with a macOS administrator prompt for that command, a filtered 15-minute unified-log summary that never returns raw messages, and an Internet quality test that requires a separate checkbox and explicit click.
- A versioned local JSON report with filtered results. Review it before sharing: even allowlisted system observations may be sensitive.

MacDry does not use third-party stress or disk utilities. Its optional CPU/memory/WebGL workload runs for at most 14 minutes on two CPU workers, checks a fixed 256 MiB memory sample and runs a short WebGL phase; the total is capped at 15 minutes. It starts only after a local readiness check and explicit safety confirmation. MacDry writes no test files, but macOS may compress or page memory. The sample is not a full RAM test and cannot guarantee a memory reserve. WebGL may use software rendering, so physical GPU acceleration is not verified. The CPU workload does not reliably measure throttling. Stop it if the Mac becomes unusually warm or macOS warns.

The readiness check uses memory-pressure and thermal-warning snapshots; these are not temperatures or health tests, and the memory-pressure interface may vary across macOS versions. An unavailable thermal signal remains unavailable; the user must confirm the Mac is cool and monitor it manually. Periodic checks stop the workload if pressure is abnormal, a thermal warning appears, a required snapshot becomes unavailable, the page is hidden, the graphics context is lost, or the time limit is reached. Back up important data first, use a hard flat surface, and connect a laptop to power.

Volume verification does not repair the filesystem or diagnose SSD health. macOS does not expose a reliable supported temperature-in-degrees signal on every Mac, so MacDry reports only thermal warnings when available. Internet testing uses Apple's built-in `networkQuality` command for at most 15 seconds and transfers external data only after confirmation; results describe that connection at that moment, not the network hardware. Log scanning reports aggregate counts from a short window; matching events may be unrelated and raw messages are never exported. No individual result, or collection of results, certifies that a Mac is healthy.

The JSON report version 3 separates local checks, human-guided responses, explicit system-test summaries and the bounded `hardware_load_test` result. Consumers of versions 1 or 2 must handle the added `system_tests` field and the new version.

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

Camera and microphone access is requested only when you start those tests. Grant permission to your browser in macOS and browser privacy settings if needed. No media is recorded or sent anywhere. The server and application assets work locally; no external service is contacted unless you explicitly confirm and start the Internet quality test. The browser may independently have its own network activity.

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

If liquid exposure is recent, the Mac is still wet, or there are signs of electrical damage, switch it off and disconnect power rather than running diagnostics. Do not run the controlled load test if the Mac is unusually warm or showing thermal warnings. Before the workload or filesystem verification, save important work and ensure you have a current backup; use a hard flat surface and connect a laptop to power. Stop using or charging the Mac if the battery appears swollen, smells unusual or becomes excessively hot. After cleaning, back up important data before relying on any test result. MacDry cannot verify that liquid damage has been fully repaired.

MIT licensed; see [LICENSE](LICENSE).
