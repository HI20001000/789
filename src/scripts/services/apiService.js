const DEFAULT_BASE = "/api";
const apiBase = (() => {
    if (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_API_BASE_URL) {
        return import.meta.env.VITE_API_BASE_URL.replace(/\/$/, "");
    }
    if (typeof process !== "undefined" && process.env?.VITE_API_BASE_URL) {
        return process.env.VITE_API_BASE_URL.replace(/\/$/, "");
    }
    return DEFAULT_BASE;
})();

async function request(path, { method = "GET", body, headers = {} } = {}) {
    const url = `${apiBase}${path}`;
    const opts = { method, headers: { ...headers } };
    if (body !== undefined) {
        opts.body = typeof body === "string" ? body : JSON.stringify(body);
        if (!opts.headers["Content-Type"]) {
            opts.headers["Content-Type"] = "application/json";
        }
    }
    const response = await fetch(url, opts);
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`API request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`);
    }
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
        return await response.json();
    }
    return await response.text();
}

export async function fetchProjects() {
    return await request("/projects");
}

export async function createOrUpdateProject(project) {
    return await request("/projects", { method: "POST", body: project });
}

export async function deleteProjectById(projectId) {
    await request(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
}

export async function fetchNodesByProject(projectId) {
    return await request(`/projects/${encodeURIComponent(projectId)}/nodes`);
}

export async function replaceProjectNodes(projectId, nodes) {
    await request(`/projects/${encodeURIComponent(projectId)}/nodes`, { method: "POST", body: { nodes } });
}

export async function deleteProjectNodes(projectId) {
    await request(`/projects/${encodeURIComponent(projectId)}/nodes`, { method: "DELETE" });
}

export async function replaceProjectFiles(projectId, files) {
    await request(`/projects/${encodeURIComponent(projectId)}/files`, { method: "POST", body: { files } });
}

export async function fetchProjectFile(projectId, path) {
    if (!path) {
        throw new Error("Path is required to fetch a project file");
    }
    const query = new URLSearchParams({ path }).toString();
    return await request(`/projects/${encodeURIComponent(projectId)}/files?${query}`);
}

const apiService = {
    fetchProjects,
    createOrUpdateProject,
    deleteProjectById,
    fetchNodesByProject,
    replaceProjectNodes,
    deleteProjectNodes,
    replaceProjectFiles,
    fetchProjectFile,
};

export default apiService;
