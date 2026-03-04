#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(ROOT, "tmp", "migration-preview.json");
const NOTION_VERSION = "2025-09-03";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REQUEST_RETRIES = 5;
const REQUEST_PACING_MS = 250;

let nextRequestAt = 0;

function parseArgs(argv) {
  const args = {
    limit: 10,
    output: DEFAULT_OUTPUT,
    includeSubtasks: true,
    legacyPageLimit: null,
    skipLegacy: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit" && argv[i + 1]) {
      args.limit = Number(argv[++i]);
    } else if (arg === "--output" && argv[i + 1]) {
      args.output = path.resolve(argv[++i]);
    } else if (arg === "--no-subtasks") {
      args.includeSubtasks = false;
    } else if (arg === "--legacy-page-limit" && argv[i + 1]) {
      args.legacyPageLimit = Number(argv[++i]);
    } else if (arg === "--skip-legacy") {
      args.skipLegacy = true;
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

  if (args.legacyPageLimit != null && (!Number.isFinite(args.legacyPageLimit) || args.legacyPageLimit <= 0)) {
    throw new Error("--legacy-page-limit must be a positive number");
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/dry-run-migration.cjs [--limit N] [--output FILE] [--no-subtasks] [--legacy-page-limit N] [--skip-legacy]

Behavior:
  - loads .env locally without printing secrets
  - reads migration config under config/
  - fetches Asana tasks from ASANA_PROJECT_GID
  - builds a dry-run preview for Integration Projects and Tasks (test)
  - writes preview JSON to tmp/migration-preview.json by default
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

async function paceRequest() {
  const now = Date.now();
  if (nextRequestAt > now) {
    await sleep(nextRequestAt - now);
  }
  nextRequestAt = Date.now() + REQUEST_PACING_MS;
}

function shouldRetryStatus(statusCode) {
  return statusCode === 429 || statusCode >= 500;
}

function shouldRetryNetworkError(error) {
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "ECONNABORTED",
  ].includes(error && error.code);
}

function getRetryDelayMs(attempt, retryAfterHeader) {
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  return Math.min(1000 * 2 ** attempt, 15000);
}

function buildDataSourceQueryPath(dataSourceId, propertyNames = []) {
  const params = new URLSearchParams();
  for (const name of propertyNames) {
    params.append("filter_properties[]", name);
  }
  const query = params.toString();
  return `/data_sources/${dataSourceId}/query${query ? `?${query}` : ""}`;
}

async function asanaRequest(apiPath, attempt = 0) {
  const token = process.env.ASANA_PAT;
  if (!token) {
    throw new Error("ASANA_PAT is required");
  }

  return new Promise((resolve, reject) => {
    void paceRequest().then(() => {
    const req = https.request(
      {
        hostname: "app.asana.com",
        path: `/api/1.0${apiPath}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error(`Asana API ${res.statusCode}: ${body}`);
            error.statusCode = res.statusCode;
            error.retryAfter = res.headers["retry-after"];
            reject(error);
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Asana API request timed out"));
    });
    req.on("error", reject);
    req.end();
    }, reject);
  }).catch(async (error) => {
    if (attempt >= MAX_REQUEST_RETRIES) {
      throw error;
    }

    if (
      error.code === "ENOTFOUND" ||
      shouldRetryNetworkError(error) ||
      error.message.includes("timed out") ||
      shouldRetryStatus(error.statusCode)
    ) {
      await sleep(getRetryDelayMs(attempt, error.retryAfter));
      return asanaRequest(apiPath, attempt + 1);
    }

    throw error;
  });
}

async function notionRequest(method, apiPath, payload, attempt = 0) {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error("NOTION_TOKEN is required");
  }

  try {
    await paceRequest();
    try {
      return await notionRequestViaNode(method, apiPath, payload, token);
    } catch (nodeError) {
      return notionRequestViaCurl(method, apiPath, payload, token, nodeError);
    }
  } catch (error) {
    if (attempt >= MAX_REQUEST_RETRIES) {
      throw error;
    }

    if (
      error.code === "ENOTFOUND" ||
      error.code === "ETIMEDOUT" ||
      shouldRetryNetworkError(error) ||
      String(error.message || "").includes("timed out") ||
      String(error.message || "").includes("ECONNRESET") ||
      String(error.message || "").includes("curl: (52)") ||
      String(error.message || "").includes("curl: (56)") ||
      error.message.includes("timed out") ||
      shouldRetryStatus(error.statusCode)
    ) {
      await sleep(getRetryDelayMs(attempt, error.retryAfter));
      return notionRequest(method, apiPath, payload, attempt + 1);
    }

    throw error;
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
        agent: false,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.2",
        ALPNProtocols: ["http/1.1"],
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
  const body = payload ? JSON.stringify(payload) : null;
  const url = `https://api.notion.com/v1${apiPath}`;
  const args = [
    "-sS",
    "-X",
    method,
    url,
    "-H",
    `Authorization: Bearer ${token}`,
    "-H",
    `Notion-Version: ${NOTION_VERSION}`,
    "-H",
    "Accept: application/json",
    "-H",
    "Connection: close",
    "-w",
    "\n__CURL_STATUS__:%{http_code}",
  ];

  if (body) {
    args.push("-H", "Content-Type: application/json", "--data", body);
  }

  try {
    const stdout = execFileSync("curl", args, {
      encoding: "utf8",
      timeout: REQUEST_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const marker = "\n__CURL_STATUS__:";
    const markerIndex = stdout.lastIndexOf(marker);
    if (markerIndex === -1) {
      throw new Error("Invalid curl response from Notion API");
    }

    const responseBody = stdout.slice(0, markerIndex);
    const statusCode = Number(stdout.slice(markerIndex + marker.length).trim());
    if (!Number.isFinite(statusCode)) {
      throw new Error("Missing HTTP status from Notion API");
    }
    if (statusCode < 200 || statusCode >= 300) {
      const error = new Error(`Notion API ${statusCode}: ${responseBody}`);
      error.statusCode = statusCode;
      throw error;
    }

    return JSON.parse(responseBody);
  } catch (curlError) {
    curlError.cause = originalError;
    throw curlError;
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function logProgress(message) {
  console.error(`[dry-run] ${message}`);
}

function getCustomFieldMap(task) {
  const result = {};
  for (const field of task.custom_fields || []) {
    result[field.name] = field;
  }
  return result;
}

function getFieldValue(task, fieldName) {
  if (fieldName === "name") {
    return task.name || "";
  }

  if (fieldName.startsWith("subtask.")) {
    const key = fieldName.replace(/^subtask\./, "");
    return getNestedValue(task, key);
  }

  if (fieldName.includes(".")) {
    return getNestedValue(task, fieldName);
  }

  const customField = getCustomFieldMap(task)[fieldName];
  if (!customField) {
    return null;
  }

  if (customField.resource_subtype === "multi_enum") {
    return (customField.multi_enum_values || []).map((item) => item.name);
  }

  if (customField.resource_subtype === "enum") {
    return customField.enum_value ? customField.enum_value.name : customField.display_value || null;
  }

  return customField.display_value || null;
}

function getNestedValue(obj, keyPath) {
  const segments = keyPath.split(".");
  let current = obj;

  for (const segment of segments) {
    if (current == null) {
      return null;
    }

    if (Array.isArray(current)) {
      current = current.map((item) => item && item[segment]).filter(Boolean);
    } else {
      current = current[segment];
    }
  }

  if (Array.isArray(current)) {
    return current.join(" | ");
  }

  return current ?? null;
}

function isValidUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeOptionMap(config, fieldName, rawValue) {
  const normalization = config.normalization[fieldName];
  if (!normalization) {
    return rawValue;
  }

  if (
    rawValue == null ||
    rawValue === "" ||
    (Array.isArray(rawValue) && rawValue.length === 0)
  ) {
    return normalization.defaultWhenEmpty ?? rawValue;
  }

  if (typeof rawValue === "string" && normalization.specialCases && rawValue in normalization.specialCases) {
    return normalization.specialCases[rawValue].mappedValue;
  }

  if (Array.isArray(rawValue)) {
    const mapped = rawValue.flatMap((item) => mapSingleOption(normalization, item));
    return dedupe(mapped.filter(Boolean));
  }

  if (typeof rawValue === "string" && normalization.tokenMap) {
    const mapped = extractTokenMatches(normalization.tokenMap, rawValue);
    if (mapped.length > 0) {
      return dedupe(mapped);
    }
  }

  if (typeof rawValue === "string" && normalization.map) {
    if (rawValue in normalization.map) {
      return normalization.map[rawValue];
    }
  }

  return normalization.fallback || rawValue;
}

function mapSingleOption(normalization, rawValue) {
  if (normalization.directMap && rawValue in normalization.directMap) {
    return normalization.directMap[rawValue];
  }

  if (normalization.map && rawValue in normalization.map) {
    return normalization.map[rawValue];
  }

  if (normalization.tokenMap) {
    return extractTokenMatches(normalization.tokenMap, rawValue);
  }

  return normalization.fallback ? [normalization.fallback] : [];
}

function extractTokenMatches(tokenMap, rawValue) {
  const matches = [];
  const lower = String(rawValue).toLowerCase();

  for (const [token, mapped] of Object.entries(tokenMap)) {
    if (lower.includes(token.toLowerCase())) {
      matches.push(mapped);
    }
  }

  return matches;
}

function dedupe(values) {
  return [...new Set(values)];
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) {
      continue;
    }

    if (Array.isArray(value) && value.length === 0) {
      continue;
    }

    if (value === "") {
      continue;
    }

    return value;
  }

  return null;
}

function isSpecificCanonicalStatus(value) {
  return value != null && value !== "" && value !== "Legacy / other";
}

function choosePreferredDeliveryStatus(legacyRawValue, currentValue, normalizationConfig) {
  const normalizedLegacy = normalizeOptionMap(normalizationConfig, "Delivery Status", legacyRawValue);

  if (isSpecificCanonicalStatus(normalizedLegacy)) {
    return normalizedLegacy;
  }

  if (isSpecificCanonicalStatus(currentValue)) {
    return currentValue;
  }

  return firstNonEmpty(normalizedLegacy, currentValue);
}

function applyTransform(rawValue, mapping, normalizationConfig) {
  switch (mapping.transform) {
    case "identity":
      return rawValue;
    case "map_multi_enum":
    case "map_enum_with_fallback":
    case "map_multi_enum_with_fallback":
    case "split_packed_multi_enum":
    case "split_packed_enum":
      return normalizeOptionMap(normalizationConfig, mapping.targetProperty, rawValue);
    case "preserve_raw_text":
      return rawValue == null ? null : String(rawValue);
    case "append_text":
      return rawValue == null ? null : String(rawValue);
    case "url_or_notes":
      return isValidUrl(rawValue) ? rawValue : null;
    case "enum_true_false_to_checkbox":
      if (rawValue === "TRUE") return true;
      if (rawValue === "FALSE") return false;
      return null;
    case "default_asana_source_system":
      return "Asana";
    case "asana_date_to_notion_date":
      return rawValue || null;
    case "map_person_if_resolvable":
      // Keep the raw human-readable value in dry-run output until a Notion user resolver is added.
      return rawValue || null;
    case "asana_task_completion_to_status":
      return rawValue ? "Done" : "Not Started";
    default:
      throw new Error(`Unsupported transform: ${mapping.transform}`);
  }
}

function buildPreviewRecord(task, fieldMappings, normalizationConfig, targetDatabase) {
  const preview = {};
  const notes = [];

  for (const mapping of fieldMappings.filter((item) => item.targetDatabase === targetDatabase)) {
    const rawValue = getFieldValue(task, mapping.asanaField);
    const transformed = applyTransform(rawValue, mapping, normalizationConfig);

    if (transformed == null || transformed === "" || (Array.isArray(transformed) && transformed.length === 0)) {
      if (mapping.transform === "url_or_notes" && rawValue) {
        notes.push({
          targetProperty: mapping.targetProperty,
          reason: "invalid_url_or_mixed_content",
          rawValue,
        });
      }
      continue;
    }

    if (mapping.transform === "append_text" && preview[mapping.targetProperty]) {
      preview[mapping.targetProperty] = `${preview[mapping.targetProperty]}\n${transformed}`;
    } else {
      preview[mapping.targetProperty] = transformed;
    }
  }

  return { properties: preview, notes };
}

function getSectionNames(task) {
  const memberships = Array.isArray(task.memberships) ? task.memberships : [];
  return dedupe(
    memberships
      .map((membership) => membership && membership.section && membership.section.name)
      .filter(Boolean)
  );
}

function getPlainText(chunks) {
  return (chunks || [])
    .map((chunk) => chunk.plain_text || "")
    .join("")
    .trim();
}

function sanitizeMarkdownText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
}

function extractNamedSection(content, title) {
  const pattern = new RegExp(`(^|\\n)#{1,3}\\s*${title}\\s*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s+|$)`, "i");
  const match = sanitizeMarkdownText(content).match(pattern);
  return match ? match[2].trim() : "";
}

function stripKnownSections(content) {
  return sanitizeMarkdownText(content)
    .replace(/(^|\n)#{1,3}\s*Background\s*\n[\s\S]*?(?=\n#{1,3}\s+|$)/gi, "\n")
    .replace(/(^|\n)#{1,3}\s*Current Progress\s*\n[\s\S]*?(?=\n#{1,3}\s+|$)/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildSourceReferences(casePreview) {
  const references = [];

  if (casePreview.source && casePreview.source.permalinkUrl) {
    references.push(`- Asana: ${casePreview.source.permalinkUrl}`);
  }

  if (casePreview.properties["Source Notion URL"]) {
    references.push(`- Legacy Notion: ${casePreview.properties["Source Notion URL"]}`);
  }

  if (casePreview.source && casePreview.source.promotedFromSubtask && casePreview.source.parentPermalinkUrl) {
    references.push(`- Parent Asana bucket: ${casePreview.source.parentPermalinkUrl}`);
  }

  return references.join("\n");
}

function buildCaseContentPreview(casePreview) {
  const rawNotes = sanitizeMarkdownText(
    firstNonEmpty(
      casePreview.source && casePreview.source.notes,
      casePreview.source && casePreview.source.parentNotes,
      casePreview.properties["Notes"]
    )
  );
  const explicitBackground = extractNamedSection(rawNotes, "Background");
  const explicitProgress = extractNamedSection(rawNotes, "Current Progress");
  const fallbackBackground = stripKnownSections(rawNotes);
  const background = explicitBackground || fallbackBackground;
  const currentProgress = explicitProgress;
  const sourceReferences = buildSourceReferences(casePreview);

  return [
    '> [!NOTE]',
    '> This card was migrated from legacy sources.',
    ...(sourceReferences ? sourceReferences.split("\n").map((line) => `> ${line.slice(2)}`) : []),
    "",
    "## Background",
    background || "",
    "",
    "## Current Progress",
    currentProgress || "",
  ].join("\n").trim();
}

function getLegacyPropertyValue(page, propertyName) {
  const property = page.properties && page.properties[propertyName];
  if (!property) {
    return null;
  }

  switch (property.type) {
    case "title":
      return getPlainText(property.title);
    case "rich_text":
      return getPlainText(property.rich_text);
    case "url":
      return property.url || null;
    case "select":
      return property.select ? property.select.name : null;
    case "multi_select":
      return (property.multi_select || []).map((item) => item.name).filter(Boolean);
    case "date":
      return property.date ? property.date.start : null;
    case "relation":
      return (property.relation || []).map((item) => item.id);
    default:
      return null;
  }
}

function normalizeLookupKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\(hk\)|\(tw\)|\(sg\)|\(au\)|\(th\)|\(jp\)|\(my\)/g, " ")
    .replace(/<>/g, " ")
    .replace(/\binline\b/g, " ")
    .replace(/[()[\],./]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getPartnerBaseName(name) {
  const base = String(name || "").trim();
  if (!base) {
    return "";
  }

  if (base.includes("<>")) {
    return base.split("<>")[0].trim();
  }

  return base;
}

async function queryAllNotionPages(dataSourceId, maxPages = null) {
  const results = [];
  let cursor;
  let pageCount = 0;
  const queryPath = buildDataSourceQueryPath(dataSourceId, [
    "partner name",
    "country",
    "partner type",
    "partnership status",
    "Integration Status",
    "3rd party contact",
    "BD / AM rep",
    "Integration Doc",
    "Onboard doc",
    "Integrated Scenarios doc",
    "Canny",
    "Note",
    "terms/ note",
    "groupId",
  ]);

  do {
    pageCount += 1;
    logProgress(`Fetching legacy Notion query page ${pageCount}${maxPages ? `/${maxPages}` : ""}`);
    const response = await notionRequest("POST", queryPath, cursor ? { start_cursor: cursor } : {});
    results.push(...(response.results || []));
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor && (!maxPages || pageCount < maxPages));

  return results;
}

async function fetchLegacyRecords(dataSourceId, maxPages = null) {
  if (!dataSourceId || !process.env.NOTION_TOKEN) {
    return [];
  }

  logProgress(`Fetching legacy Notion records from ${dataSourceId}`);
  const pages = await queryAllNotionPages(dataSourceId, maxPages);
  logProgress(`Fetched ${pages.length} legacy Notion pages`);
  return pages.map((page) => ({
    id: page.id,
    url: page.url,
    partnerName: getLegacyPropertyValue(page, "partner name"),
    country: getLegacyPropertyValue(page, "country"),
    partnerType: getLegacyPropertyValue(page, "partner type"),
    lifecycleStatusRaw: getLegacyPropertyValue(page, "partnership status"),
    deliveryStatusRaw: firstNonEmpty(...(getLegacyPropertyValue(page, "Integration Status") || [])),
    externalContact: getLegacyPropertyValue(page, "3rd party contact"),
    businessOwner: getLegacyPropertyValue(page, "BD / AM rep"),
    integrationDocUrl: getLegacyPropertyValue(page, "Integration Doc"),
    onboardDocUrl: getLegacyPropertyValue(page, "Onboard doc"),
    scenarioDocUrl: getLegacyPropertyValue(page, "Integrated Scenarios doc"),
    cannyUrl: getLegacyPropertyValue(page, "Canny"),
    notes: firstNonEmpty(getLegacyPropertyValue(page, "Note"), getLegacyPropertyValue(page, "terms/ note")),
    groupId: getLegacyPropertyValue(page, "groupId"),
  }));
}

function buildLegacyIndex(records) {
  const byKey = new Map();
  const byGroupId = new Map();

  for (const record of records) {
    const keys = dedupe([
      normalizeLookupKey(record.partnerName),
      normalizeLookupKey(getPartnerBaseName(record.partnerName)),
    ].filter(Boolean));

    for (const key of keys) {
      if (!byKey.has(key)) {
        byKey.set(key, []);
      }
      byKey.get(key).push(record);
    }

    if (record.groupId && !byGroupId.has(record.groupId)) {
      byGroupId.set(record.groupId, []);
    }
    if (record.groupId) {
      byGroupId.get(record.groupId).push(record);
    }
  }

  return { byKey, byGroupId };
}

function scoreLegacyCandidate(candidate, names) {
  const candidateKey = normalizeLookupKey(candidate.partnerName);
  let score = 0;

  for (const name of names) {
    const key = normalizeLookupKey(name);
    if (!key) {
      continue;
    }

    if (candidateKey === key) {
      score += 6;
    } else if (candidateKey === normalizeLookupKey(getPartnerBaseName(name))) {
      score += 4;
    } else if (candidateKey.includes(key) || key.includes(candidateKey)) {
      score += 2;
    }
  }

  return score;
}

function matchLegacyRecord(casePreview, legacyIndex) {
  const names = [
    casePreview.properties["Partner Name"],
    casePreview.source && casePreview.source.name,
    casePreview.source && casePreview.source.parentTaskName,
  ].filter(Boolean);

  const groupId = casePreview.properties["Group ID"];
  const candidates = [];
  const seen = new Set();

  if (groupId && legacyIndex.byGroupId.has(groupId)) {
    for (const record of legacyIndex.byGroupId.get(groupId)) {
      if (!seen.has(record.id)) {
        candidates.push(record);
        seen.add(record.id);
      }
    }
  }

  for (const name of names) {
    const key = normalizeLookupKey(name);
    if (!key || !legacyIndex.byKey.has(key)) {
      continue;
    }

    for (const record of legacyIndex.byKey.get(key)) {
      if (!seen.has(record.id)) {
        candidates.push(record);
        seen.add(record.id);
      }
    }
  }

  let best = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = scoreLegacyCandidate(candidate, names) + (groupId && candidate.groupId === groupId ? 10 : 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}

function mergeLegacyIntoCase(casePreview, legacyRecord, normalizationConfig) {
  if (!legacyRecord) {
    return casePreview;
  }

  casePreview.properties["Country"] = firstNonEmpty(casePreview.properties["Country"], legacyRecord.country);
  casePreview.properties["Partner Type"] = firstNonEmpty(casePreview.properties["Partner Type"], legacyRecord.partnerType);
  casePreview.properties["Lifecycle Status"] = firstNonEmpty(
    normalizeOptionMap(normalizationConfig, "Lifecycle Status", legacyRecord.lifecycleStatusRaw),
    casePreview.properties["Lifecycle Status"]
  );
  casePreview.properties["Delivery Status"] = choosePreferredDeliveryStatus(
    legacyRecord.deliveryStatusRaw,
    casePreview.properties["Delivery Status"],
    normalizationConfig
  );
  casePreview.properties["Business Owner"] = firstNonEmpty(casePreview.properties["Business Owner"], legacyRecord.businessOwner);
  casePreview.properties["External Contact"] = firstNonEmpty(casePreview.properties["External Contact"], legacyRecord.externalContact);
  casePreview.properties["Integration Doc URL"] = firstNonEmpty(casePreview.properties["Integration Doc URL"], legacyRecord.integrationDocUrl);
  casePreview.properties["Onboard Doc URL"] = firstNonEmpty(casePreview.properties["Onboard Doc URL"], legacyRecord.onboardDocUrl);
  casePreview.properties["Scenario Doc URL"] = firstNonEmpty(casePreview.properties["Scenario Doc URL"], legacyRecord.scenarioDocUrl);
  casePreview.properties["Canny URL"] = firstNonEmpty(casePreview.properties["Canny URL"], legacyRecord.cannyUrl);
  casePreview.properties["Source Notion URL"] = legacyRecord.url;
  casePreview.properties["Notes"] = firstNonEmpty(casePreview.properties["Notes"], legacyRecord.notes);
  casePreview.source = {
    ...casePreview.source,
    legacyRecordId: legacyRecord.id,
    legacyPartnerName: legacyRecord.partnerName,
    resolvedPartnerName: firstNonEmpty(legacyRecord.partnerName, casePreview.source && casePreview.source.resolvedPartnerName),
  };
  casePreview.notes.push({
    reason: "merged_from_legacy_notion",
    legacyRecordId: legacyRecord.id,
    legacyPartnerName: legacyRecord.partnerName,
  });
  return casePreview;
}

function isThirdPartyPartnerBucket(task) {
  return getSectionNames(task).includes("3rd Party Partners");
}

function looksLikeIntegrationCaseSubtask(subtask) {
  const name = String(subtask.name || "").trim();
  if (!name) {
    return false;
  }

  const taskLikeNames = new Set([
    "NDA",
    "Integration Doc",
    "Integration Test",
    "Training Doc",
  ]);

  if (taskLikeNames.has(name)) {
    return false;
  }

  const lower = name.toLowerCase();
  const executionOnlyPatterns = [
    "test ",
    "testing",
    "training",
    "doc",
    "document",
    "clarification",
    "prepare ",
    "goal #",
    "verify ",
    "demo account",
    "get the test app",
  ];

  if (executionOnlyPatterns.some((pattern) => lower.includes(pattern))) {
    return false;
  }

  return true;
}

function buildPromotedCaseFromSubtask(parentTask, subtask, fieldMappings, normalizationConfig) {
  const casePreview = buildPreviewRecord(parentTask, fieldMappings, normalizationConfig, "integrationProjects");
  casePreview.properties["Partner Name"] = subtask.name || parentTask.name;
  casePreview.notes.push({
    reason: "promoted_from_subtask_under_third_party_partner_bucket",
    parentTaskName: parentTask.name,
    parentTaskGid: parentTask.gid,
    subtaskGid: subtask.gid,
  });
  casePreview.source = {
    promotedFromSubtask: true,
    parentTaskGid: parentTask.gid,
    parentTaskName: parentTask.name,
    parentPermalinkUrl: parentTask.permalink_url,
    parentSectionNames: getSectionNames(parentTask),
    sectionNames: getSectionNames(subtask),
    parentNotes: parentTask.notes || "",
    gid: subtask.gid,
    name: subtask.name,
    permalinkUrl: subtask.permalink_url,
    notes: subtask.notes || "",
  };
  return casePreview;
}

async function fetchProjectTasks(projectGid, limit) {
  logProgress(`Fetching up to ${limit} Asana project tasks from ${projectGid}`);
  const optFields = [
    "gid",
    "name",
    "notes",
    "completed",
    "due_on",
    "permalink_url",
    "assignee.name",
    "memberships.section.name",
    "custom_fields.name",
    "custom_fields.display_value",
    "custom_fields.resource_subtype",
    "custom_fields.enum_value.name",
    "custom_fields.multi_enum_values.name",
  ].join(",");

  const response = await asanaRequest(
    `/tasks?project=${encodeURIComponent(projectGid)}&limit=${limit}&opt_fields=${encodeURIComponent(optFields)}`
  );

  const tasks = response.data || [];
  logProgress(`Fetched ${tasks.length} Asana tasks`);
  return tasks;
}

async function fetchSubtasks(taskGid) {
  logProgress(`Fetching subtasks for Asana task ${taskGid}`);
  const optFields = [
    "gid",
    "name",
    "notes",
    "completed",
    "due_on",
    "permalink_url",
    "assignee.name",
    "memberships.section.name",
  ].join(",");

  const response = await asanaRequest(`/tasks/${taskGid}/subtasks?opt_fields=${encodeURIComponent(optFields)}`);
  const subtasks = response.data || [];
  logProgress(`Fetched ${subtasks.length} subtasks for Asana task ${taskGid}`);
  return subtasks;
}

async function generatePreview(options = {}) {
  const args = {
    limit: options.limit || 10,
    includeSubtasks: options.includeSubtasks !== false,
    legacyPageLimit: options.legacyPageLimit ?? null,
    skipLegacy: options.skipLegacy === true,
  };

  loadDotEnv();
  const schemaConfig = readJson("config/schema/live-databases.json");
  const mappingConfig = readJson("config/mappings/asana-to-notion.json");
  const normalizationConfig = readJson("config/mappings/asana-option-normalization.json");
  const projectGid = process.env.ASANA_PROJECT_GID || schemaConfig.sources.asanaProjectGid;
  const legacyDataSourceId = process.env.LEGACY_NOTION_DATA_SOURCE_ID || schemaConfig.sources.legacyNotionDataSourceId;

  if (!projectGid) {
    throw new Error("ASANA_PROJECT_GID is required");
  }

  logProgress("Starting preview generation");
  const tasks = await fetchProjectTasks(projectGid, args.limit);
  const legacyRecords = args.skipLegacy ? [] : await fetchLegacyRecords(legacyDataSourceId, args.legacyPageLimit);
  const legacyIndex = buildLegacyIndex(legacyRecords);
  const preview = {
    generatedAt: new Date().toISOString(),
    mode: "dry-run",
    sources: {
      asanaProjectGid: projectGid,
      legacyNotionDataSourceId: args.skipLegacy ? null : legacyDataSourceId || null,
      notionPartnersDataSourceId: schemaConfig.sources.notionPartnersDataSourceId,
      notionIntegrationProjectsDataSourceId: schemaConfig.sources.notionIntegrationProjectsDataSourceId,
      notionTasksDataSourceId: schemaConfig.sources.notionTasksDataSourceId,
    },
    counts: {
      fetchedTasks: tasks.length,
      fetchedLegacyRecords: legacyRecords.length,
      integrationProjectsPreview: 0,
      taskPreview: 0,
    },
    integrationProjects: [],
    subtasks: [],
  };

  for (const task of tasks) {
    logProgress(`Processing task ${task.gid} (${task.name})`);
    const subtasks = args.includeSubtasks ? await fetchSubtasks(task.gid) : [];
    const thirdPartyBucket = isThirdPartyPartnerBucket(task);
    const hasSubtasks = subtasks.length > 0;

    if (!(thirdPartyBucket && hasSubtasks)) {
      const integrationProject = buildPreviewRecord(
        task,
        mappingConfig.fieldMappings,
        normalizationConfig,
        "integrationProjects"
      );
      mergeLegacyIntoCase(integrationProject, matchLegacyRecord(integrationProject, legacyIndex), normalizationConfig);

      integrationProject.source = {
        gid: task.gid,
        name: task.name,
        permalinkUrl: task.permalink_url,
        sectionNames: getSectionNames(task),
        notes: task.notes || "",
        ...(integrationProject.source || {}),
      };
      integrationProject.contentPreview = buildCaseContentPreview(integrationProject);
      preview.integrationProjects.push(integrationProject);
    }

    for (const subtask of subtasks) {
      if (thirdPartyBucket && looksLikeIntegrationCaseSubtask(subtask)) {
        const promotedCase = buildPromotedCaseFromSubtask(task, subtask, mappingConfig.fieldMappings, normalizationConfig);
        mergeLegacyIntoCase(promotedCase, matchLegacyRecord(promotedCase, legacyIndex), normalizationConfig);
        promotedCase.contentPreview = buildCaseContentPreview(promotedCase);
        preview.integrationProjects.push(promotedCase);
        continue;
      }

      const subtaskPreview = buildPreviewRecord(subtask, mappingConfig.fieldMappings, normalizationConfig, "tasks");
      subtaskPreview.source = {
        parentTaskGid: task.gid,
        gid: subtask.gid,
        name: subtask.name,
        permalinkUrl: subtask.permalink_url,
        sectionNames: getSectionNames(subtask),
      };
      preview.subtasks.push(subtaskPreview);
    }
  }

  preview.counts.integrationProjectsPreview = preview.integrationProjects.length;
  preview.counts.taskPreview = preview.subtasks.length;
  logProgress(
    `Finished preview generation with ${preview.counts.integrationProjectsPreview} integration cases and ${preview.counts.taskPreview} tasks`
  );

  return preview;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const preview = await generatePreview(args);

  ensureDir(args.output);
  fs.writeFileSync(args.output, JSON.stringify(preview, null, 2));

  console.log(`Dry-run preview written to ${args.output}`);
  console.log(`Integration Projects preview: ${preview.counts.integrationProjectsPreview}`);
  console.log(`Task preview: ${preview.counts.taskPreview}`);
}

module.exports = {
  generatePreview,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
