import express from "express";
import { createHash } from "node:crypto";
import pool from "./lib/db.js";
import { ensureSchema } from "./lib/ensureSchema.js";
import {
    clearAiReviewCaches,
    getAiReviewRulesText,
    getAiReviewTemplate
} from "./lib/aiReviewTemplates.js";
import { getDifyConfigSummary, partitionContent, requestDifyReport } from "./lib/difyClient.js";
import { extractSqlTextFromDocument } from "./lib/documentSqlExtractor.js";
import { analyseSqlToReport, buildSqlReportPayload, isSqlPath } from "./lib/sqlAnalyzer.js";
import { buildJavaSegments, isJavaPath } from "./lib/javaProcessor.js";

const REPORT_DEBUG_LOGS = process.env.REPORT_DEBUG_LOGS === "true";

function applyLineOffsetToSegments(segments, offset) {
    if (!Array.isArray(segments) || !segments.length || !offset) {
        return segments;
    }
    return segments.map((segment) => {
        const startLine = typeof segment?.startLine === "number" ? segment.startLine + offset : segment?.startLine;
        const endLine = typeof segment?.endLine === "number" ? segment.endLine + offset : segment?.endLine;
        let codeLocationLabel = segment?.codeLocationLabel;
        if (typeof startLine === "number" && !Number.isNaN(startLine)) {
            if (typeof endLine === "number" && !Number.isNaN(endLine) && endLine !== startLine) {
                codeLocationLabel = `程式碼位置：第 ${startLine}-${endLine} 行`;
            } else {
                codeLocationLabel = `程式碼位置：第 ${startLine} 行`;
            }
        }
        return {
            ...segment,
            startLine,
            endLine,
            codeLocationLabel
        };
    });
}

const app = express();

app.use(express.json({ limit: process.env.REQUEST_BODY_LIMIT || "10mb" }));

app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
        const duration = Date.now() - start;
        console.log(
            `[api] ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode} (${duration}ms)`
        );
    });
    res.on("error", (error) => {
        console.error(`[api] ${req.method} ${req.originalUrl || req.url} stream error`, error);
    });
    next();
});

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!allowedOrigins.length) {
        res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && allowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }
    next();
});

function mapProjectRow(row) {
    return {
        id: row.id,
        name: row.name,
        mode: row.mode,
        createdAt: Number(row.created_at) || Date.now()
    };
}

function mapNodeRow(row) {
    return {
        key: row.node_key,
        projectId: row.project_id,
        type: row.type,
        name: row.name,
        path: row.path,
        parent: row.parent || "",
        size: Number(row.size) || 0,
        lastModified: Number(row.last_modified) || 0,
        mime: row.mime || "",
        encoding: row.encoding || "",
        isBig: Boolean(row.is_big)
    };
}

function mapProjectFileRow(row) {
    return {
        projectId: row.project_id,
        path: row.path,
        mime: row.mime || "",
        encoding: row.encoding || "",
        size: Number(row.size) || 0,
        lastModified: Number(row.last_modified) || 0,
        content: typeof row.content === "string" ? row.content : "",
        createdAt: Number(row.created_at) || Date.now(),
        updatedAt: Number(row.updated_at) || Date.now()
    };
}

function computeNodeKey(projectId, path) {
    const safeProjectId = typeof projectId === "string" ? projectId : "";
    const safePath = typeof path === "string" ? path : "";
    const composite = `${safeProjectId}:${safePath}`;
    return createHash("sha256").update(composite).digest("hex");
}

function safeParseArray(jsonText, { fallback = [] } = {}) {
    if (!jsonText) return Array.isArray(fallback) ? fallback : [];
    try {
        const parsed = JSON.parse(jsonText);
        return Array.isArray(parsed) ? parsed : Array.isArray(fallback) ? fallback : [];
    } catch (error) {
        console.warn("[reports] Failed to parse JSON column", { jsonText, error });
        return Array.isArray(fallback) ? fallback : [];
    }
}

function safeSerialiseForLog(value) {
    if (typeof value === "string") {
        return value;
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch (error) {
        return `[unserialisable: ${error?.message || error}]`;
    }
}

function logReportPersistenceStage(label, value) {
    if (!REPORT_DEBUG_LOGS) {
        return;
    }
    if (typeof console === "undefined" || typeof console.log !== "function") {
        return;
    }
    console.log(`[reports] ${label}: ${safeSerialiseForLog(value)}`);
}

function toIsoString(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
        const time = value.getTime();
        if (Number.isFinite(time)) {
            return new Date(time).toISOString();
        }
        return null;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return null;
        return new Date(value).toISOString();
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) {
            return new Date(parsed).toISOString();
        }
    }
    return null;
}

function extractAnalysisFromChunks(chunks) {
    if (!Array.isArray(chunks)) return null;
    for (const chunk of chunks) {
        const raw = typeof chunk?.rawAnalysis === "string" ? chunk.rawAnalysis : null;
        if (raw && raw.trim()) {
            return { result: raw };
        }
        const nested = chunk?.raw?.analysisResult || chunk?.raw?.rawAnalysis;
        if (typeof nested === "string" && nested.trim()) {
            return { result: nested };
        }
    }
    return null;
}

function safeParseReport(reportText) {
    if (typeof reportText !== "string") {
        return null;
    }
    const trimmed = reportText.trim();
    if (!trimmed) {
        return null;
    }
    if (!/^\s*[\[{]/.test(trimmed)) {
        return null;
    }
    try {
        return JSON.parse(trimmed);
    } catch (_error) {
        return null;
    }
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clonePlainValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => clonePlainValue(entry));
    }
    if (isPlainObject(value)) {
        const clone = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
                continue;
            }
            clone[key] = clonePlainValue(entry);
        }
        return clone;
    }
    return value;
}

function clonePlainIssueList(issues) {
    if (!Array.isArray(issues)) {
        return [];
    }
    const result = [];
    for (const issue of issues) {
        if (!isPlainObject(issue)) {
            continue;
        }
        result.push(clonePlainValue(issue));
    }
    return result;
}

function normaliseSettingLanguage(language) {
    const value = typeof language === "string" ? language.trim().toUpperCase() : "";
    if (value === "JAVA") return "Java";
    return "SQL";
}

function buildAiReviewResolvers(language) {
    const resolvedLanguage = normaliseSettingLanguage(language);
    return {
        language: resolvedLanguage,
        loadAiReviewTemplate: () => getAiReviewTemplate(pool, resolvedLanguage),
        loadAiReviewRules: () => getAiReviewRulesText(pool, resolvedLanguage)
    };
}

function mapSettingRuleRow(row) {
    return {
        id: Number(row.id) || 0,
        ruleId: row.rule_id || "",
        description: row.description || "",
        enabled: Boolean(row.enabled),
        riskIndicator: row.risk_indicator || "",
        language: row.language || "SQL",
        createdAt: toIsoString(row.created_at)
    };
}

function mapAiReviewSettingRow(row) {
    return {
        id: Number(row.id) || 0,
        language: row.language || "SQL",
        codeBlock: row.code_block || "",
        createdAt: toIsoString(row.created_at)
    };
}

function normaliseDocumentChecks(checks) {
    const base = Array.isArray(checks) ? checks : [];
    const merged = new Map(DEFAULT_DOCUMENT_RULES.map((entry) => [entry.ruleId, { ...entry }]));
    for (const entry of base) {
        if (!entry || typeof entry !== "object") continue;
        const ruleIdRaw =
            typeof entry.ruleId === "string" && entry.ruleId.trim()
                ? entry.ruleId.trim()
                : typeof entry.key === "string"
                ? entry.key.trim()
                : typeof entry.label === "string"
                ? entry.label.trim()
                : "";
        if (!ruleIdRaw) continue;
        const current = merged.get(ruleIdRaw) || { ruleId: ruleIdRaw };
        merged.set(ruleIdRaw, {
            ...current,
            ruleId: ruleIdRaw,
            key:
                typeof entry.key === "string" && entry.key.trim()
                    ? entry.key.trim()
                    : current.key || ruleIdRaw,
            description:
                typeof entry.description === "string" && entry.description.trim()
                    ? entry.description.trim()
                    : current.description || "",
            enabled: entry.enabled === undefined ? current.enabled !== false : Boolean(entry.enabled),
            riskIndicator:
                typeof entry.riskIndicator === "string" && entry.riskIndicator.trim()
                    ? entry.riskIndicator.trim()
                    : typeof entry.risk === "string" && entry.risk.trim()
                    ? entry.risk.trim()
                    : current.riskIndicator || ""
        });
    }
    return Array.from(merged.values());
}

function mapDocumentReviewSettingRow(row) {
    let parsedChecks = [];
    try {
        const parsed = JSON.parse(row.checks_json || "");
        if (Array.isArray(parsed)) {
            parsedChecks = parsed;
        }
    } catch (_error) {
        parsedChecks = [];
    }
    const promptTemplate =
        typeof row.prompt_template === "string" && row.prompt_template.trim()
            ? row.prompt_template
            : DEFAULT_DOCUMENT_PROMPT_TEMPLATE;
    return {
        id: Number(row.id) || 0,
        checks: normaliseDocumentChecks(parsedChecks),
        promptTemplate,
        createdAt: toIsoString(row.created_at)
    };
}

function extractEncodingFromMime(mime) {
    if (typeof mime !== "string") return "";
    const match = mime.match(/charset=([^;]+)/i);
    return match?.[1]?.trim() || "";
}

