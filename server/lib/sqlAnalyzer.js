import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getDifyConfigSummary, requestDifyReport } from "./difyClient.js";

if (typeof globalThis !== "undefined" && typeof globalThis.logSqlPayloadStage !== "function") {
    globalThis.logSqlPayloadStage = () => {};
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = resolve(__dirname, "sql_rule_engine.py");

function logIssuesJson(label, jsonString) {
    if (typeof console === "undefined" || typeof console.log !== "function") {
        return;
    }
    if (!jsonString || typeof jsonString !== "string" || !jsonString.trim()) {
        return;
    }
    console.log(`[sql-report] ${label}: ${jsonString}`);
}

function pickFirstString(...candidates) {
    for (const value of candidates) {
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed) {
                return trimmed;
            }
        }
    }
    return "";
}

function normaliseTimestampValue(value) {
    if (value === null || value === undefined) {
        return "";
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? "" : value.toISOString();
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            return "";
        }
        const fromNumber = new Date(value);
        return Number.isNaN(fromNumber.getTime()) ? "" : fromNumber.toISOString();
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return "";
        }
        const numeric = Number(trimmed);
        if (!Number.isNaN(numeric)) {
            const fromNumeric = new Date(numeric);
            if (!Number.isNaN(fromNumeric.getTime())) {
                return fromNumeric.toISOString();
            }
        }
        const parsed = new Date(trimmed);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
        return trimmed;
    }
    return "";
}

function buildSummaryRecordForPersistence({
    source,
    label,
    summary,
    issues,
    fallbackStatus,
    fallbackGeneratedAt
}) {
    const issueCount = Array.isArray(issues) ? issues.length : 0;
    const record = {
        source,
        label,
        total_issues: issueCount
    };

    const status = pickFirstString(
        summary?.status,
        summary?.status_label,
        summary?.statusLabel,
        fallbackStatus
    );
    if (status) {
        record.status = status;
    }

    const generatedAtCandidate =
        summary?.generated_at ?? summary?.generatedAt ?? fallbackGeneratedAt;
    const generatedAt = normaliseTimestampValue(generatedAtCandidate);
    if (generatedAt) {
        record.generated_at = generatedAt;
    }

    const errorMessage = pickFirstString(summary?.error_message, summary?.errorMessage);
    if (errorMessage) {
        record.error_message = errorMessage;
    }

    const message = pickFirstString(summary?.message, summary?.note);
    if (message) {
        record.message = message;
    }

    return record;
}

function cloneSummaryRecordsForPersistence(records) {
    if (!Array.isArray(records)) {
        return [];
    }
    const result = [];
    for (const record of records) {
        if (!record || typeof record !== "object" || Array.isArray(record)) {
            continue;
        }
        const clone = {};
        for (const [key, value] of Object.entries(record)) {
            if (value === undefined || value === null) {
                continue;
            }
            if (typeof value === "object") {
                continue;
            }
            clone[key] = value;
        }
        if (Object.keys(clone).length) {
            result.push(clone);
        }
    }
    return result;
}

function serialiseCombinedReportJson(summaryRecords, issues) {
    const safeSummary = cloneSummaryRecordsForPersistence(summaryRecords);
    const safeIssues = cloneIssueListForPersistence(issues);
    const payload = { summary: safeSummary, issues: safeIssues };
    try {
        return JSON.stringify(payload, null, 2);
    } catch (error) {
        try {
            return JSON.stringify(payload);
        } catch (_nestedError) {
            return "{\"summary\":[],\"issues\":[]}";
        }
    }
}

function cloneValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => cloneValue(entry));
    }
    if (value && typeof value === "object") {
        const result = {};
        for (const [key, entry] of Object.entries(value)) {
            result[key] = cloneValue(entry);
        }
        return result;
    }
    return value;
}

function cloneIssueListForPersistence(issues) {
    if (!Array.isArray(issues)) {
        return [];
    }
    const result = [];
    for (const issue of issues) {
        if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
            continue;
        }
        result.push(cloneValue(issue));
    }
    return result;
}

function cloneSegmentListForPersistence(segments) {
    if (!Array.isArray(segments)) {
        return [];
    }
    const allowedKeys = [
        "index",
        "total",
        "text",
        "rawText",
        "line",
        "startLine",
        "endLine",
        "startColumn",
        "endColumn",
        "label",
        "kind",
        "issueContext"
    ];
    const result = [];
    for (const segment of segments) {
        if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
            continue;
        }
        const clone = {};
        for (const key of allowedKeys) {
            if (segment[key] !== undefined) {
                clone[key] = cloneValue(segment[key]);
            }
        }
        if (Object.keys(clone).length) {
            result.push(clone);
        }
    }
    return result;
}

function toTrimmedStringArray(value) {
    if (Array.isArray(value)) {
        return value
            .map((entry) => {
                if (entry === null || entry === undefined) {
                    return "";
                }
                return typeof entry === "string" ? entry.trim() : String(entry).trim();
            })
            .filter((entry) => entry.length);
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed ? [trimmed] : [];
    }
    if (value === null || value === undefined) {
        return [];
    }
    const stringValue = String(value).trim();
    return stringValue ? [stringValue] : [];
}

function gatherIssueMessages(issue) {
    const messages = [];
    if (!issue || typeof issue !== "object") {
        return messages;
    }
    if (Array.isArray(issue.issues)) {
        for (const entry of issue.issues) {
            if (typeof entry === "string") {
                const trimmed = entry.trim();
                if (trimmed) {
                    messages.push(trimmed);
                }
            }
        }
    }
    if (typeof issue.message === "string") {
        const trimmed = issue.message.trim();
        if (trimmed) {
            messages.unshift(trimmed);
        }
    }
    const unique = [];
    for (const message of messages) {
        if (!unique.includes(message)) {
            unique.push(message);
        }
    }
    return unique;
}

function gatherIssueEvidence(issue) {
    const evidence = [];
    if (!issue || typeof issue !== "object") {
        return evidence;
    }
    if (Array.isArray(issue.evidence_list)) {
        for (const entry of issue.evidence_list) {
            if (typeof entry === "string") {
                const trimmed = entry.trim();
                if (trimmed) {
                    evidence.push(trimmed);
                }
            }
        }
    }
    const candidates = [issue.evidence, issue.snippet];
    for (const candidate of candidates) {
        if (typeof candidate === "string") {
            const trimmed = candidate.trim();
            if (trimmed) {
                evidence.push(trimmed);
            }
        }
    }
    const unique = [];
    for (const entry of evidence) {
        if (!unique.includes(entry)) {
            unique.push(entry);
        }
    }
    return unique;
}

function gatherIssueRuleIds(issue) {
    const ruleIds = [];
    if (!issue || typeof issue !== "object") {
        return ruleIds;
    }
    const collections = [issue.rule_ids, issue.ruleIds];
    for (const collection of collections) {
        if (Array.isArray(collection)) {
            for (const entry of collection) {
                if (typeof entry === "string") {
                    const trimmed = entry.trim();
                    if (trimmed && !ruleIds.includes(trimmed)) {
                        ruleIds.push(trimmed);
                    }
                }
            }
        }
    }
    const singleCandidates = [issue.rule_id, issue.ruleId, issue.rule];
    for (const candidate of singleCandidates) {
        if (candidate === null || candidate === undefined) {
            continue;
        }
        const stringValue = typeof candidate === "string" ? candidate : String(candidate);
        const trimmed = stringValue.trim();
        if (trimmed && !ruleIds.includes(trimmed)) {
            ruleIds.push(trimmed);
        }
    }
    return ruleIds;
}

function gatherIssueSeverities(issue) {
    const severities = [];
    if (!issue || typeof issue !== "object") {
        return severities;
    }
    const collections = [issue.severity_levels];
    for (const collection of collections) {
        if (Array.isArray(collection)) {
            for (const entry of collection) {
                if (typeof entry === "string") {
                    const trimmed = entry.trim();
                    if (trimmed) {
                        severities.push(trimmed);
                    }
                }
            }
        }
    }
    const singleCandidates = [issue.severity, issue.level];
    for (const candidate of singleCandidates) {
        if (candidate === null || candidate === undefined) {
            continue;
        }
        const stringValue = typeof candidate === "string" ? candidate : String(candidate);
        const trimmed = stringValue.trim();
        if (trimmed) {
            severities.push(trimmed);
        }
    }
    const unique = [];
    for (const entry of severities) {
        if (!unique.includes(entry)) {
            unique.push(entry);
        }
    }
    return unique;
}

function normaliseIssueColumn(value) {
    if (Array.isArray(value)) {
        for (const entry of value) {
            const normalised = normaliseIssueColumn(entry);
            if (normalised !== null) {
                return normalised;
            }
        }
        return null;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return null;
    }
    return Math.floor(numeric);
}

