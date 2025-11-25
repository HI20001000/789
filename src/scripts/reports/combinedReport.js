import {
    cloneIssueWithSource,
    dedupeIssues,
    findEntryBySourceKey,
    normaliseReportSourceKey,
    remapIssuesToSource
} from "./shared.js";

const SHOULD_LOG_ISSUES = Boolean(
    typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV
);

export function parseIssuesFromJson(json) {
    if (typeof json !== "string") {
        return [];
    }
    const trimmed = json.trim();
    if (!trimmed) {
        return [];
    }
    try {
        const parsed = JSON.parse(trimmed);
        const issues = Array.isArray(parsed?.issues) ? parsed.issues : [];
        return issues.filter((issue) => issue !== null && issue !== undefined);
    } catch (error) {
        console.warn("[report] Failed to parse issues JSON", error);
        return [];
    }
}

function logClientIssuesJson(label, issues) {
    if (!SHOULD_LOG_ISSUES) return;
    if (typeof console === "undefined" || typeof console.log !== "function") {
        return;
    }
    let serialised = "";
    try {
        serialised = JSON.stringify({ issues: Array.isArray(issues) ? issues : [] }, null, 2);
    } catch (error) {
        try {
            serialised = JSON.stringify({ issues: Array.isArray(issues) ? issues : [] });
        } catch (_innerError) {
            serialised = "{\"issues\":[]}";
        }
    }
    console.log(`[report] ${label}: ${serialised}`);
}

/**
 * Collect issues originating from the provided report sources.
 *
 * @param {Record<string, any>} state - Workspace state containing parsed reports and in-memory analysis.
 * @param {string | string[]} sourceKeys - Report source identifiers to gather issues for.
 * @returns {Array<any>} Flattened issue list tagged with the originating source.
 */
