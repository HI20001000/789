const DEFAULT_BASE = "/api";

function readEnvBase() {
    const fromWindow = typeof window !== "undefined" && window.__AI_PLATFORM_API_BASE__;
    if (fromWindow) {
        return String(fromWindow).trim();
    }
    const metaEnv = typeof import.meta !== "undefined" ? import.meta.env : undefined;
    const processEnv = typeof process !== "undefined" ? process.env : undefined;

    const candidates = [
        metaEnv?.VITE_API_BASE_URL,
        processEnv?.VITE_API_BASE_URL,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }

    return "";
}

function normaliseBase(base) {
    const value = (base || "").trim();
    if (!value) {
        return DEFAULT_BASE;
    }
    return value.replace(/\/+$/, "");
}

const apiBase = normaliseBase(readEnvBase());

function readReportUserId() {
    const fromWindow = typeof window !== "undefined" && window.__AI_PLATFORM_REPORT_USER__;
    if (fromWindow) {
        return String(fromWindow).trim();
    }
    const metaEnv = typeof import.meta !== "undefined" ? import.meta.env : undefined;
    const processEnv = typeof process !== "undefined" ? process.env : undefined;
    const candidates = [
        metaEnv?.VITE_DIFY_USER_ID,
        processEnv?.VITE_DIFY_USER_ID
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }
    return "workspace-client";
}

function joinPaths(base, path) {
    if (!base) return path;
    const hasTrailing = base.endsWith("/");
    const hasLeading = path.startsWith("/");
    if (hasTrailing && hasLeading) {
        return base + path.slice(1);
    }
    if (!hasTrailing && !hasLeading) {
        return `${base}/${path}`;
    }
    return base + path;
}

function buildRequestUrl(path) {
    const targetPath = path.startsWith("/") ? path : `/${path}`;
    if (/^https?:\/\//i.test(apiBase)) {
        const base = apiBase.endsWith("/") ? apiBase : `${apiBase}/`;
        return new URL(targetPath.replace(/^\//, ""), base).toString();
    }
    if (apiBase.startsWith("/")) {
        return joinPaths(apiBase, targetPath);
    }
    const rootedBase = apiBase ? `/${apiBase.replace(/^\//, "")}` : "";
    return joinPaths(rootedBase || DEFAULT_BASE, targetPath);
}

async function postJson(path, payload) {
    const url = buildRequestUrl(path);
    const headers = new Headers();
    headers.set("Content-Type", "application/json");

    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
        });
    } catch (error) {
        if (error && typeof error.message === "string" && /Invalid name/i.test(error.message)) {
            const hint =
                "請確認 VITE_API_BASE_URL 或瀏覽器注入的 API Base 設定是否包含非法字元，例如換行或額外的表頭。";
            throw new Error(`${error.message}。${hint}`);
        }
        throw error;
    }

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`API request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
        return await response.json();
    }

    return await response.text();
}

async function getJson(path) {
    const url = buildRequestUrl(path);
    let response;
    try {
        response = await fetch(url, { method: "GET" });
    } catch (error) {
        if (error && typeof error.message === "string" && /Invalid name/i.test(error.message)) {
            const hint =
                "請確認 VITE_API_BASE_URL 或瀏覽器注入的 API Base 設定是否包含非法字元，例如換行或額外的表頭。";
            throw new Error(`${error.message}。${hint}`);
        }
        throw error;
    }

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`API request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
        return await response.json();
    }

    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch (_error) {
        return text;
    }
}

export async function generateReportViaDify(payload) {
    const enrichedPayload = {
        ...payload,
        userId: payload?.userId || readReportUserId()
    };
    return await postJson("/reports/dify", enrichedPayload);
}

export async function fetchProjectReports(projectId) {
    if (!projectId) return [];
    const encodedId = encodeURIComponent(projectId);
    let response;
    try {
        response = await getJson(`/projects/${encodedId}/reports`);
    } catch (error) {
        console.warn("[reports] Failed to fetch project reports", error);
        return [];
    }
    if (Array.isArray(response) && response.length) {
        return response;
    }
    if (Array.isArray(response?.reports) && response.reports.length) {
        return response.reports;
    }
    return [];
}

export default {
    generateReportViaDify,
    fetchProjectReports
};