function buildStaticIssuePromptData(issue, issueIndex, totalIssues) {
    if (!issue || typeof issue !== "object") {
        return null;
    }

    const messages = gatherIssueMessages(issue);
    const evidenceList = gatherIssueEvidence(issue);
    const ruleIds = gatherIssueRuleIds(issue);
    const severityLevels = gatherIssueSeverities(issue);
    const severity = severityLevels.length ? severityLevels[0] : "";
    const objectName = typeof issue.object === "string" ? issue.object.trim() : "";
    const lineNumber = normalisePositiveInteger(issue.line);
    const columnValue = normaliseIssueColumn(issue.column);

    let serialisedIssue = "";
    try {
        serialisedIssue = JSON.stringify(issue, null, 2);
    } catch (_error) {
        try {
            serialisedIssue = JSON.stringify(cloneValue(issue), null, 2);
        } catch (_nestedError) {
            serialisedIssue = "";
        }
    }

    const message = messages.length ? messages[0] : "";
    const snippet = evidenceList.length
        ? evidenceList[0]
        : typeof issue.snippet === "string" && issue.snippet.trim()
        ? issue.snippet.trim()
        : typeof issue.evidence === "string" && issue.evidence.trim()
        ? issue.evidence.trim()
        : message || "";

    const labelCandidate = message || ruleIds[0] || objectName || `Issue ${issueIndex + 1}`;
    const label = labelCandidate.length > 80 ? `${labelCandidate.slice(0, 77)}…` : labelCandidate;

    const segmentText = snippet || message || serialisedIssue || `Issue ${issueIndex + 1}`;

    const recommendationList = toTrimmedStringArray(issue.recommendation);
    const existingRecommendation = recommendationList.length ? recommendationList[0] : "";

    const issueContext = {
        index: issueIndex + 1,
        totalIssues,
        message: message || undefined,
        ruleIds,
        severity: severity || undefined,
        severityLevels,
        object: objectName || undefined,
        line: lineNumber || undefined,
        column: columnValue || undefined,
        evidence: snippet || undefined,
        serialisedIssue: serialisedIssue || undefined,
        recommendation: existingRecommendation || undefined
    };

    return {
        segment: {
            index: issueIndex + 1,
            total: totalIssues,
            kind: "static_issue",
            text: segmentText,
            rawText: segmentText,
            line: lineNumber || undefined,
            startLine: lineNumber || undefined,
            endLine: lineNumber || undefined,
            startColumn: columnValue || undefined,
            endColumn: columnValue || undefined,
            label,
            issueContext
        },
        serialisedIssue: serialisedIssue || segmentText
    };
}

function applyIssueEnrichment(issue, enrichment) {
    if (!issue || typeof issue !== "object") {
        return;
    }
    if (!enrichment || typeof enrichment !== "object") {
        return;
    }

    const recommendationValues = [
        ...toTrimmedStringArray(enrichment.recommendation),
        ...toTrimmedStringArray(enrichment.recommendations)
    ];
    const uniqueRecommendations = [];
    for (const entry of recommendationValues) {
        if (entry && !uniqueRecommendations.includes(entry)) {
            uniqueRecommendations.push(entry);
        }
    }
    if (uniqueRecommendations.length) {
        issue.recommendation = uniqueRecommendations;
        issue.recommendations = uniqueRecommendations;
    }

    const fixedCodeCandidate =
        typeof enrichment.fixed_code === "string"
            ? enrichment.fixed_code
            : typeof enrichment.fixedCode === "string"
            ? enrichment.fixedCode
            : null;
    if (typeof fixedCodeCandidate === "string") {
        issue.fixed_code = fixedCodeCandidate;
    }
}

async function enrichStaticIssuesWithDify(issues, options = {}) {
    const issueList = Array.isArray(issues) ? issues : [];
    const totalIssues = issueList.length;
    if (!totalIssues) {
        return { issues: [], segments: [], chunks: [], errors: [] };
    }

    const {
        projectId = "",
        projectName = "",
        path = "",
        userId = "",
        files = undefined
    } = options;

    const resolvedProjectName = projectName || projectId || "sql-report";
    const resolvedUserId = typeof userId === "string" && userId.trim() ? userId.trim() : undefined;

    const enrichedIssues = [];
    const segmentSnapshots = [];
    const chunkSnapshots = [];
    const errors = [];
    let conversationId = "";

    for (let index = 0; index < totalIssues; index += 1) {
        const originalIssue = issueList[index];
        const issueClone = cloneValue(originalIssue);
        const promptData = buildStaticIssuePromptData(issueClone, index, totalIssues);
        if (!promptData) {
            enrichedIssues.push(issueClone);
            continue;
        }

        const segment = promptData.segment;
        const segmentClone = cloneValue(segment);
        segmentSnapshots.push(segmentClone);

        const filePath = path
            ? `${path}.static_issue_${index + 1}.json`
            : `analysis.static_issue_${index + 1}.json`;

        try {
            const difyResponse = await requestDifyReport({
                projectName: resolvedProjectName,
                filePath,
                content: promptData.serialisedIssue,
                userId: resolvedUserId,
                segments: [segment],
                files,
                conversationId
            });

            if (typeof difyResponse?.conversationId === "string" && difyResponse.conversationId.trim()) {
                conversationId = difyResponse.conversationId.trim();
            }

            const firstChunk = Array.isArray(difyResponse?.chunks) ? difyResponse.chunks[0] : null;
            let parsed = firstChunk && typeof firstChunk.parsed === "object" ? firstChunk.parsed : null;
            if (!parsed) {
                const jsonText = typeof firstChunk?.json === "string" && firstChunk.json.trim()
                    ? firstChunk.json
                    : "";
                if (jsonText) {
                    try {
                        parsed = JSON.parse(jsonText);
                    } catch (_error) {
                        parsed = null;
                    }
                }
            }
            if (!parsed) {
                const fallback = extractJsonFromText(difyResponse?.report || "");
                if (fallback) {
                    try {
                        parsed = JSON.parse(fallback);
                    } catch (_error) {
                        parsed = null;
                    }
                }
            }

            if (parsed && typeof parsed === "object") {
                applyIssueEnrichment(issueClone, parsed);
            }

            chunkSnapshots.push({
                index: index + 1,
                total: totalIssues,
                answer: firstChunk?.answer || difyResponse?.report || "",
                json: firstChunk?.json || undefined,
                parsed: firstChunk?.parsed || parsed || undefined,
                raw: firstChunk?.raw || undefined,
                conversationId: difyResponse?.conversationId || undefined
            });
        } catch (error) {
            const message = error?.message || String(error);
            console.warn(
                `[sql+dify] Failed to enrich static issue ${index + 1}/${totalIssues} project=${projectName || projectId} path=${path} :: ${message}`,
                error
            );
            errors.push({ index: index + 1, message });
            chunkSnapshots.push({
                index: index + 1,
                total: totalIssues,
                error: message
            });
        }

        enrichedIssues.push(issueClone);
    }

    return {
        issues: enrichedIssues,
        segments: segmentSnapshots,
        chunks: chunkSnapshots,
        errors,
        conversationId
    };
}

function serialiseIssuesJson(issues, options = {}) {
    const safeIssues = cloneIssueListForPersistence(issues);
    const payload = { issues: safeIssues };

    const segments = Array.isArray(options?.segments)
        ? cloneSegmentListForPersistence(options.segments)
        : [];
    if (segments.length) {
        payload.segments = segments;
    }

    const chunks = Array.isArray(options?.chunks) ? cloneValue(options.chunks) : [];
    if (chunks.length) {
        payload.chunks = chunks;
    }

    const errors = Array.isArray(options?.errors) ? cloneValue(options.errors) : [];
    if (errors.length) {
        payload.errors = errors;
    }

    const conversationId =
        typeof options?.conversationId === "string" && options.conversationId.trim()
            ? options.conversationId.trim()
            : "";
    if (conversationId) {
        payload.conversationId = conversationId;
    }

    const metadata = options?.metadata && typeof options.metadata === "object" && !Array.isArray(options.metadata)
        ? cloneValue(options.metadata)
        : null;
    if (metadata && Object.keys(metadata).length) {
        payload.metadata = metadata;
    }

    try {
        return JSON.stringify(payload, null, 2);
    } catch (error) {
        try {
            return JSON.stringify(payload);
        } catch (_nestedError) {
            return "{\"issues\":[]}";
        }
    }
}

function buildIssuesOnlyEnrichment(report, fallbackIssues = [], options = {}) {
    const segments = Array.isArray(options?.segments)
        ? cloneSegmentListForPersistence(options.segments)
        : [];
    const chunks = Array.isArray(options?.chunks) ? cloneValue(options.chunks) : [];
    const errors = Array.isArray(options?.errors) ? cloneValue(options.errors) : [];
    const conversationId =
        typeof options?.conversationId === "string" && options.conversationId.trim()
            ? options.conversationId.trim()
            : "";

    const payload = {};

    if (report && typeof report === "object" && !Array.isArray(report)) {
        const issues = Array.isArray(report.issues)
            ? cloneIssueListForPersistence(report.issues)
            : [];
        if (issues.length) {
            payload.issues = issues;
        }
    }

    if (!payload.issues && Array.isArray(fallbackIssues) && fallbackIssues.length) {
        payload.issues = cloneIssueListForPersistence(fallbackIssues);
    }

    if (segments.length) {
        payload.segments = segments;
    }
    if (chunks.length) {
        payload.chunks = chunks;
    }
    if (errors.length) {
        payload.errors = errors;
    }
    if (conversationId) {
        payload.conversationId = conversationId;
    }

    return Object.keys(payload).length ? payload : null;
}

