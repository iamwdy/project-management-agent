#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const NOTION_VERSION = "2025-09-03";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REQUEST_RETRIES = 5;
const BATCH_DELAY_MS = 500;
const LIST_PAGE_SIZE = 100;

function printHelp() {
  console.log(`Usage:
  node scripts/clone-notion-card-components.cjs \\
    --source-page <notion-page-id-or-url> \\
    --targets <id-or-url,id-or-url,...> [--dry-run]

Optional:
  --targets-file <path>         One page id/url per line
  --include-types <list>        default: button,child_database,link_to_page,synced_block
  --section-heading-keywords    e.g. task,tasks
  --section-follow-types        default: child_database,link_to_page,synced_block
  --section-follow-title-keywords  e.g. project checklist
  --strict-tasks-only           only keep database-like blocks with "Tasks" in title/caption
  --dry-run                     preview only, no write
  --output <path>               default: tmp/clone-card-components-result.json

Notes:
  - This script reads local .env without printing secrets.
  - It appends cloned blocks to target pages.
  - Unsupported block types are skipped and reported.
`);
}

function parseArgs(argv) {
  const args = {
    sourcePage: null,
    targets: [],
    targetsFile: null,
    includeTypes: ["button", "child_database", "link_to_page", "synced_block"],
    sectionHeadingKeywords: [],
    sectionFollowTypes: ["child_database", "link_to_page", "synced_block"],
    sectionFollowTitleKeywords: [],
    strictTasksOnly: false,
    dryRun: false,
    output: path.join(ROOT, "tmp", "clone-card-components-result.json"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source-page" && argv[i + 1]) {
      args.sourcePage = argv[++i];
    } else if (arg === "--targets" && argv[i + 1]) {
      args.targets = argv[++i]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (arg === "--targets-file" && argv[i + 1]) {
      args.targetsFile = path.resolve(argv[++i]);
    } else if (arg === "--include-types" && argv[i + 1]) {
      args.includeTypes = argv[++i]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (arg === "--section-heading-keywords" && argv[i + 1]) {
      args.sectionHeadingKeywords = argv[++i]
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg === "--section-follow-types" && argv[i + 1]) {
      args.sectionFollowTypes = argv[++i]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (arg === "--section-follow-title-keywords" && argv[i + 1]) {
      args.sectionFollowTitleKeywords = argv[++i]
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg === "--strict-tasks-only") {
      args.strictTasksOnly = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--output" && argv[i + 1]) {
      args.output = path.resolve(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.sourcePage) {
    throw new Error("--source-page is required");
  }

  if (args.targetsFile) {
    if (!fs.existsSync(args.targetsFile)) {
      throw new Error(`targets file not found: ${args.targetsFile}`);
    }
    const fromFile = fs
      .readFileSync(args.targetsFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    args.targets.push(...fromFile);
  }

  args.targets = Array.from(new Set(args.targets));
  if (args.targets.length === 0) {
    throw new Error("at least one target is required via --targets or --targets-file");
  }

  return args;
}

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(attempt, retryAfterHeader) {
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }
  return Math.min(1000 * 2 ** attempt, 15000);
}

function shouldRetryStatus(statusCode) {
  return statusCode === 429 || statusCode >= 500;
}

async function notionRequest(method, apiPath, payload, attempt = 0) {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error("NOTION_TOKEN is required");
  }

  try {
    return await notionRequestViaNode(method, apiPath, payload, token);
  } catch (nodeError) {
    try {
      return notionRequestViaCurl(method, apiPath, payload, token, nodeError);
    } catch (curlError) {
      if (attempt >= MAX_REQUEST_RETRIES) {
        throw curlError;
      }

      const statusCode = curlError.statusCode || nodeError.statusCode;
      const retryAfter = curlError.retryAfter || nodeError.retryAfter;
      if (
        nodeError.code === "ENOTFOUND" ||
        nodeError.code === "ECONNRESET" ||
        nodeError.message.includes("timed out") ||
        shouldRetryStatus(statusCode)
      ) {
        await sleep(getRetryDelayMs(attempt, retryAfter));
        return notionRequest(method, apiPath, payload, attempt + 1);
      }

      throw curlError;
    }
  }
}

async function notionRequestViaNode(method, apiPath, payload, token) {
  const body = payload ? JSON.stringify(payload) : null;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.notion.com",
        path: `/v1${apiPath}`,
        method,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.2",
        ALPNProtocols: ["http/1.1"],
        agent: false,
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          Accept: "application/json",
          Connection: "close",
          ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error(`Notion API ${res.statusCode}: ${responseBody}`);
            error.statusCode = res.statusCode;
            error.retryAfter = res.headers["retry-after"];
            reject(error);
            return;
          }

          try {
            resolve(JSON.parse(responseBody));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Notion API request timed out"));
    });
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function notionRequestViaCurl(method, apiPath, payload, token, originalError) {
  const url = `https://api.notion.com/v1${apiPath}`;
  const args = [
    "--silent",
    "--show-error",
    "--request",
    method,
    "--url",
    url,
    "--header",
    `Authorization: Bearer ${token}`,
    "--header",
    `Notion-Version: ${NOTION_VERSION}`,
    "--header",
    "Accept: application/json",
    "--write-out",
    "\n%{http_code}",
  ];

  if (payload) {
    args.push("--header", "Content-Type: application/json", "--data", JSON.stringify(payload));
  }

  const output = execFileSync("curl", args, { encoding: "utf8" });
  const lineBreakIndex = output.lastIndexOf("\n");
  if (lineBreakIndex === -1) {
    throw new Error("Invalid curl response from Notion API");
  }

  const responseBody = output.slice(0, lineBreakIndex);
  const statusCode = Number(output.slice(lineBreakIndex + 1));
  if (!Number.isFinite(statusCode)) {
    throw new Error("Missing HTTP status from Notion API");
  }
  if (statusCode < 200 || statusCode >= 300) {
    const error = new Error(`Notion API ${statusCode}: ${responseBody}`);
    error.statusCode = statusCode;
    error.originalError = originalError;
    throw error;
  }
  return JSON.parse(responseBody);
}

function normalizeNotionId(input) {
  const value = String(input || "").trim();
  const idMatch = value.match(/[0-9a-f]{32}/i);
  if (!idMatch) {
    throw new Error(`Cannot parse Notion ID from: ${input}`);
  }
  return idMatch[0];
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

function blockTitleText(block) {
  if (!block || !block.type) {
    return "";
  }
  const data = block[block.type];
  if (!data) {
    return "";
  }
  if (block.type === "child_database") {
    return String(data.title || "").trim();
  }
  if (block.type === "link_to_page") {
    return "link_to_page";
  }
  const richText = data.rich_text || data.caption || [];
  return (richText || []).map((item) => item.plain_text || "").join("").trim();
}

function shouldKeepBlock(block, includeTypes, strictTasksOnly) {
  if (!block || !block.type) {
    return false;
  }
  if (!includeTypes.includes(block.type)) {
    return false;
  }
  if (!strictTasksOnly) {
    return true;
  }
  const title = blockTitleText(block).toLowerCase();
  if (block.type === "button") {
    return title.includes("task");
  }
  return title.includes("task");
}

function isHeadingBlock(block) {
  return block && (block.type === "heading_1" || block.type === "heading_2" || block.type === "heading_3");
}

function getSectionBlocks(sourceChildren, sectionHeadingKeywords, sectionFollowTypes, sectionFollowTitleKeywords) {
  const selected = [];
  if (!sectionHeadingKeywords || sectionHeadingKeywords.length === 0) {
    return selected;
  }

  const headingSet = new Set(sectionHeadingKeywords.map((item) => item.toLowerCase()));
  const seenIds = new Set();

  for (let i = 0; i < sourceChildren.length; i += 1) {
    const block = sourceChildren[i];
    if (!isHeadingBlock(block)) {
      continue;
    }
    const headingText = blockTitleText(block).toLowerCase();
    if (!headingSet.has(headingText)) {
      continue;
    }

    if (!seenIds.has(block.id)) {
      selected.push(block);
      seenIds.add(block.id);
    }

    for (let j = i + 1; j < sourceChildren.length; j += 1) {
      const next = sourceChildren[j];
      if (isHeadingBlock(next)) {
        break;
      }
      if (!sectionFollowTypes.includes(next.type)) {
        continue;
      }
      if (sectionFollowTitleKeywords && sectionFollowTitleKeywords.length > 0) {
        const followTitle = blockTitleText(next).toLowerCase();
        const matchedTitle = sectionFollowTitleKeywords.some((keyword) => followTitle.includes(keyword));
        if (!matchedTitle) {
          continue;
        }
      }
      if (!seenIds.has(next.id)) {
        selected.push(next);
        seenIds.add(next.id);
      }
    }
  }

  return selected;
}

async function listAllChildren(blockId) {
  let cursor = null;
  const results = [];

  do {
    const query = new URLSearchParams();
    query.set("page_size", String(LIST_PAGE_SIZE));
    if (cursor) {
      query.set("start_cursor", cursor);
    }
    const response = await notionRequest("GET", `/blocks/${blockId}/children?${query.toString()}`);
    results.push(...(response.results || []));
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  return results;
}

function pickCreatableBlockPayload(block) {
  if (!block || !block.type) {
    return null;
  }
  if (block.type === "unsupported") {
    return null;
  }

  const payload = {
    object: "block",
    type: block.type,
  };

  const blockData = block[block.type];
  if (blockData == null) {
    return null;
  }

  const cleaned = JSON.parse(JSON.stringify(blockData));
  delete cleaned.color;
  payload[block.type] = cleaned;
  return payload;
}

async function cloneBlockRecursively(sourceBlock, skipped) {
  const cloned = pickCreatableBlockPayload(sourceBlock);
  if (!cloned) {
    skipped.push({
      id: sourceBlock.id,
      type: sourceBlock.type,
      reason: "unsupported_or_non_creatable",
    });
    return null;
  }

  if (sourceBlock.has_children) {
    const children = await listAllChildren(sourceBlock.id);
    const clonedChildren = [];
    for (const child of children) {
      const clonedChild = await cloneBlockRecursively(child, skipped);
      if (clonedChild) {
        clonedChildren.push(clonedChild);
      }
    }
    if (clonedChildren.length > 0) {
      cloned[cloned.type].children = clonedChildren;
    }
  }

  return cloned;
}

async function appendBlocksToPage(pageId, blocks) {
  for (const batch of chunk(blocks, 100)) {
    await notionRequest("PATCH", `/blocks/${pageId}/children`, { children: batch });
    await sleep(BATCH_DELAY_MS);
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv();

  const sourcePageId = normalizeNotionId(args.sourcePage);
  const targetPageIds = args.targets.map(normalizeNotionId).filter((id) => id !== sourcePageId);
  if (targetPageIds.length === 0) {
    throw new Error("No valid target pages remain after removing source page");
  }

  const sourceChildren = await listAllChildren(sourcePageId);
  const sectionBlocks = getSectionBlocks(
    sourceChildren,
    args.sectionHeadingKeywords,
    args.sectionFollowTypes,
    args.sectionFollowTitleKeywords
  );
  const selected =
    sectionBlocks.length > 0
      ? sectionBlocks
      : sourceChildren.filter((block) => shouldKeepBlock(block, args.includeTypes, args.strictTasksOnly));
  const skipped = [];
  const clonedBlocks = [];
  for (const block of selected) {
    const cloned = await cloneBlockRecursively(block, skipped);
    if (cloned) {
      clonedBlocks.push(cloned);
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    sourcePageId,
    targetCount: targetPageIds.length,
    includeTypes: args.includeTypes,
    sectionHeadingKeywords: args.sectionHeadingKeywords,
    sectionFollowTypes: args.sectionFollowTypes,
    sectionFollowTitleKeywords: args.sectionFollowTitleKeywords,
    strictTasksOnly: args.strictTasksOnly,
    dryRun: args.dryRun,
    selectedBlockCount: selected.length,
    clonedBlockCount: clonedBlocks.length,
    skipped,
    targets: [],
  };

  for (const targetId of targetPageIds) {
    if (!args.dryRun) {
      await appendBlocksToPage(targetId, clonedBlocks);
    }
    result.targets.push({
      targetPageId: targetId,
      status: args.dryRun ? "dry_run_only" : "updated",
      appendedBlocks: clonedBlocks.length,
    });
  }

  ensureDir(args.output);
  fs.writeFileSync(args.output, JSON.stringify(result, null, 2));

  console.log(`Done. Output written to: ${args.output}`);
  console.log(`Selected blocks: ${selected.length}`);
  console.log(`Clonable blocks: ${clonedBlocks.length}`);
  console.log(`Targets: ${targetPageIds.length}`);
  if (args.dryRun) {
    console.log("Dry run only. No page was modified.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
