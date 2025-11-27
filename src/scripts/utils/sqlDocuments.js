import JSZip from "jszip";
import { extractSqlFromDocument } from "../services/apiService.js";

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

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function stripXmlTags(xml) {
    return (xml || "")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/<[^>]+>/g, " ")
        .replace(/[\s\u00A0]+/g, " ")
        .trim();
}

function normaliseZipEntries(zip) {
    return Object.values(zip.files || {});
}

async function extractWordText(zip) {
    const doc = zip.file("word/document.xml");
    if (!doc) return "";
    const xml = await doc.async("string");
    const matches = Array.from(xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gim));
    const texts = matches.map((match) => stripXmlTags(match[1])).filter(Boolean);
    return texts.join("\n");
}

async function extractExcelText(zip) {
    const rows = [];
    const targets = normaliseZipEntries(zip).filter(
        (entry) => entry.name === "xl/sharedStrings.xml" || (entry.name?.startsWith("xl/worksheets/") && entry.name.endsWith(".xml"))
    );

    for (const entry of targets) {
        const xml = await entry.async("string");
        const flattened = stripXmlTags(xml);
        if (flattened) rows.push(flattened);
    }

    return rows.join("\n");
}

async function extractFallbackXmlText(zip) {
    const rows = [];
    for (const entry of normaliseZipEntries(zip)) {
        if (!entry.name?.toLowerCase().endsWith(".xml")) continue;
        const flattened = stripXmlTags(await entry.async("string"));
        if (flattened) rows.push(flattened);
    }
    return rows.join("\n");
}

async function extractOfficeRawTextFromBuffer(buffer, kind) {
    try {
        const zip = await JSZip.loadAsync(buffer);
        const primaryText = kind === OFFICE_KIND_WORD ? await extractWordText(zip) : await extractExcelText(zip);
        return (primaryText && primaryText.trim()) ? primaryText : await extractFallbackXmlText(zip);
    } catch (_) {
        return "";
    }
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
        rawText = await extractOfficeRawTextFromBuffer(arrayBuffer, kind);
    }

    const lines = rawText.split(/\r\n|\r|\n/);
    const sqlOnly = extractSqlBlocksFromLines(lines);
    return sqlOnly?.trim?.() ? sqlOnly : rawText;
}
