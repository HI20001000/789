import { collectIssuesForSource } from "./combinedReport.js";
import {
    dedupeIssues,
    isPlainObject,
    normaliseReportObject,
    pickJsonStringCandidate,
    parseReportJson
} from "./shared.js";

if (typeof globalThis !== "undefined" && typeof globalThis.logAiReviewStage !== "function") {
    globalThis.logAiReviewStage = () => {};
}

/**
 * Collect AI review issues from the workspace state.
 *
 * @param {Record<string, any>} state - Workspace state containing parsed reports and analysis snapshots.
 * @returns {Array<any>} Issues raised by the AI review pipeline.
 */
export function collectAiReviewIssues(state) {
    return collectIssuesForSource(state, ["dml_prompt"]);
}

/**
 * Extract the AI review report from a report collection.
 *
 * @param {Record<string, any>} reports - Raw reports keyed by source.
 * @returns {Record<string, any> | null} The AI review report when available.
 */
export function extractAiReviewReport(reports) {
    if (!reports || typeof reports !== "object") {
        return null;
    }
    return reports.dml_prompt || reports.dmlPrompt || null;
}

/**
 * Merge the AI review report into the provided analysis object.
 *
 * @param {{ state: Record<string, any>, baseAnalysis: Record<string, any>, reports: Record<string, any> }} params - Merge inputs.
 * @returns {{ dmlReport: Record<string, any> | null }} Normalised AI report information.
 */
export function mergeAiReviewReportIntoAnalysis({ state, baseAnalysis, reports }) {
    const dmlReport = extractAiReviewReport(reports);
    if (!dmlReport || typeof dmlReport !== "object") {
        return { dmlReport: null };
    }

    state.dml = dmlReport;
    const existingDml =
        baseAnalysis.dmlReport && typeof baseAnalysis.dmlReport === "object"
            ? baseAnalysis.dmlReport
            : null;
    const mergedDml = existingDml ? { ...existingDml } : {};
    Object.assign(mergedDml, dmlReport);

    if (dmlReport.summary && typeof dmlReport.summary === "object") {
        mergedDml.summary = {
            ...(existingDml?.summary && typeof existingDml.summary === "object"
                ? existingDml.summary
                : {}),
            ...dmlReport.summary
        };
    } else if (existingDml?.summary && typeof existingDml.summary === "object") {
        mergedDml.summary = { ...existingDml.summary };
    }

    baseAnalysis.dmlReport = mergedDml;
    if (!baseAnalysis.dmlSummary && mergedDml.summary) {
        baseAnalysis.dmlSummary = mergedDml.summary;
    }

    const dmlSummary =
        dmlReport.summary && typeof dmlReport.summary === "object" ? dmlReport.summary : null;
    if (!state.dmlErrorMessage) {
        const dmlError =
            typeof dmlSummary?.error_message === "string"
                ? dmlSummary.error_message
                : typeof dmlSummary?.errorMessage === "string"
                ? dmlSummary.errorMessage
                : "";
        state.dmlErrorMessage = dmlError || "";
    }

    return { dmlReport: mergedDml };
}

function normaliseSqlText(value) {
    if (typeof value === "string") {
        return value;
    }
    if (value === null || value === undefined) {
        return "";
    }
    return String(value);
}

function normaliseNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function clonePlain(value) {
    if (Array.isArray(value)) {
        return value.map((item) => clonePlain(item));
    }
    if (isPlainObject(value)) {
        const result = {};
        for (const [key, entry] of Object.entries(value)) {
            result[key] = clonePlain(entry);
        }
        return result;
    }
    return value;
}

