/**
 * Shared helpers for report pipelines.
 * These utilities normalise source keys, clone issues, remap issue sources and remove duplicates.
 * They are intentionally colocated to prevent module level duplication across the different report pipelines.
 */

/**
 * Normalise a report source key by stripping non alpha-numeric characters and lower-casing the result.
 *
 * @param {unknown} value - Raw source key candidate.
 * @returns {string} A normalised identifier (empty when input is not a string).
 */
export function normaliseReportSourceKey(value) {
    if (typeof value !== "string") return "";
    return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Attempt to locate a report entry whose key matches the supplied source key (after normalisation).
 *
 * @template T
 * @param {Record<string, T> | null | undefined} container - Object containing report entries keyed by source name.
 * @param {string} sourceKey - Desired source key.
 * @returns {T | null} The matching entry or null when not present.
 */
export function findEntryBySourceKey(container, sourceKey) {
    if (!container || typeof container !== "object") {
        return null;
    }
    const target = normaliseReportSourceKey(sourceKey);
    if (!target) return null;
    for (const [key, value] of Object.entries(container)) {
        if (normaliseReportSourceKey(key) === target) {
            return value && typeof value === "object" ? value : null;
        }
    }
    return null;
}

/**
 * Clone an issue object and attach/override its `source` value when necessary.
 *
 * @template T extends Record<string, any>
 * @param {T} issue - The issue record to clone.
 * @param {string} sourceKey - Source identifier that should be recorded on the issue.
 * @param {{ force?: boolean }} [options]
 * @returns {T} A cloned issue with the desired source applied (original object returned when no changes required).
 */
export function cloneIssueWithSource(issue, sourceKey, options = {}) {
    let result = issue;

    if (issue && typeof issue === "object" && !Array.isArray(issue)) {
        const target = normaliseReportSourceKey(sourceKey);

        if (target) {
            const existingKeys = [
                normaliseReportSourceKey(issue.source),
                normaliseReportSourceKey(issue.analysis_source),
                normaliseReportSourceKey(issue.analysisSource)
            ].filter(Boolean);

            if (options.force) {
                const base = issue.source === sourceKey ? issue : { ...issue, source: sourceKey };
                const { analysis_source: _analysisSource, analysisSource: _analysisSourceCamel, ...rest } = base;
                result = { ...rest, source: sourceKey };
            } else if (existingKeys.includes(target)) {
                result = issue.source === sourceKey ? issue : { ...issue, source: sourceKey };
            } else if (existingKeys.length === 0) {
                result = { ...issue, source: sourceKey };
            }
        }
    }

    return result;
}

/**
 * Remap all issues in a collection to the specified source key.
 *
 * @template T extends Record<string, any>
 * @param {T[] | null | undefined} issues - Array of issue records.
 * @param {string} sourceKey - Source identifier to apply.
 * @param {{ force?: boolean }} [options]
 * @returns {T[]} List of cloned issues mapped to the supplied source.
 */
export function remapIssuesToSource(issues, sourceKey, options = {}) {
    if (!Array.isArray(issues)) {
        return [];
    }
    return issues.map((issue) => cloneIssueWithSource(issue, sourceKey, options));
}

function sortObjectKeys(value) {
    if (!value || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => sortObjectKeys(item));
    }
    const sorted = {};
    Object.keys(value)
        .sort()
        .forEach((key) => {
            sorted[key] = sortObjectKeys(value[key]);
        });
    return sorted;
}

function toIdentitySegment(value) {
    if (value === null || value === undefined) {
        return "";
    }
    if (Array.isArray(value)) {
        return value
            .map((entry) => toIdentitySegment(entry))
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

function createIssueKey(issue) {
    if (issue && typeof issue === "object" && !Array.isArray(issue)) {
        const ruleId = issue.rule_id ?? issue.ruleId ?? "";
        const message = issue.message ?? "";
        const fallbackMessage =
            !message && Array.isArray(issue.issues) && issue.issues.length
                ? issue.issues
                : [];
        const snippet = issue.snippet ?? issue.statement ?? issue.evidence ?? "";
        const objectName = issue.object ?? "";
        const lineValue = Array.isArray(issue.line)
            ? issue.line
            : issue.line ?? issue.lineNumber ?? issue.line_no ?? "";
        const columnValue = Array.isArray(issue.column)
            ? issue.column
            : issue.column ?? issue.columnNumber ?? issue.column_no ?? "";
        const sourceCandidate =
            issue.source ??
            issue.analysis_source ??
            issue.analysisSource ??
            issue.from ??
            issue.origin ??
            "";
        const sourceKey = normaliseReportSourceKey(sourceCandidate);
        const identitySegments = [
            ruleId,
            message,
            fallbackMessage,
            snippet,
            objectName,
            lineValue,
            columnValue,
            sourceKey
        ]
            .map((segment) => toIdentitySegment(segment))
            .filter((segment) => Boolean(segment));

        if (identitySegments.length) {
            return identitySegments.join("::");
        }

        try {
            return JSON.stringify(sortObjectKeys(issue));
        } catch (error) {
            console.warn("[reports] Failed to stringify issue for dedupe", error, issue);
        }
    }
    if (typeof issue === "string") {
        return issue;
    }
    return String(issue);
}

/**
 * Remove duplicate issues using a stable JSON representation for comparison.
 *
 * @template T
 * @param {T[] | null | undefined} list - Candidate issue collection.
 * @returns {T[]} Deduplicated issues preserving the original iteration order.
 */
export function dedupeIssues(list) {
    const seen = new Set();
    const result = [];
    for (const issue of list || []) {
        const key = createIssueKey(issue);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(issue);
    }
    return result;
}

/**
 * Determine whether a value is a plain object (not an array and not null).
 *
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Pick the first JSON string candidate from the provided values.
 *
 * @param {...unknown} candidates
 * @returns {string}
 */
export function pickJsonStringCandidate(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;
        const trimmed = candidate.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            return trimmed;
        }
    }
    return "";
}