export function collectIssuesForSource(state, sourceKeys) {
    if (!state) return [];
    const sources = Array.isArray(sourceKeys) ? sourceKeys : [sourceKeys];
    const sourceSet = new Set(sources.map((key) => normaliseReportSourceKey(key)));
    const results = [];

    const pushIssue = (issue, fallbackSourceKey = null, forceSource = false) => {
        if (issue === null || issue === undefined) {
            return;
        }
        let candidate = issue;
        if (fallbackSourceKey) {
            candidate = cloneIssueWithSource(candidate, fallbackSourceKey, { force: forceSource });
        }
        results.push(candidate);
    };

    const removeIssuesBySource = (normalisedKey) => {
        if (!normalisedKey) {
            return;
        }
        for (let index = results.length - 1; index >= 0; index -= 1) {
            const existing = results[index];
            if (!existing || typeof existing !== "object") {
                continue;
            }
            const existingKey =
                normaliseReportSourceKey(existing.source) ||
                normaliseReportSourceKey(existing.analysis_source) ||
                normaliseReportSourceKey(existing.analysisSource) ||
                normaliseReportSourceKey(existing.from);
            if (existingKey === normalisedKey) {
                results.splice(index, 1);
            }
        }
    };

    const parsedIssues = state.parsedReport?.issues;
    if (Array.isArray(parsedIssues)) {
        parsedIssues.forEach((issue) => {
            const sourceValue =
                issue?.source || issue?.analysis_source || issue?.analysisSource || issue?.from;
            const normalised = normaliseReportSourceKey(sourceValue);
            if (normalised && sourceSet.has(normalised)) {
                if (normalised === normaliseReportSourceKey("static_analyzer")) {
                    return;
                }
                pushIssue(issue);
            }
        });
    }

    const reports = state.parsedReport?.reports;
    if (reports && typeof reports === "object") {
        sources.forEach((sourceKey) => {
            const reportEntry = findEntryBySourceKey(reports, sourceKey);
            const normalisedKey = normaliseReportSourceKey(sourceKey);

            if (normalisedKey === normaliseReportSourceKey("static_analyzer")) {
                const staticKey = normaliseReportSourceKey("static_analyzer");
                const enrichedIssues = [];

                const difyEntry = findEntryBySourceKey(reports, "dify_workflow");
                if (Array.isArray(difyEntry?.issues) && difyEntry.issues.length) {
                    enrichedIssues.push(
                        ...remapIssuesToSource(difyEntry.issues, sourceKey, { force: true })
                    );
                }

                const difyAggregated =
                    difyEntry?.aggregated && typeof difyEntry.aggregated === "object"
                        ? difyEntry.aggregated
                        : null;
                if (!enrichedIssues.length && difyAggregated && Array.isArray(difyAggregated.issues)) {
                    enrichedIssues.push(
                        ...remapIssuesToSource(difyAggregated.issues, sourceKey, { force: true })
                    );
                }

                const aggregated =
                    reportEntry?.aggregated && typeof reportEntry.aggregated === "object"
                        ? reportEntry.aggregated
                        : null;
                if (!enrichedIssues.length && aggregated && Array.isArray(aggregated.issues)) {
                    enrichedIssues.push(...remapIssuesToSource(aggregated.issues, sourceKey));
                }

                if (!enrichedIssues.length && Array.isArray(state.dify?.issues) && state.dify.issues.length) {
                    enrichedIssues.push(
                        ...remapIssuesToSource(state.dify.issues, sourceKey, { force: true })
                    );
                }

                if (!enrichedIssues.length && reportEntry && Array.isArray(reportEntry.issues)) {
                    enrichedIssues.push(...remapIssuesToSource(reportEntry.issues, sourceKey));
                }

                if (enrichedIssues.length) {
                    removeIssuesBySource(staticKey);
                    dedupeIssues(enrichedIssues).forEach((issue) => pushIssue(issue));
                }
            } else {
                if (reportEntry && Array.isArray(reportEntry.issues)) {
                    reportEntry.issues.forEach((issue) => pushIssue(issue, sourceKey));
                }
                const aggregated =
                    reportEntry?.aggregated && typeof reportEntry.aggregated === "object"
                        ? reportEntry.aggregated
                        : null;
                if (aggregated && Array.isArray(aggregated.issues)) {
                    aggregated.issues.forEach((issue) => pushIssue(issue, sourceKey));
                }
            }
        });
    }

    const analysisIssues = state.analysis?.issues;
    if (Array.isArray(analysisIssues)) {
        analysisIssues.forEach((issue) => {
            const sourceValue =
                issue?.source || issue?.analysis_source || issue?.analysisSource || issue?.from;
            const normalised = normaliseReportSourceKey(sourceValue);
            if (normalised && sourceSet.has(normalised)) {
                pushIssue(issue);
            }
        });
    }

    const difyIssues = state.dify?.issues;
    if (Array.isArray(difyIssues)) {
        difyIssues.forEach((issue) => {
            const targetKey = normaliseReportSourceKey(issue?.source) || normaliseReportSourceKey("dify_workflow");
            if (sourceSet.has(targetKey)) {
                const fallbackSource = issue?.source || "dify_workflow";
                pushIssue(issue, fallbackSource);
            }
        });
    }

    const dmlIssues = state.dml?.issues;
    if (Array.isArray(dmlIssues)) {
        dmlIssues.forEach((issue) => {
            const targetKey =
                normaliseReportSourceKey(issue?.source) || normaliseReportSourceKey("dml_prompt");
            if (sourceSet.has(targetKey)) {
                const fallbackSource = issue?.source || "dml_prompt";
                pushIssue(issue, fallbackSource);
            }
        });
    }

    const sourceKeySet = new Set(sources.map((key) => normaliseReportSourceKey(key)));

    if (sourceKeySet.has(normaliseReportSourceKey("static_analyzer"))) {
        const reports = state.analysis && typeof state.analysis === "object" ? state.analysis : null;
        if (reports?.staticReport && typeof reports.staticReport === "object") {
            const staticIssues = reports.staticReport.issues;
            if (Array.isArray(staticIssues)) {
                dedupeIssues(remapIssuesToSource(staticIssues, "static_analyzer")).forEach((issue) =>
                    pushIssue(issue)
                );
            }
        }
    }

    if (sourceKeySet.has(normaliseReportSourceKey("dml_prompt"))) {
        const aiReportIssues = parseIssuesFromJson(state?.aiReportJson);
        if (aiReportIssues.length) {
            const aiKey = normaliseReportSourceKey("dml_prompt");
            removeIssuesBySource(aiKey);
            dedupeIssues(remapIssuesToSource(aiReportIssues, "dml_prompt", { force: true })).forEach(
                (issue) => pushIssue(issue)
            );
        }

        const dmlReport = state.analysis?.dmlReport && typeof state.analysis.dmlReport === "object"
            ? state.analysis.dmlReport
            : null;
        if (!aiReportIssues.length && Array.isArray(dmlReport?.issues)) {
            dedupeIssues(remapIssuesToSource(dmlReport.issues, "dml_prompt")).forEach((issue) =>
                pushIssue(issue)
            );
        }
    }

    return dedupeIssues(results);
}

/**
 * Gather a best-effort set of aggregated issues across static analysis, AI reviews and Dify workflows.
 *
 * @param {Record<string, any>} state - Workspace report state.
 * @returns {Array<any>} Aggregated and deduplicated issue list.
 */
export function collectAggregatedIssues(state) {
    if (!state) return [];

    const combinedIssues = (() => {
        if (typeof state.combinedReportJson !== "string") {
            return [];
        }
        const trimmed = state.combinedReportJson.trim();
        if (!trimmed) {
            return [];
        }
        try {
            const parsed = JSON.parse(trimmed);
            const issues = Array.isArray(parsed?.issues) ? parsed.issues : [];
            if (!issues.length) {
                return [];
            }
            return issues.map((issue) => {
                if (issue && typeof issue === "object" && !Array.isArray(issue)) {
                    const hasSource = Boolean(
                        issue.source || issue.analysis_source || issue.analysisSource || issue.from
                    );
                    if (hasSource) {
                        return issue;
                    }
                    return { ...issue, source: "combined" };
                }
                return issue;
            });
        } catch (error) {
            console.warn("[reports] Failed to parse combined report JSON issues", error);
            return [];
        }
    })();

    if (combinedIssues.length) {
        return dedupeIssues(combinedIssues);
    }

    const staticIssues = collectIssuesForSource(state, ["static_analyzer"]);
    const aiIssues = collectIssuesForSource(state, ["dml_prompt"]);
    const difyIssues = collectIssuesForSource(state, ["dify_workflow"]);
    const difyAsStatic =
        difyIssues.length > 0
            ? remapIssuesToSource(difyIssues, "static_analyzer", { force: true })
            : [];

    const combined = dedupeIssues([...difyAsStatic, ...staticIssues, ...aiIssues]);
    if (combined.length > 0) {
        return combined;
    }

    if (difyAsStatic.length > 0) {
        return dedupeIssues([...difyAsStatic, ...aiIssues]);
    }

    const parsedIssues = Array.isArray(state.parsedReport?.issues)
        ? remapIssuesToSource(state.parsedReport.issues, "static_analyzer")
        : [];
    if (parsedIssues.length > 0) {
        return dedupeIssues([...parsedIssues, ...aiIssues]);
    }

    const staticFallback = Array.isArray(state.analysis?.staticReport?.issues)
        ? remapIssuesToSource(state.analysis.staticReport.issues, "static_analyzer")
        : [];
    if (staticFallback.length > 0) {
        return dedupeIssues([...staticFallback, ...aiIssues]);
    }

    const dmlIssues = Array.isArray(state.dml?.issues)
        ? dedupeIssues(state.dml.issues)
        : [];
    if (dmlIssues.length > 0) {
        return dmlIssues;
    }

    return [];
}