function normaliseFallbackSource(issue) {
    if (!issue || typeof issue !== "object") {
        return "";
    }
    const value = issue.fallbackSource || issue.fallback_source || issue.fallback;
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hasAuthoritativeAiMarker(issue) {
    if (!issue || typeof issue !== "object") {
        return false;
    }
    const directRule = typeof issue.rule_id === "string" ? issue.rule_id.trim() : "";
    if (directRule) {
        return true;
    }
    if (Array.isArray(issue.rule_ids) && issue.rule_ids.some((entry) => typeof entry === "string" && entry.trim())) {
        return true;
    }
    if (Array.isArray(issue.severity_levels) && issue.severity_levels.some((entry) => typeof entry === "string" && entry.trim())) {
        return true;
    }
    const severity = typeof issue.severity === "string" ? issue.severity.trim() : "";
    if (severity) {
        return true;
    }
    if (Array.isArray(issue.details)) {
        for (const detail of issue.details) {
            if (hasAuthoritativeAiMarker(detail)) {
                return true;
            }
        }
    }
    return false;
}

function filterAiIssuesForPersistence(issues) {
    const list = Array.isArray(issues) ? issues : [];
    const authoritative = [];
    const fallback = [];

    for (const issue of list) {
        if (!issue || typeof issue !== "object") {
            continue;
        }
        const fallbackSource = normaliseFallbackSource(issue);
        if (fallbackSource === "markdown") {
            fallback.push(issue);
            continue;
        }
        if (hasAuthoritativeAiMarker(issue)) {
            authoritative.push(issue);
        } else {
            fallback.push(issue);
        }
    }

    if (authoritative.length) {
        return cloneIssueListForPersistence(authoritative);
    }

    const filteredFallback = fallback.length
        ? list.filter((issue) => normaliseFallbackSource(issue) !== "markdown")
        : list;

    return cloneIssueListForPersistence(filteredFallback);
}

function normaliseIdentitySegment(value) {
    if (value === null || value === undefined) {
        return "";
    }
    if (Array.isArray(value)) {
        return value
            .map((entry) => normaliseIdentitySegment(entry))
            .filter((segment) => Boolean(segment))
            .join("|");
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? "" : value.toISOString();
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed;
    }
    return "";
}

function normaliseReportSourceKey(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function createIssueIdentity(issue) {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
        return "";
    }
    const ruleId = issue.rule_id ?? issue.ruleId ?? "";
    const message = issue.message ?? "";
    const fallbackMessage =
        !message && Array.isArray(issue.issues) && issue.issues.length ? issue.issues : [];
    const snippet = issue.snippet ?? issue.statement ?? issue.evidence ?? "";
    const objectName = issue.object ?? "";
    const lineValue = Array.isArray(issue.line)
        ? issue.line
        : issue.line ?? issue.lineNumber ?? issue.line_no ?? "";
    const columnValue = Array.isArray(issue.column)
        ? issue.column
        : issue.column ?? issue.columnNumber ?? issue.column_no ?? "";
    const sourceCandidate =
        issue.source ?? issue.analysis_source ?? issue.analysisSource ?? issue.from ?? issue.origin ?? "";
    const sourceKey = normaliseReportSourceKey(sourceCandidate);
    const segments = [
        ruleId,
        message,
        fallbackMessage,
        snippet,
        objectName,
        lineValue,
        columnValue,
        sourceKey
    ]
        .map((segment) => normaliseIdentitySegment(segment))
        .filter((segment) => Boolean(segment));

    if (segments.length) {
        return segments.join("::");
    }

    try {
        return JSON.stringify(issue);
    } catch (error) {
        return "";
    }
}

function dedupeIssueList(issues) {
    if (!Array.isArray(issues)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const issue of issues) {
        if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
            continue;
        }
        const key = createIssueIdentity(issue);
        if (key && seen.has(key)) {
            continue;
        }
        if (key) {
            seen.add(key);
        }
        result.push(cloneValue(issue));
    }
    return result;
}

function serialiseChunkText(value, fallback = "") {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
            return value;
        }
        return fallback || value;
    }
    if (value === null || value === undefined) {
        return fallback || "";
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch (error) {
        return String(value);
    }
}

function normaliseChunksForPersistence(chunks, { fallbackRaw = "", defaultSource = "" } = {}) {
    const list = Array.isArray(chunks) ? chunks : [];
    if (!list.length) {
        return [];
    }
    const total = list.length;
    return list.map((entry, offset) => {
        const index = offset + 1;
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const clone = { ...entry };
            const answerCandidate =
                typeof clone.answer === "string" && clone.answer.trim()
                    ? clone.answer
                    : typeof clone.rawAnalysis === "string" && clone.rawAnalysis.trim()
                    ? clone.rawAnalysis
                    : typeof clone.raw === "string" && clone.raw.trim()
                    ? clone.raw
                    : typeof clone.text === "string"
                    ? clone.text
                    : null;
            const answer = serialiseChunkText(answerCandidate, fallbackRaw);
            const numericIndex = Number(clone.index);
            const numericTotal = Number(clone.total);
            clone.index = Number.isFinite(numericIndex) && numericIndex > 0 ? numericIndex : index;
            clone.total = Number.isFinite(numericTotal) && numericTotal > 0 ? numericTotal : total;
            clone.answer = answer;
            if (typeof clone.raw !== "string" || !clone.raw.trim()) {
                clone.raw = answer;
            }
            if (typeof clone.rawAnalysis !== "string" || !clone.rawAnalysis.trim()) {
                clone.rawAnalysis = clone.raw;
            }
            if (defaultSource && !clone.source) {
                clone.source = defaultSource;
            }
            return clone;
        }
        const answer = serialiseChunkText(entry, fallbackRaw);
        const base = {
            index,
            total,
            answer,
            raw: answer
        };
        if (defaultSource) {
            base.source = defaultSource;
        }
        return base;
    });
}

function extractIssuesFromChunk(chunk) {
    if (!chunk || typeof chunk !== "object") {
        return [];
    }
    if (Array.isArray(chunk.issues) && chunk.issues.length) {
        return chunk.issues;
    }
    const parsed = chunk.parsed;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.issues) && parsed.issues.length) {
        return parsed.issues;
    }
    return [];
}

function determineChunkCount(segments, aggregatedChunks, rawChunks) {
    const segmentCount = Array.isArray(segments) ? segments.length : 0;
    const scanMaxIndex = (list) => {
        if (!Array.isArray(list)) {
            return 0;
        }
        let max = 0;
        list.forEach((chunk, offset) => {
            const indexCandidate = Number(chunk?.index);
            const index = Number.isFinite(indexCandidate) && indexCandidate > 0 ? Math.floor(indexCandidate) : offset + 1;
            if (index > max) {
                max = index;
            }
        });
        return max;
    };
    const aggregatedCount = scanMaxIndex(aggregatedChunks);
    const rawCount = scanMaxIndex(rawChunks);
    return Math.max(segmentCount, aggregatedCount, rawCount);
}

function buildDmlIssueChunks(segments, dmlPrompt) {
    const aggregatedChunks = Array.isArray(dmlPrompt?.aggregated?.chunks) ? dmlPrompt.aggregated.chunks : [];
    const rawChunks = Array.isArray(dmlPrompt?.chunks) ? dmlPrompt.chunks : [];
    const chunkCount = determineChunkCount(segments, aggregatedChunks, rawChunks);
    if (!chunkCount) {
        return [];
    }

    const toIndexMap = (list) => {
        const map = new Map();
        if (!Array.isArray(list)) {
            return map;
        }
        list.forEach((chunk, offset) => {
            if (!chunk || typeof chunk !== "object") {
                return;
            }
            const indexCandidate = Number(chunk.index);
            const index = Number.isFinite(indexCandidate) && indexCandidate > 0 ? Math.floor(indexCandidate) : offset + 1;
            if (!map.has(index)) {
                map.set(index, chunk);
            }
        });
        return map;
    };

    const aggregatedMap = toIndexMap(aggregatedChunks);
    const rawMap = toIndexMap(rawChunks);

    const chunks = [];
    for (let index = 1; index <= chunkCount; index += 1) {
        const aggregatedChunk = aggregatedMap.get(index);
        const rawChunk = rawMap.get(index);
        const aggregatedIssues = extractIssuesFromChunk(aggregatedChunk);
        const rawIssues = extractIssuesFromChunk(rawChunk);
        const issues = aggregatedIssues.length ? aggregatedIssues : rawIssues;

        const aggregatedTotal = Number(aggregatedChunk?.total);
        const rawTotal = Number(rawChunk?.total);
        const total = Number.isFinite(aggregatedTotal) && aggregatedTotal > 0
            ? Math.floor(aggregatedTotal)
            : Number.isFinite(rawTotal) && rawTotal > 0
            ? Math.floor(rawTotal)
            : chunkCount;

        chunks.push({
            index,
            total,
            issues: cloneIssueListForPersistence(issues)
        });
    }

    return chunks;
}

