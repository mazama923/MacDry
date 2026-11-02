# MacDry

MacDry is an offline, first-pass diagnostic for Apple Silicon Macs, including machines that have experienced liquid damage. It combines local system observations with optional guided browser tests. It cannot locate corrosion, prove that a Mac is healthy, or replace Apple Diagnostics and a professional hardware inspection.

## What the first version checks

- macOS version, model, CPU, memory and GPU inventory; available Data volume space.
- macOS-reported battery condition, capacity and cycle count when available, and NVMe SMART status when macOS reports it.
- Guided checks for keyboard input, pointer movement and scrolling, camera preview, microphone level, left/right audio and WebGL rendering. Guided results are confirmed by the user.
- Local JSON report download. Review the report before sharing: even filtered system information can be sensitive.

Inventory is not a health test. A SMART `Verified` status does not rule out SSD failure. macOS and browsers may not expose every signal on every model. An unavailable check is not a pass. CPU, memory, GPU and storage stress tests are **not included**; there are no destructive or write-heavy tests.

## Run the standalone executable

Build `dist/macdry` as described below, or obtain a trusted build, then run it in Terminal:

```sh
./macdry
```

The program opens the browser at a local address and prints the same address in Terminal. Keep that URL private: it contains the session token. If the browser does not open, copy the complete URL from Terminal. Press `Ctrl+C` in Terminal to stop the server. Use `./macdry --no-open` to open the printed URL manually.

This is a **single executable with a browser interface**, not a native `.app`. Gleam and Deno are not required on the target Mac. Only Apple Silicon macOS is supported; compatibility across all macOS releases is not yet established. Builds are not signed or notarized, so macOS Gatekeeper may block a downloaded executable. Only run builds you trust; a public release needs an Apple Developer ID signature and notarization for a smoother experience.

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

If liquid exposure is recent, the Mac is still wet, or there are signs of electrical damage, switch it off and disconnect power rather than running diagnostics. After cleaning, back up important data before relying on any test result. MacDry cannot verify that liquid damage has been fully repaired.

MIT licensed; see [LICENSE](LICENSE).
