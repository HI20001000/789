import { normaliseJsonContent } from "../reports/exportJson.js";

function normaliseProjectId(projectId) {
    if (projectId === null || projectId === undefined) return "";
    return String(projectId);
}

function parseLineValue(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return { start: value, end: value, label: String(value) };
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return null;
        const rangeMatch = trimmed.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
        if (rangeMatch) {
            const start = Number(rangeMatch[1]);
            const end = Number(rangeMatch[2] || rangeMatch[1]);
            if (Number.isFinite(start) && Number.isFinite(end)) {
                const safeStart = Math.min(start, end);
                const safeEnd = Math.max(start, end);
                return {
                    start: safeStart,
                    end: safeEnd,
                    label: safeStart === safeEnd ? String(safeStart) : `${safeStart}-${safeEnd}`
                };
            }
        }
    }
    if (Array.isArray(value)) {
        const [first, second] = value;
        const start = Number(first);
        const end = second === undefined ? start : Number(second);
        if (Number.isFinite(start) && Number.isFinite(end)) {
            const safeStart = Math.min(start, end);
            const safeEnd = Math.max(start, end);
            return {
                start: safeStart,
                end: safeEnd,
                label: safeStart === safeEnd ? String(safeStart) : `${safeStart}-${safeEnd}`
            };
        }
    }
    if (value && typeof value === "object") {
        const start = Number(value.start ?? value.begin ?? value.from ?? value.line ?? value.lineStart);
        const end = Number(
            value.end ?? value.finish ?? value.to ?? value.lineEnd ?? value.line_finish ?? value.lineEndNumber
        );
        if (Number.isFinite(start) && Number.isFinite(end)) {
            const safeStart = Math.min(start, end);
            const safeEnd = Math.max(start, end);
            return {
                start: safeStart,
                end: safeEnd,
                label: safeStart === safeEnd ? String(safeStart) : `${safeStart}-${safeEnd}`
            };
        }
        if (Number.isFinite(start)) {
            return { start, end: start, label: String(start) };
        }
    }
    return null;
}

function extractIssueLine(issue) {
    if (!issue || typeof issue !== "object") return { start: null, end: null, label: "" };

    const candidates = [
        issue.line,
        issue.lineRange,
        issue.range,
        issue.line_no,
        issue.lineNo,
        issue.start_line,
        issue.startLine,
        issue.meta?.line,
        issue.metadata?.line
    ];

    for (const candidate of candidates) {
        const parsed = parseLineValue(candidate);
        if (parsed) return parsed;
    }

    if (Array.isArray(issue.details)) {
        for (const detail of issue.details) {
            const parsed = extractIssueLine(detail);
            if (parsed.label) return parsed;
        }
    }

    return { start: null, end: null, label: "" };
}

function normaliseSummaryEntries(summary) {
    if (!Array.isArray(summary)) return [];
    return summary
        .map((entry) => {
            if (!entry || typeof entry !== "object") return null;
            const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : null;
            const value = typeof entry.value === "string" || typeof entry.value === "number"
                ? entry.value
                : typeof entry.text === "string"
                  ? entry.text
                  : null;
            if (!label || value === null || value === undefined) return null;
            return { label, value };
        })
        .filter(Boolean);
}

function normaliseIssueTitle(issue) {
    const candidates = [
        issue?.title,
        issue?.message,
        Array.isArray(issue?.issues) ? issue.issues.find((text) => typeof text === "string" && text.trim()) : ""
    ];

    if (Array.isArray(issue?.details)) {
        for (const detail of issue.details) {
            if (typeof detail?.message === "string" && detail.message.trim()) {
                candidates.push(detail.message.trim());
                break;
            }
        }
    }

    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }
    return "未提供標題";
}

function normaliseSeverity(issue) {
    if (!issue || typeof issue !== "object") return "";
    const candidates = [issue.severity, issue.level, issue.severity_text, issue.severityText];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }
    return "";
}

function parseCombinedReportSnapshot(state) {
    const content = normaliseJsonContent(state?.combinedReportJson ?? state?.combined_report_json);
    if (!content) {
        return { summary: [], issues: [] };
    }

    try {
        const parsed = JSON.parse(content);
        const summary = normaliseSummaryEntries(parsed?.summary);
        const issues = Array.isArray(parsed?.issues)
            ? parsed.issues.map((issue, index) => {
                  const line = extractIssueLine(issue);
                  return {
                      id: `issue-${index}`,
                      title: normaliseIssueTitle(issue),
                      severity: normaliseSeverity(issue),
                      issueCount: Array.isArray(issue?.issues) ? issue.issues.length : null,
                      lineLabel: line.label,
                      lineStart: line.start,
                      lineEnd: line.end,
                      raw: issue
                  };
              })
            : [];

        return { summary, issues };
    } catch (error) {
        console.warn("[project-preview] Failed to parse combined report JSON", error);
        return { summary: [], issues: [] };
    }
}

export function buildProjectPreviewIndex({ projects, reportStates, parseKey }) {
    const projectMap = new Map();
    (Array.isArray(projects) ? projects : []).forEach((project) => {
        projectMap.set(normaliseProjectId(project.id), {
            project,
            reports: [],
            issueCount: 0
        });
    });

    Object.entries(reportStates || {}).forEach(([key, state]) => {
        if (!state || state.status !== "ready") return;
        const parsedKey = typeof parseKey === "function" ? parseKey(key) : { projectId: "", path: "" };
        const projectId = normaliseProjectId(parsedKey.projectId);
        const path = parsedKey.path || "";
        if (!projectId || !path) return;
        const projectEntry = projectMap.get(projectId);
        if (!projectEntry) return;

        const snapshot = parseCombinedReportSnapshot(state);
        if (!snapshot.summary.length && !snapshot.issues.length) {
            return;
        }

        projectEntry.reports.push({
            path,
            summary: snapshot.summary,
            issues: snapshot.issues.map((issue, index) => ({
                ...issue,
                id: `${projectId}-${path}-${index}`
            }))
        });
        projectEntry.issueCount += snapshot.issues.length;
    });

    return Array.from(projectMap.values()).filter((entry) => entry.reports.length > 0);
}

export default {
    buildProjectPreviewIndex
};
