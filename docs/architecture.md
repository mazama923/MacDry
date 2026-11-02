# Architecture

## Scope

MacDry is an offline, non-destructive first-pass diagnostic for Apple Silicon Macs. It reports observations, not a medical-style diagnosis of a computer or a guarantee against hidden corrosion. An inaccessible or unrecognised value must stay unavailable rather than becoming a passing result.

## Components

1. `src/macdry.gleam` converts a fixed set of collected facts into labelled checks and their limitations. It is compiled to JavaScript by Gleam.
2. `src/system.mjs` is the macOS/Deno boundary. It invokes only fixed system commands, bounds their execution time and output, and extracts an allowlist of values. The load-test preflight reads only the fixed memory-pressure and thermal-warning signals. `src/bridge.mjs` bridges JavaScript values into Gleam.
3. `server.mjs` serves only the three local assets and an authenticated diagnostic API. Deno bundles the compiled Gleam modules, JavaScript bridges, static assets and runtime into the executable.
4. `public/` provides the browser interface and fixed local load-test worker. Browser APIs for input, media, Web Audio and WebGL require JavaScript interop; CSS and HTML provide presentation. Media, load-test results and guided-test responses stay in the browser until the user explicitly exports a report.

## Trust and privacy

The server listens on an ephemeral port on `127.0.0.1` only. It validates `Host` and cross-origin requests, exposes no arbitrary command endpoint, and requires a random session token in an API request header. The token is passed in the URL fragment, removed from the address bar and retained in tab-scoped session storage when available. Keep the printed URL private. The server stops with its Terminal process.

No network service is contacted by the application. Browser camera and microphone access requires explicit user action and OS/browser permission; streams stop on request or when the page is hidden. No media is saved. The versioned JSON export contains allowlisted fields from known checks, their recommendations and user-marked test outcomes, not raw system command output, keystrokes or device identifiers. Unknown checks are anonymized. Review a report before sharing: hardware model and other information can still be sensitive.

## Diagnostic semantics

- `info` is an observation, **not** a passed health test.
- `warning` means a specific reported condition needs attention; it is not proof of a root cause.
- `unavailable` means the input could not be obtained or interpreted.
- Guided tests are `not-tested`, `pass`, `fail` or `unavailable`; pass/fail reflects the user's answer, not automatic fault isolation.
- The report's `checks_state` distinguishes `not-run`, `loading`, `unavailable` and `complete`. `checks: null` means no completed response; an empty list means the response contained no checks.
- The optional load test requires an authenticated preflight and explicit manual confirmation. It is fixed-duration, limited to two CPU workers, one 16 MiB memory buffer and a short WebGL workload; there are no intentional file writes; macOS may still manage or page memory normally. Normal memory pressure and no reported thermal warning are required. If the thermal signal is unavailable, the result stays unavailable, the user must manually confirm that the Mac is cool, and MacDry cannot monitor heat; otherwise periodic checks stop on abnormal pressure, a thermal warning, missing signals or other workload issues. User stop, page hide/close, graphics-context loss and the fixed timeout also stop the run. Thermal warnings are not temperature measurements.

System-wide memory pressure is read once through the private `kern.memorystatus_vm_pressure_level` sysctl; unsupported or unrecognised values remain unavailable. Battery charge and charger connection are sampled from system-profiler data, without treating a connected but not charging state as a fault. Thermal warning levels come from `pmset -g therm` and are not temperatures; a missing or unrecognised level is unavailable. These observations do not test hardware health. The thermal parser's numeric branches are tested using fixtures, not a real warning on every supported macOS version.

The controlled load test observes only whether its bounded CPU calculation and memory patterns complete consistently and whether the browser WebGL workload reports an error. It covers a small portion of memory, may use software rendering instead of the physical GPU, and cannot prove component health. The thermal preflight is a warning-level snapshot, not a temperature measurement; users must check the Mac's physical condition and stop if it becomes unusually warm or macOS reports a warning. The test does not exercise storage. MacDry does not repair hardware, locate liquid damage, or replace Apple Diagnostics and professional inspection. SMART `Verified` is only a reported signal. APFS space and battery information are also observations, not component tests.

## Distribution

`scripts/build.sh` compiles the Gleam JavaScript target and then creates a single macOS ARM64 executable with `deno compile`. The runtime and assets are embedded; no Gleam, Deno, Homebrew or Internet connection is required on the target Mac. Build tools and an initially available Deno compilation runtime are needed on the build machine. The executable is not a native `.app`, and is not signed or notarized by this project. Compatibility beyond the macOS versions actually tested is not yet established.

`.github/workflows/release.yml` runs the project checks on a GitHub-hosted Apple Silicon runner when a `v*` tag is pushed. It builds with the same script, packages the executable in a `.tar.gz` archive to retain its executable mode, computes a SHA-256 checksum, and creates or updates the matching GitHub Release. The workflow needs `contents: write` to publish release assets; it does not sign or notarize the executable.