function detectEncodingFromContent(content) {
    if (typeof content !== "string" || !content.trim()) return "";
    try {
        const buffer = Buffer.from(content, "binary");
        if (buffer.length >= 4) {
            const bom32le = buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0x00 && buffer[3] === 0x00;
            if (bom32le) return "UTF-32LE";
            const bom32be = buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xfe && buffer[3] === 0xff;
            if (bom32be) return "UTF-32BE";
        }
        if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
            return "UTF-8-BOM";
        }
        if (buffer.length >= 2) {
            const bom16le = buffer[0] === 0xff && buffer[1] === 0xfe;
            if (bom16le) return "UTF-16LE";
            const bom16be = buffer[0] === 0xfe && buffer[1] === 0xff;
            if (bom16be) return "UTF-16BE";
        }

        try {
            new TextDecoder("utf-8", { fatal: true }).decode(buffer);
            return "UTF-8";
        } catch (_err) {
            // not UTF-8
        }

        try {
            new TextDecoder("utf-16le", { fatal: true }).decode(buffer);
            return "UTF-16LE";
        } catch (_err) {
            // not UTF-16 LE
        }

        try {
            new TextDecoder("utf-16be", { fatal: true }).decode(buffer);
            return "UTF-16BE";
        } catch (_err) {
            // not UTF-16 BE
        }

        const isAscii = buffer.every((byte) => byte <= 0x7f);
        if (isAscii) {
            return "ASCII";
        }
    } catch (error) {
        console.warn("[documents] Failed to detect encoding from content", error);
    }
    return "";
}

function resolveNodeEncoding(node) {
    const encoding = typeof node?.encoding === "string" ? node.encoding.trim() : "";
    if (encoding) return encoding;
    const charset = extractEncodingFromMime(node?.mime || "");
    return charset || "";
}

function buildDocumentTreeMap(nodes, { maxEntries = 800, encodingMap = new Map() } = {}) {
    const sorted = Array.isArray(nodes) ? [...nodes] : [];
    sorted.sort((a, b) => (a?.path || "").localeCompare(b?.path || ""));
    const lines = [];
    for (let i = 0; i < sorted.length; i += 1) {
        const node = sorted[i];
        if (i >= maxEntries) {
            lines.push(`... (${sorted.length - i} more entries omitted)`);
            break;
        }
        const depth = (node?.path || "").split("/").filter(Boolean).length - 1;
        const indent = depth > 0 ? "  ".repeat(depth) : "";
        const icon = node?.type === "dir" ? "📂" : "📄";
        const label = typeof node?.name === "string" && node.name.trim() ? node.name : node?.path || "";
        const encoding = node?.type === "file"
            ? encodingMap.get(node?.path || node?.name || "") || resolveNodeEncoding(node) || "UTF-8"
            : "";
        const encodingSuffix = encoding ? ` [${encoding}]` : "";
        lines.push(`${indent}${icon} ${label}${encodingSuffix}`.trimEnd());
    }
    return lines.join("\n");
}

async function loadDocumentReviewSetting() {
    const [rows] = await pool.query(
        `SELECT id, checks_json, prompt_template, created_at
         FROM setting_document_review
         ORDER BY id DESC
         LIMIT 1`
    );
    const record = rows?.[0];
    if (record) {
        return mapDocumentReviewSettingRow(record);
    }
    return {
        id: null,
        checks: normaliseDocumentChecks(DEFAULT_DOCUMENT_RULES),
        promptTemplate: DEFAULT_DOCUMENT_PROMPT_TEMPLATE,
        createdAt: null
    };
}

function matchNodesByKeywords(nodes, keywords, { extensions = [] } = {}) {
    const keyList = (keywords || []).map((word) => (typeof word === "string" ? word.toLowerCase() : "")).filter(Boolean);
    const extList = (extensions || []).map((ext) => (typeof ext === "string" ? ext.toLowerCase() : "")).filter(Boolean);
    const matches = [];
    for (const node of nodes || []) {
        if (!node || node.type !== "file") continue;
        const name = typeof node.name === "string" ? node.name.toLowerCase() : "";
        const path = typeof node.path === "string" ? node.path : "";
        if (extList.some((ext) => name.endsWith(ext))) {
            matches.push(path || node.name || "");
            continue;
        }
        if (keyList.some((keyword) => name.includes(keyword))) {
            matches.push(path || node.name || "");
        }
    }
    return matches;
}

function buildDocumentStatusSnapshot(nodes, checks, sqlFilesMeta = []) {
    const enabledChecks = normaliseDocumentChecks(checks);
    const statusEntries = [];
    const fileNodes = (nodes || []).filter((node) => node?.type === "file");

    for (const check of enabledChecks) {
        const ruleKey = check.key || check.ruleId;
        const entry = {
            key: ruleKey,
            ruleId: check.ruleId,
            description: check.description,
            enabled: check.enabled !== false,
            riskIndicator: check.riskIndicator || "",
            matches: [],
            status: "unknown"
        };
        switch (ruleKey) {
            case "approval_form":
                entry.matches = matchNodesByKeywords(fileNodes, ["演練與投產審批表", "審批表", "审批表"], {
                    extensions: [".doc", ".docx"]
                });
                entry.status = entry.matches.length ? "found" : "missing";
                break;
            case "test_logs":
                entry.matches = matchNodesByKeywords(fileNodes, ["log"], { extensions: [".log"] });
                entry.status = entry.matches.length ? "found" : "missing";
                break;
            case "rollback_script":
                entry.matches = matchNodesByKeywords(fileNodes, ["rollback", "回退"], {
                    extensions: [".sql", ".sh", ".bat", ".ps1"]
                });
                entry.status = entry.matches.length ? "found" : "missing";
                break;
            case "deployment_guide":
                entry.matches = matchNodesByKeywords(fileNodes, ["guide", "指引", "說明", "说明", "manual"], {
                    extensions: [".md", ".doc", ".docx", ".pdf"]
                });
                entry.status = entry.matches.length ? "found" : "missing";
                break;
            case "sql_utf8_nobom": {
                const bomDetected = sqlFilesMeta.filter((item) => item?.hasBom);
                entry.matches = sqlFilesMeta.map((item) => item?.path || "");
                entry.details = {
                    checked: sqlFilesMeta.length,
                    bomDetected: bomDetected.map((item) => item?.path || ""),
                    missingContent: sqlFilesMeta.filter((item) => item && item.stored === false).map((item) => item.path)
                };
                entry.status = sqlFilesMeta.length === 0 ? "not_found" : bomDetected.length ? "bom_detected" : "ok";
                break;
            }
            default:
                entry.status = "unknown";
        }
        statusEntries.push(entry);
    }

    const snapshot = {
        total_nodes: nodes?.length || 0,
        total_files: fileNodes.length,
        sql_files: sqlFilesMeta,
        checks: statusEntries
    };

    return { enabledChecks, statusEntries, snapshot };
}

function clonePlainSnapshotList(entries) {
    if (!Array.isArray(entries)) {
        return [];
    }
    const result = [];
    for (const entry of entries) {
        if (!isPlainObject(entry)) {
            continue;
        }
        result.push(clonePlainValue(entry));
    }
    return result;
}

const EMPTY_ISSUES_JSON = JSON.stringify({ issues: [] }, null, 2);
const EMPTY_COMBINED_REPORT_JSON = JSON.stringify({ summary: [], issues: [] }, null, 2);
const JAVA_FILE_EXTENSION = ".java";
const JAVA_STATIC_SUMMARY_MESSAGE = "Java 檔案僅支援 AI 審查流程。";
const DOCUMENT_REVIEW_PATH = "__documents__/ai-status.json";
const DEFAULT_DOCUMENT_PROMPT_TEMPLATE =
    "你是一位軟體交付與作業稽核專家，請根據以下的專案檔案樹及規則引擎清單，評估必備交付物是否齊全。\n" +
    "請逐一檢查規則並輸出 JSON，至少包含 issues (每個問題需描述缺漏或風險與改善建議) 及 summary (總結風險與結論)。\n" +
    "回覆務必使用繁體中文，並以 JSON 物件表示，缺少的項目請列出問題與建議。\n" +
    "以下為專案資料：\n{{content}}";
const DEFAULT_DOCUMENT_RULES = [
    {
        key: "approval_form",
        ruleId: "DOC-001",
        description: "是否有提供《演練與投產審批表.docx》",
        riskIndicator: "高",
        enabled: true
    },
    {
        key: "test_logs",
        ruleId: "DOC-002",
        description: "是否提供測試日誌（log 文件）",
        riskIndicator: "中",
        enabled: true
    },
    {
        key: "rollback_script",
        ruleId: "DOC-003",
        description: "是否提供回退腳本（rollback 類文件）",
        riskIndicator: "高",
        enabled: true
    },
    {
        key: "deployment_guide",
        ruleId: "DOC-004",
        description: "是否提供投產指引（guide 類文件）",
        riskIndicator: "中",
        enabled: true
    },
    {
        key: "sql_utf8_nobom",
        ruleId: "DOC-005",
        description: "SQL 腳本是否為 UTF-8 無 BOM 格式",
        riskIndicator: "中",
        enabled: true
    }
];

function resolveAggregateMessage(aggregate) {
    if (!aggregate || typeof aggregate !== "object") {
        return "";
    }
    const directMessage = typeof aggregate.message === "string" ? aggregate.message.trim() : "";
    if (directMessage) {
        return directMessage;
    }
    if (Array.isArray(aggregate.messages)) {
        const combined = aggregate.messages
            .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
            .filter(Boolean)
            .join(" ");
        if (combined) {
            return combined;
        }
    }
    return "";
}

function buildSummaryRecord({ source, label, totalIssues, status, generatedAt, message }) {
    const normalisedSource = typeof source === "string" && source.trim() ? source.trim() : "";
    const normalisedLabel = typeof label === "string" && label.trim() ? label.trim() : normalisedSource || "";
    const numericTotal = Number(totalIssues);
    const totalValue = Number.isFinite(numericTotal) && numericTotal >= 0 ? Math.floor(numericTotal) : 0;
    const record = {
        source: normalisedSource,
        label: normalisedLabel,
        total_issues: totalValue
    };
    const resolvedStatus = typeof status === "string" && status.trim() ? status.trim() : "";
    if (resolvedStatus) {
        record.status = resolvedStatus;
    }
    const resolvedGeneratedAt = toIsoString(generatedAt);
    if (resolvedGeneratedAt) {
        record.generated_at = resolvedGeneratedAt;
    }
    const resolvedMessage = typeof message === "string" && message.trim() ? message.trim() : "";
    if (resolvedMessage) {
        record.message = resolvedMessage;
    }
    return record;
}

