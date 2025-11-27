import JSZip from "jszip";
import { extractDmlStatements } from "./sqlAnalyzer.js";

const WORD_KIND = "word";
const EXCEL_KIND = "excel";

function detectDocumentKind(name, mime) {
    const lower = (name || "").toLowerCase();
    const lowerMime = (mime || "").toLowerCase();
    if (lower.endsWith(".docx") || lower.endsWith(".doc") || lowerMime.includes("wordprocessingml")) {
        return WORD_KIND;
    }
    if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lowerMime.includes("spreadsheetml")) {
        return EXCEL_KIND;
    }
    return "";
}

function decodeXmlEntities(text) {
    return (text || "")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

function stripXmlTags(xml) {
    return decodeXmlEntities((xml || "").replace(/<[^>]+>/g, " "))
        .replace(/[\s\u00A0]+/g, " ")
        .trim();
}

function normaliseEntries(zip) {
    return Object.values(zip.files || {});
}

async function extractWordText(zip) {
    const doc = zip.file("word/document.xml");
    if (!doc) return "";

    const xml = await doc.async("string");
    const matches = Array.from(xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gim));
    const texts = matches.map((match) => stripXmlTags(match[1])).filter((text) => text);
    return texts.join("\n");
}

async function extractExcelText(zip) {
    const rows = [];
    const targets = normaliseEntries(zip).filter(
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
    for (const entry of normaliseEntries(zip)) {
        if (!entry.name?.toLowerCase().endsWith(".xml")) continue;
        const flattened = stripXmlTags(await entry.async("string"));
        if (flattened) rows.push(flattened);
    }
    return rows.join("\n");
}

export async function extractSqlTextFromDocument({ base64, name = "", mime = "" }) {
    if (!base64 || typeof base64 !== "string") {
        return "";
    }

    const kind = detectDocumentKind(name, mime);
    if (!kind) {
        return "";
    }

    let zip;
    try {
        const buffer = Buffer.from(base64, "base64");
        zip = await JSZip.loadAsync(buffer);
    } catch (error) {
        return "";
    }

    try {
        const primaryText = kind === WORD_KIND ? await extractWordText(zip) : await extractExcelText(zip);
        const rawText = (primaryText && primaryText.trim()) ? primaryText : await extractFallbackXmlText(zip);
        const segments = extractDmlStatements(rawText);
        const dmlText = segments
            .map((segment) => (typeof segment?.text === "string" ? segment.text.trim() : ""))
            .filter(Boolean)
            .join("\n\n");
        if (dmlText) {
            return dmlText;
        }
        return rawText?.trim?.() || "";
    } catch (error) {
        return "";
    }
}
