import { loadEnv } from "./env.js";

const env = loadEnv() ?? process.env;

const {
    DIFY_API_BASE_URL = "",
    DIFY_API_KEY = "",
    DIFY_CHAT_ENDPOINT = "/chat-messages",
    DIFY_RESPONSE_MODE = "blocking",
    DIFY_TOKEN_LIMIT = "32000",
    DIFY_APPROX_CHARS_PER_TOKEN = "4",
    DIFY_SAFETY_MARGIN = "0.8",
    DIFY_USER_ID = "code-reviewer"
} = env;

const baseUrl = typeof DIFY_API_BASE_URL === "string"
    ? DIFY_API_BASE_URL.trim().replace(/\/$/, "")
    : "";

if (!baseUrl) {
    console.warn("[dify] DIFY_API_BASE_URL is not configured; report generation will fail until it is set.");
}

const endpointPath = (typeof DIFY_CHAT_ENDPOINT === "string" && DIFY_CHAT_ENDPOINT.trim())
    ? (DIFY_CHAT_ENDPOINT.trim().startsWith("/") ? DIFY_CHAT_ENDPOINT.trim() : `/${DIFY_CHAT_ENDPOINT.trim()}`)
    : "/chat-messages";
const requestUrl = baseUrl ? `${baseUrl}${endpointPath}` : endpointPath;

const responseMode = (() => {
    const mode = typeof DIFY_RESPONSE_MODE === "string" && DIFY_RESPONSE_MODE.trim()
        ? DIFY_RESPONSE_MODE.trim().toLowerCase()
        : "blocking";
    return mode === "streaming" ? "streaming" : "blocking";
})();

let cachedFetch = null;

async function resolveFetch() {
    if (typeof fetch === "function") {
        return fetch.bind(globalThis);
    }
    if (cachedFetch) {
        return cachedFetch;
    }
    try {
        const undici = await import("node:undici");
        cachedFetch = undici.fetch;
        return cachedFetch;
    } catch (error) {
        const reason = error?.message ? ` (original error: ${error.message})` : "";
        throw new Error(
            `Fetch API is not available in this Node.js runtime. Please upgrade to Node 18+ or ensure node:undici can be imported${reason}.`
        );
    }
}

const tokenLimit = Math.max(1000, Number(DIFY_TOKEN_LIMIT) || 32000);
const approxCharsPerToken = Math.max(1, Number(DIFY_APPROX_CHARS_PER_TOKEN) || 4);
const safetyMargin = Math.min(1, Math.max(0.1, Number(DIFY_SAFETY_MARGIN) || 0.8));
const maxSegmentChars = Math.max(
    500,
    Math.floor(tokenLimit * approxCharsPerToken * safetyMargin)
);

const hasApiKey = Boolean(DIFY_API_KEY && DIFY_API_KEY.length);

console.log(
    `[dify] Resolved config baseUrl=${baseUrl || "(unset)"} endpoint=${endpointPath} responseMode=${responseMode} tokenLimit=${tokenLimit} ` +
        `approxCharsPerToken=${approxCharsPerToken} safetyMargin=${safetyMargin} maxSegmentChars=${maxSegmentChars} apiKey=${hasApiKey ? "set" : "missing"}`
);

function sliceByNewline(content, start, size) {
    const tentativeEnd = Math.min(content.length, start + size);
    if (tentativeEnd >= content.length) {
        return tentativeEnd;
    }
    const newlineIndex = content.lastIndexOf("\n", tentativeEnd);
    if (newlineIndex <= start + Math.floor(size * 0.3)) {
        return tentativeEnd;
    }
    return newlineIndex + 1;
}