function replaceRangeWithSpaces(text, start, end) {
    if (!text || start >= end) return text;
    const replacement = text
        .slice(start, end)
        .split("")
        .map((ch) => (ch === "\n" ? "\n" : " "))
        .join("");
    return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

function maskBlockComments(sqlText) {
    if (!sqlText) return "";
    const blockRegex = /\/\*[\s\S]*?\*\//g;
    let masked = sqlText;
    let match;
    while ((match = blockRegex.exec(sqlText)) !== null) {
        masked = replaceRangeWithSpaces(masked, match.index, match.index + match[0].length);
    }
    return masked;
}

function maskCommentsAndStrings(sqlText) {
    if (!sqlText) return "";
    let masked = maskBlockComments(sqlText);
    const lineRegex = /--.*?$/gm;
    let match;
    while ((match = lineRegex.exec(masked)) !== null) {
        masked = replaceRangeWithSpaces(masked, match.index, match.index + match[0].length);
    }

    const stringPatterns = [
        /'(?:''|[^'])*'/gs,
        /"(?:""|[^"])*"/gs
    ];
    for (const pattern of stringPatterns) {
        while ((match = pattern.exec(masked)) !== null) {
            masked = replaceRangeWithSpaces(masked, match.index, match.index + match[0].length);
        }
    }

    return masked;
}

function stripSqlComments(sqlText) {
    if (typeof sqlText !== "string" || !sqlText.length) {
        return "";
    }

    let result = "";
    let index = 0;
    const length = sqlText.length;
    let inSingleQuote = false;
    let inDoubleQuote = false;

    while (index < length) {
        const char = sqlText[index];
        const next = index + 1 < length ? sqlText[index + 1] : "";

        if (!inSingleQuote && !inDoubleQuote) {
            if (char === "-" && next === "-") {
                index += 2;
                while (index < length) {
                    const lineChar = sqlText[index];
                    if (lineChar === "\r" && sqlText[index + 1] === "\n") {
                        result += "\r\n";
                        index += 2;
                        break;
                    }
                    if (lineChar === "\n" || lineChar === "\r") {
                        result += lineChar;
                        index += 1;
                        break;
                    }
                    index += 1;
                }
                continue;
            }

            if (char === "/" && next === "*") {
                index += 2;
                while (index < length) {
                    const blockChar = sqlText[index];
                    const blockNext = sqlText[index + 1];
                    if (blockChar === "*" && blockNext === "/") {
                        index += 2;
                        break;
                    }
                    if (blockChar === "\r" && blockNext === "\n") {
                        result += "\r\n";
                        index += 2;
                        continue;
                    }
                    if (blockChar === "\n" || blockChar === "\r") {
                        result += blockChar;
                        index += 1;
                        continue;
                    }
                    index += 1;
                }
                continue;
            }
        }

        result += char;

        if (char === "'" && !inDoubleQuote) {
            if (inSingleQuote) {
                if (next === "'") {
                    result += "'";
                    index += 2;
                    continue;
                }
                inSingleQuote = false;
            } else {
                inSingleQuote = true;
            }
        } else if (char === '"' && !inSingleQuote) {
            if (inDoubleQuote) {
                if (next === '"') {
                    result += '"';
                    index += 2;
                    continue;
                }
                inDoubleQuote = false;
            } else {
                inDoubleQuote = true;
            }
        }

        index += 1;
    }

    return result;
}

function findStatementTerminator(maskedSql, startIndex) {
    if (!maskedSql || startIndex >= maskedSql.length) {
        return maskedSql ? maskedSql.length : 0;
    }
    for (let index = startIndex; index < maskedSql.length; index += 1) {
        if (maskedSql[index] === ";") {
            return index + 1;
        }
    }
    return maskedSql.length;
}

function indexToLineCol(text, index) {
    const prior = text.slice(0, index);
    const line = prior.split("\n").length;
    const lastNewline = prior.lastIndexOf("\n");
    const column = index - (lastNewline === -1 ? 0 : lastNewline + 1) + 1;
    return { line, column };
}

function normalisePositiveInteger(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return null;
    }
    return Math.floor(numeric);
}

const STATEMENT_KEYWORDS = [
    "SELECT",
    "WITH",
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "UPSERT",
    "REPLACE",
    "ALTER",
    "CREATE",
    "DROP",
    "TRUNCATE",
    "RENAME",
    "CALL",
    "EXEC",
    "EXECUTE",
    "REORG",
    "GRANT",
    "REVOKE",
    "COMMENT",
    "ANALYZE",
    "ANALYSE",
    "DESCRIBE",
    "EXPLAIN"
];

const STATEMENT_KEYWORD_PATTERN = new RegExp(`^(${STATEMENT_KEYWORDS.join("|")})\\b`, "i");

function extractDmlStatements(sqlText) {
    if (typeof sqlText !== "string" || !sqlText.trim()) {
        return [];
    }

    const masked = maskCommentsAndStrings(sqlText);
    const segments = [];

    let offset = 0;
    while (offset < masked.length) {
        let start = offset;
        while (start < masked.length && /\s/.test(masked[start])) {
            start += 1;
        }

        if (start >= masked.length) {
            break;
        }

        const end = findStatementTerminator(masked, start);
        if (end <= start) {
            offset = start + 1;
            continue;
        }

        const snippet = sqlText.slice(start, end);
        const cleanedSnippet = stripSqlComments(snippet).trim();
        if (cleanedSnippet) {
            const keywordMatch = cleanedSnippet.match(STATEMENT_KEYWORD_PATTERN);
            if (keywordMatch) {
                const startMeta = indexToLineCol(sqlText, start);
                const endMeta = indexToLineCol(sqlText, end);
                const startColumn = normalisePositiveInteger(startMeta.column) || 1;
                const endColumn = normalisePositiveInteger(endMeta.column) || startColumn;
                const startLine = normalisePositiveInteger(startMeta.line) || 1;
                const endLine = normalisePositiveInteger(endMeta.line) || startLine;
                segments.push({
                    index: segments.length + 1,
                    text: cleanedSnippet,
                    rawText: snippet.trim(),
                    start,
                    end,
                    line: startLine,
                    startLine,
                    startColumn,
                    endLine,
                    endColumn
                });
            }
        }

        offset = end;
    }

    return segments;
}

function parseCommand(command) {
    if (!command || typeof command !== "string") {
        return null;
    }
    const parts = command.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
        return null;
    }
    return { command: parts[0], args: parts.slice(1) };
}

function gatherPythonCandidates() {
    const envCandidates = [
        process.env.SQL_ANALYZER_PYTHON,
        process.env.PYTHON,
        process.env.PYTHON_PATH,
        process.env.PYTHON3_PATH
    ]
        .map(parseCommand)
        .filter(Boolean);

    const defaultCandidates = ["python3", "python", "py -3", "py"]
        .map(parseCommand)
        .filter(Boolean);

    const seen = new Set();
    const deduped = [];
    for (const candidate of [...envCandidates, ...defaultCandidates]) {
        const key = `${candidate.command} ${candidate.args.join(" ")}`.trim();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(candidate);
    }
    return deduped;
}

function isMissingInterpreterError(error, stderr) {
    if (!error) return false;
    if (error.code === "ENOENT") {
        return true;
    }
    const message = [error.message, stderr].filter(Boolean).join("\n");
    return /python was not found/i.test(message);
}

function runPythonCandidate(candidate, sqlText) {
    return new Promise((resolve, reject) => {
        const args = [...candidate.args, "-u", SCRIPT_PATH];
        const child = spawn(candidate.command, args, { stdio: ["pipe", "pipe", "pipe"] });

        let stdout = "";
        let stderr = "";
        let stdinError = null;

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });

        child.stdin.on("error", (error) => {
            stdinError = error;
        });

        child.on("error", (error) => {
            const err = error;
            err.stderr = stderr;
            reject(err);
        });

        child.on("close", (code) => {
            if (code !== 0) {
                const error = new Error(`Python analyzer exited with code ${code}`);
                error.stderr = stderr;
                if (stdinError) {
                    error.stdinError = stdinError;
                }
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });

        try {
            child.stdin.end(sqlText ?? "");
        } catch (error) {
            reject(error);
        }
    });
}

let cachedInterpreter = null;

