import { ref } from "vue";

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

export function usePreview() {
    return {
        previewing,
        MAX_TEXT_BYTES,
        resetPreview,
        extOf,
        isTextLike
    };
}