export function partitionContent(content) {
    if (typeof content !== "string" || !content.length) {
        return [""];
    }
    if (content.length <= maxSegmentChars) {
        return [content];
    }
    const segments = [];
    let offset = 0;
    while (offset < content.length) {
        const nextEnd = sliceByNewline(content, offset, maxSegmentChars);
        segments.push(content.slice(offset, nextEnd));
        offset = nextEnd;
    }
    return segments;
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

function parseDifyAnswer(answer) {
    let text = "";
    if (typeof answer === "string") {
        text = answer;
    } else if (answer != null) {
        try {
            text = JSON.stringify(answer);
        } catch (_error) {
            text = String(answer);
        }
    }

    const jsonString = extractJsonFromText(text);
    if (!jsonString) {
        return { text, json: "", parsed: null };
    }

    try {
        const parsed = JSON.parse(jsonString);
        return { text, json: jsonString, parsed };
    } catch (_error) {
        return { text, json: "", parsed: null };
    }
}

function gatherRuleIds(issue) {
    const values = [];
    if (!issue || typeof issue !== "object") {
        return values;
    }

    const pushValue = (candidate) => {
        if (candidate === null || candidate === undefined) return;
        const normalised = typeof candidate === "string" ? candidate : String(candidate);
        const trimmed = normalised.trim();
        if (!trimmed) return;
        values.push(trimmed);
    };

    if (Array.isArray(issue.rule_ids)) {
        issue.rule_ids.forEach(pushValue);
    }
    if (Array.isArray(issue.ruleIds)) {
        issue.ruleIds.forEach(pushValue);
    }
    pushValue(issue.rule_id);
    pushValue(issue.ruleId);
    pushValue(issue.rule);

    return Array.from(new Set(values));
}

function gatherSeverity(issue) {
    if (!issue || typeof issue !== "object") {
        return "";
    }

    const candidates = [];
    if (Array.isArray(issue.severity_levels)) {
        candidates.push(...issue.severity_levels);
    }
    candidates.push(issue.severity, issue.level);

    for (const candidate of candidates) {
        if (candidate === null || candidate === undefined) {
            continue;
        }
        const stringValue = typeof candidate === "string" ? candidate : String(candidate);
        const trimmed = stringValue.trim();
        if (trimmed) {
            return trimmed;
        }
    }

    return "";
}

function aggregateDifyChunkResults(results) {
    const aggregatedIssues = [];
    const severityCounts = new Map();
    const ruleCounts = new Map();
    const messages = [];
    const processedChunks = [];

    let hasParsedChunk = false;

    for (const item of results) {
        const issues = Array.isArray(item.parsed?.issues) ? item.parsed.issues : [];
        const issuesClone = issues.map((issue) =>
            issue && typeof issue === "object" ? { ...issue } : issue
        );

        const annotatedIssues = issuesClone.map((issue) =>
            issue && typeof issue === "object"
                ? { ...issue, chunk_index: item.index }
                : issue
        );

        aggregatedIssues.push(...annotatedIssues);

        for (const issue of issuesClone) {
            if (!issue || typeof issue !== "object") continue;
            const severity = gatherSeverity(issue);
            if (severity) {
                severityCounts.set(severity, (severityCounts.get(severity) || 0) + 1);
            }
            const ruleIds = gatherRuleIds(issue);
            for (const ruleId of ruleIds) {
                ruleCounts.set(ruleId, (ruleCounts.get(ruleId) || 0) + 1);
            }
        }

        if (item.parsed && typeof item.parsed === "object") {
            hasParsedChunk = true;
            if (typeof item.parsed.message === "string" && item.parsed.message.trim()) {
                messages.push(item.parsed.message.trim());
            }
            if (Array.isArray(item.parsed.messages)) {
                for (const entry of item.parsed.messages) {
                    if (typeof entry === "string" && entry.trim()) {
                        messages.push(entry.trim());
                    }
                }
            }
        }

        processedChunks.push({
            index: item.index,
            total: item.total,
            answer: item.text,
            raw: item.raw,
            json: item.json || undefined,
            parsed: item.parsed || undefined,
            issues: issuesClone.length ? issuesClone : undefined
        });
    }

    if (!aggregatedIssues.length && !hasParsedChunk) {
        return { aggregate: null, issues: [], chunks: processedChunks };
    }

    const aggregate = {};

    if (aggregatedIssues.length) {
        aggregate.total_issues = aggregatedIssues.length;
    }

    if (severityCounts.size) {
        aggregate.by_severity = Object.fromEntries(severityCounts.entries());
    }

    if (ruleCounts.size) {
        aggregate.by_rule = Object.fromEntries(ruleCounts.entries());
    }

    if (messages.length) {
        aggregate.messages = messages;
        aggregate.message = messages.join(" ");
    }

    const aggregateChunks = processedChunks.map((chunk) => {
        const entry = { index: chunk.index, total: chunk.total };
        if (Array.isArray(chunk.issues) && chunk.issues.length) {
            entry.issues = chunk.issues;
        }
        const parsed = chunk.parsed && typeof chunk.parsed === "object" ? chunk.parsed : null;
        if (parsed) {
            const { issues, ...rest } = parsed;
            if (Object.keys(rest).length) {
                if (typeof rest.summary === "string" && Object.keys(rest).length === 1) {
                    entry.summary = rest.summary;
                } else {
                    entry.summary = rest;
                }
            }
        }
        return entry;
    });

    if (aggregateChunks.length) {
        aggregate.chunks = aggregateChunks;
    }

    const hasAggregateContent = Object.keys(aggregate).length > 0;

    return {
        aggregate: hasAggregateContent ? aggregate : null,
        issues: aggregatedIssues,
        chunks: processedChunks
    };
}

function normaliseSelectionMeta(selection) {
    if (!selection || typeof selection !== "object") {
        return null;
    }
    const normalised = {};
    const start = Number(selection.startLine);
    const end = Number(selection.endLine);
    const startColumnRaw = Number(selection.startColumn);
    const endColumnRaw = Number(selection.endColumn);
    const providedLineCount = Number(selection.lineCount);
    if (Number.isFinite(start)) {
        normalised.startLine = Math.max(1, Math.floor(start));
    }
    if (Number.isFinite(end)) {
        normalised.endLine = Math.max(1, Math.floor(end));
    }
    if (Number.isFinite(startColumnRaw) && startColumnRaw > 0) {
        normalised.startColumn = Math.max(1, Math.floor(startColumnRaw));
    }
    if (Number.isFinite(endColumnRaw) && endColumnRaw > 0) {
        normalised.endColumn = Math.max(1, Math.floor(endColumnRaw));
    }
    if (
        normalised.startLine !== undefined &&
        normalised.endLine !== undefined &&
        normalised.endLine < normalised.startLine
    ) {
        const temp = normalised.startLine;
        normalised.startLine = normalised.endLine;
        normalised.endLine = temp;
        if (normalised.startColumn !== undefined || normalised.endColumn !== undefined) {
            const columnTemp = normalised.startColumn;
            normalised.startColumn = normalised.endColumn;
            normalised.endColumn = columnTemp;
        }
    }
    if (normalised.startLine !== undefined && normalised.endLine === undefined) {
        normalised.endLine = normalised.startLine;
    }
    if (normalised.endLine !== undefined && normalised.startLine === undefined) {
        normalised.startLine = normalised.endLine;
    }
    if (
        normalised.startLine !== undefined &&
        normalised.endLine !== undefined &&
        normalised.startLine === normalised.endLine &&
        normalised.startColumn !== undefined &&
        normalised.endColumn !== undefined &&
        normalised.endColumn < normalised.startColumn
    ) {
        const columnTemp = normalised.startColumn;
        normalised.startColumn = normalised.endColumn;
        normalised.endColumn = columnTemp;
    }
    if (typeof selection.label === "string" && selection.label.trim()) {
        normalised.label = selection.label.trim();
    }
    if (Number.isFinite(providedLineCount) && providedLineCount > 0) {
        normalised.lineCount = Math.max(1, Math.floor(providedLineCount));
    } else if (normalised.startLine !== undefined && normalised.endLine !== undefined) {
        normalised.lineCount = normalised.endLine - normalised.startLine + 1;
    }
    return Object.keys(normalised).length ? normalised : null;
}

function describeSelection(selection) {
    if (!selection) return "";
    const hasStart = typeof selection.startLine === "number" && Number.isFinite(selection.startLine);
    const hasEnd = typeof selection.endLine === "number" && Number.isFinite(selection.endLine);
    const hasStartColumn = typeof selection.startColumn === "number" && Number.isFinite(selection.startColumn);
    const hasEndColumn = typeof selection.endColumn === "number" && Number.isFinite(selection.endColumn);
    const isSingleLine = hasStart && hasEnd && selection.startLine === selection.endLine;
    let rangeText = "";
    if (hasStart && hasEnd) {
        rangeText = selection.startLine === selection.endLine
            ? `第 ${selection.startLine} 行`
            : `第 ${selection.startLine}-${selection.endLine} 行`;
    } else if (hasStart) {
        rangeText = `第 ${selection.startLine} 行`;
    } else if (hasEnd) {
        rangeText = `第 ${selection.endLine} 行`;
    }
    let columnText = "";
    if (isSingleLine) {
        if (hasStartColumn && hasEndColumn) {
            columnText = selection.startColumn === selection.endColumn
                ? `字元 ${selection.startColumn}`
                : `字元 ${selection.startColumn}-${selection.endColumn}`;
        } else if (hasStartColumn) {
            columnText = `字元 ${selection.startColumn} 起`;
        } else if (hasEndColumn) {
            columnText = `字元 ${selection.endColumn} 止`;
        }
    } else {
        if (hasStartColumn) {
            columnText = `起始字元 ${selection.startColumn}`;
        }
        if (hasEndColumn) {
            columnText = columnText ? `${columnText}，結束字元 ${selection.endColumn}` : `結束字元 ${selection.endColumn}`;
        }
    }
    const segments = [];
    if (rangeText) segments.push(rangeText);
    if (columnText) segments.push(columnText);
    const descriptor = segments.join("，");
    const label = typeof selection.label === "string" && selection.label.trim() ? selection.label.trim() : "";
    if (label && descriptor) {
        return `選取範圍：${descriptor}（${label}）`;
    }
    if (descriptor) {
        return `選取範圍：${descriptor}`;
    }
    if (label) {
        return `選取標籤：${label}`;
    }
    return "";
}

function normaliseChunkInteger(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return null;
    }
    return Math.floor(numeric);
}