async function executeSqlAnalysis(sqlText) {
    const candidates = cachedInterpreter ? [cachedInterpreter] : gatherPythonCandidates();
    let lastError = null;

    for (const candidate of candidates) {
        try {
            const { stdout } = await runPythonCandidate(candidate, sqlText);
            const trimmed = stdout.trim();
            if (!trimmed) {
                const emptyError = new Error("SQL 分析器未返回任何輸出");
                emptyError.stderr = stdout;
                throw emptyError;
            }
            let parsed;
            try {
                parsed = JSON.parse(trimmed);
            } catch (parseError) {
                const errorMessage = `無法解析 SQL 分析器輸出：${trimmed}`;
                const error = new Error(errorMessage);
                error.stderr = trimmed;
                if (/python was not found/i.test(trimmed)) {
                    error.missingInterpreter = true;
                }
                throw error;
            }
            if (parsed.error) {
                const engineError = new Error(parsed.error);
                engineError.stderr = parsed.error;
                throw engineError;
            }
            if (typeof parsed.result !== "string") {
                const invalidError = new Error("SQL 分析器輸出缺少 result 欄位");
                invalidError.stderr = JSON.stringify(parsed);
                throw invalidError;
            }
            cachedInterpreter = candidate;
            return parsed;
        } catch (error) {
            const stderr = error?.stderr || "";
            if (error?.missingInterpreter || isMissingInterpreterError(error, stderr)) {
                lastError = error;
                cachedInterpreter = null;
                continue;
            }
            throw error;
        }
    }

    const hint =
        "無法找到可用的 Python 執行檔。請在環境變數 SQL_ANALYZER_PYTHON 或 PYTHON_PATH 中指定完整的 python.exe 路徑，或確保 'python' 指令可用。";
    const error = new Error(lastError?.message ? `${lastError.message}\n${hint}` : hint);
    error.stderr = lastError?.stderr;
    throw error;
}

function extractJsonFromText(value) {
    if (value == null) {
        return "";
    }
    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch (_error) {
            return "";
        }
    }
    if (typeof value !== "string") {
        return "";
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }

    const candidates = [];

    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch && fenceMatch[1]) {
        candidates.push(fenceMatch[1].trim());
    }

    const braceStart = trimmed.indexOf("{");
    const braceEnd = trimmed.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
        candidates.push(trimmed.slice(braceStart, braceEnd + 1));
    }

    candidates.push(trimmed);

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            return JSON.stringify(parsed);
        } catch (_error) {
            continue;
        }
    }

    return "";
}

function normaliseDifyOutput(dify, rawReport) {
    if (!dify || typeof dify !== "object") {
        return dify ?? null;
    }

    const resolvedReport = extractJsonFromText(dify.report ?? dify.answer ?? "");
    const normalisedReport = resolvedReport || rawReport || "";

    const normalisedChunks = Array.isArray(dify.chunks)
        ? dify.chunks.map((chunk) => ({
              ...chunk,
              answer: extractJsonFromText(chunk?.answer) || chunk?.answer || "",
              raw: chunk?.raw
          }))
        : dify.chunks;

    return {
        ...dify,
        report: normalisedReport,
        chunks: normalisedChunks,
        originalReport: typeof dify.report === "string" ? dify.report : rawReport || "",
        originalChunks: Array.isArray(dify.chunks) ? dify.chunks : undefined
    };
}

function parseStaticReport(rawReport) {
    if (typeof rawReport !== "string") {
        return null;
    }
    let candidate = rawReport.trim();
    if (!candidate) {
        return null;
    }
    for (let depth = 0; depth < 3; depth += 1) {
        try {
            const parsed = JSON.parse(candidate);
            if (typeof parsed === "string") {
                const trimmed = parsed.trim();
                if (trimmed && trimmed !== candidate) {
                    candidate = trimmed;
                    continue;
                }
                break;
            }
            if (parsed && typeof parsed === "object") {
                return parsed;
            }
            break;
        } catch (error) {
            break;
        }
    }
    return null;
}

function buildStaticReportSnapshot(rawReport, { fallbackReport = null, fallbackExtension = ".sql" } = {}) {
    const parsedStaticReport = parseStaticReport(rawReport);
    const staticReportObject =
        parsedStaticReport && typeof parsedStaticReport === "object" && !Array.isArray(parsedStaticReport)
            ? parsedStaticReport
            : null;
    const fallbackReportObject =
        fallbackReport && typeof fallbackReport === "object" && !Array.isArray(fallbackReport)
            ? fallbackReport
            : null;

    const staticBase = staticReportObject ? cloneValue(staticReportObject) : {};
    const fallbackBase = fallbackReportObject ? cloneValue(fallbackReportObject) : null;

    const finalStaticReport = { ...staticBase };
    if (fallbackBase) {
        if (Array.isArray(fallbackBase.issues)) {
            finalStaticReport.issues = fallbackBase.issues;
        }
        if (
            (!finalStaticReport.summary || typeof finalStaticReport.summary !== "object") &&
            fallbackBase.summary &&
            typeof fallbackBase.summary === "object"
        ) {
            finalStaticReport.summary = fallbackBase.summary;
        }
        if (
            (!finalStaticReport.metadata || typeof finalStaticReport.metadata !== "object") &&
            fallbackBase.metadata &&
            typeof fallbackBase.metadata === "object"
        ) {
            finalStaticReport.metadata = fallbackBase.metadata;
        }
    }

    const staticSummary = normaliseStaticSummary(finalStaticReport.summary, fallbackExtension);

    const staticIssuesRaw = Array.isArray(finalStaticReport.issues)
        ? finalStaticReport.issues
        : Array.isArray(staticReportObject?.issues)
        ? staticReportObject.issues
        : [];
    const staticIssues = cloneIssueListForPersistence(staticIssuesRaw);

    const staticMetadata = normaliseStaticMetadata(
        (finalStaticReport.metadata && typeof finalStaticReport.metadata === "object"
            ? finalStaticReport.metadata
            : staticReportObject?.metadata && typeof staticReportObject.metadata === "object"
            ? staticReportObject.metadata
            : {})
    );

    const payload = {
        ...cloneValue(finalStaticReport),
        summary: staticSummary,
        issues: staticIssues,
        metadata: staticMetadata
    };

    if (staticReportObject) {
        payload.original = cloneValue(staticReportObject);
    }

    let serialised = typeof rawReport === "string" ? rawReport : "";
    try {
        serialised = JSON.stringify(payload, null, 2);
    } catch (error) {
        try {
            serialised = JSON.stringify(payload);
        } catch (_nestedError) {
            serialised = typeof rawReport === "string" ? rawReport : "";
        }
    }

    return {
        payload,
        summary: staticSummary,
        issues: staticIssues,
        metadata: staticMetadata,
        parsed: staticReportObject,
        final: finalStaticReport,
        serialised
    };
}

function normaliseStaticMetadata(metadata) {
    const base = metadata && typeof metadata === "object" ? { ...metadata } : {};
    if (!base.analysis_source) {
        base.analysis_source = "static_analyzer";
    }
    if (!base.engine) {
        base.engine = "sql_rule_engine";
    }
    return base;
}

function normaliseStaticSummary(summary, fallbackExtension = ".sql") {
    const source = summary && typeof summary === "object" ? summary : {};
    const normalised = { ...source };
    const byRule = normalised.by_rule || normalised.byRule;
    if (byRule && typeof byRule === "object" && !Array.isArray(byRule)) {
        normalised.by_rule = { ...byRule };
    } else if (!normalised.by_rule) {
        normalised.by_rule = {};
    }
    if (typeof normalised.file_extension !== "string" && typeof normalised.fileExtension === "string") {
        normalised.file_extension = normalised.fileExtension;
    }
    if (typeof normalised.file_extension !== "string" && fallbackExtension) {
        normalised.file_extension = fallbackExtension;
    }
    const totalCandidate = normalised.total_issues ?? normalised.totalIssues;
    const numericTotal = Number(totalCandidate);
    if (Number.isFinite(numericTotal)) {
        normalised.total_issues = numericTotal;
    }
    if (!normalised.analysis_source) {
        normalised.analysis_source = "static_analyzer";
    }
    return normalised;
}

