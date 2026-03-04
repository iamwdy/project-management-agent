# Project Instructions

This repository is the base `project-template` for new projects.

## Startup Protocol

Before modifying files or running non-trivial commands in a project created from this template:

1. Read this local `AGENTS.md`.
2. Read shared Codex preferences from the first available source:
   - `/Users/wendywang/.config/codex/PREFERENCES.md`
   - `https://github.com/iamwdy/codex-preferences`
3. If the project is being resumed, read `WIP_NOTES.md` before making changes.
4. If there is any conflict, ambiguity, or risky external action, ask before executing.

## New Project Convention

When a user asks to start a new project from this template, the default workflow is:

1. Create the new project with `scripts/new-project.sh <project-name-or-path>`.
2. Read `AGENTS.md`.
3. Load shared Codex preferences.
4. Read `WIP_NOTES.md` if it exists.
5. Only then propose or execute project-specific work.

Recommended user prompt:
`np：<專案名>`

Interpret `np：<專案名>` as:

1. Create the project with `scripts/new-project.sh <專案名>`.
2. Read local `AGENTS.md`.
3. Load shared Codex preferences.
4. Read `WIP_NOTES.md` if it exists.
5. Then begin project-specific work.

Clarification:
- `np：<專案名>` is a prompt convention for Codex, not an automatically available shell command.
- If terminal shorthand is needed, install a shell alias or function that calls `scripts/new-project.sh`.

## Project-Specific Notes

- For Notion work, choose the execution path automatically:
  - Use Notion MCP tools for exploration, schema inspection, one-off setup, and small sample validation.
  - Use Notion API-oriented implementation patterns for batch migration, repeatable sync logic, and productionizable automation.
  - Do not require explicit user instruction each time; decide based on whether the task is exploratory or operational.

## Notion API Debug Playbook

When Notion API calls fail with low-level network errors such as `ECONNRESET`, do not assume the cause is request volume or business logic. Use this sequence so future debugging is consistent.

### Debug order

1. Reproduce with the smallest possible Notion endpoint.
   - Prefer `GET /v1/users/me` first.
   - If the smallest call fails, do not start by debugging project-specific payloads.
2. Compare transport paths before changing application logic.
   - Test the same endpoint with `curl`.
   - Test the same endpoint with Node `https.request()` or `fetch()`.
   - If `curl` succeeds and Node fails, treat the problem as a Node transport or TLS path issue first.
3. Separate DNS, TCP, TLS, and HTTP phases.
   - Use `NODE_DEBUG=tls,https,net` for a single minimal Node probe.
   - If Node reaches `connect` but never reaches `secureConnect`, treat it as a TLS handshake problem rather than an HTTP payload problem.
   - Use `openssl s_client -connect api.notion.com:443 -servername api.notion.com` to confirm whether TLS handshake works outside Node.
4. Check whether the issue is version-specific, but do not assume a single patch release bug.
   - If multiple Node major or minor versions show the same behavior, stop treating it as a one-version regression.
5. Test TLS-version pinning before redesigning the workflow.
   - Explicitly compare Node with forced `TLSv1.2` and forced `TLSv1.3`.
   - For this repository, the verified outcome was:
     - Node default path failed with `ECONNRESET`
     - forced `TLSv1.3` failed with `ECONNRESET`
     - forced `TLSv1.2` succeeded against Notion

### Proven findings in this repository

- `curl` to Notion API succeeded.
- `openssl s_client` handshake to `api.notion.com:443` succeeded.
- Node `https.request()` and Node `fetch()` both failed with `ECONNRESET` on minimal Notion endpoints.
- The reset happened after TCP `connect` and before TLS `secureConnect`.
- This was not caused by high request volume; a single minimal request reproduced it.
- This was not caused by outdated Notion API versioning; the failing calls were already using the current `2025-09-03` API version.
- The working transport workaround was either:
  - use `curl` for Notion API calls, or
  - force Node Notion requests to `TLSv1.2`

### Standard remediation sequence

1. First, verify whether `curl` succeeds for the same Notion endpoint.
2. If `curl` succeeds and Node fails, do not keep increasing retries blindly.
3. Add request pacing and minimal payload reduction only after confirming the failure is not a single-request TLS issue.
4. Prefer one of these fixes:
   - temporary: route Notion API calls through `curl`
   - preferred Node-side fix: force `minVersion: 'TLSv1.2'` and `maxVersion: 'TLSv1.2'` for Notion requests only
5. Keep the TLS pinning limited to Notion transport. Do not globally downgrade all HTTPS traffic unless there is a separate reason.

### Safety notes

- Never print tokens, Authorization headers, or full secret-bearing commands in output.
- When probing connectivity, use the smallest endpoint and smallest payload that can answer the current question.
- If Homebrew or version-manager installation is used for comparison, note any side effects on existing Node binaries before proceeding further.