function describeSegmentLocation(location) {
    if (!location || typeof location !== "object") {
        return "";
    }

    const startLine = normaliseChunkInteger(location.startLine ?? location.line);
    const endLine = normaliseChunkInteger(location.endLine ?? startLine);
    const startColumn = normaliseChunkInteger(location.startColumn ?? location.column);
    const endColumn = normaliseChunkInteger(location.endColumn ?? startColumn);

    const parts = [];
    if (startLine && endLine) {
        parts.push(startLine === endLine ? `第 ${startLine} 行` : `第 ${startLine}-${endLine} 行`);
    } else if (startLine) {
        parts.push(`第 ${startLine} 行`);
    }

    if (startColumn && endColumn) {
        if (startColumn === endColumn) {
            parts.push(`字元 ${startColumn}`);
        } else {
            parts.push(`字元 ${startColumn}-${endColumn}`);
        }
    } else if (startColumn) {
        parts.push(`起始字元 ${startColumn}`);
    } else if (endColumn) {
        parts.push(`結束字元 ${endColumn}`);
    }

    if (!parts.length) {
        return "";
    }

    return `程式碼位置：${parts.join("，")}`;
}

function normaliseSegmentEntry(segment, index, total) {
    const baseIndex = index + 1;
    const baseTotal = total;

    if (!segment || typeof segment !== "object") {
        const textValue = typeof segment === "string" ? segment : String(segment ?? "");
        return {
            text: textValue,
            rawText: textValue,
            index: baseIndex,
            total: baseTotal
        };
    }

    const clone = { ...segment };
    const textValue = typeof clone.text === "string"
        ? clone.text
        : typeof clone.rawText === "string"
        ? clone.rawText
        : typeof clone.raw === "string"
        ? clone.raw
        : "";
    const indexValue = normaliseChunkInteger(clone.index) || baseIndex;
    const totalValue = normaliseChunkInteger(clone.total) || baseTotal;
    const startLine = normaliseChunkInteger(clone.startLine ?? clone.line);
    const endLine = normaliseChunkInteger(clone.endLine ?? startLine);
    const startColumn = normaliseChunkInteger(clone.startColumn ?? clone.column);
    const endColumn = normaliseChunkInteger(clone.endColumn);
    const codeLocationLabel = typeof clone.codeLocationLabel === "string" && clone.codeLocationLabel.trim()
        ? clone.codeLocationLabel.trim()
        : null;

    const derivedCodeLocationLabel = codeLocationLabel
        || (startLine
            ? endLine && endLine !== startLine
                ? `程式碼位置：第 ${startLine}-${endLine} 行`
                : `程式碼位置：第 ${startLine} 行`
            : "");

    const entry = {
        ...clone,
        text: textValue,
        rawText: typeof clone.rawText === "string" ? clone.rawText : textValue,
        index: indexValue,
        total: totalValue,
        codeLocationLabel: derivedCodeLocationLabel || undefined
    };

    if (startLine) {
        entry.startLine = startLine;
        entry.line = startLine;
    }
    if (endLine) {
        entry.endLine = endLine;
    }
    if (startColumn) {
        entry.startColumn = startColumn;
    }
    if (endColumn) {
        entry.endColumn = endColumn;
    }

    return entry;
}

