import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractDmlStatements } from "./sqlAnalyzer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PY_EXTRACTOR = join(__dirname, "document_sql_extractor.py");
const WORD_KIND = "word";
const EXCEL_KIND = "excel";

function normaliseBase64Payload(raw) {
    if (!raw || typeof raw !== "string") return "";
    const trimmed = raw.trim();
    if (trimmed.startsWith("data:")) {
        const comma = trimmed.indexOf(",");
        return comma === -1 ? trimmed : trimmed.slice(comma + 1);
    }
    return trimmed;
}

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

export async function extractSqlTextFromDocument({ base64, name = "", mime = "" }) {
    if (!base64 || typeof base64 !== "string") {
        return "";
    }

    const normalisedBase64 = normaliseBase64Payload(base64);
    if (!normalisedBase64) return "";

    const kind = detectDocumentKind(name, mime);
    if (!kind) {
        return "";
    }

    let rawText = "";
    try {
        rawText = await extractRawTextWithPython({ base64: normalisedBase64, name, mime });
    } catch (error) {
        rawText = "";
    }

    if (!rawText) return "";

    const segments = extractDmlStatements(rawText);
    const dmlText = segments
        .map((segment) => (typeof segment?.text === "string" ? segment.text.trim() : ""))
        .filter(Boolean)
        .join("\n\n");

    return dmlText || rawText.trim();
}
