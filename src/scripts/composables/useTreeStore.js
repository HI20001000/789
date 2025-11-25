import { parentOf } from "../utils/path.js";
import { ref } from "vue";
import { fetchNodesByProject, replaceProjectNodes, replaceProjectFiles } from "../services/apiService.js";

export function useTreeStore({
    getProjectRootHandleById,
    getFileHandleByPath,
    previewing,
    isTextLike,
    MAX_TEXT_BYTES,
    selectedProjectId,
    fetchStoredFileContent
}) {
    const tree = ref([]);
    const activeTreePath = ref("");
    const activeTreeRevision = ref(0);
    const projectTreeUpdateEvent = ref({ projectId: "", token: 0 });

    function markActiveTreePath(path) {
        activeTreePath.value = path || "";
        activeTreeRevision.value = activeTreeRevision.value + 1;
    }
    const isLoadingTree = ref(false);

    function buildTreeFromFlat(nodes) {
        const map = new Map();
        const roots = [];
        for (const n of nodes) {
            map.set(n.path, { ...n, children: n.type === "dir" ? [] : undefined });
        }
        for (const n of nodes) {
            const node = map.get(n.path);
            if (!n.parent) {
                roots.push(node);
            } else {
                const parent = map.get(n.parent);
                if (parent && parent.type === "dir") parent.children.push(node);
            }
        }
        const sorter = (a, b) =>
            a.type === b.type ? a.name.localeCompare(b.name) : (a.type === "dir" ? -1 : 1);
        const dfs = (node) => {
            if (node.children) {
                node.children.sort(sorter);
                node.children.forEach(dfs);
            }
        };
        roots.sort(sorter).forEach(dfs);
        return roots;
    }

    async function loadTreeFromDB(projectId) {
        const flat = await fetchNodesByProject(projectId);
        console.log(`[Tree] loaded flat nodes for ${projectId}:`, flat.length);
        return buildTreeFromFlat(flat);
    }

    async function scanAndIndexProject(projectId, dirHandle) {
        const queue = [{ handle: dirHandle, base: "" }];
        const nodes = [];
        const filesForStorage = [];

        for (const item of queue) {
            for await (const [name, handle] of item.handle.entries()) {
                const path = item.base ? `${item.base}/${name}` : name;
                if (handle.kind === "directory") {
                    nodes.push({
                        key: `${projectId}:${path}`,
                        projectId,
                        type: "dir",
                        name,
                        path,
                        parent: parentOf(path)
                    });
                    queue.push({ handle, base: path });
                } else {
                    let size = 0;
                    let lastModified = 0;
                    let mime = "";
                    let textContent = null;
                    try {
                        const file = await handle.getFile();
                        size = file.size;
                        lastModified = file.lastModified || 0;
                        mime = file.type || "";
                        if (isTextLike(name, mime) && size <= MAX_TEXT_BYTES) {
                            textContent = await file.text();
                        }
                    } catch (_) {
                        // ignore file read errors
                    }
                    nodes.push({
                        key: `${projectId}:${path}`,
                        projectId,
                        type: "file",
                        name,
                        path,
                        parent: parentOf(path),
                        size,
                        lastModified,
                        mime,
                        isBig: size >= 50 * 1024 * 1024
                    });
                    if (textContent !== null && textContent !== undefined) {
                        filesForStorage.push({
                            path,
                            content: textContent,
                            mime: mime || "text/plain",
                            size,
                            lastModified,
                            createdAt: lastModified || Date.now(),
                            updatedAt: Date.now()
                        });
                    }
                }
            }
        }

        await replaceProjectNodes(projectId, nodes);
        await replaceProjectFiles(projectId, filesForStorage);
    }

    function notifyProjectTreeUpdated(projectId) {
        const key = projectId === null || projectId === undefined ? "" : String(projectId);
        if (!key) return;
        projectTreeUpdateEvent.value = {
            projectId: key,
            token: projectTreeUpdateEvent.value.token + 1
        };
    }

    async function openNode(node) {
        if (!node) return;
        markActiveTreePath(node.path || "");
        if (node.type !== "file") return;
        if (previewing.value.url) {
            URL.revokeObjectURL(previewing.value.url);
        }
        try {
            const root = await getProjectRootHandleById(selectedProjectId.value);
            const fileHandle = await getFileHandleByPath(root, node.path);
            const file = await fileHandle.getFile();
            const mime = node.mime || file.type || "";
            const size = file.size;

            if (mime.startsWith("image/")) {
                const url = URL.createObjectURL(file);
                previewing.value = {
                    name: node.name,
                    mime,
                    size,
                    text: "",
                    url,
                    kind: "image",
                    error: "",
                    path: node.path
                };
                return;
            }
            if (mime === "application/pdf" || node.path.toLowerCase().endsWith(".pdf")) {
                const url = URL.createObjectURL(file);
                previewing.value = {
                    name: node.name,
                    mime,
                    size,
                    text: "",
                    url,
                    kind: "pdf",
                    error: "",
                    path: node.path
                };
                return;
            }
            if (isTextLike(node.name, mime) && size <= MAX_TEXT_BYTES) {
                const text = await file.text();
                previewing.value = {
                    name: node.name,
                    mime: mime || "text/plain",
                    size,
                    text,
                    url: "",
                    kind: "text",
                    error: "",
                    path: node.path
                };
                return;
            }
            const url = URL.createObjectURL(file);
            previewing.value = {
                name: node.name,
                mime: mime || "application/octet-stream",
                size,
                text: "",
                url,
                kind: "other",
                error: "",
                path: node.path
            };
        } catch (error) {
            if (error?.code === "external-handle-missing") {
                try {
                    const record = await fetchStoredFileContent?.(selectedProjectId.value, node.path);
                    if (typeof record?.content !== "string") {
                        throw new Error("資料庫中沒有這個檔案的備份內容，請重新匯入資料夾。");
                    }
                    const text = record.content;
                    previewing.value = {
                        name: node.name,
                        mime: record?.mime || node.mime || "text/plain",
                        size: Number(record?.size) || text.length,
                        text,
                        url: "",
                        kind: "text",
                        error: "",
                        path: node.path
                    };
                    return;
                } catch (fallbackError) {
                    previewing.value = {
                        name: node?.name || "",
                        mime: "",
                        size: 0,
                        text: "",
                        url: "",
                        kind: "error",
                        error: String(fallbackError?.message || fallbackError || ""),
                        path: node?.path || ""
                    };
                    return;
                }
            }
            previewing.value = {
                name: node?.name || "",
                mime: "",
                size: 0,
                text: "",
                url: "",
                kind: "error",
                error: String(error),
                path: node?.path || ""
            };
        }
    }

    function selectTreeNode(path) {
        markActiveTreePath(path || "");
    }

    return {
        tree,
        activeTreePath,
        activeTreeRevision,
        isLoadingTree,
        buildTreeFromFlat,
        loadTreeFromDB,
        scanAndIndexProject,
        openNode,
        selectTreeNode,
        projectTreeUpdateEvent,
        notifyProjectTreeUpdated
    };
}

