#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const { generatePreview } = require("./dry-run-migration.cjs");

const ROOT = path.resolve(__dirname, "..");
const NOTION_VERSION = "2025-09-03";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REQUEST_RETRIES = 5;
const ARCHIVE_BATCH_SIZE = 10;
const CREATE_BATCH_SIZE = 5;
const BATCH_DELAY_MS = 500;

function parseArgs(argv) {
  const args = {
    limit: 100,
    output: path.join(ROOT, "tmp", "migration-import-result.json"),
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
  node scripts/import-migration.cjs [--limit N] [--output FILE]

Behavior:
  - reads local .env without printing secrets
  - rebuilds the three target Notion databases from Asana
  - archives existing pages in the target databases before re-import
  - writes a summary report JSON
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

async function archivePages(dataSourceId) {
  const pages = await queryAllPages(dataSourceId);
  await runInBatches(
    pages,
    ARCHIVE_BATCH_SIZE,
    (page) => notionRequest("PATCH", `/pages/${page.id}`, { in_trash: true }),
    BATCH_DELAY_MS
  );
  return pages.length;
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

  return parts.length > 0 ? parts : richText("");
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null || value === "") {
      continue;
    }
    return value;
  }
  return null;
}

function buildNotionProperties(schema, record, relationIdsByProperty = {}) {
  const properties = {};

  for (const [propertyName, propertyType] of Object.entries(schema)) {
    const value = relationIdsByProperty[propertyName] ?? record[propertyName];

    if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) {
      continue;
    }

    switch (propertyType) {
      case "title":
        properties[propertyName] = { title: richText(value) };
        break;
      case "text":
        properties[propertyName] = { rich_text: richText(value) };
        break;
      case "url":
        properties[propertyName] = { url: String(value) };
        break;
      case "select":
        properties[propertyName] = { select: { name: String(value) } };
        break;
      case "status":
        properties[propertyName] = { status: { name: String(value) } };
        break;
      case "multi_select":
        properties[propertyName] = {
          multi_select: Array.isArray(value) ? value.map((item) => ({ name: String(item) })) : [{ name: String(value) }],
        };
        break;
      case "checkbox":
        properties[propertyName] = { checkbox: Boolean(value) };
        break;
      case "date":
        properties[propertyName] = { date: { start: String(value) } };
        break;
      case "relation":
        properties[propertyName] = {
          relation: (Array.isArray(value) ? value : [value]).map((id) => ({ id })),
        };
        break;
      default:
        break;
    }
  }

  return properties;
}

function normalizePartnerName(caseRecord) {
  const explicit = firstNonEmpty(
    caseRecord.source && caseRecord.source.resolvedPartnerName,
    caseRecord.source && caseRecord.source.promotedFromSubtask ? caseRecord.source.parentTaskName : null,
    caseRecord.properties["Partner Name"]
  );
  const base = String(explicit || "").trim();
  if (!base) {
    return "";
  }

  if (caseRecord.source && caseRecord.source.promotedFromSubtask) {
    return base;
  }

  if (base.includes("<>")) {
    return base.split("<>")[0].trim();
  }

  return base;
}

function normalizePartnerKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[<>()[\],.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
    return [];
  }

  const lines = text.split("\n");
  const references = [];
  let backgroundLines = [];
  let progressLines = [];
  let mode = null;

  for (const line of lines) {
    if (line.startsWith("> Asana: ")) {
      references.push(line.replace(/^>\s*/, ""));
      continue;
    }

    if (line.startsWith("> Legacy Notion: ")) {
      references.push(line.replace(/^>\s*/, ""));
      continue;
    }

    if (line.startsWith("> Parent Asana bucket: ")) {
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
    return [paragraphBlock("")];
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

  return blocks.length > 0 ? blocks : [paragraphBlock("")];
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

async function createPage(dataSourceId, properties, children = []) {
  return notionRequest("POST", "/pages", {
    parent: { data_source_id: dataSourceId },
    properties,
    ...(children.length > 0 ? { children } : {}),
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv();

  const schemaConfig = readJson("config/schema/live-databases.json");
  const preview = await generatePreview({ limit: args.limit, includeSubtasks: true });

  const partnerSchema = schemaConfig.databases.partners.properties;
  const caseSchema = schemaConfig.databases.integrationProjects.properties;
  const taskSchema = schemaConfig.databases.tasks.properties;

  const archivedCounts = {
    partners: await archivePages(schemaConfig.sources.notionPartnersDataSourceId),
    integrationProjects: await archivePages(schemaConfig.sources.notionIntegrationProjectsDataSourceId),
    tasks: await archivePages(schemaConfig.sources.notionTasksDataSourceId),
  };

  const partnerMap = new Map();
  const createdPartners = [];
  const partnerSeedRecords = [];
  const seenPartnerKeys = new Set();

  for (const caseRecord of preview.integrationProjects) {
    const partnerName = normalizePartnerName(caseRecord);
    const partnerKey = normalizePartnerKey(partnerName);
    if (!partnerKey || seenPartnerKeys.has(partnerKey)) {
      continue;
    }

    seenPartnerKeys.add(partnerKey);
    partnerSeedRecords.push({ caseRecord, partnerKey, partnerName });
  }

  const createdPartnerPages = await runInBatches(
    partnerSeedRecords,
    CREATE_BATCH_SIZE,
    async ({ caseRecord, partnerKey, partnerName }) => {
      const partnerProperties = buildNotionProperties(partnerSchema, {
        "Partner Name": partnerName,
        "Normalized Name": partnerKey,
        "Partner Type": caseRecord.properties["Partner Type"] || [],
        "Country": caseRecord.properties["Country"] || [],
        "Notes": caseRecord.source && caseRecord.source.promotedFromSubtask ? `Imported from parent bucket: ${caseRecord.source.parentTaskName}` : null,
        "Source System": "Asana",
      });

      const page = await createPage(schemaConfig.sources.notionPartnersDataSourceId, partnerProperties);
      return { page, partnerKey, partnerName };
    },
    BATCH_DELAY_MS
  );

  for (const created of createdPartnerPages) {
    partnerMap.set(created.partnerKey, created.page.id);
    createdPartners.push({ id: created.page.id, name: created.partnerName });
  }

  const createdCases = [];
  const casePageIdsBySourceGid = new Map();

  const createdCasePages = await runInBatches(
    preview.integrationProjects,
    CREATE_BATCH_SIZE,
    async (caseRecord) => {
      const partnerName = normalizePartnerName(caseRecord);
      const partnerId = partnerMap.get(normalizePartnerKey(partnerName));
      const properties = buildNotionProperties(caseSchema, {
        ...caseRecord.properties,
        "Source System": "Asana",
        "Source Asana Task URL": caseRecord.source && caseRecord.source.permalinkUrl,
      }, partnerId ? { Partner: [partnerId] } : {});
      const children = buildChildrenFromContentPreview(caseRecord.contentPreview);
      const page = await createPage(schemaConfig.sources.notionIntegrationProjectsDataSourceId, properties, children);
      return { page, caseRecord };
    },
    BATCH_DELAY_MS
  );

  for (const created of createdCasePages) {
    const { page, caseRecord } = created;
    createdCases.push({ id: page.id, name: caseRecord.properties["Partner Name"] || caseRecord.source.name });
    if (caseRecord.source && caseRecord.source.gid) {
      casePageIdsBySourceGid.set(caseRecord.source.gid, page.id);
    }
  }

  const createdTasks = [];

  const createdTaskPages = await runInBatches(
    preview.subtasks,
    CREATE_BATCH_SIZE,
    async (taskRecord) => {
      const relatedCaseId = taskRecord.source ? casePageIdsBySourceGid.get(taskRecord.source.parentTaskGid) : null;
      const properties = buildNotionProperties(taskSchema, taskRecord.properties, relatedCaseId ? { "Partner Hub": [relatedCaseId] } : {});
      const page = await createPage(schemaConfig.sources.notionTasksDataSourceId, properties);
      return { page, taskRecord };
    },
    BATCH_DELAY_MS
  );

  for (const created of createdTaskPages) {
    createdTasks.push({ id: created.page.id, name: created.taskRecord.properties["Task name"] || created.taskRecord.source.name });
  }

  const result = {
    generatedAt: new Date().toISOString(),
    mode: "import",
    archivedCounts,
    createdCounts: {
      partners: createdPartners.length,
      integrationProjects: createdCases.length,
      tasks: createdTasks.length,
    },
    createdPartners,
    createdCases,
    createdTasks,
  };

  ensureDir(args.output);
  fs.writeFileSync(args.output, JSON.stringify(result, null, 2));

  console.log(`Import completed. Summary written to ${args.output}`);
  console.log(`Archived: partners=${archivedCounts.partners}, integrationProjects=${archivedCounts.integrationProjects}, tasks=${archivedCounts.tasks}`);
  console.log(`Created: partners=${createdPartners.length}, integrationProjects=${createdCases.length}, tasks=${createdTasks.length}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