function buildPrompt({ segmentText, projectName, filePath, chunkIndex, chunkTotal, selection, location }) {
    const issueContext = location && typeof location === "object" ? location.issueContext : null;
    if (location && location.kind === "static_issue") {
        const context = issueContext && typeof issueContext === "object" ? issueContext : {};
        const totalIssues = Number(context.totalIssues);
        const numbering = context.index
            ? totalIssues && totalIssues > 1
                ? `${context.index}/${totalIssues}`
                : `${context.index}`
            : `${chunkIndex}`;
        const ruleLine = Array.isArray(context.ruleIds) && context.ruleIds.length
            ? `觸發規則：${context.ruleIds.join(", ")}`
            : "";
        const severityLine = context.severity ? `嚴重性：${context.severity}` : "";
        const objectLine = context.object ? `關聯對象：${context.object}` : "";
        const locationLine = describeSegmentLocation(location);
        const messageLine = context.message ? `靜態分析問題描述：${context.message}` : "";

        const headerLines = [
            "你是一位資深的 SQL 程式碼審查專家。",
            "請根據下列靜態分析器提供的單一問題，補充 recommendation 與 fixed_code 欄位。",
            "回覆必須為 JSON 物件（鍵名為 recommendation 與 fixed_code），若無適用內容請輸出空字串。",
            "輸出請使用繁體中文。",
            "",
            `專案：${projectName || "(未命名專案)"}`,
            `檔案：${filePath}`,
            numbering ? `問題編號：${numbering}` : "",
            locationLine,
            ruleLine,
            severityLine,
            objectLine,
            context.line ? `偵測行號：${context.line}` : "",
            context.column ? `偵測欄位：${context.column}` : "",
            describeSelection(selection),
            messageLine
        ].filter(Boolean);

        const snippet = typeof segmentText === "string" && segmentText.trim()
            ? segmentText.trim()
            : typeof context.evidence === "string" && context.evidence.trim()
            ? context.evidence.trim()
            : context.message || "";

        const promptLines = [
            ...headerLines,
            "",
            "請以 JSON 形式回覆，描述修正建議與對應的修正後 SQL 程式碼片段。",
            "相關程式碼：",
            "```sql",
            snippet,
            "```"
        ];

        if (typeof context.serialisedIssue === "string" && context.serialisedIssue.trim()) {
            promptLines.push("", "原始靜態分析資料：", "```json", context.serialisedIssue.trim(), "```");
        }

        return promptLines.join("\n");
    }

    const headerLines = [
        "你是一位資深的程式碼審查專家，請針對以下程式碼段落提供深入的審查報告。",
        "請重點標記潛在缺陷、最佳化建議、安全性問題、可維護性與測試建議。",
        "輸出請使用繁體中文，並保持清晰的 Markdown 結構。",
        "",
        `專案：${projectName || "(未命名專案)"}`,
        `檔案：${filePath}`,
        location?.codeLocationLabel || describeSegmentLocation(location),
        describeSelection(selection),
        location?.kind === "java_method" && location?.label ? `方法：${location.label}` : "",
        location?.kind === "java_method" && location?.className ? `類別：${location.className}` : "",
        location?.kind === "java_method" && location?.methodSignature
            ? `方法簽名：${location.methodSignature}`
            : "",
        chunkTotal > 1 ? `分段：${chunkIndex}/${chunkTotal}` : "",
        "",
        "以下是本段程式碼：",
        "```",
        segmentText.trimEnd(),
        "```"
    ].filter(Boolean);
    return headerLines.join("\n");
}

