import { ref } from "vue";
import { extractSqlTextFromFile, isSqlDocument } from "../utils/sqlDocuments.js";

const previewing = ref({
    name: "",
    mime: "",
    size: 0,
    text: "",
    url: "",
    kind: "",
    error: "",
    path: ""
});

const MAX_TEXT_BYTES = 1 * 1024 * 1024;

function resetPreview() {
    if (previewing.value.url) {
        URL.revokeObjectURL(previewing.value.url);
    }
    previewing.value = {
        name: "",
        mime: "",
        size: 0,
        text: "",
        url: "",
        kind: "",
        error: "",
        path: ""
    };
}

function extOf(name = "") {
    const i = name.lastIndexOf(".");
    return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

function isTextLike(name, mime) {
    if ((mime || "").startsWith("text/")) return true;
    const exts = [
        "txt", "md", "json", "js", "ts", "tsx", "jsx", "vue", "html", "css", "scss", "sass",
        "py", "r", "sql", "yml", "yaml", "xml", "csv", "tsv", "ini", "conf", "log", "java"
    ];
    return exts.includes(extOf(name));
}

function isTextPreviewable(name, mime) {
    return isTextLike(name, mime) || isSqlDocument(name, mime);
}

async function readTextContent(file, { name, mime, maxBytes = MAX_TEXT_BYTES } = {}) {
    const resolvedName = name || file?.name || "";
    const resolvedMime = mime || file?.type || "";
    if (!file) throw new Error("缺少檔案內容，無法讀取。");

    if (isTextLike(resolvedName, resolvedMime)) {
        if (file.size > maxBytes) {
            throw new Error("檔案過大，無法載入完整內容預覽。");
        }
        return await file.text();
    }

    if (!isSqlDocument(resolvedName, resolvedMime)) {
        throw new Error("目前僅支援純文字或包含 SQL 的文件預覽。");
    }

    if (file.size > maxBytes * 2) {
        throw new Error("檔案過大，請縮小檔案後再試或僅保留包含 SQL 的頁面。");
    }

    return await extractSqlTextFromFile(file);
}

export function usePreview() {
    return {
        previewing,
        MAX_TEXT_BYTES,
        resetPreview,
        extOf,
        isTextLike,
        isSqlDocument,
        isTextPreviewable,
        readTextContent
    };
}
