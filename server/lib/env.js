import { accessSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let hasLoaded = false;
let cachedEnv = null;
let lastLoadMeta = null;

function findEnvPath() {
    const candidates = [];

    // Prefer the directory where the process was started from.
    candidates.push(resolve(process.cwd(), ".env"));

    // Fall back to the project root (two directories up from this file).
    const currentDir = dirname(fileURLToPath(import.meta.url));
    candidates.push(resolve(currentDir, "../../.env"));

    for (const candidate of candidates) {
        try {
            accessSync(candidate);
            return candidate;
        } catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
    }

    // Default to the first candidate so downstream logging can mention the
    // expected location even if the file does not exist.
    return candidates[0];
}

function parseEnv(content) {
    const result = {};
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        if (!line || /^\s*#/.test(line)) {
            continue;
        }
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match) {
            continue;
        }
        let [, key, value] = match;
        if (value.startsWith("\ufeff")) {
            value = value.slice(1);
        }
        if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        result[key] = value.trim();
    }
    return result;
}

export function loadEnv() {
    if (hasLoaded) {
        return cachedEnv ?? process.env;
    }
    hasLoaded = true;

    if (typeof process.loadEnvFile === "function") {
        try {
            process.loadEnvFile();
            cachedEnv = { ...process.env };
            lastLoadMeta = { source: "process.loadEnvFile" };
            console.log("[env] Loaded environment variables via process.loadEnvFile()");
            return cachedEnv;
        } catch (error) {
            if (error?.code !== "ENOENT") {
                console.warn("Failed to load .env via process.loadEnvFile", error?.message || error);
            } else {
                cachedEnv = { ...process.env };
                lastLoadMeta = { source: "process.env" };
                return cachedEnv;
            }
        }
    }

    try {
        const envPath = findEnvPath();
        const content = readFileSync(envPath, "utf8");
        const variables = parseEnv(content);
        for (const [key, value] of Object.entries(variables)) {
            if (process.env[key] === undefined) {
                process.env[key] = value;
            }
        }
        cachedEnv = { ...process.env };
        lastLoadMeta = { source: "file", path: envPath };
        console.log(`[env] Loaded environment variables from ${envPath}`);
        return cachedEnv;
    } catch (error) {
        if (error?.code !== "ENOENT") {
            console.warn("Failed to load .env file", error?.message || error);
        } else if (!lastLoadMeta) {
            const attemptedPath = findEnvPath();
            console.warn(`[env] .env file not found at ${attemptedPath}; falling back to process.env`);
        }
        cachedEnv = { ...process.env };
        lastLoadMeta = { source: "process.env" };
        return cachedEnv;
    }
}