/**
 * Update the `issueSummary.totalIssues` property on the supplied state in place.
 *
 * @param {Record<string, any>} state - Workspace report state subject to mutation.
 * @returns {void}
 */
export function updateIssueSummaryTotals(state) {
    if (!state) return;
    const combinedIssues = collectAggregatedIssues(state);
    const total = Number.isFinite(combinedIssues.length) ? combinedIssues.length : null;
    if (total === null) {
        return;
    }
    if (!state.issueSummary || typeof state.issueSummary !== "object") {
        state.issueSummary = { totalIssues: total };
        return;
    }
    state.issueSummary.totalIssues = total;
}

/**
 * Extract a summary object matching the requested report source from state.
 *
 * @param {Record<string, any>} state - Workspace report state.
 * @param {string} sourceKey - Desired source identifier.
 * @returns {Record<string, any> | null} Summary candidate or null when not available.
 */
export function extractSummaryCandidate(state, sourceKey) {
    if (!state) return null;
    if (sourceKey) {
        const normalisedKey = normaliseReportSourceKey(sourceKey);
        if (normalisedKey === normaliseReportSourceKey("static_analyzer")) {
            const staticSummary = state.analysis?.staticReport?.summary;
            if (staticSummary && typeof staticSummary === "object" && !Array.isArray(staticSummary)) {
                return staticSummary;
            }
        }
        if (normalisedKey === normaliseReportSourceKey("dml_prompt")) {
            const dmlSummary = state.dml?.summary || state.analysis?.dmlSummary;
            if (dmlSummary && typeof dmlSummary === "object" && !Array.isArray(dmlSummary)) {
                return dmlSummary;
            }
        }
        if (normalisedKey === normaliseReportSourceKey("dify_workflow")) {
            const difySummary = state.analysis?.dify?.summary;
            if (difySummary && typeof difySummary === "object" && !Array.isArray(difySummary)) {
                return difySummary;
            }
        }
    }

    return null;
}

function normaliseTimestampValue(value) {
    if (!value) return null;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (typeof value === "number") {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed || null;
    }
    return null;
}

/**
 * Build a normalised summary record suitable for UI presentation.
 *
 * @param {Record<string, any> | string | null} summarySource - Source summary data.
 * @param {{ source: string, label: string, issues?: Array<any> }} options - Render options.
 * @returns {Record<string, any>} Normalised summary payload.
 */
export function buildSummaryRecord(summarySource, options) {
    const issues = Array.isArray(options.issues) ? options.issues : [];
    const record = {
        source: options.source,
        label: options.label,
        total_issues: issues.length
    };

    if (summarySource && typeof summarySource === "object" && !Array.isArray(summarySource)) {
        const statusValue =
            typeof summarySource.status === "string"
                ? summarySource.status
                : typeof summarySource.status_label === "string"
                ? summarySource.status_label
                : typeof summarySource.statusLabel === "string"
                ? summarySource.statusLabel
                : "";
        if (statusValue && statusValue.trim()) {
            record.status = statusValue.trim();
        }
        const generatedAtValue =
            summarySource.generated_at ??
            summarySource.generatedAt ??
            summarySource.generated_at_display ??
            summarySource.generatedAtDisplay ??
            null;
        const normalisedTimestamp = normaliseTimestampValue(generatedAtValue);
        if (normalisedTimestamp) {
            record.generated_at = normalisedTimestamp;
        }
        const errorValue =
            typeof summarySource.error_message === "string"
                ? summarySource.error_message
                : typeof summarySource.errorMessage === "string"
                ? summarySource.errorMessage
                : "";
        if (errorValue && errorValue.trim()) {
            record.error_message = errorValue.trim();
        }
        const messageValue =
            typeof summarySource.message === "string" ? summarySource.message : summarySource.note;
        if (messageValue && typeof messageValue === "string" && messageValue.trim()) {
            record.message = messageValue.trim();
        }
    } else if (typeof summarySource === "string") {
        const trimmed = summarySource.trim();
        if (trimmed) {
            record.message = trimmed;
        }
    }

    return record;
}

