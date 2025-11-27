import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = resolve(__dirname, "document_sql_extractor.py");

export async function extractSqlTextFromDocument({ base64, name = "", mime = "" }) {
    if (!base64 || typeof base64 !== "string") {
        return "";
    }

    return await new Promise((resolve, reject) => {
        const child = spawn("python3", [SCRIPT_PATH], { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => {
            stdout += data.toString();
        });
        child.stderr.on("data", (data) => {
            stderr += data.toString();
        });
        child.on("error", (error) => reject(error));
        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(stderr || `Document extractor exited with code ${code}`));
                return;
            }
            try {
                const parsed = JSON.parse(stdout || "{}", (key, value) => value);
                resolve(typeof parsed?.text === "string" ? parsed.text : "");
            } catch (error) {
                reject(error);
            }
        });

        child.stdin.write(JSON.stringify({ base64, name, mime }));
        child.stdin.end();
    });
}