function normaliseDmlSummary(segments, dmlPrompt, dmlError) {
    const totalSegments = Array.isArray(segments) ? segments.length : 0;
    const chunkCount = Array.isArray(dmlPrompt?.chunks) ? dmlPrompt.chunks.length : 0;
    const hasReport = typeof dmlPrompt?.report === "string" && dmlPrompt.report.trim().length > 0;
    const summary = {
        analysis_source: "dml_prompt",
        total_segments: totalSegments,
        analyzed_segments: chunkCount || (hasReport ? totalSegments : 0),
        generated_at: dmlPrompt?.generatedAt || null
    };

    let status = "idle";
    if (totalSegments === 0) {
        status = "idle";
    } else if (dmlPrompt) {
        status = "succeeded";
    } else if (dmlError) {
        status = "failed";
    } else {
        status = "pending";
    }
    summary.status = status;

    const errorMessage = dmlError?.message || (typeof dmlError === "string" ? dmlError : "");
    if (errorMessage) {
        summary.error_message = errorMessage;
    }

    const aggregated = dmlPrompt && typeof dmlPrompt.aggregated === "object" ? dmlPrompt.aggregated : null;
    if (aggregated) {
        const aggregatedIssueCount = Array.isArray(aggregated.issues) ? aggregated.issues.length : 0;
        const aggregatedTotalCandidate = Number(aggregated.total_issues ?? aggregated.totalIssues);
        if (Number.isFinite(aggregatedTotalCandidate)) {
            summary.total_issues = aggregatedTotalCandidate;
        } else if (aggregatedIssueCount) {
            summary.total_issues = aggregatedIssueCount;
        }

        const aggregatedSeverity =
            aggregated.by_severity && typeof aggregated.by_severity === "object" && !Array.isArray(aggregated.by_severity)
                ? aggregated.by_severity
                : aggregated.bySeverity && typeof aggregated.bySeverity === "object" && !Array.isArray(aggregated.bySeverity)
                ? aggregated.bySeverity
                : null;
        if (aggregatedSeverity) {
            summary.by_severity = { ...aggregatedSeverity };
        }

        const aggregatedRules =
            aggregated.by_rule && typeof aggregated.by_rule === "object" && !Array.isArray(aggregated.by_rule)
                ? aggregated.by_rule
                : aggregated.byRule && typeof aggregated.byRule === "object" && !Array.isArray(aggregated.byRule)
                ? aggregated.byRule
                : null;
        if (aggregatedRules) {
            summary.by_rule = { ...aggregatedRules };
        }

        const messages = Array.isArray(aggregated.messages)
            ? aggregated.messages
                  .map((item) => (typeof item === "string" ? item.trim() : ""))
                  .filter((item) => item.length)
            : [];
        const messageText = typeof aggregated.message === "string" ? aggregated.message.trim() : "";
        if (messageText) {
            summary.message = messageText;
        } else if (messages.length) {
            summary.message = messages.join(" ");
        }
        if (messages.length) {
            summary.messages = messages;
        }
    }

    return summary;
}

function collectRuleCountsFromIssues(issues) {
    const result = {};
    if (!Array.isArray(issues)) {
        return result;
    }

    for (const issue of issues) {
        if (!issue || typeof issue !== "object") continue;

        const ruleValues = [];
        if (Array.isArray(issue.rule_ids)) {
            ruleValues.push(...issue.rule_ids);
        }
        if (Array.isArray(issue.ruleIds)) {
            ruleValues.push(...issue.ruleIds);
        }
        ruleValues.push(issue.rule_id, issue.ruleId, issue.rule);

        const uniqueRules = new Set();
        for (const value of ruleValues) {
            if (value === null || value === undefined) continue;
            const stringValue = typeof value === "string" ? value : String(value);
            const trimmed = stringValue.trim();
            if (!trimmed) continue;
            uniqueRules.add(trimmed);
        }

        if (!uniqueRules.size) continue;

        for (const rule of uniqueRules) {
            result[rule] = (result[rule] || 0) + 1;
        }
    }

    return result;
}

function annotateIssueSource(issue, source) {
    if (!issue || typeof issue !== "object") {
        return issue;
    }
    if (issue.source || issue.analysis_source) {
        return issue;
    }
    return { ...issue, source };
}

function normaliseDifySummary(summarySource, issueCount = 0) {
    if (!summarySource || typeof summarySource !== "object") {
        return null;
    }

    const rawSummary = summarySource.summary;
    if (rawSummary && typeof rawSummary === "object" && !Array.isArray(rawSummary)) {
        const summary = { ...rawSummary };
        if (!summary.analysis_source && !summary.analysisSource) {
            summary.analysis_source = "dify_workflow";
        }
        if (
            summary.total_issues === undefined &&
            summary.totalIssues === undefined &&
            Number.isFinite(issueCount)
        ) {
            summary.total_issues = issueCount;
        }
        return summary;
    }

    const message = typeof rawSummary === "string" ? rawSummary.trim() : "";
    const totalCandidate = Number(summarySource.total_issues ?? summarySource.totalIssues);
    const totalIssues = Number.isFinite(totalCandidate) ? totalCandidate : issueCount;
    const summary = {
        analysis_source: "dify_workflow",
        total_issues: Number.isFinite(totalIssues) ? totalIssues : 0
    };
    if (message) {
        summary.message = message;
    }
    return summary;
}

function buildCompositeSummary(staticSummary, dmlSummary, difySummary, issues) {
    const ruleCounts = collectRuleCountsFromIssues(issues);
    const hasRuleCounts = Object.keys(ruleCounts).length > 0;
    const staticByRule =
        staticSummary?.by_rule && typeof staticSummary.by_rule === "object" && !Array.isArray(staticSummary.by_rule)
            ? { ...staticSummary.by_rule }
            : {};

    const byRule = hasRuleCounts ? ruleCounts : staticByRule;

    const fileExtension = typeof staticSummary?.file_extension === "string"
        ? staticSummary.file_extension
        : typeof staticSummary?.fileExtension === "string"
        ? staticSummary.fileExtension
        : ".sql";

    const totalIssues = Array.isArray(issues) ? issues.length : 0;

    const sources = {};
    if (staticSummary) {
        sources.static_analyzer = staticSummary;
    }
    if (dmlSummary) {
        sources.dml_prompt = dmlSummary;
    }
    if (difySummary) {
        sources.dify_workflow = difySummary;
    }

    const composite = {
        total_issues: totalIssues,
        by_rule: byRule,
        file_extension: fileExtension,
        analysis_source: "composite",
        sources
    };

    const messages = [];
    if (typeof staticSummary?.message === "string" && staticSummary.message.trim()) {
        messages.push(staticSummary.message.trim());
    }
    if (typeof difySummary?.message === "string" && difySummary.message.trim()) {
        messages.push(difySummary.message.trim());
    }
    if (messages.length) {
        composite.message = messages.join(" ");
    }

    return composite;
}

export async function analyseSqlToReport(sqlText, options = {}) {
    const analysis = await executeSqlAnalysis(sqlText);
    const rawReport = typeof analysis?.result === "string" ? analysis.result : "";
    const trimmedReport = rawReport.trim();
    const dmlSegments = extractDmlStatements(sqlText);

    if (!trimmedReport) {
        return {
            analysis,
            dify: null,
            difyError: null,
            dml: { segments: dmlSegments, dify: null },
            dmlError: null
        };
    }

    const {
        projectId = "",
        projectName = "",
        path = "",
        userId = "",
        files = undefined
    } = options || {};

    const resolvedProjectName = projectName || projectId || "sql-report";
    const resolvedUserId = typeof userId === "string" && userId.trim() ? userId.trim() : undefined;
    const analysisFilePath = path ? `${path}.analysis.json` : "analysis.json";
    const staticSnapshot = buildStaticReportSnapshot(trimmedReport);
    const difyConfig = getDifyConfigSummary();

    let dmlPrompt = null;
    let dmlError = null;
    if (dmlSegments.length) {
        const segmentTexts = dmlSegments.map((segment) => segment.text);
        const segmentsForDify = dmlSegments.map((segment) => {
            const startLine = normalisePositiveInteger(segment.startLine ?? segment.line);
            const endLine = normalisePositiveInteger(segment.endLine);
            const startColumn = normalisePositiveInteger(segment.startColumn);
            const endColumn = normalisePositiveInteger(segment.endColumn);
            const text = typeof segment.text === "string"
                ? segment.text
                : typeof segment.rawText === "string"
                ? segment.rawText
                : "";
            return {
                text,
                rawText: typeof segment.rawText === "string" ? segment.rawText : text,
                index: segment.index,
                startLine: startLine || undefined,
                endLine: endLine || startLine || undefined,
                startColumn: startColumn || undefined,
                endColumn: endColumn || undefined,
                line: startLine || undefined
            };
        });
        const dmlFilePath = path ? `${path}.dml.txt` : "analysis.dml.txt";
        try {
            console.log(
                `[sql+dml] Running prompt analysis project=${projectId || resolvedProjectName} path=${dmlFilePath} segments=${segmentTexts.length}`
            );
            dmlPrompt = await requestDifyReport({
                projectName: resolvedProjectName,
                filePath: dmlFilePath,
                content: segmentTexts.join("\n\n"),
                userId: resolvedUserId,
                segments: segmentsForDify,
                files
            });
        } catch (error) {
            dmlError = error;
            const message = error?.message || String(error);
            console.warn(
                `[sql+dml] Failed to analyse DML segments project=${projectId || resolvedProjectName} path=${dmlFilePath} :: ${message}`,
                error
            );
        }
    }

    let dify = null;
    let difyError = null;

    if (difyConfig.hasApiKey) {
        const totalStaticIssues = Array.isArray(staticSnapshot.issues) ? staticSnapshot.issues.length : 0;
        console.log(
            `[sql+dify] Enriching static analysis issues project=${projectId || resolvedProjectName} path=${path || analysisFilePath} total=${totalStaticIssues}`
        );
        try {
            const enrichment = await enrichStaticIssuesWithDify(staticSnapshot.issues, {
                projectId,
                projectName,
                path,
                userId: resolvedUserId,
                files
            });
            if (enrichment) {
                const enrichedIssues = cloneIssueListForPersistence(enrichment.issues);
                let difyReportString = "";
                try {
                    difyReportString = JSON.stringify({ issues: enrichedIssues }, null, 2);
                } catch (_error) {
                    try {
                        difyReportString = JSON.stringify({ issues: enrichedIssues });
                    } catch (_nestedError) {
                        difyReportString = "";
                    }
                }

                const successfulCount = enrichedIssues.length - enrichment.errors.length;
                console.log(
                    `[sql+dify] Issue enrichment completed project=${projectId || resolvedProjectName} path=${path || analysisFilePath} succeeded=${successfulCount}/${enrichedIssues.length}`
                );

                const segmentSnapshots = cloneSegmentListForPersistence(enrichment.segments);
                const chunkSnapshots = cloneValue(enrichment.chunks);
                const errorSnapshots = cloneValue(enrichment.errors);
                const conversationId =
                    typeof enrichment.conversationId === "string" && enrichment.conversationId.trim()
                        ? enrichment.conversationId.trim()
                        : "";

                dify = normaliseDifyOutput(
                    {
                        report: difyReportString,
                        issues: enrichedIssues,
                        segments: segmentSnapshots,
                        chunks: chunkSnapshots,
                        conversationId: conversationId || undefined,
                        generatedAt: new Date().toISOString(),
                        enrichment: {
                            totalIssues: totalStaticIssues,
                            successfulIssues: successfulCount,
                            failedIssues: errorSnapshots.length,
                            errors: errorSnapshots,
                            conversationId: conversationId || undefined
                        }
                    },
                    difyReportString
                );

                if (enrichment.errors.length === enrichedIssues.length && enrichedIssues.length) {
                    difyError = new Error("Dify enrichment failed for all static issues");
                }
            }
        } catch (error) {
            const message = error?.message || String(error);
            const locationLabel = path || analysisFilePath;
            console.warn(
                `[sql+dify] Failed to enrich static issues project=${projectId || resolvedProjectName} path=${locationLabel} :: ${message}`,
                error
            );
            difyError = error;
            dify = null;
        }
    } else {
        console.warn("[sql+dify] Dify API 未設定，靜態分析問題將不進行補充建議。");
    }

    return { analysis, dify, difyError, dml: { segments: dmlSegments, dify: dmlPrompt }, dmlError };
}