/**
 * Build a summary record scoped to a particular report source.
 *
 * @param {Record<string, any>} state - Workspace report state.
 * @param {{ sourceKey: string, label: string, issues?: Array<any> }} options - Source configuration.
 * @returns {Record<string, any>} Summary record.
 */
export function buildSourceSummaryRecord(state, options) {
    const summaryCandidate = extractSummaryCandidate(state, options.sourceKey);
    const record = buildSummaryRecord(summaryCandidate, {
        source: options.sourceKey,
        label: options.label,
        issues: options.issues
    });

    const normalisedKey = normaliseReportSourceKey(options.sourceKey);
    if (!record.status) {
        if (normalisedKey === normaliseReportSourceKey("static_analyzer")) {
            const fallbackStatus = pickStringCandidate(
                state?.analysis?.staticReport?.summary?.status,
                state?.analysis?.staticReport?.status,
                state?.analysis?.enrichmentStatus
            );
            if (fallbackStatus) {
                record.status = fallbackStatus;
            }
        } else if (normalisedKey === normaliseReportSourceKey("dml_prompt")) {
            const fallbackStatus = pickStringCandidate(
                state?.analysis?.dmlSummary?.status,
                state?.analysis?.dmlReport?.summary?.status,
                state?.analysis?.dmlStatus,
                state?.dml?.summary?.status
            );
            if (fallbackStatus) {
                record.status = fallbackStatus;
            }
        }
    }

    if (!record.generated_at) {
        if (normalisedKey === normaliseReportSourceKey("static_analyzer")) {
            const generatedAt = pickFirstCandidate(
                state?.analysis?.staticReport?.generatedAt,
                state?.analysis?.generatedAt,
                state?.generatedAt
            );
            if (generatedAt) {
                record.generated_at = generatedAt;
            }
        } else if (normalisedKey === normaliseReportSourceKey("dml_prompt")) {
            const generatedAt = pickFirstCandidate(
                state?.analysis?.dmlGeneratedAt,
                state?.analysis?.dmlReport?.generatedAt,
                state?.dml?.generatedAt
            );
            if (generatedAt) {
                record.generated_at = generatedAt;
            }
        }
    }

    if (!record.error_message) {
        if (normalisedKey === normaliseReportSourceKey("static_analyzer")) {
            const errorMessage = pickStringCandidate(
                state?.analysis?.staticReport?.summary?.error_message,
                state?.analysis?.staticReport?.summary?.errorMessage,
                state?.analysis?.staticReport?.error,
                state?.analysis?.enrichmentError
            );
            if (errorMessage) {
                record.error_message = errorMessage;
            }
        } else if (normalisedKey === normaliseReportSourceKey("dml_prompt")) {
            const errorMessage = pickStringCandidate(
                state?.analysis?.dmlErrorMessage,
                state?.analysis?.dmlReport?.summary?.error_message,
                state?.analysis?.dmlReport?.summary?.errorMessage,
                state?.dmlErrorMessage
            );
            if (errorMessage) {
                record.error_message = errorMessage;
            }
        }
    }

    return record;
}

/**
 * Construct a combined summary record derived from the global report summary.
 *
 * @param {Record<string, any>} state - Workspace report state.
 * @param {{ label?: string, issues?: Array<any> }} options - Presentation overrides.
 * @returns {Record<string, any>} Summary record for the combined view.
 */
export function buildCombinedSummaryRecord(state, options) {
    const globalSummary = state?.parsedReport?.summary || null;
    const record = buildSummaryRecord(globalSummary, {
        source: "combined",
        label: options.label || "聚合報告",
        issues: options.issues
    });

    if (!record.status) {
        const fallbackStatus = pickStringCandidate(
            state?.analysis?.dify?.status,
            state?.analysis?.difySummary?.status,
            state?.analysis?.difyReport?.summary?.status,
            state?.dify?.status
        );
        if (fallbackStatus) {
            record.status = fallbackStatus;
        }
    }

    if (!record.generated_at) {
        const generatedAt = pickFirstCandidate(
            state?.analysis?.difySummary?.generated_at,
            state?.analysis?.difySummary?.generatedAt,
            state?.analysis?.dify?.generatedAt
        );
        if (generatedAt) {
            record.generated_at = generatedAt;
        }
    }

    if (!record.error_message) {
        const errorMessage = pickStringCandidate(
            state?.analysis?.difyErrorMessage,
            state?.analysis?.difySummary?.error_message,
            state?.analysis?.difySummary?.errorMessage,
            state?.difyErrorMessage
        );
        if (errorMessage) {
            record.error_message = errorMessage;
        }
    }

    return record;
}

/**
 * Produce a trio of summary records for static, AI and combined report contexts.
 *
 * @param {Record<string, any>} state - Workspace report state.
 * @param {Array<any>} staticIssues - Static report issues.
 * @param {Array<any>} aiIssues - AI review issues.
 * @param {Array<any> | null} [aggregatedIssues] - Optional pre-aggregated issues.
 * @returns {Array<Record<string, any>>} Summary records in display order.
 */