function normaliseIssueSourceValue(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function collectIssueSourceCandidates(issue) {
    if (!issue || typeof issue !== "object") {
        return [];
    }
    const candidates = [];
    const direct = normaliseIssueSourceValue(issue.source);
    if (direct) candidates.push(direct);
    const analysisSource = normaliseIssueSourceValue(issue.analysis_source || issue.analysisSource);
    if (analysisSource) candidates.push(analysisSource);
    if (issue.metadata && typeof issue.metadata === "object") {
        const metaSource = normaliseIssueSourceValue(
            issue.metadata.analysis_source || issue.metadata.analysisSource || issue.metadata.source
        );
        if (metaSource) candidates.push(metaSource);
    }
    if (issue.details && Array.isArray(issue.details)) {
        issue.details.forEach((detail) => {
            if (!detail || typeof detail !== "object") return;
            const detailSource = normaliseIssueSourceValue(detail.analysis_source || detail.analysisSource);
            if (detailSource) candidates.push(detailSource);
        });
    }
    return candidates;
}

function isNonDmlSource(source) {
    if (!source) return false;
    if (source.includes("dml")) return false;
    if (source.includes("ai")) return false;
    if (source.includes("review")) return false;
    if (source.includes("markdown")) return false;
    return source.includes("static") || source.includes("dify") || source.includes("workflow") || source.includes("composite");
}

function filterDmlIssueList(issues) {
    const list = Array.isArray(issues) ? issues : [];
    const hasAuthoritative = hasAuthoritativeAiIssues(list);
    const result = [];
    for (const issue of list) {
        if (!issue) continue;
        if (typeof issue !== "object") {
            if (!hasAuthoritative) {
                result.push(issue);
            }
            continue;
        }
        const sources = collectIssueSourceCandidates(issue);
        if (sources.some((candidate) => isNonDmlSource(candidate))) {
            continue;
        }
        const fallbackSource = normaliseIssueSourceValue(
            issue.fallbackSource || issue.fallback_source || issue.fallback
        );
        if (hasAuthoritative) {
            if (fallbackSource === "markdown") {
                continue;
            }
            if (!isAuthoritativeAiIssue(issue)) {
                continue;
            }
        }
        result.push(issue);
    }
    if (!hasAuthoritative) {
        return result;
    }
    return result.filter((entry) => {
        if (!entry || typeof entry !== "object") {
            return false;
        }
        return isAuthoritativeAiIssue(entry);
    });
}

function isAuthoritativeAiIssue(issue) {
    if (!isPlainObject(issue)) {
        return false;
    }

    if (typeof issue.rule_id === "string" && issue.rule_id.trim()) {
        return true;
    }

    if (Array.isArray(issue.rule_ids)) {
        for (const ruleId of issue.rule_ids) {
            if (typeof ruleId === "string" && ruleId.trim()) {
                return true;
            }
        }
    }

    if (typeof issue.ruleId === "string" && issue.ruleId.trim()) {
        return true;
    }

    if (typeof issue.rule === "string" && issue.rule.trim()) {
        return true;
    }

    return false;
}

function hasAuthoritativeAiIssues(issues) {
    if (!Array.isArray(issues)) {
        return false;
    }
    return issues.some((issue) => isAuthoritativeAiIssue(issue));
}

function pickFirstString(candidates, options = {}) {
    const list = Array.isArray(candidates) ? candidates : [candidates];
    const allowEmpty = Boolean(options.allowEmpty);

    for (const candidate of list) {
        if (typeof candidate === "string") {
            const trimmed = candidate.trim();
            if (trimmed || (allowEmpty && candidate !== undefined && candidate !== null)) {
                return allowEmpty ? candidate : trimmed;
            }
        } else if (candidate && typeof candidate === "object") {
            const message = typeof candidate.message === "string" ? candidate.message.trim() : "";
            if (message) {
                return message;
            }
        }
    }

    return "";
}

function pickErrorMessage(candidates) {
    const list = Array.isArray(candidates) ? candidates : [candidates];
    for (const candidate of list) {
        if (!candidate) continue;
        if (typeof candidate === "string") {
            const trimmed = candidate.trim();
            if (trimmed) {
                return trimmed;
            }
        } else if (candidate && typeof candidate === "object") {
            const errorValue =
                typeof candidate.error === "string"
                    ? candidate.error
                    : typeof candidate.message === "string"
                    ? candidate.message
                    : null;
            if (typeof errorValue === "string" && errorValue.trim()) {
                return errorValue.trim();
            }
        }
    }
    return "";
}

function normaliseTimestamp(value) {
    if (!value) {
        return null;
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (typeof value === "number") {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        const parsed = new Date(trimmed);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
        return trimmed;
    }
    return null;
}

function normaliseIssues(issues) {
    if (!Array.isArray(issues)) {
        return [];
    }

    const results = [];
    for (const issue of issues) {
        if (!issue) continue;
        if (isPlainObject(issue)) {
            const clone = { ...issue };
            const lineCandidate =
                clone.line ?? clone.line_number ?? clone.lineNumber ?? clone.startLine ?? null;
            const columnCandidate =
                clone.column ?? clone.column_number ?? clone.columnNumber ?? clone.startColumn ?? null;
            const severityCandidate = clone.severity ?? clone.level ?? null;

            const lineNumber = normaliseNumber(lineCandidate);
            if (lineNumber !== null) {
                clone.line = lineNumber;
            }
            const columnNumber = normaliseNumber(columnCandidate);
            if (columnNumber !== null) {
                clone.column = columnNumber;
            }
            if (severityCandidate && typeof severityCandidate === "string") {
                clone.severity = severityCandidate.trim();
            }

            const statement = pickFirstString(
                [clone.statement, clone.sql, clone.segment, clone.text, clone.raw],
                { allowEmpty: true }
            );
            if (statement) {
                clone.statement = normaliseSqlText(statement);
            }

            if (typeof clone.source !== "string" && typeof clone.analysis_source === "string") {
                clone.source = clone.analysis_source;
            }

            results.push(clone);
        } else if (typeof issue === "string") {
            const trimmed = issue.trim();
            if (trimmed) {
                results.push({ message: trimmed });
            }
        }
    }
    return results;
}

function stripIssuesFromChunks(chunks) {
    if (!Array.isArray(chunks)) {
        return;
    }
    chunks.forEach((chunk) => {
        if (!chunk || typeof chunk !== "object") {
            return;
        }
        if ("issues" in chunk) {
            delete chunk.issues;
        }
    });
}

function normaliseSegments(segments, chunks) {
    const segmentList = Array.isArray(segments) ? segments : [];
    const chunkList = Array.isArray(chunks) ? chunks : [];

    const results = [];
    const appendSegment = (segment, index) => {
        if (!segment && segment !== 0) return;

        if (isPlainObject(segment)) {
            const clone = { ...segment };
            const text = pickFirstString(
                [clone.text, clone.segment, clone.sql, clone.answer, clone.raw, clone.statement],
                { allowEmpty: true }
            );
            if (text) {
                clone.text = normaliseSqlText(text);
            }
            const indexValue = normaliseNumber(clone.index);
            clone.index = indexValue !== null ? indexValue : index + 1;
            if (typeof clone.id !== "string" || !clone.id.trim()) {
                clone.id = String(clone.index);
            }
            const totalValue = normaliseNumber(clone.total);
            if (totalValue !== null) {
                clone.total = totalValue;
            }
            if (!Array.isArray(clone.lines) && clone.startLine !== undefined && clone.endLine !== undefined) {
                const startLine = normaliseNumber(clone.startLine);
                const endLine = normaliseNumber(clone.endLine);
                if (startLine !== null || endLine !== null) {
                    clone.lines = [startLine, endLine].filter((value) => value !== null);
                }
            }
            results.push(clone);
            return;
        }

        if (typeof segment === "string") {
            const text = segment.trim();
            if (text) {
                results.push({
                    id: String(index + 1),
                    index: index + 1,
                    text,
                    total: segmentList.length || chunkList.length || null
                });
            }
        }
    };

    if (segmentList.length) {
        segmentList.forEach((segment, index) => appendSegment(segment, index));
    }

    if (results.length === 0 && chunkList.length) {
        chunkList.forEach((chunk, index) => {
            if (!chunk) return;
            if (typeof chunk === "string") {
                const trimmed = chunk.trim();
                if (trimmed) {
                    results.push({
                        id: String(index + 1),
                        index: index + 1,
                        total: chunkList.length,
                        text: trimmed
                    });
                }
                return;
            }

            const normalised = isPlainObject(chunk) ? clonePlain(chunk) : {};
            const text = pickFirstString(
                [normalised.answer, normalised.rawAnalysis, normalised.raw, normalised.text],
                { allowEmpty: true }
            );
            const label = text ? normaliseSqlText(text) : "";
            const indexValue = normaliseNumber(normalised.index);
            const totalValue = normaliseNumber(normalised.total);
            results.push({
                ...normalised,
                id:
                    typeof normalised.id === "string" && normalised.id.trim()
                        ? normalised.id
                        : String(indexValue !== null ? indexValue : index + 1),
                index: indexValue !== null ? indexValue : index + 1,
                total: totalValue !== null ? totalValue : chunkList.length,
                text: label
            });
        });
    }

    return results;
}

function truncateText(value, limit) {
    if (typeof value !== "string") {
        return "";
    }
    if (!Number.isFinite(limit) || limit <= 0) {
        return value.trim();
    }
    const trimmed = value.trim();
    if (trimmed.length <= limit) {
        return trimmed;
    }
    return `${trimmed.slice(0, limit).trim()}…`;
}

function cleanMarkdownLine(line) {
    if (typeof line !== "string") {
        return "";
    }
    const trimmed = line.replace(/\t/g, "    ").trim();
    if (!trimmed) {
        return "";
    }

    const headingMatch = trimmed.match(/^#{1,6}\s*(.+)$/);
    if (headingMatch) {
        const heading = headingMatch[1].trim();
        if (!heading || /^第\s*\d+\s*段/.test(heading)) {
            return "";
        }
        return heading;
    }

    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
        const content = bulletMatch[1].trim();
        if (!content || /^第\s*\d+\s*段/.test(content)) {
            return "";
        }
        return `• ${content}`;
    }

    const orderedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (orderedMatch) {
        const content = orderedMatch[1].trim();
        if (!content || /^第\s*\d+\s*段/.test(content)) {
            return "";
        }
        return content;
    }

    if (/^第\s*\d+\s*段/.test(trimmed)) {
        return "";
    }

    return trimmed;
}

function summariseMarkdownContent(text) {
    if (typeof text !== "string") {
        return null;
    }

    const normalised = text.replace(/\r\n?/g, "\n");
    const lines = normalised.split("\n");
    const cleanedLines = [];

    lines.forEach((line) => {
        const cleaned = cleanMarkdownLine(line);
        if (cleaned) {
            cleanedLines.push(cleaned);
        }
    });

    if (!cleanedLines.length) {
        return null;
    }

    const summary = cleanedLines[0];
    const detailText = cleanedLines.join("\n\n");
    return {
        summary,
        detailText
    };
}

function deriveIssuesFromMarkdownSegments(segments, reportText) {
    const issues = [];
    const seenMessages = new Set();
    let globalDetailIndex = 1;

    const pushIssueFromText = (text, segment) => {
        if (typeof text !== "string") {
            return false;
        }
        const candidate = summariseMarkdownContent(text);
        if (!candidate) {
            return false;
        }

        const { summary, detailText } = candidate;
        const headline = truncateText(summary || detailText, 160);
        const detailDisplay = truncateText(detailText, 600) || headline;
        const dedupeKey = `${headline}::${detailDisplay}`;
        if (seenMessages.has(dedupeKey)) {
            return false;
        }
        seenMessages.add(dedupeKey);

        const lines = Array.isArray(segment?.lines) ? segment.lines : [];
        const numericLines = lines
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value));
        const firstLine = numericLines.length ? numericLines[0] : null;
        const lastLine = numericLines.length ? numericLines[numericLines.length - 1] : null;

        const detail = {
            index: globalDetailIndex,
            message: detailDisplay,
            severity: "",
            severityLabel: "未標示",
            severityClass: "muted"
        };

        if (detailText && detailText.length > detailDisplay.length) {
            detail.fullMessage = detailText;
        }

        const issue = {
            source: "dml_prompt",
            message: headline,
            description: detailText,
            severity: "",
            severityLabel: "未標示",
            severityClass: "muted",
            details: [detail],
            fallbackSource: "markdown"
        };

        if (segment?.id) {
            issue.segmentId = segment.id;
        }
        if (Number.isFinite(segment?.index)) {
            issue.segmentIndex = Number(segment.index);
        }
        if (firstLine !== null) {
            issue.line = firstLine;
        }
        if (lastLine !== null && lastLine !== firstLine) {
            issue.endLine = lastLine;
        }
        if (typeof segment?.text === "string" && segment.text.trim()) {
            issue.statement = segment.text.trim();
        }

        issues.push(issue);
        globalDetailIndex += 1;
        return true;
    };

    (Array.isArray(segments) ? segments : []).forEach((segment) => {
        const text = typeof segment?.text === "string" ? segment.text : "";
        pushIssueFromText(text, segment);
    });

    if (!issues.length && typeof reportText === "string" && reportText.trim()) {
        const sections = reportText.split(/\n{2,}/);
        let processed = false;
        sections.forEach((section) => {
            if (processed) return;
            processed = pushIssueFromText(section, null);
        });
        if (!processed) {
            pushIssueFromText(reportText, null);
        }
    }

    return issues;
}

