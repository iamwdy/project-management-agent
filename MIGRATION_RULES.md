# Batch Migration Rules

## Scope

This document turns the current migration decisions into an executable rule set for batch migration from:

- legacy Notion database `inline clients & partners integrations`
- current Asana project `inline Clients & Partners Integrations`

into the new Notion model:

- `Partners` = company / vendor master
- `Integration Projects` = one row per real integration case
- `Tasks` = execution-level work items

The case-layer database was previously referred to in notes as `Partner Integration Hub`, but the current live data source title in Notion is `Integration Projects`.

Important historical context:

- The legacy Notion database is the pre-Asana source model, not just a side reference.
- The workflow was: old Notion database -> moved into Asana for active management -> migrated back into the new Notion model.
- Because of that history, Asana should be treated as the operational layer that flattened some older Notion semantics.
- When Asana and legacy Notion disagree about classification or naming, use legacy Notion as stronger evidence for the original model.

Machine-readable migration config lives in:

- `config/schema/live-databases.json`
- `config/mappings/asana-to-notion.json`
- `config/mappings/asana-option-normalization.json`

## Canonical Model

### Layer rules

- Create one `Partners` row per normalized partner company name.
- Create one `Integration Projects` row per actual integration case.
- Create one `Tasks` row per execution-level work item only.
- Link every integration case to exactly one `Partner` row when a partner can be determined.
- Link execution tasks to the relevant integration case through `Tasks` <-> `Partner Hub`.

### Case identity rule

Treat a row as an `Integration Projects` case when it represents one of:

- a partner-wide integration effort
- a partner-to-brand implementation
- a partner-to-restaurant-group implementation
- a partner-to-restaurant implementation

Do not treat a row as a case when it is only:

- NDA
- document preparation
- testing
- training
- clarification
- environment setup
- access provisioning
- one-off follow-up work

## Source Priority

### Record merge priority

- Use legacy Notion as the primary source for historical lifecycle context, legacy delivery status, document URLs, and notes.
- Use legacy Notion fields such as `partner name`, `partnership status`, `Integration Status`, URLs, and notes as recovery signals when reconstructing the migrated model.
- Use Asana as the primary source for current operational structure, section status, assignee, subtasks, and recent task description.
- If both systems contain useful but conflicting data, prefer:
  - legacy Notion for `Lifecycle Status`
  - legacy Notion for `Delivery Status` when old `Integration Status` exists
  - legacy Notion for partner naming and historical case semantics when the Asana board structure is ambiguous
  - Asana for current execution details and subtask structure
- Preserve raw conflicting values in `Notes` or page content instead of forcing lossy normalization.

### Page content priority

- If the Asana description already contains explicit `Background` and/or `Current Progress` sections, mirror them directly.
- Otherwise:
  - put durable context into `Background`
  - put current updates into `Current Progress`
- If source text is sparse, keep `Current Progress` present but empty.
- Keep raw Asana detail only when it adds context that should not be collapsed into properties.

## Partner Deduplication

### Partner key

Use `Partners.Normalized Name` as the dedupe key.

Normalize partner names by:

- lowercasing
- trimming outer whitespace
- collapsing repeated inner whitespace
- removing decorative punctuation when it does not change identity
- preserving meaningful words from bilingual names when they identify the same company

Examples:

- `KCSYS 冠全` -> `kcsys`
- `Yahoo Table` -> `yahoo table`
- `Advocado` -> `advocado`

### Partner creation rule

- If normalized partner already exists in `Partners`, reuse it.
- If not, create a new `Partners` row.
- Populate partner-level properties only when the value is clearly company-level rather than case-level.

## Integration Case Creation

Create one `Integration Projects` page per merged case with:

- title in `Partner Name`
- partner relation in `Partner`
- source traceability fields
- normalized statuses
- relevant structured properties
- minimal page content using the current template

### Current page template

Use this exact structure:

1. top gray callout with icon `📝`
2. callout opening line: `This card was migrated from legacy sources.`
3. `Source References` as bullets inside the callout
4. `## Background`
5. `## Current Progress`

### Source references rules

Include only relevant source links such as:

- Asana task or subtask
- legacy Notion page
- key legacy task record when a case was promoted from an execution task

Do not place Canny links in `Source References`.

### Background rules

Put the following under `Background` when present:

