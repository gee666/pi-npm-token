# Project instructions

## Pi compatibility and releases

- Test only against the latest stable Pi release from npm. Do not add an older-version test matrix or rely on stale installed dependencies.
- Before every release, run `npm test`. Its `pretest` installs `@earendil-works/pi-coding-agent@latest` with `--save-dev --ignore-scripts`, then runs strict TypeScript checking. If the update or typecheck fails, stop rather than testing an older release.
- After successful checks, update the standalone README line `Tested against Pi <version>` using the actual installed coding-agent version. Maintain this line on every release and include it in the release commit. Never claim a version or live authentication check that was not tested.
- Declare host-provided Pi libraries as peer dependencies, not runtime dependencies. Keep supported Pi ranges in `package.json` accurate and development dependencies and the lockfile aligned with the tested version. The current tested baseline is Pi 1.4.0.
- Run `npm pack --dry-run --ignore-scripts` and inspect the file list before release. Include source, README, and license only; never include settings, npmrc files, tokens, test fixtures, or temporary directories.
- Keep this root `AGENTS.md` tracked and committed. Do not bump versions, publish packages, or push unless requested.

## Code quality bar

- Remove dead code, unused imports, and unused dependencies. Wire intended functionality into the extension instead of leaving disconnected code.
- Keep Pi lifecycle registration, settings validation, private-file checks, and credential/environment management in their existing modules. Follow strict TypeScript, Node.js ESM, npm INI, and documented Pi extension conventions.
- Avoid duplicated logic and unnecessary abstractions. Prefer simple, consistent solutions over one-off patterns.
- Fix root causes, not symptoms. Avoid brittle workarounds. Make deployment-specific values and operational settings configurable without weakening registry scoping or trust checks. Never hardcode secrets, echo credentials in diagnostics, or put tokens in prompts, session records, command arguments, fixtures, or documentation.
- Preserve project-trust boundaries and fail closed on invalid project settings. Reject unsafe files and temporary directories. Keep generated npm configuration private, restore the previous environment during cleanup, and never modify the user's original npmrc file.
- Use strict TypeScript and types that model valid application states. Validate settings, environment variables, files, and INI data at runtime. Do not bypass type safety with `any`, unsafe assertions, non-null assertions that hide missing data, or suppressed type errors.
- Keep functions and classes focused. Split files by responsibility before they exceed 350 lines. Exceed this limit only when splitting would clearly hurt readability or cohesion, and explain why. Avoid unrelated restructuring during maintenance changes.
- Remove stale or irrelevant comments and docs. Keep useful ones accurate, short, clear, and human-friendly. Explain non-obvious decisions rather than restating code. Apply the unslop and write-prompts skills when available.
- Add or update tests for changed behavior, including trust, malformed configuration, credential redaction, concurrent activation, file permissions, inheritance, and cleanup when affected. Use dummy credentials and isolated local subprocesses only. Do not authenticate to npm, publish, or access real user credentials as part of testing.
- Run the available type checks, lint checks, and relevant tests before considering work complete. This project currently has no lint script; do not claim a lint check was run.
- Give every shell command a timeout. Keep temporary files and logs under this repository's ignored `tmp/` directory. Preserve unrelated user changes.