/**
 * Transform the AI review report into UI friendly detail records.
 *
 * @param {Record<string, any>} dmlReport - Raw AI review report payload.
 * @returns {{ summary: Record<string, any> | null, details: Record<string, any> | null }}
 */
export function buildAiReviewDetails(dmlReport) {
    if (!dmlReport || typeof dmlReport !== "object") {
        return { summary: null, details: null };
    }

    const dmlSummary =
        dmlReport.summary && typeof dmlReport.summary === "object" ? dmlReport.summary : null;
    const dmlChunks = Array.isArray(dmlReport.chunks) ? dmlReport.chunks : [];
    const segments = normaliseSegments(dmlReport.segments, dmlChunks);

    const aggregatedText = typeof dmlReport.report === "string" ? dmlReport.report.trim() : "";
    const humanReadableText =
        typeof dmlReport.reportText === "string" ? dmlReport.reportText.trim() : "";
    const aggregatedIssues = Array.isArray(dmlReport.issues) ? dmlReport.issues : [];
    let issues = aggregatedIssues;
    if (!issues.length) {
        const derived = deriveIssuesFromMarkdownSegments(segments, humanReadableText || aggregatedText);
        if (derived.length) {
            issues = derived;
        }
    }
    const aggregatedObject =
        dmlReport.aggregated && typeof dmlReport.aggregated === "object"
            ? dmlReport.aggregated
            : null;
    const errorMessage =
        typeof dmlReport.error === "string"
            ? dmlReport.error
            : typeof dmlSummary?.error_message === "string"
            ? dmlSummary.error_message
            : typeof dmlSummary?.errorMessage === "string"
            ? dmlSummary.errorMessage
            : "";
    const status = typeof dmlSummary?.status === "string" ? dmlSummary.status : "";
    const generatedAt =
        dmlReport.generatedAt || dmlSummary?.generated_at || dmlSummary?.generatedAt || null;
    const conversationId =
        typeof dmlReport.conversationId === "string" ? dmlReport.conversationId : "";

    return {
        summary: dmlSummary,
        details: {
            summary: dmlSummary,
            segments,
            reportText: humanReadableText || aggregatedText,
            aggregatedText,
            aggregated: aggregatedObject,
            issues,
            error: errorMessage,
            status,
            generatedAt,
            conversationId
        }
    };
}

