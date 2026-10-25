# CLAUDE.md

Domain vocabulary and language rules are in `CONTEXT.md`; every setting is documented in `.env.example`.

## Verification

Run after every change, and show the command output as evidence; don't just claim success:

- `bun run check` — `tsc` for the service.
- `bun run test` — `bun test --isolate --timeout 60000 ./test` (~5 s). Always use the script, not bare `bun test` (it needs `--isolate`).
- `bun fmt --check` — Bun's built-in formatter; `bun fmt` rewrites. Code style lives in `.prettierrc.json` (service) and `web/.prettierrc.json` (web UI, shadcn style). Do not add a `fmt` script: `bun fmt` would run it instead of the formatter.
- `bun run lint` — oxlint (`.oxlintrc.json`); Bun has no linter of its own.
- Web UI changes: `bun run --cwd web typecheck` (`tsc -b`).
- CI parity (slow, builds ffmpeg/Bento4): `docker build --target test .`

## Gotchas

- Two separate installs: `bun install` and `bun install --cwd web` (the web UI has its own `bun.lock`).
- Two protected-media tests skip locally without `mp4decrypt` (Bento4); they run in the Docker test stage. A skip is not a pass for DRM changes.
- Stderr noise like "iprima: updating the programme index failed: The operation was aborted" during tests is expected.
- Dev: `bun run dev` (service on :8787) and `bun run dev:web` (Vite on :5173, proxies the API to :8787); both are in `.claude/launch.json`.
- Providers hit real Czech/Slovak streaming services and some need account credentials; don't run the service against real accounts or Sonarr/Radarr unasked.

When compacting, preserve the list of modified files and the verification commands.
