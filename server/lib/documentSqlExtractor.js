import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = resolve(__dirname, "document_sql_extractor.py");
const PYTHON_CANDIDATES = [process.env.PYTHON, process.env.PYTHON_BIN, "python3", "python"].filter(
    Boolean
);

async function runExtractor(command, payload) {
    return await new Promise((resolve, reject) => {
        const child = spawn(command, [SCRIPT_PATH], { stdio: ["pipe", "pipe", "pipe"] });
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

        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
    });
}

export async function extractSqlTextFromDocument({ base64, name = "", mime = "" }) {
    if (!base64 || typeof base64 !== "string") {
        return "";
    }

    const attempts = PYTHON_CANDIDATES.length ? PYTHON_CANDIDATES : ["python3", "python"];
    let lastError;

    for (const command of attempts) {
        try {
            return await runExtractor(command, { base64, name, mime });
        } catch (error) {
            lastError = error;
            if (error?.code !== "ENOENT") {
                break;
            }
        }
    }

    const message =
        "Document SQL extraction requires Python (python3 or python) to be installed on the server." +
        (lastError?.message ? ` Last error: ${lastError.message}` : "");
    const error = new Error(message);
    error.code = lastError?.code || "PYTHON_NOT_FOUND";
    throw error;
}

