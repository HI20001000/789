import "../vendor/jszip.min.js";
import { extractSqlFromDocument } from "../services/apiService.js";

const JSZip = globalThis.JSZip;

const SQL_KEYWORD_PATTERN = /\b(select|update|insert|delete|create|alter|drop|with|merge|replace)\b/i;
const SQL_DOC_EXTS = new Set(["doc", "docx", "xls", "xlsx"]);

const OFFICE_KIND_WORD = "word";
const OFFICE_KIND_EXCEL = "excel";

function extOf(name = "") {
    const i = name.lastIndexOf(".");
    return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

function detectOfficeKind(name, mime = "") {
    const ext = extOf(name);
    if (SQL_DOC_EXTS.has(ext)) {
        if (ext === "xls" || ext === "xlsx") return OFFICE_KIND_EXCEL;
        if (ext === "doc" || ext === "docx") return OFFICE_KIND_WORD;
    }

    const normalisedMime = (mime || "").toLowerCase();
    if (normalisedMime.includes("spreadsheet")) return OFFICE_KIND_EXCEL;
    if (normalisedMime.includes("ms-excel")) return OFFICE_KIND_EXCEL;
    if (normalisedMime.includes("wordprocessingml")) return OFFICE_KIND_WORD;
    if (normalisedMime.includes("msword") || normalisedMime.includes("ms-word")) return OFFICE_KIND_WORD;

    return "";
}

function endsStatement(line) {
    return /[;；]\s*$/.test(line);
}

function extractSqlBlocksFromLines(lines) {
    const blocks = [];
    let current = [];

    for (const rawLine of lines || []) {
        if (rawLine === null || rawLine === undefined) continue;
        const line = String(rawLine).replace(/\s+/g, " ").trim();
        if (!line) continue;

        if (current.length) {
            current.push(line);
            if (endsStatement(line)) {
                blocks.push(current.join("\n"));
                current = [];
            }
            continue;
        }

        if (SQL_KEYWORD_PATTERN.test(line)) {
            current.push(line);
            if (endsStatement(line)) {
                blocks.push(current.join("\n"));
                current = [];
            }
        }
    }

    if (current.length) {
        blocks.push(current.join("\n"));
    }

    const fallback = (lines || [])
        .map((entry) => (entry === null || entry === undefined ? "" : String(entry)))
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join("\n");

    return blocks.length ? blocks.join("\n") : fallback;
}

function parseXml(xmlText) {
    const parser = new DOMParser();
    return parser.parseFromString(xmlText || "", "application/xml");
}

function flattenXmlText(doc, selector) {
    if (!doc) return [];
    const elements = doc.querySelectorAll(selector);
    return Array.from(elements)
        .map((el) => (el.textContent || "").trim())
        .filter(Boolean);
}

async function extractDocxTextFromZip(zip) {
    const docFile = zip.file("word/document.xml");
    if (!docFile) return "";
    const xml = await docFile.async("string");
    const doc = parseXml(xml);
    const paragraphs = flattenXmlText(doc, "w\\:t, t");
    return paragraphs.join("\n");
}

function loadSharedStrings(zip) {
    const file = zip.file("xl/sharedStrings.xml");
    if (!file) return null;
    return file.async("string").then((xml) => {
        const doc = parseXml(xml);
        return flattenXmlText(doc, "s\\:si s\\:t, si t");
    });
}

function cellValue(cell, sharedStrings) {
    const type = cell.getAttribute("t");
    if (type === "s") {
        const v = cell.querySelector("v");
        const idx = Number(v?.textContent || "-");
        return Number.isFinite(idx) && sharedStrings?.[idx] ? sharedStrings[idx] : "";
    }

    const inlineTexts = Array.from(cell.querySelectorAll("is t"));
    if (inlineTexts.length) {
        return inlineTexts.map((t) => t.textContent || "").join("");
    }

    const value = cell.querySelector("v");
    return value?.textContent || "";
}

async function extractXlsxTextFromZip(zip) {
    const sharedStrings = (await loadSharedStrings(zip)) || [];
    const rows = [];

    const sheetFiles = zip.file(/^xl\/worksheets\/.*\.xml$/i);
    for (const entry of sheetFiles) {
        const xml = await entry.async("string");
        const doc = parseXml(xml);
        const sheetRows = doc.querySelectorAll("row");
        for (const row of sheetRows) {
            const cells = Array.from(row.querySelectorAll("c"))
                .map((cell) => (cellValue(cell, sharedStrings) || "").trim())
                .filter(Boolean);
            if (cells.length) {
                rows.push(cells.join(" "));
            }
        }
    }

    return rows.join("\n");
}

async function extractOfficeTextLocally(arrayBuffer, kind) {
    try {
        const zip = await JSZip.loadAsync(arrayBuffer);
        if (kind === OFFICE_KIND_WORD) {
            return await extractDocxTextFromZip(zip);
        }
        return await extractXlsxTextFromZip(zip);
    } catch (error) {
        return "";
    }
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

export function isOfficeDocument(name, mime = "") {
    return Boolean(detectOfficeKind(name, mime));
}

export function isSqlDocument(name, mime = "") {
    return Boolean(detectOfficeKind(name, mime));
}

export async function extractSqlTextFromFile(file) {
    if (!file) return "";
    const name = file.name || "";
    const mime = file.type || "";
    const kind = detectOfficeKind(name, mime);
    if (!kind) {
        throw new Error("This file is not a supported SQL document type");
    }

    const arrayBuffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);
    const response = await extractSqlFromDocument({ data: base64, name, mime });
    let rawText = typeof response?.text === "string" ? response.text : "";

    if (!rawText.trim()) {
        rawText = await extractOfficeTextLocally(arrayBuffer, kind);
    }

    const lines = rawText.split(/\r\n|\r|\n/);
    const sqlOnly = extractSqlBlocksFromLines(lines);
    return sqlOnly?.trim?.() ? sqlOnly : rawText;
}