function computeIssueCountFromAggregate(aggregate, issues) {
    const aggregateTotal = Number(aggregate?.total_issues ?? aggregate?.totalIssues);
    if (Number.isFinite(aggregateTotal) && aggregateTotal >= 0) {
        return Math.floor(aggregateTotal);
    }
    return Array.isArray(issues) ? issues.length : 0;
}

function serialiseCombinedReportSnapshot(summaryRecords, issues) {
    const summary = [];
    if (Array.isArray(summaryRecords)) {
        for (const record of summaryRecords) {
            if (!record || typeof record !== "object" || Array.isArray(record)) {
                continue;
            }
            const entry = {};
            for (const [key, value] of Object.entries(record)) {
                if (value === undefined || value === null) {
                    continue;
                }
                if (typeof value === "object") {
                    continue;
                }
                entry[key] = value;
            }
            if (Object.keys(entry).length) {
                summary.push(entry);
            }
        }
    }
    const safeIssues = clonePlainIssueList(issues);
    try {
        return JSON.stringify({ summary, issues: safeIssues }, null, 2);
    } catch (error) {
        console.warn("[reports] Failed to serialise combined report snapshot", error);
        return EMPTY_COMBINED_REPORT_JSON;
    }
}

function buildJavaCombinedSummaryRecords({ aggregate, issues, generatedAt }) {
    const issueCount = computeIssueCountFromAggregate(aggregate, issues);
    const generatedAtIso = toIsoString(generatedAt) || new Date().toISOString();
    const aggregateStatus = typeof aggregate?.status === "string" && aggregate.status.trim()
        ? aggregate.status.trim()
        : "completed";
    const aggregateMessage = resolveAggregateMessage(aggregate);
    const records = [];
    records.push(
        buildSummaryRecord({
            source: "static_analyzer",
            label: "靜態分析器",
            totalIssues: 0,
            status: "skipped",
            generatedAt: generatedAtIso,
            message: JAVA_STATIC_SUMMARY_MESSAGE
        })
    );
    records.push(
        buildSummaryRecord({
            source: "dml_prompt",
            label: "AI審查",
            totalIssues: issueCount,
            status: aggregateStatus,
            generatedAt: generatedAtIso,
            message: aggregateMessage
        })
    );
    records.push(
        buildSummaryRecord({
            source: "combined",
            label: "聚合報告",
            totalIssues: issueCount,
            status: aggregateStatus,
            generatedAt: generatedAtIso,
            message: aggregateMessage
        })
    );
    return records;
}

function buildJavaAiIssuesJsonSnapshot(result, issueSnapshot) {
    const issues = Array.isArray(issueSnapshot) && issueSnapshot.length
        ? issueSnapshot.map((issue) => clonePlainValue(issue))
        : clonePlainIssueList(result?.issues);
    const payload = { issues };
    const segments = clonePlainSnapshotList(result?.segments);
    if (segments.length) {
        payload.segments = segments;
    }
    const chunks = clonePlainSnapshotList(result?.chunks);
    if (chunks.length) {
        payload.chunks = chunks;
    }
    const conversationId = typeof result?.conversationId === "string" ? result.conversationId.trim() : "";
    if (conversationId) {
        payload.conversationId = conversationId;
    }
    if (result?.selection && isPlainObject(result.selection)) {
        payload.metadata = { selection: clonePlainValue(result.selection) };
    }
    try {
        return JSON.stringify(payload, null, 2);
    } catch (error) {
        console.warn("[reports] Failed to serialise AI issues snapshot", error);
        return EMPTY_ISSUES_JSON;
    }
}

function buildJavaStaticSummary() {
    return {
        message: JAVA_STATIC_SUMMARY_MESSAGE,
        file_extension: JAVA_FILE_EXTENSION,
        total_issues: 0,
        analysis_source: "static_analyzer",
        by_rule: {}
    };
}

function normaliseJavaSegments(segments) {
    const cloned = clonePlainSnapshotList(segments);
    return cloned.map((segment, index) => {
        if (!segment || typeof segment !== "object") {
            return segment;
        }
        const copy = { ...segment };
        if (!Number.isFinite(Number(copy.index))) {
            copy.index = index + 1;
        }
        if (!Number.isFinite(Number(copy.total))) {
            copy.total = cloned.length;
        }
        return copy;
    });
}

function normaliseJavaChunks(chunks) {
    if (!Array.isArray(chunks)) {
        return [];
    }
    const result = [];
    for (const chunk of chunks) {
        if (!chunk || typeof chunk !== "object") {
            continue;
        }
        const entry = {};
        const index = Number(chunk.index);
        if (Number.isFinite(index)) {
            entry.index = Math.max(1, Math.floor(index));
        }
        const total = Number(chunk.total);
        if (Number.isFinite(total)) {
            entry.total = Math.max(1, Math.floor(total));
        }
        const issues = Array.isArray(chunk.issues)
            ? chunk.issues
            : Array.isArray(chunk.parsed?.issues)
            ? chunk.parsed.issues
            : Array.isArray(chunk.raw?.issues)
            ? chunk.raw.issues
            : [];
        if (issues.length) {
            entry.issues = clonePlainIssueList(issues);
        }
        if (Object.keys(entry).length) {
            result.push(entry);
        }
    }
    return result;
}

function buildJavaDmlSummary({ segments, chunks, aggregate, generatedAt }) {
    const totalSegments = segments.length;
    const analysedSegments = chunks.length || totalSegments;
    const status = aggregate?.status
        ? String(aggregate.status).trim() || "completed"
        : totalSegments || analysedSegments
        ? "completed"
        : "idle";
    const summary = {
        analysis_source: "dml_prompt",
        total_segments: totalSegments,
        analyzed_segments: analysedSegments,
        generated_at: generatedAt,
        status
    };
    const errorMessage = typeof aggregate?.error_message === "string" ? aggregate.error_message.trim() : "";
    if (errorMessage) {
        summary.error_message = errorMessage;
    }
    const aggregateMessage = resolveAggregateMessage(aggregate);
    if (aggregateMessage) {
        summary.message = aggregateMessage;
    }
    return summary;
}

function buildJavaDifySummary(issueCount, aggregate) {
    const summary = {
        analysis_source: "dify_workflow",
        total_issues: issueCount
    };
    const aggregateMessage = resolveAggregateMessage(aggregate);
    if (aggregateMessage) {
        summary.message = aggregateMessage;
    }
    return summary;
}

function buildJavaCompositeSummary({ issueCount, aggregate, staticSummary, dmlSummary, difySummary }) {
    const summary = {
        total_issues: issueCount,
        by_rule: isPlainObject(aggregate?.by_rule) ? clonePlainValue(aggregate.by_rule) : {},
        analysis_source: "composite",
        file_extension: JAVA_FILE_EXTENSION,
        sources: {
            static_analyzer: clonePlainValue(staticSummary),
            dml_prompt: clonePlainValue(dmlSummary),
            dify_workflow: clonePlainValue(difySummary)
        }
    };
    if (isPlainObject(aggregate?.by_severity)) {
        summary.by_severity = clonePlainValue(aggregate.by_severity);
    }
    const aggregateMessage = resolveAggregateMessage(aggregate);
    if (aggregateMessage) {
        summary.message = aggregateMessage;
    }
    return summary;
}

function buildJavaReportPayload({ result, issueSnapshot, summaryRecords, generatedAt }) {
    const aggregate = isPlainObject(result?.aggregated) ? clonePlainValue(result.aggregated) : null;
    const staticSummary = buildJavaStaticSummary();
    const segments = normaliseJavaSegments(result?.segments || []);
    const chunks = normaliseJavaChunks(result?.chunks || []);
    const dmlSummary = buildJavaDmlSummary({ segments, chunks, aggregate, generatedAt });
    const issueCount = issueSnapshot.length;
    const difySummary = buildJavaDifySummary(issueCount, aggregate);
    const compositeSummary = buildJavaCompositeSummary({
        issueCount,
        aggregate,
        staticSummary,
        dmlSummary,
        difySummary
    });
    const staticReportEntry = {
        summary: clonePlainValue(staticSummary),
        issues: [],
        analysis_source: "static_analyzer",
        metadata: { analysis_source: "static_analyzer" },
        original: clonePlainValue(staticSummary),
        type: "static_analyzer"
    };
    const dmlReportEntry = {
        type: "dml_prompt",
        summary: clonePlainValue(dmlSummary),
        segments,
        report: typeof result?.textReport === "string" && result.textReport.trim()
            ? result.textReport
            : typeof result?.report === "string"
            ? result.report
            : "",
        chunks,
        issues: clonePlainIssueList(issueSnapshot),
        conversationId: typeof result?.conversationId === "string" ? result.conversationId : "",
        generatedAt,
        metadata: { analysis_source: "dml_prompt" }
    };
    const difyReportEntry = {
        type: "dify_workflow",
        summary: clonePlainValue(difySummary),
        issues: clonePlainIssueList(issueSnapshot),
        metadata: { analysis_source: "dify_workflow" },
        raw: aggregate ? clonePlainValue(aggregate) : { issues: [] },
        report:
            typeof result?.report === "string" && result.report.trim()
                ? result.report
                : JSON.stringify({ issues: issueSnapshot }, null, 2)
    };
    const combinedEntry = {
        type: "combined",
        summary: clonePlainValue(compositeSummary),
        issues: clonePlainIssueList(issueSnapshot)
    };
    const aggregatedReports = {
        summary: summaryRecords.map((record) => clonePlainValue(record)),
        issues: clonePlainIssueList(issueSnapshot)
    };
    const payload = {
        summary: clonePlainValue(compositeSummary),
        issues: clonePlainIssueList(issueSnapshot),
        reports: {
            static_analyzer: staticReportEntry,
            dml_prompt: dmlReportEntry,
            combined: combinedEntry,
            dify_workflow: difyReportEntry
        },
        aggregated_reports: aggregatedReports,
        metadata: {
            analysis_source: "composite",
            components: ["static_analyzer", "dml_prompt", "dify_workflow"]
        }
    };
    try {
        return JSON.stringify(payload, null, 2);
    } catch (error) {
        console.warn("[reports] Failed to serialise Java report payload", error);
        return result?.report || JSON.stringify({ issues: issueSnapshot }, null, 2);
    }
}

