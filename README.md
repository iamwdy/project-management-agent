# Integration Migration Workspace

## Scope
This repository is currently being used for integration-focused migration work only.

More specifically, the active work in this repo is:
- migrate integration tracking data between legacy Notion, Asana, and the new Notion databases
- normalize partner / integration-project / task schema for integration operations
- validate page content migration for integration project records

This repository is not currently acting as a general booking PM assistant or a full reservation-operations workspace.
If booking-domain workflows are needed later, they should be documented as a separate scope instead of being mixed into the current integration migration logic.

## New Project Flow
1. Run `scripts/new-project.sh <project-name-or-path>` from this template repository
2. Read `AGENTS.md` in the new project
3. Load shared Codex preferences from the local cache or `https://github.com/iamwdy/codex-preferences`
4. Read `WIP_NOTES.md` if the project is being resumed
5. Replace this README content with project-specific documentation

## Setup
1. Copy `.env.example` to `.env`
2. Fill in only the variables needed for this project
3. Install dependencies
4. Run the project

## Migration Preview
Run a dry-run preview without writing to Notion:

`node scripts/dry-run-migration.cjs --limit 10`

Optional flags:
- `--output <path>` to write the preview JSON somewhere else
- `--no-subtasks` to preview only integration-project level records

Run the one-time importer that archives current test data and rebuilds from Asana:

`node scripts/import-migration.cjs --limit 100`

Run the content-only backfill for existing `Integration Projects` pages:

`node scripts/backfill-case-content.cjs --limit 100`

Current behavior:
- writes `Background` / `Current Progress` content into existing integration case pages
- intended for integration project pages only
- does not rebuild `Partners` or `Tasks`

## Environment Variables
- `ASANA_PAT`: required to read Asana project data through the API. Keep this local only.
- `ASANA_PROJECT_GID`: the primary Asana project to inspect and sync from.
- `NOTION_TOKEN`: required only when reading from or writing to Notion through the API.
- `NOTION_PAGE_ID`: optional page used as a parent container for a new Notion database.
- `NOTION_SOURCE_DB_ID`: optional old Notion database to compare against Asana.
- `NOTION_TARGET_DB_ID`: optional target Notion database for future sync runs.
- `SYNC_DRY_RUN`: set to `true` while validating mappings so no write happens by accident.
- `DEFAULT_TIMEZONE`: canonical timezone for due dates and sync timestamps.

## Conventions
- Project-specific agent guidance lives in `AGENTS.md`
- Shared Codex collaboration preferences should come from the `codex-preferences` repository (`https://github.com/iamwdy/codex-preferences`)
- A local machine-specific copy may also exist at `/Users/wendywang/.config/codex/PREFERENCES.md`
- If work is paused mid-development, create `WIP_NOTES.md` to capture status and next steps
- Use `scripts/new-project.sh` to create a new project from this template
- `scripts/bootstrap-project.sh` prepares the local preference cache placeholder and `WIP_NOTES.md` inside an existing project

## Recommended Prompt
Use this prompt when starting a new project with Codex:

`np：<專案名>`

Interpretation:
1. Create the project with `scripts/new-project.sh <專案名>`
2. Read `AGENTS.md`
3. Read shared `codex-preferences`
4. Read `WIP_NOTES.md` if it exists
5. Start project work

Important:
- `np：<專案名>` is a prompt convention, not a built-in shell command
- If you want a real `np` terminal command, create a shell alias or function that calls `scripts/new-project.sh`
