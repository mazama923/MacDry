# Architecture

## Scope

MacDry is an offline, non-destructive first-pass diagnostic for Apple Silicon Macs. It reports observations, not a medical-style diagnosis of a computer or a guarantee against hidden corrosion. An inaccessible or unrecognised value must stay unavailable rather than becoming a passing result.

## Components

1. `src/macdry.gleam` converts a fixed set of collected facts into labelled checks and their limitations. It is compiled to JavaScript by Gleam.
2. `src/system.mjs` is the macOS/Deno boundary. It invokes only fixed system commands, bounds their execution time and output, and extracts an allowlist of values. `src/bridge.mjs` bridges JavaScript values into Gleam.
3. `server.mjs` serves only the three local assets and an authenticated diagnostic API. Deno bundles the compiled Gleam modules, JavaScript bridges, static assets and runtime into the executable.
4. `public/` provides the browser interface. Browser APIs for input, media, Web Audio and WebGL require JavaScript interop; CSS and HTML provide presentation. Media and guided-test results stay in the browser until the user explicitly exports a report.

## Trust and privacy

The server listens on an ephemeral port on `127.0.0.1` only. It validates `Host` and cross-origin requests, exposes no arbitrary command endpoint, and requires a random session token in an API request header. The token is passed in the URL fragment, removed from the address bar and retained in tab-scoped session storage when available. Keep the printed URL private. The server stops with its Terminal process.

No network service is contacted by the application. Browser camera and microphone access requires explicit user action and OS/browser permission; streams stop on request or when the page is hidden. No media is saved. The export contains the filtered check results and user-marked test outcomes, not raw system command output, keystrokes or device identifiers. Review a report before sharing: hardware model and other information can still be sensitive.

## Diagnostic semantics

- `info` is an observation, **not** a passed health test.
- `warning` means a specific reported condition needs attention; it is not proof of a root cause.
- `unavailable` means the input could not be obtained or interpreted.
- Guided tests are `not-tested`, `pass`, `fail` or `unavailable`; pass/fail reflects the user's answer, not automatic fault isolation.

The initial version does not stress-test CPU, memory, GPU or storage. It does not repair hardware, find the physical location of liquid damage, or replace Apple Diagnostics and professional inspection. SMART `Verified` is only a reported signal. APFS space and battery information are also observations, not component tests.

## Distribution

`scripts/build.sh` compiles the Gleam JavaScript target and then creates a single macOS ARM64 executable with `deno compile`. The runtime and assets are embedded; no Gleam, Deno, Homebrew or Internet connection is required on the target Mac. Build tools and an initially available Deno compilation runtime are needed on the build machine. The executable is not a native `.app`, and is not signed or notarized by this project. Compatibility beyond the macOS versions actually tested is not yet established.