- migrated source context
- integration docs
- screenshots / attachment images
- Slack deep links if they are already part of the approved source content

### Current Progress rules

Put the following under `Current Progress` when present:

- recent milestones
- pending next steps
- open delivery updates

## Property Mapping

### Identity and traceability

- legacy Notion `partner name` / Asana task `name` -> `Integration Projects.Partner Name`
- legacy Notion row URL -> `Integration Projects.Source Notion URL`
- Asana task URL -> `Integration Projects.Source Asana Task URL`
- source composition -> `Integration Projects.Source System`
  - `Notion` if only legacy Notion exists
  - `Asana` if only Asana exists
  - `Merged` if both exist
- migration run timestamp -> `Integration Projects.Last Source Sync`

### Partner-level mapping

- normalized partner name -> `Partners.Normalized Name`
- partner company display name -> `Partners.Partner Name`
- company-level `Partner Type` -> `Partners.Partner Type`
- company-level `Country` -> `Partners.Country`
- linked integration cases -> `Partners.Integration Cases`
- company-level notes that do not fit the current schema -> `Partners.Notes`
- partner source composition -> `Partners.Source System`
- migration run timestamp -> `Partners.Last Source Sync`

### Current live Partners schema

The live `Partners` database in Notion is currently limited to:

- `Partner Name`
- `Normalized Name`
- `Partner Type`
- `Country`
- `Integration Cases`
- `Notes`
- `Last Source Sync`
- `Source System`

Do not write partner-level values into non-existent properties. Until the schema changes, keep values such as `Primary Contact`, `Business Owner`, `Primary PM`, `Partner Website`, and `Canny URL` on the integration-case layer or preserve them in `Partners.Notes`.

### Case property mapping

- old `country` / Asana `Country` -> `Country`
- old `partner type` / Asana `Partner Type` -> `Partner Type`
- old `PM` / Asana assignee / `Assignee (imported)` -> `Primary PM`
- old `BD / AM rep` / Asana collaborators -> `Business Owner` and optionally `External Collaborator`
- old `3rd party contact` / Asana `3rd party contact` -> `External Contact`
- old `Integration Type` / Asana `Integration Type` -> `Integration Type`
- old `Integration Scope` / Asana `Integration Scope` -> `Integration Scope`
- old `partnership type` / Asana `partnership type` -> `Commercial Model`
- old `Scope` / Asana `Scope` -> `Implementation Scope Detail`
- old `contract status` / Asana `Contract status` -> `Contract Status`
- old `contract starts` / Asana `contract starts` -> `Contract Start`
- old `contract term` / Asana `contract term` -> `Contract Term`
- old `#restaurants` / Asana `#restaurants` / Asana `Restaurant` -> `Restaurant Coverage`
- old `groupId` / Asana `groupId` -> `Group ID`
- old `Integration Doc` / Asana `Integration Doc` -> `Integration Doc URL`
- old `Onboard doc` / Asana `Onboard doc` -> `Onboard Doc URL`
- old `Integrated Scenarios doc` -> `Scenario Doc URL`
- old `Canny` / Asana `Canny` -> `Canny URL`
- Asana `Developed by` -> `Developed By`
- Asana `Material Preparation` -> `Material Preparation`
- old `Clarification Required` / Asana `Clarification Required` -> `Clarification Status`
- old `Feature Requests` / Asana `Feature Requests` -> `Feature Requests`
- old `FO Integrations` / Asana `FO Integrations` -> `FO Integrations`
- old `TMS Integrations` / Asana `TMS Integrations` -> `TMS Integrations`
- Asana `Key Partner` -> `Key Partner`
- merged free text -> `Notes`, `Conversation Summary`, `Open Questions`, `Next Action`

### Current live Integration Projects schema

The live case database currently includes these properties:

- `Partner Name`
- `Partner`
- `Tasks`
- `Country`
- `Partner Type`
- `Lifecycle Status`
- `Delivery Status`
- `Primary PM`
- `Business Owner`
- `External Collaborator`
- `External Contact`
- `Developed By`
- `Integration Type`
- `Integration Scope`
- `Commercial Model`
- `Implementation Scope Detail`
- `Contract Status`
- `Contract Start`
- `Contract Term`
- `Restaurant Coverage`
- `Group ID`
- `Integration Doc URL`
- `Onboard Doc URL`
- `Scenario Doc URL`
- `Canny URL`
- `Material Preparation`
- `Clarification Status`
- `Feature Requests`
- `FO Integrations`
- `TMS Integrations`
- `Key Partner`
- `Notes`
- `Conversation Summary`
- `Open Questions`
- `Next Action`
- `Manual Intake Needed`
- `Last Source Sync`
- `Source Notion URL`
- `Source Asana Task URL`
- `Source System`