function normaliseAiReviewPayload(payload = {}) {

    const analysis =
        payload && typeof payload.analysis === "object" && !Array.isArray(payload.analysis)
            ? payload.analysis
            : null;
    logAiReviewStage("analysis.resolved", analysis);

    const reportObject =
        normaliseReportObject(payload.dml) ||
        normaliseReportObject(payload.dmlReport) ||
        normaliseReportObject(analysis?.dmlReport);
    logAiReviewStage("report.object", reportObject);

    let summaryObject =
        normaliseReportObject(payload.dmlSummary) ||
        normaliseReportObject(analysis?.dmlSummary) ||
        (reportObject?.summary && typeof reportObject.summary === "object"
            ? reportObject.summary
            : null);
    logAiReviewStage("summary.object", summaryObject);

    let aggregatedObject =
        normaliseReportObject(payload.dmlAggregated) ||
        normaliseReportObject(analysis?.dmlAggregated) ||
        (reportObject?.aggregated && typeof reportObject.aggregated === "object"
            ? reportObject.aggregated
            : null);
    logAiReviewStage("aggregated.object.initial", aggregatedObject);

    const reportJsonText = pickJsonStringCandidate(
        payload.dmlJson,
        payload.dmlReportJson,
        payload.reportJson,
        payload.dmlReport?.report,
        payload.dml?.report,
        reportObject?.report,
        payload.dmlReportText,
        payload.dmlReport?.reportText,
        payload.dml?.reportText,
        payload.reportText
    );
    logAiReviewStage("report.jsonText", reportJsonText);

    let parsedJsonReport = reportJsonText ? parseReportJson(reportJsonText) : null;
    if (!parsedJsonReport && isPlainObject(reportObject?.report)) {
        parsedJsonReport = reportObject.report;
    }
    logAiReviewStage("report.parsedJson", parsedJsonReport);

    if (!summaryObject && parsedJsonReport?.summary && isPlainObject(parsedJsonReport.summary)) {
        summaryObject = parsedJsonReport.summary;
    }
    logAiReviewStage("summary.object.final", summaryObject);

    if (!aggregatedObject && parsedJsonReport?.aggregated && isPlainObject(parsedJsonReport.aggregated)) {
        aggregatedObject = parsedJsonReport.aggregated;
    }

    if (aggregatedObject) {
        aggregatedObject = clonePlain(aggregatedObject);
    }
    logAiReviewStage("aggregated.object.final", aggregatedObject);

    let segments = Array.isArray(payload.dmlSegments) ? payload.dmlSegments : null;
    if (!segments || !segments.length) {
        segments = Array.isArray(reportObject?.segments) ? reportObject.segments : null;
    }
    if (!segments || !segments.length) {
        segments = Array.isArray(analysis?.dmlSegments) ? analysis.dmlSegments : null;
    }
    if ((!segments || !segments.length) && Array.isArray(parsedJsonReport?.segments)) {
        segments = parsedJsonReport.segments;
    }
    if ((!segments || !segments.length) && Array.isArray(parsedJsonReport?.chunks)) {
        segments = parsedJsonReport.chunks;
    }
    segments = Array.isArray(segments) ? clonePlain(segments) : [];
    logAiReviewStage("segments.normalised", segments);

    let issues = Array.isArray(payload.dmlIssues) ? payload.dmlIssues : null;
    if (!issues || !issues.length) {
        issues = Array.isArray(analysis?.dmlIssues) ? analysis.dmlIssues : null;
    }
    if (!issues || !issues.length) {
        issues = Array.isArray(reportObject?.issues) ? reportObject.issues : null;
    }
    if (!issues || !issues.length) {
        issues = Array.isArray(aggregatedObject?.issues) ? aggregatedObject.issues : null;
    }
    issues = normaliseIssues(issues);

    const fallbackMarkdown = pickFirstString(
        [
            summaryObject?.reportText,
            summaryObject?.report,
            reportObject?.reportText,
            reportObject?.report,
            aggregatedObject?.reportText,
            aggregatedObject?.report,
            payload.dmlReportText,
            payload.dmlReport?.reportText,
            payload.dmlReport?.report,
            payload.dml?.reportText,
            payload.dml?.report
        ],
        { allowEmpty: false }
    );

    const derivedIssues = deriveIssuesFromMarkdownSegments(segments, fallbackMarkdown);
    const normalisedDerivedIssues = normaliseIssues(derivedIssues);

    const hasAuthoritativeIssuesBeforeDerived = hasAuthoritativeAiIssues(issues);

    if (!issues.length && normalisedDerivedIssues.length) {
        issues = normalisedDerivedIssues;
    } else if (normalisedDerivedIssues.length && !hasAuthoritativeIssuesBeforeDerived) {
        issues = dedupeIssues([...issues, ...normalisedDerivedIssues]);
    } else if (normalisedDerivedIssues.length) {
    }

    const parsedIssues = parsedJsonReport ? normaliseIssues(parsedJsonReport.issues) : [];

    const parsedChunkIssues = [];
    if (parsedJsonReport && Array.isArray(parsedJsonReport.chunks)) {
        parsedJsonReport.chunks.forEach((chunk) => {
            if (!chunk) return;
            const chunkIndex = normaliseNumber(chunk.index);
            if (Array.isArray(chunk.issues)) {
                chunk.issues.forEach((issue) => {
                    if (!issue) return;
                    if (isPlainObject(issue)) {
                        const enriched = { ...issue };
                        if (chunkIndex !== null && enriched.chunk_index === undefined) {
                            enriched.chunk_index = chunkIndex;
                        }
                        parsedChunkIssues.push(enriched);
                        return;
                    }
                    parsedChunkIssues.push(issue);
                });
            }
        });
    }

    const parsedJsonIssues = dedupeIssues([...parsedIssues, ...normaliseIssues(parsedChunkIssues)]);
    if (parsedJsonIssues.length) {
        issues = dedupeIssues([...parsedJsonIssues, ...issues]);
    }

    if (aggregatedObject && Array.isArray(aggregatedObject.issues)) {
        const aggregatedIssuesRaw = clonePlain(aggregatedObject.issues);
        const aggregatedIssues = normaliseIssues(aggregatedObject.issues);
        if (aggregatedIssues.length) {
            issues = dedupeIssues([...aggregatedIssues, ...issues]);
        }
        aggregatedObject.issues = aggregatedIssuesRaw;
    }
    issues = filterDmlIssueList(issues);

    const generatedAtCandidates = [
        payload.dmlGeneratedAt,
        analysis?.dmlGeneratedAt,
        reportObject?.generatedAt,
        summaryObject?.generated_at,
        summaryObject?.generatedAt,
        payload.generatedAt
    ];
    let generatedAt = null;
    for (const candidate of generatedAtCandidates) {
        const normalised = normaliseTimestamp(candidate);
        if (normalised) {
            generatedAt = normalised;
            break;
        }
    }
    logAiReviewStage("generatedAt.resolved", generatedAt);

    const conversationId = pickFirstString(
        [
            payload.dmlConversationId,
            analysis?.dmlConversationId,
            payload.conversationId,
            reportObject?.conversationId,
            summaryObject?.conversationId
        ],
        { allowEmpty: false }
    );
    logAiReviewStage("conversationId.resolved", conversationId);

    const status = pickFirstString(
        [
            payload.dmlStatus,
            summaryObject?.status,
            analysis?.dmlSummary?.status,
            analysis?.dmlReport?.summary?.status,
            reportObject?.status
        ],
        { allowEmpty: false }
    );
    logAiReviewStage("status.resolved", status);

    const errorMessage = pickErrorMessage([
        payload.dmlErrorMessage,
        payload.dmlError,
        analysis?.dmlErrorMessage,
        summaryObject?.error_message,
        summaryObject?.errorMessage,
        reportObject?.error
    ]);
    logAiReviewStage("error.resolved", errorMessage);

    let report = reportObject ? clonePlain(reportObject) : null;
    const summary = summaryObject ? clonePlain(summaryObject) : null;
    const aggregated = aggregatedObject ? clonePlain(aggregatedObject) : null;

    if (report) {
        report.issues = clonePlain(issues);
        if (!report.summary && summary) {
            report.summary = clonePlain(summary);
        }
        if (!report.aggregated && aggregated) {
            report.aggregated = clonePlain(aggregated);
        }
        if (Array.isArray(report.chunks)) {
            stripIssuesFromChunks(report.chunks);
        }
        if (report.aggregated) {
            if (Array.isArray(report.aggregated.chunks)) {
                stripIssuesFromChunks(report.aggregated.chunks);
            }
            if ("issues" in report.aggregated) {
                delete report.aggregated.issues;
            }
        }
    } else if (issues.length) {
        report = { issues: clonePlain(issues) };
    }
    logAiReviewStage("report.normalised", report);
    logAiReviewStage("summary.normalised", summary);
    logAiReviewStage("aggregated.normalised", aggregated);

    const analysisPatch = {};
    if (report) analysisPatch.dmlReport = report;
    if (summary) analysisPatch.dmlSummary = summary;
    if (aggregated) {
        if ("issues" in aggregated) {
            delete aggregated.issues;
        }
        if (Array.isArray(aggregated.chunks)) {
            stripIssuesFromChunks(aggregated.chunks);
        }
        analysisPatch.dmlAggregated = aggregated;
    }
    if (issues.length) analysisPatch.dmlIssues = clonePlain(issues);
    if (segments.length) analysisPatch.dmlSegments = clonePlain(segments);
    if (generatedAt) analysisPatch.dmlGeneratedAt = generatedAt;
    if (conversationId) analysisPatch.dmlConversationId = conversationId;
    if (typeof errorMessage === "string") analysisPatch.dmlErrorMessage = errorMessage;
    if (status) analysisPatch.dmlStatus = status;

    const hasPatchEntries = Object.keys(analysisPatch).length > 0;
    if (hasPatchEntries) {
        logAiReviewStage("analysis.patch", analysisPatch);
    }

    const result = {
        report,
        summary,
        aggregated,
        issues,
        segments,
        status,
        errorMessage: typeof errorMessage === "string" ? errorMessage : "",
        generatedAt,
        conversationId,
        analysisPatch: hasPatchEntries ? analysisPatch : null
    };
    return result;
}

