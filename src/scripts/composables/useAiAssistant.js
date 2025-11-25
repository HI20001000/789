import { ref, computed } from "vue";

let messageId = 0;
let ctxId = 0;

const API_ENDPOINT = "http://192.168.3.71:8000/v1/chat/completions";
const MODEL_ID = "Qwen3-30B-A3B-Instruct-2507-FP8";
const SYSTEM_PROMPT = "\u4f60\u662f\u4e00\u500b\u6709\u7528\u7684\u52a9\u624b\u3002";
const GREETING_MESSAGE = "\u55e8\uff01Chat AI \u5df2\u9023\u7dda\u81f3 Qwen3-30B \u6a21\u578b\uff0c\u96a8\u6642\u53ef\u4ee5\u63d0\u554f\u3002";
const THINKING_MESSAGE = "\u6a21\u578b\u6b63\u5728\u751f\u6210\u56de\u61c9...";
const ERROR_PREFIX = "\u62b1\u6b49\uff0c\u8acb\u6c42\u5931\u6557\uff1a";
const CONTEXT_HEADER = "\u4f7f\u7528\u8005\u9078\u64c7\u4e86\u4ee5\u4e0b\u4e0a\u4e0b\u6587\uff0c\u82e5\u5408\u9069\u8acb\u53c3\u8003\uff1a";
const HANDSHAKE_CHECKING_MESSAGE = "\u9023\u63a5\u4e2d...";
const HANDSHAKE_OK_MESSAGE = "\u9023\u63a5\u6210\u529f";
const HANDSHAKE_FAIL_MESSAGE = "\u9023\u63a5\u5931\u6557";
const HANDSHAKE_USER_PROMPT = "ping";
const NO_CONTENT_ERROR = "\u6a21\u578b\u672a\u8fd4\u56de\u5167\u5bb9";
const MAX_TOKENS = 6000;
const TEMPERATURE = 0.7;