export function buildAggregatedSummaryRecords(state, staticIssues, aiIssues, aggregatedIssues = null) {
    const records = [];
    records.push(
        buildSourceSummaryRecord(state, {
            sourceKey: "static_analyzer",
            label: "靜態分析器",
            issues: staticIssues
        })
    );
    records.push(
        buildSourceSummaryRecord(state, {
            sourceKey: "dml_prompt",
            label: "AI審查",
            issues: aiIssues
        })
    );
    records.push(
        buildCombinedSummaryRecord(state, {
            label: "聚合報告",
            issues:
                Array.isArray(aggregatedIssues) && aggregatedIssues.length
                    ? aggregatedIssues
                    : dedupeIssues([...staticIssues, ...aiIssues])
        })
    );
    return records;
}

/**
 * Convert a summary-like object into labelled detail rows for UI consumption.
 *
 * @param {Record<string, any>} source - Summary object to flatten.
 * @param {{ omitKeys?: string[] }} [options] - Keys to omit from the output.
 * @returns {Array<{ label: string, value: string }>} Detail rows.
 */
export function buildSummaryDetailList(source, options = {}) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
        return [];
    }

    const omit = new Set(options.omitKeys || []);
    const details = [];

    for (const [key, rawValue] of Object.entries(source)) {
        if (omit.has(key)) continue;
        if (rawValue === null || rawValue === undefined) continue;
        if (typeof rawValue === "object") continue;

        let value;
        if (typeof rawValue === "boolean") {
            value = rawValue ? "是" : "否";
        } else {
            value = String(rawValue);
        }

        const label = typeof key === "string" && key.trim() ? key : "-";
        details.push({ label, value });
    }

    return details;
}

export function buildCombinedReportPayload(state) {
    if (!state) {
        return {
            summary: [],
            issues: []
        };
    }

    const staticIssues = collectIssuesForSource(state, ["static_analyzer"]);
    const aiIssues = collectIssuesForSource(state, ["dml_prompt"]);
    const aggregatedIssues = collectAggregatedIssues(state);
    const summaryRecords = buildAggregatedSummaryRecords(state, staticIssues, aiIssues, aggregatedIssues);

    logClientIssuesJson("static.issues.json", staticIssues);
    logClientIssuesJson("ai.issues.json", aiIssues);

    const cloneIssues = (issues) =>
        (Array.isArray(issues) ? issues : []).map((issue) =>
            issue && typeof issue === "object" && !Array.isArray(issue) ? { ...issue } : issue
        );

    const combinedIssueList = cloneIssues(aggregatedIssues);

    const cloneSummaryRecords = Array.isArray(summaryRecords)
        ? summaryRecords.map((record) =>
              record && typeof record === "object" && !Array.isArray(record) ? { ...record } : record
          )
        : [];

    logClientIssuesJson("combined.issues.json", combinedIssueList);

    return {
        summary: cloneSummaryRecords,
        issues: combinedIssueList
    };
}

export function buildCombinedReportJsonExport(state) {
    if (state && typeof state === "object" && typeof state.combinedReportJson === "string") {
        const stored = state.combinedReportJson.trim();
        if (stored) {
            try {
                const parsed = JSON.parse(stored);
                const summary = Array.isArray(parsed?.summary)
                    ? parsed.summary.map((entry) =>
                          entry && typeof entry === "object" && !Array.isArray(entry) ? { ...entry } : entry
                      )
                    : [];
                const issues = Array.isArray(parsed?.issues)
                    ? parsed.issues.map((issue) =>
                          issue && typeof issue === "object" && !Array.isArray(issue) ? { ...issue } : issue
                      )
                    : [];
                return { summary, issues };
            } catch (error) {
                console.warn("[combined-report] Failed to parse stored combined report JSON", error);
            }
        }
    }

    const payload = buildCombinedReportPayload(state);
    const summary = Array.isArray(payload?.summary)
        ? payload.summary.map((entry) =>
              entry && typeof entry === "object" && !Array.isArray(entry) ? { ...entry } : entry
          )
        : [];
    const issues = Array.isArray(payload?.issues)
        ? payload.issues.map((issue) =>
              issue && typeof issue === "object" && !Array.isArray(issue) ? { ...issue } : issue
          )
        : [];

    return { summary, issues };
}

function normaliseDetailSeverity(detail) {
    const arrayCandidate = Array.isArray(detail?.severity_levels)
        ? detail.severity_levels.find((value) => typeof value === "string" && value.trim())
        : Array.isArray(detail?.severityLevels)
        ? detail.severityLevels.find((value) => typeof value === "string" && value.trim())
        : null;
    const candidates = [detail?.severityLabel, detail?.severity_label, detail?.severity, arrayCandidate];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }
    return "未標示";
}