function buildJavaReportSnapshots(result, generatedAt) {
    if (!result || typeof result !== "object") {
        return {
            combinedReportJson: EMPTY_COMBINED_REPORT_JSON,
            aiReportJson: EMPTY_ISSUES_JSON,
            reportPayload: ""
        };
    }
    const issueSnapshot = clonePlainIssueList(result.issues);
    const summaryRecords = buildJavaCombinedSummaryRecords({
        aggregate: result.aggregated,
        issues: issueSnapshot,
        generatedAt
    });
    const combinedReportJson = serialiseCombinedReportSnapshot(summaryRecords, issueSnapshot);
    const aiReportJson = buildJavaAiIssuesJsonSnapshot(result, issueSnapshot);
    const reportPayload = buildJavaReportPayload({
        result,
        issueSnapshot,
        summaryRecords,
        generatedAt
    });
    return {
        combinedReportJson,
        aiReportJson,
        reportPayload
    };
}

function sanitiseIssuesJson(value) {
    if (typeof value !== "string") {
        return EMPTY_ISSUES_JSON;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return EMPTY_ISSUES_JSON;
    }
    try {
        const parsed = JSON.parse(trimmed);
        const issues = Array.isArray(parsed?.issues)
            ? parsed.issues.filter((entry) => isPlainObject(entry)).map((entry) => clonePlainValue(entry))
            : [];
        const segments = Array.isArray(parsed?.segments)
            ? parsed.segments.filter((entry) => isPlainObject(entry)).map((entry) => clonePlainValue(entry))
            : [];
        const chunks = Array.isArray(parsed?.chunks)
            ? parsed.chunks.filter((entry) => isPlainObject(entry) || typeof entry === "string")
            : [];
        const errors = Array.isArray(parsed?.errors)
            ? parsed.errors.filter((entry) => isPlainObject(entry)).map((entry) => clonePlainValue(entry))
            : [];
        const conversationId = typeof parsed?.conversationId === "string" ? parsed.conversationId.trim() : "";
        const metadata = isPlainObject(parsed?.metadata) ? clonePlainValue(parsed.metadata) : null;

        const payload = { issues };
        if (segments.length) {
            payload.segments = segments;
        }
        if (chunks.length) {
            payload.chunks = chunks.map((entry) => clonePlainValue(entry));
        }
        if (errors.length) {
            payload.errors = errors;
        }
        if (conversationId) {
            payload.conversationId = conversationId;
        }
        if (metadata && Object.keys(metadata).length) {
            payload.metadata = metadata;
        }

        return JSON.stringify(payload, null, 2);
    } catch (error) {
        console.warn("[reports] Failed to sanitise issues JSON", error);
        return EMPTY_ISSUES_JSON;
    }
}

function buildFallbackCombinedReport(errorMessage, generatedAt) {
    const trimmedMessage = typeof errorMessage === "string" ? errorMessage.trim() : "";
    const baseMessage = trimmedMessage
        ? `AI 審查流程執行失敗：${trimmedMessage}`
        : "AI 審查流程執行失敗。";
    const summary = [
        {
            source: "static_analyzer",
            label: "靜態分析器",
            total_issues: 0,
            status: "skipped",
            generated_at: generatedAt
        },
        {
            source: "dml_prompt",
            label: "AI審查",
            total_issues: 0,
            status: "failed",
            message: baseMessage,
            generated_at: generatedAt
        },
        {
            source: "combined",
            label: "聚合報告",
            total_issues: 0,
            status: "failed",
            message: baseMessage,
            generated_at: generatedAt
        }
    ].map((entry) => clonePlainValue(entry));

    return { summary, issues: [] };
}

function mapReportRow(row) {
    const chunks = safeParseArray(row.chunks_json);
    const segments = safeParseArray(row.segments_json);
    const parsedReport = safeParseReport(row.report);
    const reportsBlock =
        parsedReport && typeof parsedReport === "object" && !Array.isArray(parsedReport.reports)
            ? parsedReport.reports
            : parsedReport && typeof parsedReport.reports === "object"
            ? parsedReport.reports
            : {};
    const staticReport =
        reportsBlock?.static_analyzer || reportsBlock?.staticAnalyzer || null;
    const dmlReport = reportsBlock?.dml_prompt || reportsBlock?.dmlPrompt || null;
    const difyReport = reportsBlock?.dify_workflow || reportsBlock?.difyWorkflow || null;

    let analysis = extractAnalysisFromChunks(chunks);
    const ensureAnalysis = () => {
        if (!analysis) {
            analysis = {};
        }
        return analysis;
    };

    if (parsedReport && typeof parsedReport === "object") {
        const target = ensureAnalysis();
        if (parsedReport.summary && typeof parsedReport.summary === "object") {
            target.combinedSummary = parsedReport.summary;
        }
        if (Array.isArray(parsedReport.issues)) {
            target.combinedIssues = parsedReport.issues;
        }
    }

    if (staticReport && typeof staticReport === "object") {
        const target = ensureAnalysis();
        target.staticReport = staticReport;
    }

    if (difyReport && typeof difyReport === "object") {
        const target = ensureAnalysis();
        target.difyReport = difyReport;
        if (difyReport.summary && typeof difyReport.summary === "object") {
            target.difySummary = difyReport.summary;
        }
        if (Array.isArray(difyReport.issues)) {
            target.difyIssues = difyReport.issues;
        }
    }

    if (dmlReport && typeof dmlReport === "object") {
        const target = ensureAnalysis();
        target.dmlReport = dmlReport;
        if (Array.isArray(dmlReport.issues)) {
            target.dmlIssues = dmlReport.issues;
        }
        if (Array.isArray(dmlReport.segments)) {
            target.dmlSegments = dmlReport.segments;
        }
        if (dmlReport.aggregated && typeof dmlReport.aggregated === "object") {
            target.dmlAggregated = dmlReport.aggregated;
        }
        if (dmlReport.summary && typeof dmlReport.summary === "object") {
            target.dmlSummary = dmlReport.summary;
        }
        if (dmlReport.generatedAt || dmlReport.generated_at) {
            target.dmlGeneratedAt = dmlReport.generatedAt || dmlReport.generated_at;
        }
        if (typeof dmlReport.conversationId === "string" && dmlReport.conversationId) {
            target.dmlConversationId = dmlReport.conversationId;
        }
    }

    const combinedReportJson = typeof row.combined_report_json === "string"
        ? row.combined_report_json
        : EMPTY_COMBINED_REPORT_JSON;
    const staticReportJson = sanitiseIssuesJson(row.static_report_json || "");
    const aiReportJson = sanitiseIssuesJson(row.ai_report_json || "");

    return {
        projectId: row.project_id,
        projectName: row.project_name || "",
        path: row.path,
        report: row.report || "",
        chunks,
        segments,
        analysis,
        dml: dmlReport || null,
        dify: difyReport || null,
        staticReport: staticReport || null,
        conversationId: row.conversation_id || "",
        userId: row.user_id || "",
        generatedAt: toIsoString(row.generated_at),
        createdAt: toIsoString(row.created_at),
        updatedAt: toIsoString(row.updated_at),
        combinedReportJson,
        staticReportJson,
        aiReportJson
    };
}

function mapDocumentReportRow(row) {
    return {
        ...mapReportRow({
            ...row,
            project_id: row.project_id || row.project_name
        }),
        projectName: row.project_name || row.project_id || ""
    };
}

async function fetchProjectNameById(projectId) {
    if (!projectId) return "";
    const [rows] = await pool.query(
        "SELECT name FROM projects WHERE id = ? LIMIT 1",
        [projectId]
    );
    if (!rows.length) return "";
    return typeof rows[0].name === "string" ? rows[0].name : "";
}

function normaliseSnippetSelection(selection) {
    if (!selection || typeof selection !== "object") {
        return null;
    }
    if (typeof selection.content !== "string") {
        return null;
    }
    const content = selection.content;
    const start = Number(selection.startLine);
    const end = Number(selection.endLine);
    const startColumnRaw = Number(selection.startColumn);
    const endColumnRaw = Number(selection.endColumn);
    const providedLineCount = Number(selection.lineCount);
    const label = typeof selection.label === "string" ? selection.label.trim() : "";
    const meta = {};
    if (Number.isFinite(start)) {
        meta.startLine = Math.max(1, Math.floor(start));
    }
    if (Number.isFinite(end)) {
        meta.endLine = Math.max(1, Math.floor(end));
    }
    if (Number.isFinite(startColumnRaw) && startColumnRaw > 0) {
        meta.startColumn = Math.max(1, Math.floor(startColumnRaw));
    }
    if (Number.isFinite(endColumnRaw) && endColumnRaw > 0) {
        meta.endColumn = Math.max(1, Math.floor(endColumnRaw));
    }
    if (meta.startLine !== undefined && meta.endLine !== undefined && meta.endLine < meta.startLine) {
        const temp = meta.startLine;
        meta.startLine = meta.endLine;
        meta.endLine = temp;
        if (meta.startColumn !== undefined || meta.endColumn !== undefined) {
            const columnTemp = meta.startColumn;
            meta.startColumn = meta.endColumn;
            meta.endColumn = columnTemp;
        }
    }
    if (meta.startLine !== undefined && meta.endLine === undefined) {
        meta.endLine = meta.startLine;
    }
    if (meta.endLine !== undefined && meta.startLine === undefined) {
        meta.startLine = meta.endLine;
    }
    if (
        meta.startLine !== undefined &&
        meta.endLine !== undefined &&
        meta.startLine === meta.endLine &&
        meta.startColumn !== undefined &&
        meta.endColumn !== undefined &&
        meta.endColumn < meta.startColumn
    ) {
        const columnTemp = meta.startColumn;
        meta.startColumn = meta.endColumn;
        meta.endColumn = columnTemp;
    }
    if (Number.isFinite(providedLineCount) && providedLineCount > 0) {
        meta.lineCount = Math.max(1, Math.floor(providedLineCount));
    } else if (meta.startLine !== undefined && meta.endLine !== undefined) {
        meta.lineCount = meta.endLine - meta.startLine + 1;
    }
    if (label) {
        meta.label = label;
    }
    const hasMeta = Object.keys(meta).length > 0;
    return {
        content,
        meta: hasMeta ? meta : null
    };
}

