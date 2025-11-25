import JSZip from "jszip";

function ensureArray(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (value === null || value === undefined) {
        return [];
    }
    return [value];
}

function escapeXmlText(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\r\n?/g, "\n")
        .replace(/\n/g, "&#10;")
        .replace(/\t/g, "    ");
}

function escapeXmlAttribute(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function toColumnLetter(index) {
    let dividend = index + 1;
    let columnName = "";
    while (dividend > 0) {
        const modulo = (dividend - 1) % 26;
        columnName = String.fromCharCode(65 + modulo) + columnName;
        dividend = Math.floor((dividend - modulo) / 26);
    }
    return columnName;
}

function normaliseRows(rows) {
    if (!Array.isArray(rows) || !rows.length) {
        return [];
    }
    return rows.map((row) => {
        if (!Array.isArray(row)) {
            return [String(row ?? "")];
        }
        return row.map((cell) => {
            if (cell === null || cell === undefined) {
                return "";
            }
            if (cell instanceof Date) {
                return Number.isNaN(cell.getTime()) ? "" : cell.toISOString();
            }
            if (typeof cell === "object") {
                try {
                    return JSON.stringify(cell);
                } catch (error) {
                    return String(cell);
                }
            }
            return String(cell);
        });
    });
}

function buildWorksheetXml(rows) {
    const normalised = normaliseRows(rows);
    const rowXml = [];
    let maxColumnCount = 0;

    normalised.forEach((cells, rowIndex) => {
        const rowNumber = rowIndex + 1;
        maxColumnCount = Math.max(maxColumnCount, cells.length);
        const cellXml = cells.map((cellValue, cellIndex) => {
            const column = toColumnLetter(cellIndex);
            const cellRef = `${column}${rowNumber}`;
            const text = escapeXmlText(cellValue);
            return `<c r="${cellRef}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
        });
        rowXml.push(`<row r="${rowNumber}">${cellXml.join("")}</row>`);
    });

    const lastColumn = maxColumnCount > 0 ? toColumnLetter(maxColumnCount - 1) : "A";
    const lastRow = normalised.length > 0 ? normalised.length : 1;
    const dimension = `A1:${lastColumn}${lastRow}`;

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<dimension ref="${dimension}"/>` +
        `<sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
        `<sheetFormatPr defaultRowHeight="15"/>` +
        `<sheetData>${rowXml.join("")}</sheetData>` +
        `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
        `</worksheet>`;
}

function buildStylesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts>` +
        `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
        `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>` +
        `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
        `</styleSheet>`;
}

function buildRootRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`;
}

function sanitiseSheetName(name, fallback) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    const base = trimmed ? trimmed : fallback;
    const replaced = base.replace(/[\\\/*?:\[\]]/g, "-");
    return replaced.length > 31 ? replaced.slice(0, 31) : replaced || fallback;
}

function buildWorkbookXml(sheets) {
    const sheetEntries = sheets
        .map((sheet, index) => {
            const name = escapeXmlAttribute(sheet.name);
            return `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`;
        })
        .join("");

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<bookViews><workbookView/></bookViews>` +
        `<sheets>${sheetEntries}</sheets>` +
        `</workbook>`;
}

function buildWorkbookRelsXml(sheets) {
    const relationships = sheets
        .map((sheet, index) =>
            `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
        )
        .join("");

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
}

function buildContentTypesXml(sheetCount) {
    const overrides = [];
    for (let index = 0; index < sheetCount; index += 1) {
        overrides.push(
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        );
    }

    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        overrides.join("") +
        `</Types>`;
}

async function createWorkbookBlob(sheets) {
    if (!Array.isArray(sheets) || !sheets.length) {
        throw new Error("No sheets provided for export.");
    }

    const zip = new JSZip();
    zip.file("[Content_Types].xml", buildContentTypesXml(sheets.length));
    zip.folder("_rels").file(".rels", buildRootRelsXml());

    const xlFolder = zip.folder("xl");
    xlFolder.file("styles.xml", buildStylesXml());

    const preparedSheets = sheets.map((sheet, index) => {
        const name = sanitiseSheetName(sheet.name, `Sheet${index + 1}`);
        return { ...sheet, name };
    });

    xlFolder.file("workbook.xml", buildWorkbookXml(preparedSheets));
    xlFolder.folder("_rels").file("workbook.xml.rels", buildWorkbookRelsXml(preparedSheets));

    const worksheetsFolder = xlFolder.folder("worksheets");
    preparedSheets.forEach((sheet, index) => {
        worksheetsFolder.file(`sheet${index + 1}.xml`, buildWorksheetXml(sheet.rows));
    });

    return zip.generateAsync({ type: "blob" });
}

function triggerDownload(blob, filename) {
    if (typeof window === "undefined" || typeof document === "undefined") {
        throw new Error("Excel export is only available in browser environments.");
    }

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatDate(value) {
    if (!value) return "";
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? "" : value.toISOString();
    }
    if (typeof value === "number") {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "" : date.toISOString();
    }
    if (typeof value === "string") {
        return value;
    }
    return "";
}

function toMultiline(value) {
    if (Array.isArray(value)) {
        return value
            .filter((item) => item !== null && item !== undefined)
            .map((item) => (typeof item === "string" ? item : String(item)))
            .join("\n");
    }
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    return String(value);
}

function pickFirstString(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
        if (Array.isArray(candidate)) {
            for (const entry of candidate) {
                if (typeof entry === "string" && entry.trim()) {
                    return entry.trim();
                }
            }
        }
    }
    return "";
}

function normaliseIssueRow(issue) {
    if (!issue || typeof issue !== "object") {
        return Array(11).fill("");
    }

    const ruleId = pickFirstString(issue.rule_id, issue.ruleId, ensureArray(issue.rule_ids));
    const severity = pickFirstString(issue.severity, issue.level, ensureArray(issue.severity_levels));
    const message = pickFirstString(issue.message, ensureArray(issue.issues), issue.description);
    const line = issue.line ?? issue.line_number ?? issue.lineNumber ?? issue.startLine ?? "";
    const columnRaw = issue.column ?? issue.column_number ?? issue.columnNumber ?? issue.startColumn;
    const column = Array.isArray(columnRaw)
        ? columnRaw.join(", ")
        : columnRaw !== undefined && columnRaw !== null
        ? String(columnRaw)
        : "";
    const recommendation = toMultiline(issue.recommendation ?? issue.suggestion ?? issue.fix_suggestion);
    const evidence = toMultiline(issue.evidence_list ?? issue.evidence);
    const targetObject = pickFirstString(issue.object, issue.table, issue.field);
    const source = pickFirstString(issue.source, issue.analysis_source, issue.analysisSource, issue.from);
    const fixedCode = toMultiline(issue.fixed_code ?? issue.fix_code ?? issue.fix);
    const snippet = toMultiline(issue.snippet ?? issue.statement ?? issue.sql);

    return [source, ruleId, severity, message, line, column, targetObject, recommendation, evidence, fixedCode, snippet];
}

function buildIssueRows(issues) {
    const rows = [
        ["來源", "規則", "嚴重度", "訊息", "行", "欄", "對象", "建議", "證據", "修正程式碼", "相關片段"]
    ];
    if (Array.isArray(issues)) {
        issues.forEach((issue) => {
            rows.push(normaliseIssueRow(issue));
        });
    }
    return rows.length > 1 ? rows : [];
}

function buildKeyValueRows(items, headerLabel = "欄位", valueLabel = "內容") {
    if (!Array.isArray(items) || !items.length) {
        return [];
    }
    const rows = [[headerLabel, valueLabel]];
    items.forEach((item) => {
        if (!item || typeof item !== "object") {
            return;
        }
        const label = typeof item.label === "string" ? item.label : String(item.key ?? "");
        let value = item.value;
        if (Array.isArray(value)) {
            value = value
                .filter((entry) => entry !== null && entry !== undefined)
                .map((entry) => (typeof entry === "string" ? entry : String(entry)))
                .join("\n");
        }
        if (value instanceof Date) {
            value = formatDate(value);
        }
        if (value === null || value === undefined) {
            value = "";
        }
        rows.push([label, typeof value === "string" ? value : String(value)]);
    });
    return rows.length > 1 ? rows : [];
}

function buildSourceRows(sourceSummaries) {
    if (!Array.isArray(sourceSummaries) || !sourceSummaries.length) {
        return [];
    }
    const rows = [["來源", "狀態", "產生時間", "指標", "數值", "錯誤訊息"]];
    sourceSummaries.forEach((item) => {
        if (!item || typeof item !== "object") {
            return;
        }
        const label = typeof item.label === "string" ? item.label : item.key;
        const status = typeof item.status === "string" ? item.status : "";
        const generatedAt = formatDate(item.generatedAt);
        const error = typeof item.errorMessage === "string" ? item.errorMessage : "";
        const metrics = Array.isArray(item.metrics) && item.metrics.length ? item.metrics : [null];
        metrics.forEach((metric) => {
            if (metric && typeof metric === "object") {
                rows.push([
                    label,
                    status,
                    generatedAt,
                    typeof metric.label === "string" ? metric.label : "",
                    metric.value !== undefined && metric.value !== null ? String(metric.value) : "",
                    error
                ]);
            } else {
                rows.push([label, status, generatedAt, "", "", error]);
            }
        });
    });
    return rows.length > 1 ? rows : [];
}

function buildOverviewRows(metadata = {}, summary = {}) {
    const rows = [["欄位", "內容"]];
    if (metadata.projectName) {
        rows.push(["專案", metadata.projectName]);
    }
    if (metadata.filePath) {
        rows.push(["檔案", metadata.filePath]);
    }
    if (metadata.typeLabel) {
        rows.push(["報告類型", metadata.typeLabel]);
    }
    if (metadata.updatedAtDisplay || metadata.updatedAt) {
        rows.push(["更新時間", metadata.updatedAtDisplay || formatDate(metadata.updatedAt)]);
    }
    if (metadata.generatedAt) {
        rows.push(["產生時間", formatDate(metadata.generatedAt)]);
    }
    if (summary.totalIssues !== undefined && summary.totalIssues !== null) {
        rows.push(["問題總數", String(summary.totalIssues)]);
    }
    if (summary.summaryText) {
        rows.push(["摘要", summary.summaryText]);
    }
    return rows;
}

function buildCombinedSheets({ details, issues, metadata }) {
    if (!details) {
        throw new Error("缺少聚合報告內容");
    }
    const sheets = [];
    sheets.push({
        name: "概覽",
        rows: buildOverviewRows(metadata, {
            totalIssues: details.totalIssues,
            summaryText: details.summaryText
        })
    });

    const sourceRows = buildSourceRows(details.sourceSummaries);
    if (sourceRows.length) {
        sheets.push({ name: "來源摘要", rows: sourceRows });
    }

    const combinedRows = buildKeyValueRows(details.combinedSummaryDetails, "項目", "數值");
    if (combinedRows.length) {
        sheets.push({ name: "整合摘要", rows: combinedRows });
    }

    const ruleRows = Array.isArray(details.ruleBreakdown) && details.ruleBreakdown.length
        ? [["規則", "數量"], ...details.ruleBreakdown.map((item) => [item.label, String(item.count)])]
        : [];
    if (ruleRows.length) {
        sheets.push({ name: "規則分佈", rows: ruleRows });
    }

    const severityRows = Array.isArray(details.severityBreakdown) && details.severityBreakdown.length
        ? [["嚴重度", "數量"], ...details.severityBreakdown.map((item) => [item.label, String(item.count)])]
        : [];
    if (severityRows.length) {
        sheets.push({ name: "嚴重度", rows: severityRows });
    }

    const issueRows = buildIssueRows(issues);
    if (issueRows.length) {
        sheets.push({ name: "聚合問題", rows: issueRows });
    }

    return sheets;
}

function buildStaticSheets({ details, issues, metadata }) {
    if (!details) {
        throw new Error("缺少靜態分析報告內容");
    }
    const sheets = [];
    sheets.push({
        name: "概覽",
        rows: buildOverviewRows(metadata, {
            totalIssues: issues?.length ?? null,
            summaryText:
                typeof details.staticSummary === "string"
                    ? details.staticSummary
                    : ""
        })
    });

    const summaryRows = buildKeyValueRows(details.staticSummaryDetails, "項目", "數值");
    if (summaryRows.length) {
        sheets.push({ name: "摘要資訊", rows: summaryRows });
    }

    const metadataRows = buildKeyValueRows(details.staticMetadataDetails, "欄位", "內容");
    if (metadataRows.length) {
        sheets.push({ name: "中繼資料", rows: metadataRows });
    }

    const issueRows = buildIssueRows(issues);
    if (issueRows.length) {
        sheets.push({ name: "靜態問題", rows: issueRows });
    }

    return sheets;
}

function buildSegmentRows(segments) {
    if (!Array.isArray(segments) || !segments.length) {
        return [];
    }
    const rows = [["段落", "SQL / 語句", "分析", "起始行", "結束行"]];
    segments.forEach((segment) => {
        if (!segment || typeof segment !== "object") {
            return;
        }
        const sqlText = segment.sql ?? segment.text ?? "";
        let startLine = segment.startLine;
        let endLine = segment.endLine;
        if ((startLine === undefined || startLine === null) && Array.isArray(segment.lines) && segment.lines.length) {
            startLine = segment.lines[0];
            endLine = segment.lines.length > 1 ? segment.lines[1] : segment.lines[0];
        }
        rows.push([
            segment.index ?? segment.id ?? "",
            sqlText,
            segment.analysis ?? "",
            startLine ?? "",
            endLine ?? ""
        ]);
    });
    return rows;
}

function buildAiSheets({ details, issues, metadata }) {
    if (!details) {
        throw new Error("缺少 AI 審查報告內容");
    }
    const sheets = [];
    sheets.push({
        name: "概覽",
        rows: buildOverviewRows(
            { ...metadata, generatedAt: metadata.generatedAt || details.generatedAt },
            { totalIssues: issues?.length ?? null, summaryText: details.reportText }
        )
    });

    if (details.summary && typeof details.summary === "object") {
        const summaryRows = [["欄位", "內容"]];
        Object.entries(details.summary).forEach(([key, value]) => {
            if (value === undefined || value === null) {
                return;
            }
            if (typeof value === "object") {
                try {
                    summaryRows.push([key, JSON.stringify(value)]);
                } catch (error) {
                    summaryRows.push([key, String(value)]);
                }
            } else {
                summaryRows.push([key, String(value)]);
            }
        });
        if (summaryRows.length > 1) {
            sheets.push({ name: "摘要", rows: summaryRows });
        }
    }

    const segmentRows = buildSegmentRows(details.segments);
    if (segmentRows.length) {
        sheets.push({ name: "段落詳情", rows: segmentRows });
    }

    if (details.reportText) {
        sheets.push({ name: "報告全文", rows: [["內容"], [details.reportText]] });
    }

    const issueRows = buildIssueRows(issues && issues.length ? issues : details.issues);
    if (issueRows.length) {
        sheets.push({ name: "AI 問題", rows: issueRows });
    }

    return sheets;
}

function buildFilename({ projectName, filePath, type }, suffix) {
    const parts = [];
    if (projectName) {
        parts.push(projectName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""));
    }
    if (filePath) {
        const filename = filePath.split(/[\\/]/).pop();
        if (filename) {
            parts.push(filename.replace(/[^a-zA-Z0-9\u4e00-\u9fa5.]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""));
        }
    }
    const typeSegment = type || suffix;
    if (typeSegment) {
        parts.push(typeSegment.replace(/[^a-zA-Z0-9\u4e00-\u9fa5-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""));
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    parts.push(timestamp);
    const filename = parts.filter(Boolean).join("_") || `report_${timestamp}`;
    return `${filename}.xlsx`;
}

async function exportSheetsAsWorkbook({ sheets, metadata, fallbackType }) {
    if (!Array.isArray(sheets) || !sheets.length) {
        throw new Error("缺少可匯出的資料");
    }
    const blob = await createWorkbookBlob(sheets);
    const filename = buildFilename(metadata || {}, fallbackType);
    triggerDownload(blob, filename);
}

export async function exportCombinedReportToExcel({ details, issues = [], metadata = {} }) {
    const sheets = buildCombinedSheets({ details, issues, metadata: { ...metadata, typeLabel: "聚合報告" } });
    await exportSheetsAsWorkbook({ sheets, metadata: { ...metadata, type: "combined" }, fallbackType: "combined" });
}

export async function exportStaticReportToExcel({ details, issues = [], metadata = {} }) {
    const sheets = buildStaticSheets({ details, issues, metadata: { ...metadata, typeLabel: "靜態分析報告" } });
    await exportSheetsAsWorkbook({ sheets, metadata: { ...metadata, type: "static" }, fallbackType: "static" });
}

export async function exportAiReviewReportToExcel({ details, issues = [], metadata = {} }) {
    const sheets = buildAiSheets({ details, issues, metadata: { ...metadata, typeLabel: "AI 審查報告" } });
    await exportSheetsAsWorkbook({ sheets, metadata: { ...metadata, type: "ai-review" }, fallbackType: "ai" });
}

export default {
    exportCombinedReportToExcel,
    exportStaticReportToExcel,
    exportAiReviewReportToExcel
};