export function buildIssueDistributions(issues, options = {}) {
    const severityCounts = new Map();
    const ruleCounts = new Map();

    const increment = (map, key, value = 1) => {
        if (!key) return;
        const numeric = Number(value);
        const current = map.get(key) || 0;
        map.set(key, current + (Number.isFinite(numeric) ? numeric : 0));
    };

    (Array.isArray(issues) ? issues : []).forEach((issue) => {
        if (!issue || typeof issue !== "object") return;
        const detailList = Array.isArray(issue.details) && issue.details.length ? issue.details : [issue];
        detailList.forEach((detail) => {
            if (!detail || typeof detail !== "object") return;
            const severityLabel = normaliseDetailSeverity(detail) || "未標示";
            increment(severityCounts, severityLabel);
            const ruleCandidates = [];
            if (typeof detail.ruleId === "string") {
                ruleCandidates.push(detail.ruleId.trim());
            }
            if (typeof detail.rule_id === "string") {
                ruleCandidates.push(detail.rule_id.trim());
            }
            if (Array.isArray(detail.ruleIds)) {
                ruleCandidates.push(
                    ...detail.ruleIds.map((value) => (typeof value === "string" ? value.trim() : ""))
                );
            }
            if (Array.isArray(detail.rule_ids)) {
                ruleCandidates.push(
                    ...detail.rule_ids.map((value) => (typeof value === "string" ? value.trim() : ""))
                );
            }
            if (typeof detail.rule === "string") {
                ruleCandidates.push(detail.rule.trim());
            }
            const uniqueRules = Array.from(new Set(ruleCandidates.filter((value) => Boolean(value))));
            if (!uniqueRules.length) {
                return;
            }
            uniqueRules.forEach((ruleId) => increment(ruleCounts, ruleId));
        });
    });

    const byRuleSource = options.summaryByRule && typeof options.summaryByRule === "object"
        ? options.summaryByRule
        : null;
    if (byRuleSource) {
        Object.entries(byRuleSource).forEach(([label, count]) => {
            const key = typeof label === "string" && label.trim() ? label.trim() : "未分類";
            const numeric = Number(count);
            if (!Number.isFinite(numeric)) return;
            const existing = ruleCounts.get(key) || 0;
            if (numeric > existing) {
                ruleCounts.set(key, numeric);
            }
        });
    }

    const severityBreakdown = Array.from(severityCounts.entries()).map(([label, count]) => ({
        label,
        count
    }));
    severityBreakdown.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    const ruleBreakdown = Array.from(ruleCounts.entries())
        .filter(([, count]) => Number.isFinite(count) && count > 0)
        .map(([label, count]) => ({
            label,
            count
        }));
    ruleBreakdown.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    return { severityBreakdown, ruleBreakdown };
}

function normaliseSourceKey(value) {
    return typeof value === "string" ? value.toLowerCase() : "";
}

function pickStringCandidate(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === "string") {
            const trimmed = candidate.trim();
            if (trimmed) {
                return trimmed;
            }
        }
    }
    return "";
}

function pickFirstCandidate(...candidates) {
    for (const candidate of candidates) {
        if (candidate !== null && candidate !== undefined && candidate !== "") {
            return candidate;
        }
    }
    return null;
}

function buildSourceMetrics(...sources) {
    const metrics = [];
    const seen = new Set();
    const pushMetric = (label, rawValue, transform = (value) => value) => {
        if (!label || rawValue === undefined || rawValue === null) return;
        const value = transform(rawValue);
        if (value === null || value === undefined || value === "") return;
        if (seen.has(label)) return;
        seen.add(label);
        metrics.push({ label, value });
    };

    for (const source of sources) {
        if (!source || typeof source !== "object") continue;
        pushMetric(
            "問題數",
            source.total_issues ?? source.totalIssues,
            (candidate) => {
                const numeric = Number(candidate);
                return Number.isFinite(numeric) ? numeric : Number(candidate ?? 0) || 0;
            }
        );
        if (source.by_rule || source.byRule) {
            const byRuleEntries = Object.entries(source.by_rule || source.byRule || {});
            pushMetric("規則數", byRuleEntries.length, (count) => Number(count) || 0);
        }
        pushMetric(
            "拆分語句",
            source.total_segments ?? source.totalSegments,
            (candidate) => {
                const numeric = Number(candidate);
                return Number.isFinite(numeric) ? numeric : Number(candidate ?? 0) || 0;
            }
        );
        pushMetric(
            "已分析段數",
            source.analyzed_segments ?? source.analyzedSegments,
            (candidate) => {
                const numeric = Number(candidate);
                return Number.isFinite(numeric) ? numeric : Number(candidate ?? 0) || 0;
            }
        );
    }

    return metrics;
}

function mergeMetricLists(base, extra) {
    if (!Array.isArray(base) || !base.length) return Array.isArray(extra) ? [...extra] : [];
    if (!Array.isArray(extra) || !extra.length) return [...base];
    const merged = [...base];
    const seen = new Set(base.map((item) => item.label));
    extra.forEach((item) => {
        if (!item || typeof item !== "object") return;
        if (seen.has(item.label)) return;
        seen.add(item.label);
        merged.push(item);
    });
    return merged;
}

const DIFY_STATUS_SOURCES = new Set([
    "static_analyzer",
    "staticanalyzer",
    "dml_prompt",
    "dmlprompt",
    "dify_workflow",
    "difyworkflow"
]);

const DIFY_STATUS_BASE_LABELS = {
    static_analyzer: "Dify 補充",
    staticanalyzer: "Dify 補充",
    dml_prompt: "Dify 審查",
    dmlprompt: "Dify 審查",
    dify_workflow: "Dify 聚合",
    difyworkflow: "Dify 聚合"
};

function interpretStatusKind(normalised) {
    if (!normalised) return "empty";
    if (/(success|succeed|succeeded|completed|complete|done|ok|ready|finish|finished)/.test(normalised)) {
        return "success";
    }
    if (/(cancel|canceled|cancelled|aborted)/.test(normalised)) {
        return "cancelled";
    }
    if (/(fail|error|errored|denied|rejected|fault|invalid)/.test(normalised)) {
        return "error";
    }
    if (/(pending|process|progress|running|working|generat|queue|queued|prepar|start|loading|execut)/.test(normalised)) {
        return "processing";
    }
    if (/(idle|wait|waiting|none|standby|initial)/.test(normalised)) {
        return "idle";
    }
    return "unknown";
}

