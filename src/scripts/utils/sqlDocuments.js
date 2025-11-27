import { extractSqlFromDocument } from "../services/apiService.js";

const SQL_KEYWORD_PATTERN = /\b(select|update|insert|delete|create|alter|drop|with|merge|replace)\b/i;
const SQL_DOC_EXTS = new Set(["doc", "docx", "xls", "xlsx"]);

function extOf(name = "") {
    const i = name.lastIndexOf(".");
    return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

function detectSqlDocKind(name, mime = "") {
    const ext = extOf(name);
    if (SQL_DOC_EXTS.has(ext)) {
        if (ext === "xls" || ext === "xlsx") return "excel";
        if (ext === "doc" || ext === "docx") return "word";
    }

    const normalisedMime = (mime || "").toLowerCase();
    if (normalisedMime.includes("spreadsheet")) return "excel";
    if (normalisedMime.includes("ms-excel")) return "excel";
    if (normalisedMime.includes("wordprocessingml")) return "word";
    if (normalisedMime.includes("msword") || normalisedMime.includes("ms-word")) return "word";

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

export function isSqlDocument(name, mime = "") {
    return Boolean(detectSqlDocKind(name, mime));
}

export async function extractSqlTextFromFile(file) {
    if (!file) return "";
    const name = file.name || "";
    const mime = file.type || "";
    const kind = detectSqlDocKind(name, mime);
    if (!kind) {
        throw new Error("This file is not a supported SQL document type");
    }

    const base64 = arrayBufferToBase64(await file.arrayBuffer());
    const response = await extractSqlFromDocument({ data: base64, name, mime });
    const rawText = typeof response?.text === "string" ? response.text : "";
    const lines = rawText.split(/\r\n|\r|\n/);
    return extractSqlBlocksFromLines(lines);
}

