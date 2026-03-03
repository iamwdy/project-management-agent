#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const { generatePreview } = require("./dry-run-migration.cjs");

const ROOT = path.resolve(__dirname, "..");
const NOTION_VERSION = "2025-09-03";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REQUEST_RETRIES = 5;
const UPDATE_BATCH_SIZE = 10;
const BATCH_DELAY_MS = 500;

function parseArgs(argv) {
  const args = {
    limit: 100,
    output: path.join(ROOT, "tmp", "delivery-status-backfill-result.json"),
    preview: null,
    onlyLegacy: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit" && argv[i + 1]) {
      args.limit = Number(argv[++i]);
    } else if (arg === "--output" && argv[i + 1]) {
      args.output = path.resolve(argv[++i]);
    } else if (arg === "--preview" && argv[i + 1]) {
      args.preview = path.resolve(argv[++i]);
    } else if (arg === "--all-statuses") {
      args.onlyLegacy = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    throw new Error("--limit must be a positive number");
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/backfill-delivery-status.cjs [--limit N] [--output FILE] [--preview FILE] [--all-statuses]

Behavior:
  - reads local .env without printing secrets
  - optionally reuses a cached dry-run preview JSON instead of re-fetching Asana
  - matches existing Integration Projects pages
  - updates only the Delivery Status property
  - defaults to updating only pages currently set to Legacy / other
  - does not rebuild databases or modify page content
`);
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

function shouldRetryStatus(statusCode) {
  return statusCode === 429 || statusCode >= 500;
}

function getRetryDelayMs(attempt, retryAfterHeader) {
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  return Math.min(1000 * 2 ** attempt, 15000);
}

async function notionRequest(method, apiPath, payload, attempt = 0) {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error("NOTION_TOKEN is required");
  }

  const body = payload ? JSON.stringify(payload) : null;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.notion.com",
        path: `/v1${apiPath}`,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          Accept: "application/json",
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
  }).catch(async (error) => {
    if (attempt >= MAX_REQUEST_RETRIES) {
      throw error;
    }

    if (error.code === "ENOTFOUND" || error.message.includes("timed out") || shouldRetryStatus(error.statusCode)) {
      await sleep(getRetryDelayMs(attempt, error.retryAfter));
      return notionRequest(method, apiPath, payload, attempt + 1);
    }

    throw error;
  });
}

async function queryAllPages(dataSourceId) {
  const results = [];
  let cursor;

  do {
    const response = await notionRequest("POST", `/data_sources/${dataSourceId}/query`, cursor ? { start_cursor: cursor } : {});
    results.push(...(response.results || []));
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  return results;
}

async function runInBatches(items, batchSize, worker, delayMs = 0) {
  const results = [];

  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const batchResults = await Promise.all(batch.map((item, batchIndex) => worker(item, index + batchIndex)));
    results.push(...batchResults);

    if (delayMs > 0 && index + batchSize < items.length) {
      await sleep(delayMs);
    }
  }

  return results;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readPreviewFromFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getDefaultPreviewPath() {
  const candidates = [
    path.join(ROOT, "tmp", "migration-preview.full.json"),
    path.join(ROOT, "tmp", "migration-preview.json"),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function getPlainText(chunks) {
  return (chunks || []).map((chunk) => chunk.plain_text || "").join("").trim();
}

function getPropertyValue(page, propertyName) {
  const property = page.properties && page.properties[propertyName];
  if (!property) {
    return null;
  }

  switch (property.type) {
    case "title":
      return getPlainText(property.title);
    case "url":
      return property.url || null;
    case "select":
    case "status":
      return property[property.type] ? property[property.type].name : null;
    default:
      return null;
  }
}

function buildPageIndex(pages) {
  const byAsanaUrl = new Map();
  const byTitle = new Map();

  for (const page of pages) {
    const asanaUrl = getPropertyValue(page, "Source Asana Task URL");
    const title = getPropertyValue(page, "Partner Name");
    if (asanaUrl) {
      byAsanaUrl.set(asanaUrl, page);
    }
    if (title && !byTitle.has(title)) {
      byTitle.set(title, page);
    }
  }

  return { byAsanaUrl, byTitle };
}

function matchPage(caseRecord, pageIndex) {
  const asanaUrl = caseRecord.properties["Source Asana Task URL"] || (caseRecord.source && caseRecord.source.permalinkUrl);
  if (asanaUrl && pageIndex.byAsanaUrl.has(asanaUrl)) {
    return pageIndex.byAsanaUrl.get(asanaUrl);
  }

  const title = caseRecord.properties["Partner Name"] || (caseRecord.source && caseRecord.source.name);
  if (title && pageIndex.byTitle.has(title)) {
    return pageIndex.byTitle.get(title);
  }

  return null;
}

async function updateDeliveryStatus(pageId, deliveryStatus) {
  return notionRequest("PATCH", `/pages/${pageId}`, {
    properties: {
      "Delivery Status": {
        select: { name: deliveryStatus },
      },
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv();

  const previewPath = args.preview || getDefaultPreviewPath();
  const preview = previewPath
    ? readPreviewFromFile(previewPath)
    : await generatePreview({ limit: args.limit, includeSubtasks: true });
  const existingPages = await queryAllPages("b0dd567d-5d09-4cbe-9c86-252754e9a42d");
  const pageIndex = buildPageIndex(existingPages);

  const matched = preview.integrationProjects
    .map((caseRecord) => ({
      caseRecord,
      page: matchPage(caseRecord, pageIndex),
    }))
    .filter((item) => item.page && item.caseRecord.properties["Delivery Status"]);

  const result = {
    generatedAt: new Date().toISOString(),
    mode: "delivery-status-backfill",
    previewSource: previewPath || "generated",
    onlyLegacy: args.onlyLegacy,
    candidates: matched.length,
    updated: [],
    skippedNoChange: [],
    skippedNotLegacy: [],
    unmatched: preview.integrationProjects
      .filter((caseRecord) => !matchPage(caseRecord, pageIndex))
      .map((caseRecord) => caseRecord.properties["Partner Name"] || caseRecord.source.name),
  };

  await runInBatches(
    matched,
    UPDATE_BATCH_SIZE,
    async ({ caseRecord, page }) => {
      const nextStatus = caseRecord.properties["Delivery Status"];
      const currentStatus = getPropertyValue(page, "Delivery Status");

      if (args.onlyLegacy && currentStatus !== "Legacy / other") {
        result.skippedNotLegacy.push({
          id: page.id,
          name: caseRecord.properties["Partner Name"] || caseRecord.source.name,
          status: currentStatus,
        });
        return;
      }

      if (currentStatus === nextStatus) {
        result.skippedNoChange.push({
          id: page.id,
          name: caseRecord.properties["Partner Name"] || caseRecord.source.name,
          status: currentStatus,
        });
        return;
      }

      await updateDeliveryStatus(page.id, nextStatus);
      result.updated.push({
        id: page.id,
        name: caseRecord.properties["Partner Name"] || caseRecord.source.name,
        from: currentStatus,
        to: nextStatus,
      });
    },
    BATCH_DELAY_MS
  );

  ensureDir(args.output);
  fs.writeFileSync(args.output, JSON.stringify(result, null, 2));

  console.log(`Delivery status backfill completed. Summary written to ${args.output}`);
  console.log(`Preview source: ${result.previewSource}`);
  console.log(`Updated: ${result.updated.length}`);
  console.log(`Skipped no change: ${result.skippedNoChange.length}`);
  console.log(`Skipped not legacy: ${result.skippedNotLegacy.length}`);
  console.log(`Unmatched: ${result.unmatched.length}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