function formatStatusForSource(keyLower, status) {
    const trimmed = typeof status === "string" ? status.trim() : "";
    if (!DIFY_STATUS_SOURCES.has(keyLower)) {
        return { raw: trimmed, display: trimmed };
    }

    const baseLabel = DIFY_STATUS_BASE_LABELS[keyLower] || "Dify";
    if (!trimmed) {
        return { raw: "", display: `${baseLabel} 尚未執行` };
    }

    const normalised = trimmed.toLowerCase();
    const kind = interpretStatusKind(normalised);
    if (kind === "success") {
        return { raw: trimmed, display: `${baseLabel} 完成` };
    }
    if (kind === "error") {
        return { raw: trimmed, display: `${baseLabel} 失敗` };
    }
    if (kind === "cancelled") {
        return { raw: trimmed, display: `${baseLabel} 已取消` };
    }
    if (kind === "processing") {
        return { raw: trimmed, display: `${baseLabel} 處理中` };
    }
    if (kind === "idle") {
        return { raw: trimmed, display: `${baseLabel} 尚未執行` };
    }

    return { raw: trimmed, display: `${baseLabel}：${trimmed}` };
}

export function buildSourceSummaries(options = {}) {
    const {
        summaryRecords = [],
        globalSummary = null,
        staticSummary = null,
        analysisState = null,
        state = null,
        dmlReport = null,
        dmlSummary = null,
        dmlDetails = null,
        combinedSummarySource = null
    } = options;

    const sourceSummaries = [];

    if (globalSummary?.sources && typeof globalSummary.sources === "object") {
        for (const [key, value] of Object.entries(globalSummary.sources)) {
            if (!value || typeof value !== "object") continue;
            const keyLower = normaliseSourceKey(key);
            let label = key;
            if (keyLower === "static_analyzer" || keyLower === "staticanalyzer") {
                label = "靜態分析器";
            } else if (keyLower === "dml_prompt" || keyLower === "dmlprompt") {
                label = "AI審查";
            } else if (keyLower === "dify_workflow" || keyLower === "difyworkflow") {
                label = "聚合報告";
            }

            const metrics = buildSourceMetrics(value);
            const status = pickStringCandidate(value.status);
            const errorMessage = pickStringCandidate(value.error_message, value.errorMessage);
            const generatedAt = pickFirstCandidate(value.generated_at, value.generatedAt);
            const statusResult = formatStatusForSource(keyLower, status);

            sourceSummaries.push({
                key,
                keyLower,
                label,
                metrics,
                status: statusResult.display,
                statusRaw: statusResult.raw,
                errorMessage,
                generatedAt
            });
        }
    }

    const enhanceSourceSummary = (keyLower, label, enhanceOptions = {}) => {
        const entry = sourceSummaries.find((item) => item.keyLower === keyLower);
        const metrics = buildSourceMetrics(...(enhanceOptions.metricsSources || []));
        const status = pickStringCandidate(...(enhanceOptions.statusCandidates || []));
        const errorMessage = pickStringCandidate(...(enhanceOptions.errorCandidates || []));
        const generatedAt = pickFirstCandidate(...(enhanceOptions.generatedAtCandidates || []));
        const statusResult = formatStatusForSource(keyLower, status);

        if (entry) {
            entry.label = label;
            if (metrics.length) {
                entry.metrics = mergeMetricLists(entry.metrics, metrics);
            }
            if (statusResult.raw) {
                entry.statusRaw = statusResult.raw;
                entry.status = statusResult.display;
            } else if (!entry.status) {
                entry.statusRaw = statusResult.raw;
                entry.status = statusResult.display;
            }
            if (!entry.errorMessage) {
                entry.errorMessage = errorMessage;
            }
            if (!entry.generatedAt) {
                entry.generatedAt = generatedAt;
            }
        } else if (metrics.length || statusResult.display || errorMessage || generatedAt) {
            sourceSummaries.push({
                key: enhanceOptions.key || keyLower,
                keyLower,
                label,
                metrics,
                status: statusResult.display,
                statusRaw: statusResult.raw,
                errorMessage,
                generatedAt
            });
        }
    };

    const applySummaryRecords = (records) => {
        if (!Array.isArray(records)) return;
        records.forEach((record) => {
            if (!record || typeof record !== "object") return;
            const keyLower = normaliseSourceKey(record.source);
            if (!keyLower) return;
            const label =
                typeof record.label === "string" && record.label.trim()
                    ? record.label.trim()
                    : record.source || keyLower;
            const existingIndex = sourceSummaries.findIndex((item) => item.keyLower === keyLower);
            if (existingIndex !== -1) {
                sourceSummaries.splice(existingIndex, 1);
            }
            enhanceSourceSummary(keyLower, label, {
                key: record.source || keyLower,
                metricsSources: [record],
                statusCandidates: [record.status],
                errorCandidates: [record.error_message, record.errorMessage, record.message],
                generatedAtCandidates: [record.generated_at, record.generatedAt]
            });
        });
    };

    applySummaryRecords(summaryRecords);

    const staticSourceValue =
        globalSummary?.sources?.static_analyzer || globalSummary?.sources?.staticAnalyzer || null;
    const staticAnalysis =
        analysisState?.staticReport && typeof analysisState.staticReport === "object"
            ? analysisState.staticReport
            : null;
    enhanceSourceSummary("static_analyzer", "靜態分析器", {
        metricsSources: [staticSourceValue, staticSummary],
        statusCandidates: [
            staticSourceValue?.status,
            staticSummary?.status,
            staticSummary?.status_label,
            staticSummary?.statusLabel,
            staticAnalysis?.summary?.status,
            staticAnalysis?.status,
            analysisState?.enrichmentStatus
        ],
        errorCandidates: [
            staticSourceValue?.error_message,
            staticSourceValue?.errorMessage,
            staticSummary?.error_message,
            staticSummary?.errorMessage,
            staticAnalysis?.summary?.error_message,
            staticAnalysis?.summary?.errorMessage,
            staticAnalysis?.error
        ],
        generatedAtCandidates: [
            staticSourceValue?.generated_at,
            staticSourceValue?.generatedAt,
            staticSummary?.generated_at,
            staticSummary?.generatedAt,
            staticAnalysis?.generatedAt,
            staticAnalysis?.summary?.generated_at,
            staticAnalysis?.summary?.generatedAt,
            state?.generatedAt,
            analysisState?.generatedAt
        ]
    });

    const dmlSourceValue = globalSummary?.sources?.dml_prompt || globalSummary?.sources?.dmlPrompt || null;
    enhanceSourceSummary("dml_prompt", "AI審查", {
        metricsSources: [dmlSourceValue, dmlDetails?.summary, dmlDetails?.aggregated],
        statusCandidates: [
            dmlSourceValue?.status,
            dmlDetails?.status,
            dmlSummary?.status,
            analysisState?.dmlSummary?.status,
            analysisState?.dmlReport?.summary?.status
        ],
        errorCandidates: [
            dmlSourceValue?.error_message,
            dmlSourceValue?.errorMessage,
            dmlDetails?.error,
            dmlSummary?.error_message,
            dmlSummary?.errorMessage,
            analysisState?.dmlErrorMessage
        ],
        generatedAtCandidates: [
            dmlSourceValue?.generated_at,
            dmlSourceValue?.generatedAt,
            dmlDetails?.generatedAt,
            dmlReport?.generatedAt,
            dmlSummary?.generated_at,
            dmlSummary?.generatedAt,
            analysisState?.dmlGeneratedAt
        ]
    });

    const combinedSummarySourceValue =
        globalSummary?.sources?.dify_workflow || globalSummary?.sources?.difyWorkflow || null;
    enhanceSourceSummary("dify_workflow", "聚合報告", {
        metricsSources: [combinedSummarySourceValue, globalSummary, combinedSummarySource, analysisState?.difySummary],
        statusCandidates: [
            combinedSummarySourceValue?.status,
            globalSummary?.status,
            analysisState?.dify?.status,
            analysisState?.difySummary?.status,
            analysisState?.difyReport?.summary?.status
        ],
        errorCandidates: [
            combinedSummarySourceValue?.error_message,
            combinedSummarySourceValue?.errorMessage,
            globalSummary?.error_message,
            globalSummary?.errorMessage,
            analysisState?.difyErrorMessage,
            analysisState?.difySummary?.error_message,
            analysisState?.difySummary?.errorMessage,
            analysisState?.difyReport?.summary?.error_message,
            analysisState?.difyReport?.summary?.errorMessage,
            state?.difyErrorMessage
        ],
        generatedAtCandidates: [
            combinedSummarySourceValue?.generated_at,
            combinedSummarySourceValue?.generatedAt,
            globalSummary?.generated_at,
            globalSummary?.generatedAt,
            analysisState?.difySummary?.generated_at,
            analysisState?.difySummary?.generatedAt,
            analysisState?.dify?.generatedAt
        ]
    });

    return sourceSummaries.map(({ keyLower, ...item }) => item);
}

export function collectIssueSummaryTotals(reportStates, options = {}) {
    const totals = new Map();
    if (!reportStates || typeof reportStates !== "object") {
        return totals;
    }
    const parseKey = typeof options.parseKey === "function" ? options.parseKey : (key) => ({ projectId: key });
    Object.entries(reportStates).forEach(([key, state]) => {
        const summary = state?.issueSummary;
        if (!summary || !Number.isFinite(summary.totalIssues)) return;
        const parsed = parseKey(key) || {};
        const projectId = parsed.projectId;
        if (!projectId) return;
        const previous = totals.get(projectId);
        const base = typeof previous === "number" && Number.isFinite(previous) ? previous : 0;
        totals.set(projectId, base + summary.totalIssues);
    });
    return totals;
}

export default {
    collectIssuesForSource,
    collectAggregatedIssues,
    updateIssueSummaryTotals,
    extractSummaryCandidate,
    buildSummaryRecord,
    buildSourceSummaryRecord,
    buildCombinedSummaryRecord,
    buildAggregatedSummaryRecords,
    buildSummaryDetailList,
    buildCombinedReportPayload,
    buildIssueDistributions,
    buildSourceSummaries,
    collectIssueSummaryTotals
};