function assertConfig() {
    if (!baseUrl) {
        throw new Error("Dify API base URL (DIFY_API_BASE_URL) is not configured");
    }
    if (!DIFY_API_KEY) {
        throw new Error("Dify API key (DIFY_API_KEY) is not configured");
    }
}

function isMaxContextLengthError(status, text) {
    if (status !== 400) {
        return false;
    }
    const payloadText = typeof text === "string" ? text : "";
    const lowerText = payloadText.toLowerCase();
    if (lowerText.includes("maximum context length")) {
        return true;
    }
    try {
        const parsed = JSON.parse(payloadText);
        const message =
            typeof parsed?.message === "string"
                ? parsed.message
                : typeof parsed?.error?.message === "string"
                  ? parsed.error.message
                  : typeof parsed?.data?.error?.message === "string"
                    ? parsed.data.error.message
                    : "";
        return typeof message === "string" && message.toLowerCase().includes("maximum context length");
    } catch (error) {
        return false;
    }
}

export async function requestDifyReport({
    projectName,
    filePath,
    content,
    userId,
    segments: presetSegments,
    files,
    selection,
    conversationId: initialConversationId
}) {
    assertConfig();
    const rawSegments = Array.isArray(presetSegments) && presetSegments.length
        ? presetSegments
        : partitionContent(content || "");
    const normalisedSegments = rawSegments.map((segment, index) =>
        normaliseSegmentEntry(segment, index, rawSegments.length)
    );
    const results = [];
    let conversationId = typeof initialConversationId === "string" && initialConversationId.trim()
        ? initialConversationId.trim()
        : "";
    const conversationIds = conversationId ? [conversationId] : [];
    const fetchImpl = await resolveFetch();
    const fileAttachments = Array.isArray(files) ? files : [];
    const selectionMeta = normaliseSelectionMeta(selection);
    const totalSegments = normalisedSegments.length || 1;
    for (let index = 0; index < normalisedSegments.length; index += 1) {
        const segmentMeta = normalisedSegments[index];
        const segmentText = typeof segmentMeta.text === "string" ? segmentMeta.text : "";
        const chunkIndex = normaliseChunkInteger(segmentMeta.index) || index + 1;
        const resolvedUserId = typeof userId === "string" && userId.trim() ? userId.trim() : DIFY_USER_ID;
        if (!resolvedUserId) {
            throw new Error("Dify user identifier is required; set DIFY_USER_ID or pass userId");
        }
        const body = {
            inputs: {
                project_name: projectName || "",
                file_path: filePath,
                chunk_index: chunkIndex,
                chunk_total: totalSegments
            },
            query: buildPrompt({
                segmentText,
                projectName,
                filePath,
                chunkIndex,
                chunkTotal: totalSegments,
                selection: selectionMeta,
                location: segmentMeta
            }),
            response_mode: responseMode,
            conversation_id: conversationId,
            user: resolvedUserId,
            files: fileAttachments
        };
        const startLine = normaliseChunkInteger(segmentMeta.startLine ?? segmentMeta.line);
        const endLine = normaliseChunkInteger(segmentMeta.endLine ?? startLine);
        const startColumn = normaliseChunkInteger(segmentMeta.startColumn ?? segmentMeta.column);
        const endColumn = normaliseChunkInteger(segmentMeta.endColumn);
        const codeLocationLabel =
            typeof segmentMeta.codeLocationLabel === "string" && segmentMeta.codeLocationLabel.trim()
                ? segmentMeta.codeLocationLabel.trim()
                : null;
        if (startLine) {
            body.inputs.chunk_start_line = startLine;
            body.inputs.chunk_line = startLine;
            body.inputs.line = startLine;
            body.inputs.start_line = startLine;
        }
        if (endLine) {
            body.inputs.chunk_end_line = endLine;
            body.inputs.end_line = endLine;
        }
        if (startColumn) {
            body.inputs.chunk_start_column = startColumn;
            body.inputs.start_column = startColumn;
        }
        if (endColumn) {
            body.inputs.chunk_end_column = endColumn;
            body.inputs.end_column = endColumn;
        }
        if (codeLocationLabel) {
            body.inputs.code_location = codeLocationLabel;
        }
        if (selectionMeta) {
            if (typeof selectionMeta.startLine === "number") {
                body.inputs.selection_start_line = selectionMeta.startLine;
            }
            if (typeof selectionMeta.endLine === "number") {
                body.inputs.selection_end_line = selectionMeta.endLine;
            }
            if (typeof selectionMeta.startColumn === "number") {
                body.inputs.selection_start_column = selectionMeta.startColumn;
            }
            if (typeof selectionMeta.endColumn === "number") {
                body.inputs.selection_end_column = selectionMeta.endColumn;
            }
            if (typeof selectionMeta.lineCount === "number") {
                body.inputs.selection_line_count = selectionMeta.lineCount;
            }
            if (selectionMeta.label) {
                body.inputs.selection_label = selectionMeta.label;
            }
        }
        let response;
        let responseText = "";
        let retriedWithNewConversation = false;
        while (true) {
            try {
                const headers = new Headers();
                headers.set("Authorization", `Bearer ${DIFY_API_KEY}`);
                headers.set("Content-Type", "application/json");
                response = await fetchImpl(requestUrl, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body)
                });
            } catch (error) {
                const cause = error?.cause;
                const addressHint = cause?.address ? ` ${cause.address}` : "";
                const networkHint = cause?.code ? ` (code: ${cause.code}${addressHint})` : "";
                const reason = error?.message || "Unknown error";
                throw new Error(`Failed to reach Dify endpoint ${requestUrl}${networkHint}: ${reason}`);
            }
            if (response.ok) {
                break;
            }
            responseText = await response.text().catch(() => "");
            if (!retriedWithNewConversation && isMaxContextLengthError(response.status, responseText)) {
                retriedWithNewConversation = true;
                conversationId = "";
                body.conversation_id = "";
                continue;
            }
            throw new Error(
                `Dify request failed for chunk ${chunkIndex}/${totalSegments}: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ""}`
            );
        }
        const payload = await response.json();
        conversationId = payload?.conversation_id || conversationId;
        if (conversationId) {
            body.conversation_id = conversationId;
            if (!conversationIds.includes(conversationId)) {
                conversationIds.push(conversationId);
            }
        }
        const answer = payload?.answer || "";
        const parsedAnswer = parseDifyAnswer(answer);
        results.push({
            index: chunkIndex,
            total: totalSegments,
            answer,
            text: parsedAnswer.text,
            json: parsedAnswer.json,
            parsed: parsedAnswer.parsed,
            raw: payload
        });
    }

    const processedResults = results.map((item) => ({
        index: item.index,
        total: item.total,
        text: item.text,
        json: item.json,
        parsed: item.parsed,
        raw: item.raw
    }));

    const textReport = processedResults
        .map((item) => {
            if (normalisedSegments.length === 1) {
                return item.text;
            }
            return [`### 第 ${item.index} 段審查`, item.text].join("\n\n");
        })
        .join("\n\n")
        .trim();

    const { aggregate, issues: aggregateIssues, chunks } = aggregateDifyChunkResults(processedResults);
    const reportPayload = aggregate ? JSON.stringify(aggregate, null, 2) : textReport;
    const issues = Array.isArray(aggregateIssues) ? aggregateIssues : [];

    return {
        report: reportPayload,
        textReport: textReport || undefined,
        aggregated: aggregate || undefined,
        issues,
        conversationId,
        conversationIds,
        chunks,
        segments: normalisedSegments,
        generatedAt: new Date().toISOString(),
        selection: selectionMeta || undefined
    };
}

export async function requestDifyJsonEnrichment({
    projectName,
    filePath,
    content,
    userId,
    segments,
    files,
    selection,
    conversationId
}) {
    const jsonString = typeof content === "string" ? content : JSON.stringify(content ?? {});
    return requestDifyReport({
        projectName,
        filePath,
        content: jsonString,
        userId,
        segments,
        files,
        selection,
        conversationId
    });
}

export function getDifyConfigSummary() {
    return {
        baseUrl,
        endpointPath,
        tokenLimit,
        approxCharsPerToken,
        safetyMargin,
        maxSegmentChars,
        responseMode,
        hasApiKey
    };
}
