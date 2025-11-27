import JSZip from "jszip";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractDmlStatements } from "./sqlAnalyzer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PY_EXTRACTOR = join(__dirname, "document_sql_extractor.py");
const WORD_KIND = "word";
const EXCEL_KIND = "excel";

async function extractRawTextWithPython({ base64, name = "", mime = "" }) {
    return await new Promise((resolve) => {
        const child = spawn("python3", [PY_EXTRACTOR], { stdio: ["pipe", "pipe", "inherit"] });
        let stdout = "";

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });

        child.on("error", () => resolve(""));
        child.on("close", () => {
            try {
                const parsed = JSON.parse(stdout || "{}");
                resolve(typeof parsed?.text === "string" ? parsed.text : "");
            } catch (error) {
                resolve("");
            }
        });

        const payload = { base64, data: base64, name, mime };
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
    });
}

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

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });

        child.on("error", () => resolve(""));
        child.on("close", () => {
            try {
                const parsed = JSON.parse(stdout || "{}");
                resolve(typeof parsed?.text === "string" ? parsed.text : "");
            } catch (error) {
                resolve("");
            }
        });

        const payload = { base64, data: base64, name, mime };
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
    });
}

export async function extractSqlTextFromDocument({ base64, name = "", mime = "" }) {
    if (!base64 || typeof base64 !== "string") {
        return "";
    }

    const kind = detectDocumentKind(name, mime);
    if (!kind) {
        return "";
    }

    let rawText = "";
    try {
        rawText = await extractRawTextWithPython({ base64, name, mime });
    } catch (error) {
        rawText = "";
    }

    if (!rawText) {
        try {
            const buffer = Buffer.from(base64, "base64");
            const zip = await JSZip.loadAsync(buffer);
            const primaryText = kind === WORD_KIND ? await extractWordText(zip) : await extractExcelText(zip);
            rawText = (primaryText && primaryText.trim()) ? primaryText : await extractFallbackXmlText(zip);
        } catch (error) {
            rawText = "";
        }
    }

    if (!rawText) return "";

    const segments = extractDmlStatements(rawText);
    const dmlText = segments
        .map((segment) => (typeof segment?.text === "string" ? segment.text.trim() : ""))
        .filter(Boolean)
        .join("\n\n");

    return dmlText || rawText.trim();
}