export function buildSqlReportPayload({
    analysis,
    content,
    dify,
    difyError,
    dml,
    dmlError,
    staticIssueSegments
}) {

    const rawReport = typeof analysis?.result === "string" ? analysis.result : "";

    const difyReport = typeof dify?.report === "string" && dify.report.trim().length
        ? dify.report
        : rawReport;

    const segments = dify?.segments && Array.isArray(dify.segments) && dify.segments.length
        ? dify.segments
        : [rawReport || content || ""];
    logSqlPayloadStage("segments.normalised", segments);

    const parsedDify = parseStaticReport(difyReport);
    logSqlPayloadStage("dify.parsedReport", parsedDify);
    const parsedDifyReport = parsedDify && typeof parsedDify === "object" ? parsedDify : null;

    const difyIssuesFromReport = Array.isArray(parsedDifyReport?.issues) ? parsedDifyReport.issues : [];
    const difyIssuesDirect = Array.isArray(dify?.issues) ? dify.issues : [];
    const difyIssuesPreferredRaw = difyIssuesFromReport.length ? difyIssuesFromReport : difyIssuesDirect;
    const difyIssuesSanitised = cloneIssueListForPersistence(difyIssuesPreferredRaw);
    const difyConversationId =
        typeof dify?.conversationId === "string" && dify.conversationId.trim()
            ? dify.conversationId.trim()
            : "";

    const fallbackReportForSnapshot =
        parsedDifyReport || (difyIssuesSanitised.length ? { issues: difyIssuesSanitised } : null);

    const staticSnapshot = buildStaticReportSnapshot(rawReport, {
        fallbackReport: fallbackReportForSnapshot,
        fallbackExtension: ".sql"
    });
    logSqlPayloadStage("static.parsedReport", staticSnapshot.parsed);

    const staticSummary = cloneValue(staticSnapshot.summary);

    const staticReportPayload = cloneValue(staticSnapshot.payload);
    staticReportPayload.summary = cloneValue(staticSummary);
    staticReportPayload.metadata = cloneValue(staticSnapshot.metadata);
    if (difyConversationId) {
        staticReportPayload.conversationId = difyConversationId;
    }

    const difyStaticIssues = difyIssuesSanitised;
    const snapshotIssues = cloneIssueListForPersistence(staticSnapshot.issues);
    const preferredStaticIssues = difyStaticIssues.length ? difyStaticIssues : snapshotIssues;

    staticReportPayload.issues = cloneIssueListForPersistence(preferredStaticIssues);
    const enrichmentIssues = buildIssuesOnlyEnrichment(parsedDifyReport, difyIssuesSanitised, {
        segments: dify?.segments,
        chunks: dify?.chunks,
        errors: dify?.enrichment?.errors,
        conversationId: difyConversationId
    });
    if (enrichmentIssues) {
        staticReportPayload.enrichment = enrichmentIssues;
    }
    if (staticSnapshot.parsed && staticSnapshot.parsed !== staticSnapshot.final) {
        staticReportPayload.original = cloneValue(staticSnapshot.parsed);
    }
    logSqlPayloadStage("static.reportPayload", staticReportPayload);

    const staticIssuesForPersistence = cloneIssueListForPersistence(preferredStaticIssues);
    const staticIssuesWithSource = staticIssuesForPersistence.map((issue) =>
        annotateIssueSource(issue, "static_analyzer")
    );

    const dmlSegments = Array.isArray(dml?.segments)
        ? dml.segments.map((segment, index) => {
              const baseIndex = index + 1;
              if (!segment || typeof segment !== "object") {
                  const textValue = typeof segment === "string" ? segment : String(segment ?? "");
                  return {
                      index: baseIndex,
                      text: textValue,
                      rawText: textValue
                  };
              }
              const clone = { ...segment };
              const numericIndex = normalisePositiveInteger(clone.index);
              clone.index = numericIndex || baseIndex;
              if (typeof clone.text !== "string" || !clone.text.trim()) {
                  if (typeof clone.rawText === "string" && clone.rawText.trim()) {
                      clone.text = clone.rawText.trim();
                  } else if (typeof clone.raw === "string" && clone.raw.trim()) {
                      clone.text = clone.raw;
                  } else {
                      clone.text = "";
                  }
              }
              if (typeof clone.rawText !== "string" || !clone.rawText.trim()) {
                  clone.rawText = clone.text;
              }
              const startLine = normalisePositiveInteger(clone.startLine ?? clone.line);
              const endLine = normalisePositiveInteger(clone.endLine);
              const startColumn = normalisePositiveInteger(clone.startColumn ?? clone.column);
              const endColumn = normalisePositiveInteger(clone.endColumn);
              if (startLine) {
                  clone.startLine = startLine;
                  clone.line = startLine;
              }
              if (endLine) {
                  clone.endLine = endLine;
              }
              if (startColumn) {
                  clone.startColumn = startColumn;
              }
              if (endColumn) {
                  clone.endColumn = endColumn;
              }
              return clone;
          })
        : [];
    logSqlPayloadStage("dml.segments", dmlSegments);
    const dmlPrompt = dml?.dify || null;
    const dmlReportText = typeof dmlPrompt?.report === "string" ? dmlPrompt.report : "";
    const dmlReportTextHuman = typeof dmlPrompt?.textReport === "string" ? dmlPrompt.textReport : "";
    const dmlChunks = buildDmlIssueChunks(dmlSegments, dmlPrompt);
    const dmlSummary = normaliseDmlSummary(dmlSegments, dmlPrompt, dmlError);
    const dmlAggregated = dmlPrompt && typeof dmlPrompt.aggregated === "object" ? dmlPrompt.aggregated : null;
    const dmlIssuesRaw = Array.isArray(dmlPrompt?.issues)
        ? dmlPrompt.issues
        : Array.isArray(dmlAggregated?.issues)
        ? dmlAggregated.issues
        : [];
    const dmlIssues = cloneIssueListForPersistence(dmlIssuesRaw);
    const dmlIssuesWithSource = dmlIssues.map((issue) => annotateIssueSource(issue, "dml_prompt"));
    const dmlConversationId = typeof dmlPrompt?.conversationId === "string" ? dmlPrompt.conversationId : "";
    const dmlGeneratedAt = dmlPrompt?.generatedAt || null;
    const dmlErrorMessage = dmlSummary.error_message || (dmlPrompt?.error ? String(dmlPrompt.error) : "");
    const dmlReportPayload = {
        type: "dml_prompt",
        summary: dmlSummary,
        segments: dmlSegments,
        report: dmlReportText,
        reportText: dmlReportTextHuman || undefined,
        chunks: dmlChunks,
        issues: dmlIssues,
        aggregated: dmlAggregated || undefined,
        conversationId: dmlConversationId,
        generatedAt: dmlGeneratedAt,
        metadata: { analysis_source: "dml_prompt" }
    };
    logSqlPayloadStage("dml.reportPayload", dmlReportPayload);

    let finalReport = difyReport && difyReport.trim() ? difyReport : rawReport;

    const difyIssuesRaw = difyIssuesSanitised;
    const difyIssuesWithSource = difyIssuesRaw.map((issue) => annotateIssueSource(issue, "dify_workflow"));
    const combinedIssues = [...staticIssuesWithSource, ...difyIssuesWithSource, ...dmlIssuesWithSource];
    const difySummary = parsedDifyReport
        ? normaliseDifySummary(parsedDifyReport, difyIssuesRaw.length)
        : null;
    logSqlPayloadStage("dify.summary", difySummary);
    logSqlPayloadStage("issues.combined", combinedIssues);

    const compositeSummary = buildCompositeSummary(staticSummary, dmlSummary, difySummary, combinedIssues);

    const aiIssuesForPersistence = filterAiIssuesForPersistence(dmlIssues);

    const reportsStaticIssues = cloneIssueListForPersistence(staticIssuesForPersistence);
    const reportsAiIssues = cloneIssueListForPersistence(aiIssuesForPersistence);

    const staticIssuesJson = serialiseIssuesJson(reportsStaticIssues, {
        segments: dify?.segments,
        chunks: dify?.chunks,
        errors: dify?.enrichment?.errors,
        conversationId: difyConversationId
    });
    const aiIssuesJson = serialiseIssuesJson(reportsAiIssues);

    logIssuesJson("static.issues.json.pre_aggregate", staticIssuesJson);
    logIssuesJson("ai.issues.json.pre_aggregate", aiIssuesJson);

    const combinedIssuesForReports = dedupeIssueList([
        ...reportsStaticIssues,
        ...reportsAiIssues
    ]);

    dmlReportPayload.issues = cloneIssueListForPersistence(aiIssuesForPersistence);

    const generatedAt = dify?.generatedAt || new Date().toISOString();
    const combinedSummaryRecords = [
        buildSummaryRecordForPersistence({
            source: "static_analyzer",
            label: "靜態分析器",
            summary: staticSummary,
            issues: reportsStaticIssues
        }),
        buildSummaryRecordForPersistence({
            source: "dml_prompt",
            label: "AI審查",
            summary: dmlSummary,
            issues: reportsAiIssues,
            fallbackGeneratedAt: dmlGeneratedAt
        }),
        buildSummaryRecordForPersistence({
            source: "combined",
            label: "聚合報告",
            summary: compositeSummary,
            issues: combinedIssuesForReports,
            fallbackStatus: difySummary?.status,
            fallbackGeneratedAt:
                difySummary?.generated_at ||
                difySummary?.generatedAt ||
                dify?.generatedAt ||
                generatedAt
        })
    ];

    const aggregatedReports = {
        summary: cloneSummaryRecordsForPersistence(combinedSummaryRecords),
        issues: cloneIssueListForPersistence(combinedIssuesForReports)
    };

    const combinedReportJson = serialiseCombinedReportJson(
        combinedSummaryRecords,
        combinedIssuesForReports
    );
    logIssuesJson("combined.report.json.post_aggregate", combinedReportJson);

    const staticReportEntry = cloneValue({
        ...staticReportPayload,
        type: "static_analyzer",
        issues: reportsStaticIssues
    });

    const dmlReportEntry = cloneValue({
        ...dmlReportPayload,
        issues: reportsAiIssues
    });

    const combinedReportEntry = {
        type: "combined",
        summary: cloneValue(compositeSummary),
        issues: cloneIssueListForPersistence(combinedIssuesForReports)
    };

    const finalReports = {
        static_analyzer: staticReportEntry,
        dml_prompt: dmlReportEntry,
        combined: combinedReportEntry
    };

    const finalPayload = {
        summary: cloneValue(compositeSummary),
        issues: cloneIssueListForPersistence(combinedIssues),
        reports: finalReports,
        aggregated_reports: aggregatedReports,
        metadata: {
            analysis_source: "composite",
            components: [
                "static_analyzer",
                dmlSegments.length ? "dml_prompt" : null,
                difySummary ? "dify_workflow" : null
            ].filter(Boolean)
        }
    };
    logSqlPayloadStage("payload.final", finalPayload);

    if (parsedDify && typeof parsedDify === "object") {
        finalPayload.reports.dify_workflow = {
            type: "dify_workflow",
            summary: cloneValue(difySummary),
            issues: cloneIssueListForPersistence(difyIssuesRaw),
            metadata: { analysis_source: "dify_workflow" },
            raw: parsedDify,
            report: difyReport
        };
    } else if (difyIssuesRaw.length) {
        finalPayload.reports.dify_workflow = {
            type: "dify_workflow",
            issues: cloneIssueListForPersistence(difyIssuesRaw),
            metadata: { analysis_source: "dify_workflow" }
        };
    }

    const aiChunkSummaries = cloneValue(dmlChunks);
    logSqlPayloadStage("chunks.ai", aiChunkSummaries);

    const chunksForReport = [];
    logSqlPayloadStage("chunks.final", chunksForReport);

    finalReport = JSON.stringify(finalPayload, null, 2);
    logSqlPayloadStage("report.serialised", finalReport);

    const difyErrorMessage = difyError ? difyError.message || String(difyError) : "";
    const enrichmentStatus = dify ? "succeeded" : "failed";

    const originalResult = typeof analysis?.result === "string" ? analysis.result : rawReport;
    const analysisPayload =
        analysis && typeof analysis === "object" ? { ...analysis } : originalResult ? {} : null;

    if (analysisPayload) {
        if (originalResult && typeof analysisPayload.originalResult !== "string") {
            analysisPayload.originalResult = originalResult;
        }
        if (rawReport && typeof analysisPayload.rawReport !== "string") {
            analysisPayload.rawReport = rawReport;
        }
        analysisPayload.result = finalReport;
        analysisPayload.enriched = Boolean(dify);
        if (!analysisPayload.enrichmentStatus) {
            analysisPayload.enrichmentStatus = enrichmentStatus;
        }
        analysisPayload.staticReport = staticReportPayload;
        analysisPayload.dmlReport = dmlReportPayload;
        analysisPayload.dmlSegments = dmlSegments;
        analysisPayload.dmlSummary = dmlSummary;
        analysisPayload.dmlIssues = cloneIssueListForPersistence(aiIssuesForPersistence);
        if (dmlAggregated) {
            analysisPayload.dmlAggregated = dmlAggregated;
        }
        analysisPayload.combinedSummary = compositeSummary;
        analysisPayload.combinedSummaryRecords = combinedSummaryRecords;
        analysisPayload.combinedIssues = combinedIssues;
        analysisPayload.aggregatedReports = aggregatedReports;
        if (parsedDify && typeof parsedDify === "object") {
            analysisPayload.difyReport = parsedDify;
            analysisPayload.difySummary = difySummary;
        }
        if (!analysisPayload.difyIssues && difyIssuesRaw.length) {
            analysisPayload.difyIssues = cloneIssueListForPersistence(difyIssuesRaw);
        }
        if (dmlErrorMessage) {
            analysisPayload.dmlErrorMessage = dmlErrorMessage;
        }
        if (dmlConversationId) {
            analysisPayload.dmlConversationId = dmlConversationId;
        }
        if (dmlGeneratedAt) {
            analysisPayload.dmlGeneratedAt = dmlGeneratedAt;
        }
        if (difyErrorMessage) {
            analysisPayload.difyErrorMessage = difyErrorMessage;
        } else if (!dify) {
            analysisPayload.difyErrorMessage = "";
        }
    }
    logSqlPayloadStage("analysis.payload", analysisPayload);

    const sourceLabels = ["sql-rule-engine"];
    if (dmlSegments.length) {
        sourceLabels.push(dmlPrompt ? "dml-dify" : "dml");
    }
    if (dify) {
        sourceLabels.push("dify");
    }

    const result = {
        report: finalReport,
        conversationId: typeof dify?.conversationId === "string" ? dify.conversationId : "",
        chunks: chunksForReport,
        segments,
        generatedAt,
        analysis: analysisPayload,
        rawReport,
        dify: dify || null,
        dml: dmlReportPayload,
        source: sourceLabels.join("+"),
        enrichmentStatus,
        difyErrorMessage: difyErrorMessage || undefined,
        dmlErrorMessage: dmlErrorMessage || undefined,
        combinedReportJson,
        staticReportJson: staticIssuesJson,
        aiReportJson: aiIssuesJson
    };
    return result;
}

export function isSqlPath(filePath) {
    if (!filePath || typeof filePath !== "string") {
        return false;
    }
    return filePath.trim().toLowerCase().endsWith(".sql");
}
