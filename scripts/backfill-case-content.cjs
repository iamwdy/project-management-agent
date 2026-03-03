#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const { generatePreview } = require("./dry-run-migration.cjs");

const ROOT = path.resolve(__dirname, "..");
const NOTION_VERSION = "2025-09-03";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REQUEST_RETRIES = 5;
const UPDATE_BATCH_SIZE = 5;
const BATCH_DELAY_MS = 500;

function parseArgs(argv) {
  const args = {
    limit: 100,
    output: path.join(ROOT, "tmp", "case-content-backfill-result.json"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit" && argv[i + 1]) {
      args.limit = Number(argv[++i]);
    } else if (arg === "--output" && argv[i + 1]) {
      args.output = path.resolve(argv[++i]);
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
  node scripts/backfill-case-content.cjs [--limit N] [--output FILE]

Behavior:
  - reads local .env without printing secrets
  - generates Integration Projects content preview from Asana + legacy signals
  - matches existing Integration Projects pages
  - writes page content only for blank pages
  - does not rebuild databases or modify Partners / Tasks
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

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
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

function richText(value) {
  return [
    {
      type: "text",
      text: {
        content: String(value),
      },
    },
  ];
}

function richTextWithLinks(value) {
  const text = String(value || "");
  const parts = [];
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  let lastIndex = 0;
  let match;

  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        type: "text",
        text: { content: text.slice(lastIndex, match.index) },
      });
    }

    parts.push({
      type: "text",
      text: {
        content: match[0],
        link: { url: match[0] },
      },
    });

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({
      type: "text",
      text: { content: text.slice(lastIndex) },
    });
  }

  return parts.length > 0 ? parts : richText(" ");
}

function paragraphBlock(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: richTextWithLinks(text || " "),
    },
  };
}

function bulletedListItemBlock(text) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: richTextWithLinks(text),
    },
  };
}

function heading2Block(text) {
  return {
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: richText(text),
    },
  };
}

function isImageUrl(url) {
  const value = String(url || "").trim();
  if (!value) {
    return false;
  }

  if (/^https:\/\/app\.asana\.com\/app\/asana\/-\/get_asset\?asset_id=/i.test(value)) {
    return true;
  }

  return /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(value);
}

function imageBlock(url) {
  return {
    object: "block",
    type: "image",
    image: {
      type: "external",
      external: { url: String(url) },
    },
  };
}

function calloutBlock(text, references) {
  return {
    object: "block",
    type: "callout",
    callout: {
      rich_text: richText(text),
      icon: {
        type: "emoji",
        emoji: "📝",
      },
      color: "gray_background",
      children: references.map((reference) => bulletedListItemBlock(reference)),
    },
  };
}

function parseContentPreview(contentPreview) {
  const text = String(contentPreview || "").trim();
  if (!text) {
    return { references: [], background: "", currentProgress: "" };
  }

  const lines = text.split("\n");
  const references = [];
  const backgroundLines = [];
  const progressLines = [];
  let mode = null;

  for (const line of lines) {
    if (line.startsWith("> Asana: ") || line.startsWith("> Legacy Notion: ") || line.startsWith("> Parent Asana bucket: ")) {
      references.push(line.replace(/^>\s*/, ""));
      continue;
    }

    if (line === "## Background") {
      mode = "background";
      continue;
    }

    if (line === "## Current Progress") {
      mode = "progress";
      continue;
    }

    if (line.startsWith("> [!NOTE]") || line.startsWith("> This card was migrated from legacy sources.")) {
      continue;
    }

    if (mode === "background") {
      backgroundLines.push(line);
    } else if (mode === "progress") {
      progressLines.push(line);
    }
  }

  return {
    references,
    background: backgroundLines.join("\n").trim(),
    currentProgress: progressLines.join("\n").trim(),
  };
}

function blocksFromSectionText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return [paragraphBlock(" ")];
  }

  const blocks = [];
  const chunks = normalized.split(/\n\s*\n/).map((chunk) => chunk.trim()).filter(Boolean);

  for (const chunk of chunks) {
    const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
    const textLines = [];

    for (const line of lines) {
      if (/^https?:\/\//i.test(line) && isImageUrl(line)) {
        if (textLines.length > 0) {
          blocks.push(paragraphBlock(textLines.join("\n")));
          textLines.length = 0;
        }
        blocks.push(imageBlock(line));
      } else {
        textLines.push(line);
      }
    }

    if (textLines.length > 0) {
      blocks.push(paragraphBlock(textLines.join("\n")));
    }
  }

  return blocks.length > 0 ? blocks : [paragraphBlock(" ")];
}

function buildChildrenFromContentPreview(contentPreview) {
  const parsed = parseContentPreview(contentPreview);
  return [
    calloutBlock("This card was migrated from legacy sources.", parsed.references),
    heading2Block("Background"),
    ...blocksFromSectionText(parsed.background),
    heading2Block("Current Progress"),
    ...blocksFromSectionText(parsed.currentProgress),
  ];
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

async function isBlankPage(pageId) {
  const response = await notionRequest("GET", `/blocks/${pageId}/children?page_size=1`);
  return !response.results || response.results.length === 0;
}

async function appendChildren(pageId, children) {
  return notionRequest("PATCH", `/blocks/${pageId}/children`, { children });
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv();

  const schemaConfig = readJson("config/schema/live-databases.json");
  const preview = await generatePreview({ limit: args.limit, includeSubtasks: true });
  const existingPages = await queryAllPages(schemaConfig.sources.notionIntegrationProjectsDataSourceId);
  const pageIndex = buildPageIndex(existingPages);

  const candidates = preview.integrationProjects
    .map((caseRecord) => ({
      caseRecord,
      page: matchPage(caseRecord, pageIndex),
    }))
    .filter((item) => item.page && item.caseRecord.contentPreview);

  const result = {
    generatedAt: new Date().toISOString(),
    mode: "content-backfill",
    candidates: candidates.length,
    updated: [],
    skippedNonBlank: [],
    unmatched: preview.integrationProjects
      .filter((caseRecord) => !matchPage(caseRecord, pageIndex))
      .map((caseRecord) => caseRecord.properties["Partner Name"] || caseRecord.source.name),
  };

  await runInBatches(
    candidates,
    UPDATE_BATCH_SIZE,
    async ({ caseRecord, page }) => {
      const blank = await isBlankPage(page.id);
      if (!blank) {
        result.skippedNonBlank.push({
          id: page.id,
          name: caseRecord.properties["Partner Name"] || caseRecord.source.name,
        });
        return;
      }

      const children = buildChildrenFromContentPreview(caseRecord.contentPreview);
      await appendChildren(page.id, children);
      result.updated.push({
        id: page.id,
        name: caseRecord.properties["Partner Name"] || caseRecord.source.name,
      });
    },
    BATCH_DELAY_MS
  );

  ensureDir(args.output);
  fs.writeFileSync(args.output, JSON.stringify(result, null, 2));

  console.log(`Content backfill completed. Summary written to ${args.output}`);
  console.log(`Updated: ${result.updated.length}`);
  console.log(`Skipped non-blank: ${result.skippedNonBlank.length}`);
  console.log(`Unmatched: ${result.unmatched.length}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
