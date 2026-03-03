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