async function upsertReport({
    projectId,
    path,
    report,
    chunks,
    segments,
    conversationId,
    userId,
    generatedAt,
    combinedReportJson,
    staticReportJson,
    aiReportJson
}) {
    if (!projectId || !path) {
        throw new Error("Report upsert requires projectId and path");
    }
    const now = Date.now();
    const generatedTime = (() => {
        if (!generatedAt) return Number.NaN;
        if (typeof generatedAt === "number") {
            return generatedAt;
        }
        const parsed = Date.parse(generatedAt);
        return Number.isNaN(parsed) ? Number.NaN : parsed;
    })();
    const storedGeneratedAt = Number.isFinite(generatedTime) ? generatedTime : now;
    const serialisedChunks = JSON.stringify(Array.isArray(chunks) ? chunks : []);
    const serialisedSegments = JSON.stringify(Array.isArray(segments) ? segments : []);
    const safeProjectId = typeof projectId === "string" ? projectId : String(projectId);
    const safePath = typeof path === "string" ? path : String(path);
    const safeReport = typeof report === "string" ? report : "";
    const safeConversationId = typeof conversationId === "string" ? conversationId : "";
    const safeUserId = typeof userId === "string" ? userId : "";
    const safeCombinedJson = typeof combinedReportJson === "string" ? combinedReportJson : "";
    const safeStaticJson = typeof staticReportJson === "string" ? staticReportJson : "";
    const safeAiJson = typeof aiReportJson === "string" ? aiReportJson : "";

    logReportPersistenceStage("upsertReport.input", {
        projectId,
        path,
        report,
        chunks,
        segments,
        conversationId,
        userId,
        generatedAt,
        combinedReportJson,
        staticReportJson,
        aiReportJson
    });

    logReportPersistenceStage("upsertReport.serialised", {
        projectId: safeProjectId,
        path: safePath,
        report: safeReport,
        chunks: serialisedChunks,
        segments: serialisedSegments,
        conversationId: safeConversationId,
        userId: safeUserId,
        generatedAt: storedGeneratedAt,
        createdAt: now,
        updatedAt: now,
        combinedReportJson: safeCombinedJson,
        staticReportJson: safeStaticJson,
        aiReportJson: safeAiJson
    });

    await pool.query(
        `INSERT INTO reports (
            project_id,
            path,
            report,
            chunks_json,
            segments_json,
            conversation_id,
            user_id,
            generated_at,
            created_at,
            updated_at,
            combined_report_json,
            static_report_json,
            ai_report_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            report = VALUES(report),
            chunks_json = VALUES(chunks_json),
            segments_json = VALUES(segments_json),
            conversation_id = VALUES(conversation_id),
            user_id = VALUES(user_id),
            generated_at = VALUES(generated_at),
            updated_at = VALUES(updated_at),
            combined_report_json = VALUES(combined_report_json),
            static_report_json = VALUES(static_report_json),
            ai_report_json = VALUES(ai_report_json)`,
        [
            safeProjectId,
            safePath,
            safeReport,
            serialisedChunks,
            serialisedSegments,
            safeConversationId,
            safeUserId,
            storedGeneratedAt,
            now,
            now,
            safeCombinedJson,
            safeStaticJson,
            safeAiJson
        ]
    );
}

async function upsertDocumentReport({
    projectName,
    projectId,
    path,
    report,
    chunks,
    segments,
    conversationId,
    userId,
    generatedAt,
    combinedReportJson,
    staticReportJson,
    aiReportJson
}) {
    if (!projectName || !path) {
        throw new Error("Document report upsert requires projectName and path");
    }
    const now = Date.now();
    const generatedTime = (() => {
        if (!generatedAt) return Number.NaN;
        if (typeof generatedAt === "number") {
            return generatedAt;
        }
        const parsed = Date.parse(generatedAt);
        return Number.isNaN(parsed) ? Number.NaN : parsed;
    })();
    const storedGeneratedAt = Number.isFinite(generatedTime) ? generatedTime : now;
    const serialisedChunks = JSON.stringify(Array.isArray(chunks) ? chunks : []);
    const serialisedSegments = JSON.stringify(Array.isArray(segments) ? segments : []);
    const safeProjectName = String(projectName);
    const safeProjectId = typeof projectId === "string" ? projectId : projectId ? String(projectId) : "";
    const safePath = typeof path === "string" ? path : String(path);
    const safeReport = typeof report === "string" ? report : "";
    const safeConversationId = typeof conversationId === "string" ? conversationId : "";
    const safeUserId = typeof userId === "string" ? userId : "";
    const safeCombinedJson = typeof combinedReportJson === "string" ? combinedReportJson : "";
    const safeStaticJson = typeof staticReportJson === "string" ? staticReportJson : "";
    const safeAiJson = typeof aiReportJson === "string" ? aiReportJson : "";

    await pool.query(
        `INSERT INTO document_reports (
            project_name,
            project_id,
            path,
            report,
            chunks_json,
            segments_json,
            conversation_id,
            user_id,
            generated_at,
            created_at,
            updated_at,
            combined_report_json,
            static_report_json,
            ai_report_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            project_id = VALUES(project_id),
            report = VALUES(report),
            chunks_json = VALUES(chunks_json),
            segments_json = VALUES(segments_json),
            conversation_id = VALUES(conversation_id),
            user_id = VALUES(user_id),
            generated_at = VALUES(generated_at),
            updated_at = VALUES(updated_at),
            combined_report_json = VALUES(combined_report_json),
            static_report_json = VALUES(static_report_json),
            ai_report_json = VALUES(ai_report_json)`,
        [
            safeProjectName,
            safeProjectId,
            safePath,
            safeReport,
            serialisedChunks,
            serialisedSegments,
            safeConversationId,
            safeUserId,
            storedGeneratedAt,
            now,
            now,
            safeCombinedJson,
            safeStaticJson,
            safeAiJson
        ]
    );
}

app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
});

app.get("/api/projects", async (req, res, next) => {
    try {
        const [rows] = await pool.query(
            "SELECT id, name, mode, created_at FROM projects ORDER BY name ASC"
        );
        res.json(rows.map(mapProjectRow));
    } catch (error) {
        next(error);
    }
});

app.post("/api/projects", async (req, res, next) => {
    try {
        const { id, name, mode, createdAt } = req.body || {};
        if (!id || !name || !mode) {
            res.status(400).json({ message: "Missing required project fields" });
            return;
        }
        const createdAtValue = Number(createdAt) || Date.now();
        await pool.query(
            `INSERT INTO projects (id, name, mode, created_at)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), mode = VALUES(mode), created_at = VALUES(created_at)`,
            [id, name, mode, createdAtValue]
        );
        res.status(201).json({ id, name, mode, createdAt: createdAtValue });
    } catch (error) {
        next(error);
    }
});

app.delete("/api/projects/:id", async (req, res, next) => {
    try {
        const { id } = req.params;
        await pool.query("DELETE FROM projects WHERE id = ?", [id]);
        res.status(204).end();
    } catch (error) {
        next(error);
    }
});

app.get("/api/projects/:projectId/nodes", async (req, res, next) => {
    try {
        const { projectId } = req.params;
        const [rows] = await pool.query(
            `SELECT node_key, project_id, type, name, path, parent, size, last_modified, mime, encoding, is_big
             FROM nodes
             WHERE project_id = ?
             ORDER BY path ASC`,
            [projectId]
        );
        res.json(rows.map(mapNodeRow));
    } catch (error) {
        next(error);
    }
});

async function insertNodes(connection, projectId, nodes) {
    if (!nodes.length) return;
    const chunkSize = Number(process.env.NODE_INSERT_BATCH || "400");
    for (let i = 0; i < nodes.length; i += chunkSize) {
        const chunk = nodes.slice(i, i + chunkSize).map((node) => {
            const path = typeof node?.path === "string" ? node.path : "";
            const type = node?.type === "dir" ? "dir" : "file";
            return {
                key: computeNodeKey(projectId, path),
                type,
                name: typeof node?.name === "string" ? node.name : "",
                path,
                parent: typeof node?.parent === "string" ? node.parent : "",
                size: Number(node?.size) || 0,
                lastModified: Number(node?.lastModified) || 0,
                mime: typeof node?.mime === "string" ? node.mime : "",
                encoding: typeof node?.encoding === "string" ? node.encoding : "",
                isBig: Boolean(node?.isBig)
            };
        });
        const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
        const values = chunk.flatMap((node) => [
            node.key,
            projectId,
            node.type,
            node.name,
            node.path,
            node.parent,
            node.size,
            node.lastModified,
            node.mime,
            node.encoding,
            node.isBig ? 1 : 0
        ]);
        await connection.query(
            `INSERT INTO nodes (node_key, project_id, type, name, path, parent, size, last_modified, mime, encoding, is_big)
             VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE
                project_id = VALUES(project_id),
                type = VALUES(type),
                name = VALUES(name),
                path = VALUES(path),
                parent = VALUES(parent),
                size = VALUES(size),
                last_modified = VALUES(last_modified),
                mime = VALUES(mime),
                encoding = VALUES(encoding),
                is_big = VALUES(is_big)`,
            values
        );
    }
}

