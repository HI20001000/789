import { inflateRawSync } from "node:zlib";
import { extractDmlStatements } from "./sqlAnalyzer.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

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

function findEndOfCentralDirectory(buffer) {
    const minOffset = Math.max(0, buffer.length - 0xffff - 22);
    for (let i = buffer.length - 22; i >= minOffset; i--) {
        if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
            return i;
        }
    }
    return -1;
}

function listEntries(buffer) {
    const entries = [];
    const eocdOffset = findEndOfCentralDirectory(buffer);
    if (eocdOffset < 0) return entries;

    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    let offset = buffer.readUInt32LE(eocdOffset + 16);

    for (let i = 0; i < totalEntries; i++) {
        if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
            break;
        }

        const compressionMethod = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const fileNameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);
        const nameStart = offset + 46;

        const name = buffer.slice(nameStart, nameStart + fileNameLength).toString("utf8");
        entries.push({
            name,
            compressionMethod,
            compressedSize,
            uncompressedSize,
            localHeaderOffset
        });

        offset = nameStart + fileNameLength + extraLength + commentLength;
    }

    return entries;
}

function extractEntry(buffer, entry) {
    const headerOffset = entry.localHeaderOffset;
    if (buffer.readUInt32LE(headerOffset) !== LOCAL_SIGNATURE) {
        return null;
    }

    const fileNameLength = buffer.readUInt16LE(headerOffset + 26);
    const extraLength = buffer.readUInt16LE(headerOffset + 28);
    const dataStart = headerOffset + 30 + fileNameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart < 0 || dataEnd > buffer.length) {
        return null;
    }
    const compressedData = buffer.slice(dataStart, dataEnd);

    if (entry.compressionMethod === 0) {
        return compressedData;
    }
    if (entry.compressionMethod === 8) {
        try {
            return inflateRawSync(compressedData);
        } catch (error) {
            return null;
        }
    }

    return null;
}

async function extractWordText(buffer, entries) {
    const target = entries.find((entry) => entry.name === "word/document.xml");
    if (!target) return "";

    const content = extractEntry(buffer, target);
    if (!content) return "";

    const xml = content.toString("utf8");
    const matches = Array.from(xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gim));
    const texts = matches.map((match) => stripXmlTags(match[1])).filter((text) => text);
    return texts.join("\n");
}

async function extractExcelText(buffer, entries) {
    const rows = [];
    for (const entry of entries) {
        if (entry.name !== "xl/sharedStrings.xml" && !(entry.name.startsWith("xl/worksheets/") && entry.name.endsWith(".xml"))) {
            continue;
        }
        const content = extractEntry(buffer, entry);
        if (!content) continue;
        const xml = content.toString("utf8");
        const flattened = stripXmlTags(xml);
        if (flattened) {
            rows.push(flattened);
        }
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

    let buffer;
    try {
        buffer = Buffer.from(base64, "base64");
    } catch (error) {
        return "";
    }

    const entries = listEntries(buffer);
    if (!entries.length) {
        return "";
    }

    try {
        const rawText = kind === WORD_KIND ? await extractWordText(buffer, entries) : await extractExcelText(buffer, entries);
        const segments = extractDmlStatements(rawText);
        if (segments.length) {
            return segments
                .map((segment) => (typeof segment?.text === "string" ? segment.text.trim() : ""))
                .filter(Boolean)
                .join("\n\n");
        }
        return rawText?.trim?.() || "";
    } catch (error) {
        return "";
    }
}