function mergeAnalysisPatch(baseAnalysis, patch) {
    if (!patch) {
        return baseAnalysis || null;
    }
    const target =
        baseAnalysis && typeof baseAnalysis === "object" && !Array.isArray(baseAnalysis)
            ? { ...baseAnalysis }
            : {};
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
        if (target[key] === value) continue;
        target[key] = value;
        changed = true;
    }
    return changed ? target : baseAnalysis || null;
}

function assignAiReviewState(state, payload) {
    if (!state || !payload) {
        return payload;
    }

    const existingReport = state.dml && typeof state.dml === "object" ? state.dml : null;
    const incomingReport = payload.report && typeof payload.report === "object" ? payload.report : null;
    const nextReport = existingReport ? { ...existingReport } : {};

    if (incomingReport) {
        Object.assign(nextReport, incomingReport);
    }

    if (payload.summary && typeof payload.summary === "object") {
        nextReport.summary = clonePlain(payload.summary);
    }

    if (payload.aggregated && typeof payload.aggregated === "object") {
        nextReport.aggregated = clonePlain(payload.aggregated);
    }

    if (Array.isArray(payload.segments)) {
        nextReport.segments = clonePlain(payload.segments);
    }

    if (Array.isArray(payload.issues)) {
        nextReport.issues = clonePlain(payload.issues);
    } else if (!Array.isArray(nextReport.issues)) {
        nextReport.issues = [];
    }

    if (payload.generatedAt) {
        nextReport.generatedAt = payload.generatedAt;
    }

    if (payload.conversationId) {
        nextReport.conversationId = payload.conversationId;
    }

    if (payload.status) {
        nextReport.status = payload.status;
    }

    if (typeof payload.errorMessage === "string" && payload.errorMessage.trim()) {
        nextReport.error = payload.errorMessage.trim();
    } else if (typeof nextReport.error !== "string") {
        delete nextReport.error;
    }

    const hasReportEntries = Object.keys(nextReport).length > 0;
    state.dml = hasReportEntries ? nextReport : null;

    if (typeof payload.errorMessage === "string") {
        state.dmlErrorMessage = payload.errorMessage;
    } else if (!state.dmlErrorMessage) {
        state.dmlErrorMessage = "";
    }

    const mergedAnalysis = mergeAnalysisPatch(state.analysis, payload.analysisPatch);
    if (mergedAnalysis !== state.analysis) {
        state.analysis = mergedAnalysis;
    }

    if (state.dml && !Array.isArray(state.dml.issues)) {
        state.dml.issues = [];
    }

    payload.report = state.dml || payload.report;

    return payload;
}