async function insertProjectFiles(connection, projectId, files) {
    if (!files.length) return;
    const chunkSize = Number(process.env.FILE_INSERT_BATCH || "200");
    for (let i = 0; i < files.length; i += chunkSize) {
        const chunk = files.slice(i, i + chunkSize)
            .map((file) => {
                const path = typeof file?.path === "string" ? file.path : "";
                const content = typeof file?.content === "string" ? file.content : "";
                return {
                    path,
                    content,
                    mime: typeof file?.mime === "string" ? file.mime : "",
                    encoding: typeof file?.encoding === "string" ? file.encoding : "",
                    size: Number(file?.size) || 0,
                    lastModified: Number(file?.lastModified) || 0,
                    createdAt: Number(file?.createdAt) || Date.now(),
                    updatedAt: Number(file?.updatedAt) || Date.now()
                };
            })
            .filter((file) => file.path && file.content !== null && file.content !== undefined);

        if (!chunk.length) {
            continue;
        }

        const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
        const values = chunk.flatMap((file) => [
            projectId,
            file.path,
            file.mime,
            file.encoding,
            file.size,
            file.lastModified,
            file.content,
            file.createdAt,
            file.updatedAt
        ]);

        await connection.query(
            `INSERT INTO project_files (project_id, path, mime, encoding, size, last_modified, content, created_at, updated_at)
             VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE
                mime = VALUES(mime),
                encoding = VALUES(encoding),
                size = VALUES(size),
                last_modified = VALUES(last_modified),
                content = VALUES(content),
                updated_at = VALUES(updated_at)`,
            values
        );
    }
}

app.post("/api/projects/:projectId/nodes", async (req, res, next) => {
    const connection = await pool.getConnection();
    try {
        const { projectId } = req.params;
        const payload = req.body || {};
        const nodes = Array.isArray(payload) ? payload : payload.nodes;
        if (!Array.isArray(nodes)) {
            res.status(400).json({ message: "Request body must be an array of nodes or { nodes: [] }" });
            return;
        }
        await connection.beginTransaction();
        await connection.query("DELETE FROM nodes WHERE project_id = ?", [projectId]);
        await insertNodes(connection, projectId, nodes);
        await connection.commit();
        res.status(204).end();
    } catch (error) {
        await connection.rollback().catch(() => {});
        next(error);
    } finally {
        connection.release();
    }
});

app.post("/api/projects/:projectId/files", async (req, res, next) => {
    const connection = await pool.getConnection();
    try {
        const { projectId } = req.params;
        const payload = req.body || {};
        const files = Array.isArray(payload) ? payload : payload.files;
        if (!Array.isArray(files)) {
            res.status(400).json({ message: "Request body must be an array of files or { files: [] }" });
            return;
        }
        await connection.beginTransaction();
        await connection.query("DELETE FROM project_files WHERE project_id = ?", [projectId]);
        await insertProjectFiles(connection, projectId, files);
        await connection.commit();
        res.status(204).end();
    } catch (error) {
        await connection.rollback().catch(() => {});
        next(error);
    } finally {
        connection.release();
    }
});

app.get("/api/projects/:projectId/files", async (req, res, next) => {
    try {
        const { projectId } = req.params;
        const path = typeof req.query?.path === "string" ? req.query.path : "";
        if (!path) {
            res.status(400).json({ message: "Query parameter `path` is required" });
            return;
        }
        const [rows] = await pool.query(
            `SELECT project_id, path, mime, encoding, size, last_modified, content, created_at, updated_at
             FROM project_files
             WHERE project_id = ? AND path = ?
             LIMIT 1`,
            [projectId, path]
        );
        if (!rows.length) {
            res.status(404).json({ message: "File not found" });
            return;
        }
        res.json(mapProjectFileRow(rows[0]));
    } catch (error) {
        next(error);
    }
});