Use the live property names and types above as the source of truth. In particular:

- `Primary PM` is a people field
- `Business Owner` is a text field
- `External Collaborator` is available as a separate text field
- `Country` currently supports only `TW`, `HK`, `SG`, `AU`, and `TH`

## Type Handling Rules

### URLs

- Write to Notion URL properties only when the value is a valid URL.
- If a source field looks like free text or mixed content, keep it in `Notes` or page content.

### Dates

- `Contract Start` stays text-first during migration.
- `Last Source Sync` is always written as datetime.

### People

- Use Notion people fields only when a resolvable Notion user mapping exists.
- If no user mapping exists, preserve the raw human name in text fields rather than dropping it.

### Multi-select normalization

- Split packed source values into multiple canonical options when the source encodes more than one concept.
- If a source value cannot be safely normalized, map to `Other` or `Legacy / other` and preserve the raw text in `Notes`.

## Status Mapping

### Status separation

Keep these fields separate:

- `Lifecycle Status` = commercial / relationship stage
- `Delivery Status` = execution / implementation stage
- Asana section `3rd Party Partners` is a board-organization bucket for partner-level items, not a real execution-stage status.
- Do not map `3rd Party Partners` directly into `Integration Projects.Delivery Status`.
- If a record only carries `3rd Party Partners` as its Asana section, leave `Delivery Status` unset unless stronger evidence exists from legacy Notion or other source context.
- A parent task in `3rd Party Partners` may exist only as the partner bucket or grouping container.
- In that pattern, its subtasks can still represent real integration cases and must be evaluated independently.
- If legacy relation fields are missing or unreliable, fall back to legacy naming, status fields, URLs, and notes rather than blocking migration.

### Lifecycle source priority

1. legacy Notion `partnership status`
2. Asana `Partnership status`
3. blank

### Delivery source priority

1. legacy Notion `Integration Status`
2. Asana board section name
3. blank

### Lifecycle normalization

- `live`
- `live (since ...)`
- `live (partial)...`
- `for 晶華`
- `to live (gradually go live)`
  -> `Live`

- `signed`
  -> `Signed`

- `in discussion`
- `in discussion - ...`
- `to sign NDA and discuss technical details`
  -> `In discussion`

- `to integrate`
  -> `To integrate`

- `integratoin to start`
  -> `Integration to start`

- `on hold`
- `on hold - ...`
  -> `On hold`

- `terminated`
  -> `Terminated`

- any mixed legacy free text such as:
  - `partner keen to integrate - aim to live end of 2019/ beginning of 2020. To sign NDA and partner to start testing`
  - `integratoin ongoing ...`
  - `bookability for full inventory. to arrange tech discussion`
  - `free booking - live / paid booking - in discussion`
  -> `Legacy / other`

Preserve the raw source value in `Notes` whenever `Legacy / other` is used.

### Delivery normalization from legacy Notion

- `In discussion` -> `In Discussion`
- `Action Require` -> `Action Required`
- `in development by partner` -> `In Development by Partner`
- `launched` -> `Launched`
- `launched - but still takes time` -> `Launched - follow-up`
- `on pause` -> `On Pause`
- `terminated` -> `Terminated`
- `pending for a while` -> `Pending for a while`
- `free booking - launch / paid booking - in development` -> `Launched - follow-up`
- `in development by inline` -> `Legacy / other`
- `pending launch` -> `Legacy / other`
- `Issue Investigation` -> `Legacy / other`
- `TBC` -> `Legacy / other`

Preserve the raw source value in `Notes` whenever `Legacy / other` is used.

### Delivery normalization from Asana board section

