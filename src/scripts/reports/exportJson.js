const DEFAULT_TYPE_LABELS = {
    combined: "聚合報告",
    static: "靜態分析報告",
    ai: "AI 審查報告"
};

function normaliseFileSegment(value, fallback = "") {
    if (typeof value !== "string") {
        return fallback;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return fallback;
    }
    return trimmed
        .normalize("NFKD")
        .replace(/[^\w\-\s.]+/gu, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "");
}

function buildTimestampSegment(value) {
    if (!value) {
        return "";
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "";
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}${month}${day}-${hours}${minutes}`;
}

export function buildReportFileName({
    projectName = "",
    filePath = "",
    type = "combined",
    typeLabel = "",
    updatedAt = null,
    extension = "json"
} = {}) {
    const safeProject = normaliseFileSegment(projectName, "report");
    const safePath = normaliseFileSegment(filePath.replace(/\\/g, "/"));
    const label = typeLabel || DEFAULT_TYPE_LABELS[type] || type.toUpperCase();
    const safeLabel = normaliseFileSegment(label, type);
    const timestamp = buildTimestampSegment(updatedAt);

    const segments = [safeProject];
    if (safePath) segments.push(safePath);
    segments.push(safeLabel);
    if (timestamp) segments.push(timestamp);

    const baseName = segments.filter(Boolean).join("-") || "report";
    const safeExtension = normaliseFileSegment(extension, "json") || "json";
    return `${baseName}.${safeExtension}`;
}

export function normaliseJsonContent(payload) {
    if (payload === undefined || payload === null) {
        return "";
    }
    if (typeof payload === "string") {
        const trimmed = payload.trim();
        if (!trimmed) {
            return "";
        }
        return trimmed;
    }
    try {
        return JSON.stringify(payload, null, 2);
    } catch (error) {
        console.warn("[Report] Failed to serialise JSON payload", error, payload);
        return "";
    }
}

export async function exportJsonReport({ json, metadata = {} }) {
    const content = normaliseJsonContent(json);
    if (!content) {
        throw new Error("無可匯出的 JSON 內容");
    }
    const fileName = metadata.fileName || buildReportFileName(metadata);
    const blob = new Blob([content], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } finally {
        URL.revokeObjectURL(url);
    }
}

export default {
    buildReportFileName,
    normaliseJsonContent,
    exportJsonReport
};