app.get("/api/projects/:projectId/reports", async (req, res, next) => {
    try {
        const { projectId } = req.params;
        const [rows] = await pool.query(
            `SELECT project_id, path, report, chunks_json, segments_json, conversation_id, user_id, generated_at, created_at, updated_at,
                    combined_report_json, static_report_json, ai_report_json
             FROM reports
             WHERE project_id = ?
             ORDER BY path ASC`,
            [projectId]
        );
        res.json({
            projectId,
            reports: rows.map(mapReportRow)
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/projects/:projectId/document-reports", async (req, res, next) => {
    try {
        const { projectId } = req.params;
        const projectName = await fetchProjectNameById(projectId);
        if (!projectName) {
            res.status(404).json({ message: "Project not found" });
            return;
        }

        const [rows] = await pool.query(
            `SELECT project_name, project_id, path, report, chunks_json, segments_json, conversation_id, user_id, generated_at, created_at, updated_at,
                    combined_report_json, static_report_json, ai_report_json
             FROM document_reports
             WHERE project_name = ?
             ORDER BY path ASC`,
            [projectName]
        );

        res.json({
            projectId,
            projectName,
            reports: rows.map(mapDocumentReportRow)
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/documents/sql-text", async (req, res, next) => {
    try {
        const { data, base64, name, mime } = req.body || {};
        const payload = typeof data === "string" && data.trim() ? data.trim() : typeof base64 === "string" ? base64.trim() : "";
        if (!payload) {
            res.status(400).json({ message: "Missing document data (base64)" });
            return;
        }
        const text = await extractSqlTextFromDocument({
            base64: payload,
            name: typeof name === "string" ? name : "",
            mime: typeof mime === "string" ? mime : ""
        });
        res.json({ text: typeof text === "string" ? text : "" });
    } catch (error) {
        next(error);
    }
});

app.post("/api/reports/dify", async (req, res, next) => {
    const { projectId, projectName, path, content, userId, files } = req.body || {};
    let resolvedUserId = typeof userId === "string" ? userId.trim() : "";

    try {
        if (!projectId || !path || typeof content !== "string") {
            res.status(400).json({ message: "Missing projectId, path, or content for report generation" });
            return;
        }
        if (!content.trim()) {
            res.status(400).json({ message: "檔案內容為空，無法生成報告" });
            return;
        }
        resolvedUserId = typeof userId === "string" ? userId.trim() : "";
        if (isSqlPath(path)) {
            if (REPORT_DEBUG_LOGS) {
                console.log(`[sql] Generating SQL report project=${projectId} path=${path}`);
            }
            const aiReviewResolvers = buildAiReviewResolvers("SQL");
            let sqlAnalysis;
            try {
                sqlAnalysis = await analyseSqlToReport(content, {
                    projectId,
                    projectName,
                    path,
                    userId: resolvedUserId,
                    files,
                    ...aiReviewResolvers
                });
            } catch (error) {
                console.error("[sql] Failed to analyse SQL", error);
                res.status(502).json({ message: error?.message || "SQL 分析失敗" });
                return;
            }

            const reportPayload = buildSqlReportPayload({
                analysis: sqlAnalysis.analysis,
                content,
                dify: sqlAnalysis.dify,
                difyError: sqlAnalysis.difyError,
                dml: sqlAnalysis.dml,
                dmlError: sqlAnalysis.dmlError
            });
            await upsertReport({
                projectId,
                path,
                report: reportPayload.report,
                chunks: reportPayload.chunks,
                segments: reportPayload.segments,
                conversationId: reportPayload.conversationId,
                userId: resolvedUserId,
                generatedAt: reportPayload.generatedAt,
                combinedReportJson: reportPayload.combinedReportJson,
                staticReportJson: reportPayload.staticReportJson,
                aiReportJson: reportPayload.aiReportJson
            });
            const savedAtIso = new Date().toISOString();
            res.json({
                projectId,
                path,
                ...reportPayload,
                savedAt: savedAtIso,
                difyError:
                    reportPayload.difyErrorMessage ||
                    (sqlAnalysis.difyError ? sqlAnalysis.difyError.message || String(sqlAnalysis.difyError) : undefined),
                dmlError:
                    reportPayload.dmlErrorMessage ||
                    (sqlAnalysis.dmlError ? sqlAnalysis.dmlError.message || String(sqlAnalysis.dmlError) : undefined)
            });
            return;
        }

        const javaFile = isJavaPath(path);
        const javaSegments = javaFile ? buildJavaSegments(content) : [];
        const segments = javaSegments.length ? javaSegments : partitionContent(content);
        const summary = getDifyConfigSummary();
        if (REPORT_DEBUG_LOGS) {
            console.log(
                `[dify] Generating report project=${projectId} path=${path} segments=${segments.length} ` +
                    `maxSegmentChars=${summary.maxSegmentChars}${javaFile ? " (java)" : ""}`
            );
        }

        const aiReviewResolvers = buildAiReviewResolvers(javaFile ? "Java" : "SQL");

        const result = await requestDifyReport({
            projectName: projectName || projectId,
            filePath: path,
            content,
            userId,
            segments,
            files,
            ...aiReviewResolvers
        });
        const resolvedGeneratedAt = result?.generatedAt || new Date().toISOString();
        const javaSnapshots = javaFile ? buildJavaReportSnapshots(result, resolvedGeneratedAt) : null;
        await upsertReport({
            projectId,
            path,
            report: javaSnapshots?.reportPayload || result?.report,
            chunks: result?.chunks,
            segments: result?.segments,
            conversationId: result?.conversationId,
            userId: resolvedUserId,
            generatedAt: resolvedGeneratedAt,
            combinedReportJson: javaSnapshots?.combinedReportJson,
            staticReportJson: javaFile ? EMPTY_ISSUES_JSON : undefined,
            aiReportJson: javaSnapshots?.aiReportJson
        });
        const savedAtIso = new Date().toISOString();
        res.json({
            projectId,
            path,
            ...result,
            report: javaSnapshots?.reportPayload || result?.report,
            combinedReportJson: javaSnapshots?.combinedReportJson,
            aiReportJson: javaSnapshots?.aiReportJson,
            savedAt: savedAtIso
        });
    } catch (error) {
        console.error("[dify] Failed to generate report", error);

        const errorMessage = typeof error?.message === "string" ? error.message : "";
        const shouldFallback =
            errorMessage && errorMessage.toLowerCase().includes("aggregatedreports is not defined");

        if (shouldFallback && projectId && path) {
            const fallbackGeneratedAt = new Date().toISOString();
            const fallbackCombined = buildFallbackCombinedReport(errorMessage, fallbackGeneratedAt);
            const combinedJson = JSON.stringify(fallbackCombined, null, 2);
            const savedAtIso = new Date().toISOString();

            try {
                await upsertReport({
                    projectId,
                    path,
                    report: "",
                    chunks: [],
                    segments: [],
                    conversationId: "",
                    userId: resolvedUserId,
                    generatedAt: fallbackGeneratedAt,
                    combinedReportJson: combinedJson,
                    staticReportJson: EMPTY_ISSUES_JSON,
                    aiReportJson: EMPTY_ISSUES_JSON
                });
            } catch (persistError) {
                console.error("[dify] Failed to persist fallback report", persistError);
                const status = errorMessage.includes("not configured") ? 500 : 502;
                res.status(status).json({ message: errorMessage || "Failed to generate report" });
                return;
            }

            res.json({
                projectId,
                path,
                report: "",
                chunks: [],
                segments: [],
                conversationId: "",
                generatedAt: fallbackGeneratedAt,
                combinedReportJson: combinedJson,
                staticReportJson: EMPTY_ISSUES_JSON,
                aiReportJson: EMPTY_ISSUES_JSON,
                dify: null,
                dml: null,
                analysis: null,
                savedAt: savedAtIso,
                difyErrorMessage: errorMessage,
                dmlErrorMessage: ""
            });
            return;
        }

        const status = errorMessage.includes("not configured") ? 500 : 502;
        res.status(status).json({ message: errorMessage || "Failed to generate report" });
    }
});

app.post("/api/reports/document-review", async (req, res, next) => {
    try {
        const { projectId, projectName, userId } = req.body || {};
        const path =
            typeof req.body?.path === "string" && req.body.path.trim()
                ? req.body.path.trim()
                : DOCUMENT_REVIEW_PATH;

        if (!projectId) {
            res.status(400).json({ message: "Missing projectId for document review" });
            return;
        }

        const resolvedProjectName =
            (typeof projectName === "string" && projectName.trim()) || (await fetchProjectNameById(projectId));
        if (!resolvedProjectName) {
            res.status(404).json({ message: "Project not found" });
            return;
        }

        const [nodeRows] = await pool.query(
            `SELECT node_key, project_id, type, name, path, parent, size, last_modified, mime, encoding, is_big
             FROM nodes
             WHERE project_id = ?
             ORDER BY path ASC`,
            [projectId]
        );
        const nodes = nodeRows.map(mapNodeRow);
        if (!nodes.length) {
            res.status(404).json({ message: "此專案尚未匯入檔案樹，無法檢查文件項目" });
            return;
        }

        const encodingMap = new Map();
        const fileContentByPath = new Map();
        for (const node of nodes) {
            const encoding = resolveNodeEncoding(node);
            if (encoding && (node?.path || node?.name)) {
                encodingMap.set(node.path || node.name, encoding);
            }
        }

        const missingEncodingPaths = nodes
            .filter((node) => node.type === "file")
            .map((node) => node.path || node.name || "")
            .filter((path) => path && !encodingMap.has(path));

        if (missingEncodingPaths.length) {
            const placeholders = missingEncodingPaths.map(() => "?").join(",");
            try {
                const [encodingRows] = await pool.query(
                    `SELECT path, mime, encoding, content
                     FROM project_files
                     WHERE project_id = ? AND path IN (${placeholders})`,
                    [projectId, ...missingEncodingPaths]
                );
                for (const row of encodingRows || []) {
                    if (row?.path && typeof row?.content === "string" && !fileContentByPath.has(row.path)) {
                        fileContentByPath.set(row.path, row.content);
                    }
                    const resolvedEncoding =
                        resolveNodeEncoding(row) || detectEncodingFromContent(row?.content || "");
                    if (resolvedEncoding && row?.path && !encodingMap.has(row.path)) {
                        encodingMap.set(row.path, resolvedEncoding);
                    }
                }
            } catch (error) {
                console.warn("[documents] Failed to load encoding metadata from stored files", error);
            }
        }

        const sqlFileNodes = nodes.filter(
            (node) => node.type === "file" && typeof node.name === "string" && node.name.toLowerCase().endsWith(".sql")
        );
        let sqlFilesMeta = [];
        if (sqlFileNodes.length) {
            const sqlPaths = sqlFileNodes.map((node) => node.path).filter(Boolean);
            if (sqlPaths.length) {
                const placeholders = sqlPaths.map(() => "?").join(",");
                try {
                    const missingSqlContent = sqlPaths.filter((path) => !fileContentByPath.has(path));
                    if (missingSqlContent.length) {
                        const [fileRows] = await pool.query(
                            `SELECT path, content
                             FROM project_files
                             WHERE project_id = ? AND path IN (${placeholders})`,
                            [projectId, ...sqlPaths]
                        );
                        for (const row of fileRows || []) {
                            if (row?.path && typeof row?.content === "string" && !fileContentByPath.has(row.path)) {
                                fileContentByPath.set(row.path, row.content);
                            }
                        }
                    }
                    sqlFilesMeta = sqlFileNodes.map((node) => {
                        const content = fileContentByPath.get(node.path);
                        const stored = fileContentByPath.has(node.path);
                        const hasBom = typeof content === "string" ? content.startsWith("\ufeff") : false;
                        const detected = detectEncodingFromContent(content || "");
                        return { path: node.path, hasBom, stored, detected };
                    });
                } catch (error) {
                    console.warn("[documents] Failed to load SQL file content for BOM check", error);
                    sqlFilesMeta = sqlFileNodes.map((node) => ({ path: node.path, hasBom: false, stored: false, detected: "" }));
                }
            }
        }

        for (const meta of sqlFilesMeta) {
            if (!meta?.path || encodingMap.has(meta.path)) continue;
            const detected = typeof meta?.detected === "string" ? meta.detected.trim() : "";
            if (detected) {
                encodingMap.set(meta.path, detected);
            } else if (meta.hasBom) {
                encodingMap.set(meta.path, "UTF-8-BOM");
            } else if (meta.stored) {
                encodingMap.set(meta.path, "UTF-8");
            }
        }

        for (const node of nodes) {
            if (node?.type !== "file") continue;
            const key = node?.path || node?.name || "";
            if (!key || encodingMap.has(key)) continue;
            encodingMap.set(key, "UTF-8");
        }

        const treeMap = buildDocumentTreeMap(nodes, { encodingMap });

        const setting = await loadDocumentReviewSetting();
        const { enabledChecks, snapshot } = buildDocumentStatusSnapshot(nodes, setting.checks, sqlFilesMeta);
        const checksJson = JSON.stringify(enabledChecks, null, 2);
        const statusJson = JSON.stringify(snapshot, null, 2);
        const segmentText = [
            `專案：${resolvedProjectName}`,
            "",
            "檔案樹：",
            treeMap || "(空)",
            "",
            "規則清單：",
            checksJson,
            "",
            "狀態摘要：",
            statusJson
        ].join("\n");

        const difyTemplateContext = {
            project_tree: treeMap,
            tree_map: treeMap,
            rule_set: checksJson,
            checks: checksJson,
            status_json: statusJson,
            file_name: (path.split("/").filter(Boolean).pop() || path || resolvedProjectName || "")
        };

        const dify = await requestDifyReport({
            projectName: resolvedProjectName,
            filePath: path,
            content: segmentText,
            userId,
            segments: [segmentText],
            language: "Docs",
            loadAiReviewTemplate: async () => setting.promptTemplate,
            loadAiReviewRules: async () => "",
            templateContext: difyTemplateContext
        });

        const difyReport = typeof dify?.report === "string" ? dify.report : segmentText;
        const parsedDify = safeParseReport(difyReport);
        const difyIssues = Array.isArray(parsedDify?.issues)
            ? parsedDify.issues
            : Array.isArray(dify?.issues)
            ? dify.issues
            : [];
        const difySummary = parsedDify && typeof parsedDify === "object" && parsedDify.summary
            ? parsedDify.summary
            : null;
        const generatedAt = dify?.generatedAt || new Date().toISOString();

        const summary = difySummary || {
            total_issues: difyIssues.length,
            sources: { document_review: { total_issues: difyIssues.length } },
            document_status: snapshot,
            generated_at: generatedAt
        };

        const reportEntry = {
            type: "document_review",
            summary: clonePlainValue(summary),
            issues: clonePlainIssueList(difyIssues),
            metadata: { analysis_source: "document_review", checks: enabledChecks, status: snapshot },
            report: difyReport,
            raw: parsedDify || undefined
        };

        const aggregatedReports = {
            summary: [
                buildSummaryRecord({
                    source: "document_review",
                    label: "文件審查",
                    totalIssues: difyIssues.length,
                    generatedAt
                })
            ],
            issues: clonePlainIssueList(difyIssues)
        };

        const finalPayload = {
            summary,
            issues: clonePlainIssueList(difyIssues),
            reports: { document_review: reportEntry },
            aggregated_reports: aggregatedReports,
            metadata: {
                analysis_source: "document_review",
                components: ["document_review"],
                checks: enabledChecks,
                document_status: snapshot
            }
        };

        const reportString = JSON.stringify(finalPayload, null, 2);
        const combinedReportJson = JSON.stringify(aggregatedReports, null, 2);
        const aiReportJson = JSON.stringify({ issues: clonePlainIssueList(difyIssues) }, null, 2);
        const resolvedUserId = typeof userId === "string" ? userId.trim() : "";

        await upsertDocumentReport({
            projectId,
            projectName: resolvedProjectName,
            path,
            report: reportString,
            chunks: [],
            segments: [segmentText],
            conversationId: typeof dify?.conversationId === "string" ? dify.conversationId : "",
            userId: resolvedUserId,
            generatedAt,
            combinedReportJson,
            staticReportJson: EMPTY_ISSUES_JSON,
            aiReportJson
        });

        const savedAtIso = new Date().toISOString();
        res.json({
            projectId,
            projectName: resolvedProjectName,
            path,
            report: reportString,
            chunks: [],
            segments: [segmentText],
            conversationId: typeof dify?.conversationId === "string" ? dify.conversationId : "",
            generatedAt,
            combinedReportJson,
            staticReportJson: EMPTY_ISSUES_JSON,
            aiReportJson,
            analysis: {
                documentStatus: snapshot,
                documentChecks: enabledChecks,
                dify,
                difySummary
            },
            dify,
            savedAt: savedAtIso
        });
    } catch (error) {
        console.error("[dify] Failed to generate document review", error);
        const status = error?.message && error.message.includes("not configured") ? 500 : 502;
        res.status(status).json({ message: error?.message || "文件 AI 審查失敗" });
    }
});

app.post("/api/reports/dify/snippet", async (req, res, next) => {
    try {
        const { projectId, projectName, path, selection, userId, files } = req.body || {};
        if (!projectId || !path) {
            res.status(400).json({ message: "Missing projectId or path for snippet report generation" });
            return;
        }
        const normalised = normaliseSnippetSelection(selection);
        if (!normalised || typeof normalised.content !== "string") {
            res.status(400).json({ message: "Missing selection content for snippet report generation" });
            return;
        }
        if (!normalised.content.trim()) {
            res.status(400).json({ message: "選取內容為空，無法生成報告" });
            return;
        }

        const resolvedUserId = typeof userId === "string" ? userId.trim() : "";

        if (isSqlPath(path)) {
            if (REPORT_DEBUG_LOGS) {
                console.log(`[sql] Generating SQL snippet report project=${projectId} path=${path}`);
            }
            const aiReviewResolvers = buildAiReviewResolvers("SQL");
            let sqlAnalysis;
            try {
                sqlAnalysis = await analyseSqlToReport(normalised.content, {
                    projectId,
                    projectName,
                    path,
                    userId: resolvedUserId,
                    files,
                    ...aiReviewResolvers
                });
            } catch (error) {
                console.error("[sql] Failed to analyse SQL snippet", error);
                res.status(502).json({ message: error?.message || "SQL 分析失敗" });
                return;
            }
            const reportPayload = buildSqlReportPayload({
                analysis: sqlAnalysis.analysis,
                content: normalised.content,
                dify: sqlAnalysis.dify,
                difyError: sqlAnalysis.difyError,
                dml: sqlAnalysis.dml,
                dmlError: sqlAnalysis.dmlError
            });
            res.json({
                projectId,
                path,
                selection: normalised.meta || undefined,
                ...reportPayload,
                difyError:
                    reportPayload.difyErrorMessage ||
                    (sqlAnalysis.difyError ? sqlAnalysis.difyError.message || String(sqlAnalysis.difyError) : undefined)
            });
            return;
        }

        const javaFile = isJavaPath(path);
        const selectionOffset = normalised.meta?.startLine
            ? Math.max(0, Number(normalised.meta.startLine) - 1)
            : 0;
        const javaSegments = javaFile ? buildJavaSegments(normalised.content) : [];
        const normalisedSegments = javaSegments.length
            ? applyLineOffsetToSegments(javaSegments, selectionOffset)
            : partitionContent(normalised.content);
        const summary = getDifyConfigSummary();
        const rangeLabel = normalised.meta
            ? `${normalised.meta.startLine ?? "-"}-${normalised.meta.endLine ?? "-"}`
            : "full";
        if (REPORT_DEBUG_LOGS) {
            console.log(
                `[dify] Generating snippet report project=${projectId} path=${path} segments=${normalisedSegments.length} range=${rangeLabel} ` +
                    `maxSegmentChars=${summary.maxSegmentChars}${javaFile ? " (java)" : ""}`
            );
        }

        const aiReviewResolvers = buildAiReviewResolvers(javaFile ? "Java" : "SQL");

        const result = await requestDifyReport({
            projectName: projectName || projectId,
            filePath: path,
            content: normalised.content,
            userId,
            segments: normalisedSegments,
            files,
            selection: normalised.meta,
            ...aiReviewResolvers
        });

        res.json({
            projectId,
            path,
            selection: normalised.meta || undefined,
            ...result
        });
    } catch (error) {
        console.error("[dify] Failed to generate snippet report", error);
        const status = error?.message?.includes("not configured") ? 500 : 502;
        res.status(status).json({ message: error?.message || "Failed to generate snippet report" });
    }
});

app.get("/api/settings/rules", async (req, res, next) => {
    try {
        const language = normaliseSettingLanguage(req.query?.language);
        const [rows] = await pool.query(
            `SELECT id, rule_id, description, enabled, risk_indicator, language, created_at
             FROM setting_rules
             WHERE language = ?
             ORDER BY id ASC`,
            [language]
        );
        res.json({ language, rules: rows.map(mapSettingRuleRow) });
    } catch (error) {
        next(error);
    }
});

app.post("/api/settings/rules", async (req, res, next) => {
    const connection = await pool.getConnection();
    try {
        const language = normaliseSettingLanguage(req.body?.language);
        const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
        const normalised = rules
            .map((rule) => ({
                ruleId: typeof rule?.ruleId === "string" ? rule.ruleId.trim() : String(rule?.ruleId ?? ""),
                description: typeof rule?.description === "string" ? rule.description : "",
                enabled: Boolean(rule?.enabled),
                riskIndicator: typeof rule?.riskIndicator === "string" ? rule.riskIndicator : ""
            }))
            .filter((rule) => rule.ruleId || rule.description || rule.riskIndicator);

        const missing = normalised.find(
            (rule) => !rule.ruleId || !rule.description || !rule.riskIndicator
        );
        if (missing) {
            res.status(400).json({ message: "規則ID、描述與風險指標皆為必填" });
            return;
        }

        const seenRuleIds = new Set();
        const duplicate = normalised.find((rule) => {
            if (seenRuleIds.has(rule.ruleId)) return true;
            seenRuleIds.add(rule.ruleId);
            return false;
        });
        if (duplicate) {
            res.status(400).json({ message: "規則ID 不可重覆" });
            return;
        }

        await connection.beginTransaction();
        await connection.query("DELETE FROM setting_rules WHERE language = ?", [language]);

        if (normalised.length) {
            const values = normalised.map((rule) => [
                rule.ruleId,
                rule.description,
                rule.enabled ? 1 : 0,
                rule.riskIndicator,
                language
            ]);

            await connection.query(
                `INSERT INTO setting_rules (rule_id, description, enabled, risk_indicator, language)
                 VALUES ?`,
                [values]
            );
        }

        await connection.commit();
        clearAiReviewCaches();
        res.json({ success: true, count: normalised.length, language });
    } catch (error) {
        await connection.rollback().catch(() => {});
        next(error);
    } finally {
        connection.release();
    }
});

app.get("/api/settings/ai-review", async (req, res, next) => {
    try {
        const language = normaliseSettingLanguage(req.query?.language);
        const [rows] = await pool.query(
            `SELECT id, language, code_block, created_at
             FROM setting_ai_review
             WHERE language = ?
             ORDER BY id DESC
             LIMIT 1`,
            [language]
        );
        const record = rows?.[0];
        const payload = record ? mapAiReviewSettingRow(record) : { language, codeBlock: "", createdAt: null };
        res.json(payload);
    } catch (error) {
        next(error);
    }
});

app.post("/api/settings/ai-review", async (req, res, next) => {
    try {
        const language = normaliseSettingLanguage(req.body?.language);
        const codeBlock = typeof req.body?.codeBlock === "string" ? req.body.codeBlock : "";
        const [result] = await pool.query(
            `INSERT INTO setting_ai_review (language, code_block)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE code_block = VALUES(code_block), created_at = CURRENT_TIMESTAMP`,
            [language, codeBlock]
        );
        clearAiReviewCaches();
        res.json({ success: true, id: result?.insertId || null, language });
    } catch (error) {
        next(error);
    }
});

app.get("/api/settings/document-review", async (_req, res, next) => {
    try {
        const setting = await loadDocumentReviewSetting();
        res.json(setting);
    } catch (error) {
        next(error);
    }
});

app.post("/api/settings/document-review", async (req, res, next) => {
    try {
        const checks = normaliseDocumentChecks(req.body?.checks);
        const promptTemplate =
            typeof req.body?.promptTemplate === "string" && req.body.promptTemplate.trim()
                ? req.body.promptTemplate
                : DEFAULT_DOCUMENT_PROMPT_TEMPLATE;

        const serialisedChecks = JSON.stringify(checks);
        const [result] = await pool.query(
            `INSERT INTO setting_document_review (checks_json, prompt_template)
             VALUES (?, ?)`,
            [serialisedChecks, promptTemplate]
        );

        res.json({ success: true, id: result?.insertId || null });
    } catch (error) {
        next(error);
    }
});

app.delete("/api/projects/:projectId/nodes", async (req, res, next) => {
    try {
        const { projectId } = req.params;
        await pool.query("DELETE FROM nodes WHERE project_id = ?", [projectId]);
        res.status(204).end();
    } catch (error) {
        next(error);
    }
});

const MISSING_TABLE_ERROR_CODE = "ER_NO_SUCH_TABLE";

app.use((err, req, res, _next) => {
    if (err?.code === MISSING_TABLE_ERROR_CODE) {
        console.error(
            "API error: database schema is missing required tables",
            err
        );
        res.status(500).json({
            message:
                "Database tables are missing. Run `npm run db:init` or ensure your MySQL schema is up to date.",
            details:
                "Check that MYSQL_DATABASE points to the schema where the `projects` and `nodes` tables are created."
        });
        return;
    }

    console.error("API error", err);
    res.status(500).json({ message: err.message || "Internal Server Error" });
});

const PORT = Number(process.env.PORT || process.env.API_PORT || 3001);
const HOST = process.env.HOST || "0.0.0.0";

try {
    console.log("Ensuring MySQL schema before starting server...");
    await ensureSchema({ logger: console });
    console.log("MySQL schema ensured successfully.");
} catch (error) {
    console.error("Failed to ensure MySQL schema", error);
    process.exit(1);
}

const server = app.listen(PORT, HOST, () => {
    console.log(`API server listening on http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
        console.error(
            `[server] Port ${PORT} is already in use. Set PORT or API_PORT to a free port before starting the server.`
        );
    } else {
        console.error("[server] Failed to start server", error);
    }
    process.exit(1);
});

let isShuttingDown = false;

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`Received ${signal}, shutting down server`);
    server.close(async (closeError) => {
        if (closeError) {
            console.error("Error while closing server", closeError);
        }
        await pool.end().catch((error) => {
            console.error("Error while closing MySQL pool", error);
        });
        process.exit(closeError ? 1 : 0);
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