/**
 * Return the first plain-object candidate from the provided values.
 *
 * @param {...unknown} candidates
 * @returns {Record<string, any> | null}
 */
export function pickReportObjectCandidate(...candidates) {
    for (const candidate of candidates) {
        if (isPlainObject(candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Normalise an arbitrary report payload into a plain object.
 *
 * @param {unknown} value
 * @param {{ fallbackKey?: string }} [options]
 * @returns {Record<string, any> | null}
 */
export function normaliseReportObject(value, options = {}) {
    if (isPlainObject(value)) {
        return value;
    }
    if (Array.isArray(value)) {
        return { issues: value };
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        const parsed = parseReportJson(trimmed);
        if (parsed) {
            return parsed;
        }
        const fallbackKey =
            typeof options.fallbackKey === "string" && options.fallbackKey.trim()
                ? options.fallbackKey
                : "report";
        return { [fallbackKey]: trimmed };
    }
    return null;
}

/**
 * Normalise an AI review payload into a predictable structure.
 *
 * @param {unknown} value
 * @returns {Record<string, any> | null}
 */
export function normaliseAiReviewPayload(value) {
    const base = normaliseReportObject(value);
    if (!base) {
        return null;
    }

    const result = { ...base };
    result.summary = isPlainObject(result.summary) ? result.summary : null;
    result.aggregated = isPlainObject(result.aggregated) ? result.aggregated : null;
    result.metadata = isPlainObject(result.metadata) ? result.metadata : null;
    result.issues = Array.isArray(result.issues) ? result.issues : [];
    result.chunks = Array.isArray(result.chunks) ? result.chunks : [];
    result.segments = Array.isArray(result.segments) ? result.segments : [];
    if (typeof result.report !== "string") {
        result.report = result.report === undefined || result.report === null ? "" : String(result.report);
    }
    if (typeof result.reportText !== "string") {
        result.reportText =
            result.reportText === undefined || result.reportText === null ? "" : String(result.reportText);
    }
    if (typeof result.error !== "string") {
        result.error = result.error === undefined || result.error === null ? "" : String(result.error);
    }
    if (typeof result.status !== "string") {
        result.status = result.status === undefined || result.status === null ? "" : String(result.status);
    }

    return result;
}

/**
 * Safely stringify a report candidate for export or preview usage.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
export function stringifyReportCandidate(value, label) {
    if (!isPlainObject(value)) {
        return "";
    }
    try {
        return JSON.stringify(value);
    } catch (error) {
        console.warn(`[reports] Failed to stringify ${label}`, error);
    }
    return "";
}

/**
 * Parse a JSON string into a report object, tolerating array payloads by wrapping them.
 *
 * @param {string} reportText
 * @returns {Record<string, any> | null}
 */
export function parseReportJson(reportText) {
    if (typeof reportText !== "string") return null;
    const trimmed = reportText.trim();
    if (!trimmed) return null;
    if (!/^\s*[\[{]/.test(trimmed)) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            return { issues: parsed };
        }
        if (parsed && typeof parsed === "object") {
            return parsed;
        }
        return null;
    } catch (_error) {
        return null;
    }
}

export default {
    normaliseReportSourceKey,
    findEntryBySourceKey,
    cloneIssueWithSource,
    remapIssuesToSource,
    dedupeIssues,
    isPlainObject,
    pickJsonStringCandidate,
    pickReportObjectCandidate,
    normaliseReportObject,
    normaliseAiReviewPayload,
    stringifyReportCandidate,
    parseReportJson
};