export function applyAiReviewResultToState(state, payload = {}) {
    const normalised = normaliseAiReviewPayload({ ...payload, analysis: payload.analysis ?? state?.analysis });
    return assignAiReviewState(state, normalised);
}

export function hydrateAiReviewStateFromRecord(state, record = {}) {
    const normalised = normaliseAiReviewPayload({ ...record, analysis: record.analysis ?? state?.analysis });
    return assignAiReviewState(state, normalised);
}

export function buildAiReviewSourceSummaryConfig({ report, globalSource, analysis } = {}) {
    const dmlReport = report && typeof report === "object" ? report : null;
    const { summary, details } = buildAiReviewDetails(dmlReport);
    const analysisState = analysis && typeof analysis === "object" ? analysis : null;

    return {
        summary,
        details,
        metricsSources: [globalSource, details?.summary, details?.aggregated].filter(Boolean),
        statusCandidates: [
            globalSource?.status,
            details?.status,
            summary?.status,
            analysisState?.dmlSummary?.status,
            analysisState?.dmlReport?.summary?.status
        ],
        errorCandidates: [
            globalSource?.error_message,
            globalSource?.errorMessage,
            details?.error,
            summary?.error_message,
            summary?.errorMessage,
            analysisState?.dmlErrorMessage
        ],
        generatedAtCandidates: [
            globalSource?.generated_at,
            globalSource?.generatedAt,
            details?.generatedAt,
            dmlReport?.generatedAt,
            summary?.generated_at,
            summary?.generatedAt,
            analysisState?.dmlGeneratedAt
        ]
    };
}

export function buildAiReviewPersistencePayload(state) {
    if (!state) {
        return null;
    }
    const payload = normaliseAiReviewPayload({
        dml: state.dml,
        dmlErrorMessage: state.dmlErrorMessage,
        dmlIssues: state.dml?.issues,
        dmlSegments: state.dml?.segments,
        dmlAggregated: state.dml?.aggregated,
        dmlSummary: state.dml?.summary,
        dmlGeneratedAt: state.analysis?.dmlGeneratedAt || state.dml?.generatedAt,
        dmlConversationId:
            state.analysis?.dmlConversationId || state.dml?.conversationId || state.conversationId,
        analysis: state.analysis
    });
    return payload.analysisPatch;
}

export function filterDmlIssues(issues) {
    return filterDmlIssueList(issues);
}

export default {
    collectAiReviewIssues,
    extractAiReviewReport,
    mergeAiReviewReportIntoAnalysis,
    buildAiReviewDetails,
    applyAiReviewResultToState,
    hydrateAiReviewStateFromRecord,
    buildAiReviewSourceSummaryConfig,
    buildAiReviewPersistencePayload
};