function normaliseLine(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normaliseColumn(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function normalisePositiveInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function buildSnippetRangeParts(meta = {}) {
    const startLine = normaliseLine(meta.startLine);
    const endLine = normaliseLine(meta.endLine ?? startLine);
    const startColumn = normaliseColumn(meta.startColumn);
    const endColumn = normaliseColumn(meta.endColumn);
    const lineCount = normalisePositiveInteger(meta.lineCount);
    const parts = [];
    if (startLine !== null && endLine !== null) {
        parts.push(startLine === endLine ? `行 ${startLine}` : `行 ${startLine}-${endLine}`);
    } else if (startLine !== null) {
        parts.push(`行 ${startLine}`);
    } else if (endLine !== null) {
        parts.push(`行 ${endLine}`);
    }
    const isSingleLine = startLine !== null && endLine !== null && startLine === endLine;
    if (isSingleLine) {
        if (startColumn !== null && endColumn !== null) {
            parts.push(startColumn === endColumn ? `字元 ${startColumn}` : `字元 ${startColumn}-${endColumn}`);
        } else if (startColumn !== null) {
            parts.push(`字元 ${startColumn} 起`);
        } else if (endColumn !== null) {
            parts.push(`字元 ${endColumn} 止`);
        }
    } else {
        if (startColumn !== null) parts.push(`起始字元 ${startColumn}`);
        if (endColumn !== null) parts.push(`結束字元 ${endColumn}`);
    }
    if (lineCount !== null) {
        parts.push(`共 ${lineCount} 行`);
    }
    return parts;
}

function findNodeByPath(nodes, targetPath) {
    if (!Array.isArray(nodes)) return null;
    for (const node of nodes) {
        if (!node) continue;
        if (node.path === targetPath) return node;
        if (node.children) {
            const found = findNodeByPath(node.children, targetPath);
            if (found) return found;
        }
    }
    return null;
}

function formatContextSummary(items) {
    if (!Array.isArray(items) || !items.length) return "";
    const lines = items.map((item, index) => {
        const label = item.label || item.path || `Item ${index + 1}`;
        const isSnippet = item.type === "snippet";
        const header = isSnippet ? `\u7a0b\u5f0f\u78bc\u7247\u6bb5: ${label}` : `\u6a94\u6848: ${label}`;
        const segments = [`${index + 1}. ${header}`];
        if (isSnippet) {
            if (item.snippet?.path) {
                segments.push(`\u4f86\u6e90\u6a94\u6848: ${item.snippet.path}`);
            }
            const rangeParts = buildSnippetRangeParts(item.snippet || {});
            if (rangeParts.length) {
                segments.push(`\u7bc4\u570d: ${rangeParts.join("\uff0c")}`);
            }
        } else if (item.path) {
            segments.push(`\u8def\u5f91: ${item.path}`);
        }
        if (item.content) segments.push(item.content);
        return segments.join("\n");
    });
    return `${CONTEXT_HEADER}\n\n${lines.join("\n\n")}`;
}


function normaliseMessagesForApi(messages) {
    return messages
        .filter((msg) => (msg.role === "user" || msg.role === "assistant") && msg.content && msg.status !== "pending" && !msg.synthetic)
        .map((msg) => ({ role: msg.role, content: msg.content }));
}

export function useAiAssistant({ treeStore, projectsStore, fileSystem, preview }) {
    const isOpen = ref(false);
    const isProcessing = ref(false);
    const connectionStatus = ref("checking");
    const connectionMessage = ref(HANDSHAKE_CHECKING_MESSAGE);
    const contextItems = ref([]);
    const messages = ref([]);

    let handshakePromise = null;

    const isInteractionLocked = computed(() => connectionStatus.value !== "ready");
    const connection = computed(() => ({ status: connectionStatus.value, message: connectionMessage.value }));

    function pushMessage(role, content, extra = {}) {
        const entry = {
            id: ++messageId,
            role,
            content,
            timestamp: new Date(),
            ...extra
        };
        messages.value.push(entry);
        return entry;
    }

    function formatError(error) {
        return error?.message || String(error);
    }

    async function performHandshake() {
        if (!handshakePromise) {
            handshakePromise = (async () => {
                connectionStatus.value = "checking";
                connectionMessage.value = HANDSHAKE_CHECKING_MESSAGE;
                try {
                    const response = await fetch(API_ENDPOINT, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            model: MODEL_ID,
                            messages: [
                                { role: "system", content: SYSTEM_PROMPT },
                                { role: "user", content: HANDSHAKE_USER_PROMPT }
                            ],
                            max_tokens: 1,
                            temperature: 0
                        })
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(errorText || `HTTP ${response.status}`);
                    }

                    const data = await response.json();
                    if (data?.error) {
                        throw new Error(data.error.message || JSON.stringify(data.error));
                    }

                    connectionStatus.value = "ready";
                    connectionMessage.value = HANDSHAKE_OK_MESSAGE;
                    if (!messages.value.some((msg) => msg.synthetic && msg.status === "info")) {
                        pushMessage("assistant", GREETING_MESSAGE, { synthetic: true, status: "info" });
                    }
                } catch (error) {
                    const suffix = formatError(error);
                    connectionStatus.value = "error";
                    connectionMessage.value = HANDSHAKE_FAIL_MESSAGE;
                    pushMessage("assistant", `${ERROR_PREFIX}${suffix}`, { synthetic: true, status: "error" });
                    handshakePromise = null;
                }
            })();
        }
        return handshakePromise;
    }

    function retryHandshake(options = {}) {
        const force = options === true || options?.force;
        if (force || connectionStatus.value === "error") {
            handshakePromise = null;
        }
        return performHandshake();
    }

    async function ensureHandshakeReady() {
        await performHandshake();
        return connectionStatus.value === "ready";
    }

    function open() {
        isOpen.value = true;
    }

    function close() {
        isOpen.value = false;
    }

    async function loadContextContent(node) {
        if (!node) throw new Error("請先選擇要加入的檔案。");
        if (node.type !== "file") throw new Error("僅支援將單一文件加入上下文。");

        const projectId = projectsStore?.selectedProjectId?.value;
        if (!projectId) throw new Error("請先從左側開啟一個專案。");

        let mime = node.mime || "";
        let name = node.name || node.path || `ctx-${ctxId + 1}`;
        let size = 0;
        let content = "";

        try {
            const root = await projectsStore.getProjectRootHandleById(projectId);
            const fileHandle = await fileSystem.getFileHandleByPath(root, node.path);
            const file = await fileHandle.getFile();
            mime = node.mime || file.type || "";
            name = node.name || file.name || node.path || `ctx-${ctxId + 1}`;
            size = file.size;
            if (!preview.isTextLike(name, mime)) {
                throw new Error("目前僅支援加入純文字類型檔案。");
            }
            if (size > preview.MAX_TEXT_BYTES) {
                throw new Error("檔案過大（> 1 MB），請先簡化後再試。");
            }
            content = await file.text();
        } catch (error) {
            if (error?.code !== "external-handle-missing") {
                throw error;
            }
            const record = await projectsStore.fetchStoredFileContent?.(projectId, node.path);
            if (!record || typeof record.content !== "string") {
                throw new Error("無法從資料庫讀取檔案內容，請重新匯入資料夾。");
            }
            mime = record.mime || node.mime || "text/plain";
            name = node.name || node.path || `ctx-${ctxId + 1}`;
            if (!preview.isTextLike(name, mime)) {
                throw new Error("目前僅支援加入純文字類型檔案。");
            }
            content = record.content;
            size = Number(record.size) || content.length;
            if (size > preview.MAX_TEXT_BYTES) {
                throw new Error("檔案過大（> 1 MB），請先簡化後再試。");
            }
        }

        return {
            id: node.path || `ctx-${++ctxId}`,
            label: name,
            type: node.type || "file",
            path: node.path,
            mime,
            size,
            content
        };
    }

    async function addContext(node) {
        try {
            const entry = await loadContextContent(node);
            if (contextItems.value.some((ctx) => ctx.id === entry.id)) {
                return false;
            }
            contextItems.value.push(entry);
            return true;
        } catch (error) {
            pushMessage("assistant", `${ERROR_PREFIX}${formatError(error)}`, { synthetic: true, status: "error" });
            return false;
        }
    }

    function normaliseLine(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function normaliseColumn(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
    }

    function normalisePositiveInteger(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
    }

    function buildSnippetRangeParts(meta = {}) {
        const startLine = normaliseLine(meta.startLine);
        const endLine = normaliseLine(meta.endLine ?? startLine);
        const startColumn = normaliseColumn(meta.startColumn);
        const endColumn = normaliseColumn(meta.endColumn);
        const lineCount = normalisePositiveInteger(meta.lineCount);
        const parts = [];
        if (startLine !== null && endLine !== null) {
            parts.push(startLine === endLine ? `行 ${startLine}` : `行 ${startLine}-${endLine}`);
        } else if (startLine !== null) {
            parts.push(`行 ${startLine}`);
        } else if (endLine !== null) {
            parts.push(`行 ${endLine}`);
        }
        const isSingleLine = startLine !== null && endLine !== null && startLine === endLine;
        if (isSingleLine) {
            if (startColumn !== null && endColumn !== null) {
                parts.push(startColumn === endColumn ? `字元 ${startColumn}` : `字元 ${startColumn}-${endColumn}`);
            } else if (startColumn !== null) {
                parts.push(`字元 ${startColumn} 起`);
            } else if (endColumn !== null) {
                parts.push(`字元 ${endColumn} 止`);
            }
        } else {
            if (startColumn !== null) parts.push(`起始字元 ${startColumn}`);
            if (endColumn !== null) parts.push(`結束字元 ${endColumn}`);
        }
        if (lineCount !== null) {
            parts.push(`共 ${lineCount} 行`);
        }
        return parts;
    }

    async function addActiveNode() {
        if (isInteractionLocked.value) return false;
        const activePath = treeStore?.activeTreePath?.value;
        if (!activePath) {
            pushMessage("assistant", "請先在左側選擇想要加入的檔案。", { synthetic: true, status: "error" });
            return false;
        }
        const node = findNodeByPath(treeStore?.tree?.value || [], activePath);
        if (!node) {
            pushMessage("assistant", "無法找到選取的檔案。", { synthetic: true, status: "error" });
            return false;
        }
        return await addContext(node);
    }

    function removeContext(id) {
        contextItems.value = contextItems.value.filter((item) => item.id !== id);
    }

    function clearContext() {
        if (isInteractionLocked.value) return;
        contextItems.value = [];
    }

    function formatSnippetLabel(snippetMeta, fallbackId) {
        const name = snippetMeta?.label || snippetMeta?.name || snippetMeta?.path;
        const startLine = normaliseLine(snippetMeta?.startLine);
        const endLine = normaliseLine(snippetMeta?.endLine ?? snippetMeta?.startLine);
        if (!name) return `Snippet ${fallbackId}`;
        if (startLine === null) return name;
        if (endLine === null || endLine === startLine) {
            return `${name} (行 ${startLine})`;
        }
        return `${name} (行 ${startLine}-${endLine})`;
    }

    function formatSnippetPayload(text) {
        const normalised = (text || "").replace(/\r\n|\r/g, "\n");
        const body = normalised.replace(/\u00A0/g, " ").trimEnd();
        return { payload: body, body };
    }

    function addSnippetContext(snippetMeta = {}) {
        if (isInteractionLocked.value) return false;
        try {
            const projectId = projectsStore?.selectedProjectId?.value;
            if (!projectId) {
                throw new Error("請先從左側開啟一個專案。");
            }

            const snippetText = typeof snippetMeta.text === "string" ? snippetMeta.text : snippetMeta.content;
            if (!(snippetText || "").trim()) {
                throw new Error("請先在程式碼檢視中選取想加入的程式碼片段。");
            }

            const path = snippetMeta.path || treeStore?.activeTreePath?.value;
            if (!path) {
                throw new Error("無法辨識程式碼片段所屬的檔案，請重新選取。");
            }

            const startLine = normaliseLine(snippetMeta.startLine);
            const endLine = normaliseLine(snippetMeta.endLine ?? snippetMeta.startLine);
            const startColumn = normaliseColumn(snippetMeta.startColumn);
            const endColumn = normaliseColumn(snippetMeta.endColumn);
            const inferredLineCount = endLine !== null && startLine !== null ? endLine - startLine + 1 : null;
            const lineCount = normalisePositiveInteger(snippetMeta.lineCount) ?? inferredLineCount;

            const id = `snippet-${++ctxId}`;
            const label = formatSnippetLabel(snippetMeta, ctxId);
            const { payload, body } = formatSnippetPayload(snippetText);

            const entry = {
                id,
                label,
                type: "snippet",
                path,
                snippet: {
                    path,
                    startLine,
                    endLine,
                    startColumn,
                    endColumn,
                    lineCount,
                    text: body
                },
                content: payload
            };

            contextItems.value.push(entry);
            return true;
        } catch (error) {
            pushMessage("assistant", `${ERROR_PREFIX}${formatError(error)}`, { synthetic: true, status: "error" });
            return false;
        }
    }

    async function sendUserMessage(raw) {
        const text = (raw || "").trim();
        if (!text || isProcessing.value) return;
        const ready = await ensureHandshakeReady();
        if (!ready || isInteractionLocked.value) return;

        pushMessage("user", text);
        const assistantMessage = pushMessage("assistant", THINKING_MESSAGE, { status: "pending" });

        isProcessing.value = true;

        try {
            const conversation = normaliseMessagesForApi(messages.value);
            const payloadMessages = [
                { role: "system", content: SYSTEM_PROMPT }
            ];

            const contextSummary = formatContextSummary(contextItems.value);
            if (contextSummary) {
                payloadMessages.push({ role: "system", content: contextSummary });
            }

            payloadMessages.push(...conversation);

            const requestBody = {
                model: MODEL_ID,
                messages: payloadMessages,
                max_tokens: MAX_TOKENS,
                temperature: TEMPERATURE
            };

            const response = await fetch(API_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText || `HTTP ${response.status}`);
            }

            const data = await response.json();
            if (data?.error) {
                throw new Error(data.error.message || JSON.stringify(data.error));
            }

            const reply = data?.choices?.[0]?.message?.content?.trim();
            if (!reply) {
                throw new Error(NO_CONTENT_ERROR);
            }

            assistantMessage.content = reply;
            assistantMessage.status = "success";
        } catch (error) {
            console.error("Chat AI request failed", error);
            assistantMessage.content = `${ERROR_PREFIX}${formatError(error)}`;
            assistantMessage.status = "error";
        } finally {
            assistantMessage.timestamp = new Date();
            isProcessing.value = false;
        }
    }

    void performHandshake();

    return {
        isOpen,
        open,
        close,
        isProcessing,
        connection,
        isInteractionLocked,
        contextItems,
        messages,
        addActiveNode,
        addSnippetContext,
        removeContext,
        clearContext,
        sendUserMessage,
        retryHandshake,
        addSnippetContext
    };
}