- `3rd Party Partners` -> no direct `Delivery Status` mapping; treat as partner bucket context
- `In Discussion` -> `In Discussion`
- `Action Require` -> `Action Required`
- `Action Require, launched` -> `Launched - follow-up`
- `Action Require, on pause` -> `On Pause`
- `Action Require, in development by partner` -> `In Development by Partner`
- `In Development by partner, pending for a while` -> `Pending for a while`
- `In Development by Partner` -> `In Development by Partner`
- `Free Booking - launch / paid booking - in development` -> `Launched - follow-up`
- `Pending for a while` -> `Pending for a while`
- `On Pause` -> `On Pause`
- `Terminated` -> `Terminated`
- `Launched - but still takes time` -> `Launched - follow-up`
- `Launched` -> `Launched`

### Conflict resolution

- If legacy `Integration Status` exists, use it for `Delivery Status`.
- If legacy `partnership status` exists, use it for `Lifecycle Status`.
- If legacy Notion gives a cleaner partner name or clearer historical classification than Asana, use the legacy value as the canonical reference and preserve the Asana raw value in notes when needed.
- Exception for `Delivery Status`:
  - if legacy `Integration Status` only normalizes to `Legacy / other`
  - and Asana board section normalizes to a more specific canonical delivery status
  - prefer the Asana delivery status instead of keeping `Legacy / other`
- If old and new systems disagree:
  - prefer the system with the clearer and less obviously stale value
  - keep the secondary raw value in `Notes` or page content

## Subtask Promotion Rules

### Promote to integration case when

Promote an Asana subtask into `Integration Projects` if it clearly represents:

- a partner-to-brand implementation
- a partner-to-restaurant implementation
- a named rollout for a specific merchant group or restaurant brand
- a distinct implementation track that would otherwise be hidden under a generic parent task
- a real implementation case nested under a `3rd Party Partners` parent bucket

### Keep in Tasks when

Keep an Asana subtask in `Tasks` if it is a work item such as:

- `NDA`
- `Integration Doc`
- `Integration Test`
- `Training Doc`
- `Get the test app from the POS ready and available for demo`
- `Prepare training materials with Antonia`
- `Clarifications on integration scenarios and get test account from 點點廚`
- `Goal #1: connect the Abacus testing env that can work for the inline integration`
- `Goal #2: reach out to Tyro for how to enable the no.2 POS in AU`
- `Get a demo account from the partner (PC-only)`
- `Verify the training doc is ready from Antonia`

### Promotion implementation rules

- When promoting a case-like subtask, create a new `Integration Projects` page instead of only linking the subtask task.
- Re-fetch the original Asana subtask description and use it as source material for page content.
- Do not rely only on summary text already stored in `Tasks`.
- Link the promoted case to the same `Partner` master when applicable.
- Keep the legacy execution task record only when it still represents execution work or source traceability.
- If the parent Asana task is only a `3rd Party Partners` bucket, do not force that parent into `Integration Projects` unless it also stands on its own as a real implementation case.

### Current promotion candidates

Treat these as the next known candidates for promotion:

- `Salt & Stone`
  - parent task: `開展集團 <> inline`
- `Outback Steak House (HK) <> Seapoint`
  - parent task: `Seapoint`
- `Other Restaurants <> Seapoint`
  - parent task: `Seapoint`

## Batch Migration Sequence

1. Load all legacy Notion rows and Asana tasks.
2. Build a merged case candidate list keyed by source URLs and normalized names.
3. Normalize partner names and upsert `Partners`.
4. Decide case-vs-task classification for each top-level task and subtask.
5. Normalize statuses and property values.
6. Validate URLs before writing URL properties.
7. Create or update `Integration Projects` pages.
8. Create or update `Tasks` pages for execution items only.
9. Attach relations:
   - case -> partner
   - task -> case
10. Write page content using the current template.
11. Stamp `Last Source Sync`.
12. Log unmapped or lossy values for manual review.

## Manual Review Queue

Send a record to manual review when any of the following is true:

- partner identity is ambiguous
- one source value maps to multiple possible canonical options
- a supposed URL is not a valid URL
- a person field cannot be resolved to a Notion user
- lifecycle or delivery status falls into `Legacy / other`
- a subtask may be either a case or a task

## Pre-flight Cleanup Before Batch Run

Before running batch migration at scale:

- resolve duplicate sample pages such as duplicate `DTF SG <> inline`
- standardize existing sample pages to the current page template
- remove or clearly isolate old inline database views from the draft hub page
- confirm the final production names of the target databases, since the current case database title is `Integration Projects`
