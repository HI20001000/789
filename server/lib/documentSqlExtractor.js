import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractDmlStatements } from "./sqlAnalyzer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PY_EXTRACTOR = join(__dirname, "document_sql_extractor.py");

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

export async function extractSqlTextFromDocument({ base64, name = "", mime = "" }) {
    if (!base64 || typeof base64 !== "string") {
        return "";
    }

    let rawText = "";
    try {
        rawText = await extractRawTextWithPython({ base64, name, mime });
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
