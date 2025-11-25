<script setup>
import { computed, ref, watch } from "vue";

defineOptions({
    name: "TreeNode"
});

const props = defineProps({
    node: {
        type: Object,
        required: true
    },
    activePath: {
        type: String,
        default: ""
    }
});

const emit = defineEmits(["open", "select"]);

const isDirectory = computed(() => props.node?.type === "dir");
const isActive = computed(() => props.activePath === (props.node?.path || ""));
const children = computed(() => props.node?.children || []);

const isOpen = ref(false);

watch(
    () => props.node,
    (node) => {
        if (!node) {
            isOpen.value = false;
            return;
        }
        isOpen.value = node.type === "dir";
    },
    { immediate: true }
);

const icon = computed(() => {
    if (!props.node) return "";
    if (isDirectory.value) {
        return isOpen.value ? "📂" : "📁";
    }
    return "📄";
});

const bigFileLabel = computed(() => {
    if (!props.node || props.node.type !== "file" || !props.node.isBig) {
        return "";
    }
    const size = props.node.size || 0;
    const mb = size / 1024 / 1024;
    return `${mb.toFixed(1)} MB`;
});

const fileTitle = computed(() => {
    const node = props.node;
    if (!node) return "";
    if (node.type !== "file") return node.name || "";
    const size = node.size ?? 0;
    const mime = node.mime || "-";
    const timestamp = node.lastModified ? new Date(node.lastModified).toLocaleString() : "-";
    return `Size: ${size} bytes\nType: ${mime}\nUpdated: ${timestamp}`;
});

function toggleDirectory() {
    if (!isDirectory.value) return;
    isOpen.value = !isOpen.value;
}

function handleRowClick() {
    const node = props.node;
    if (!node) return;
    emit("select", node.path);
    if (node.type === "dir") {
        toggleDirectory();
        return;
    }
    emit("open", node);
}

function handleCaretClick(event) {
    event?.stopPropagation?.();
    toggleDirectory();
}

function forwardOpen(childNode) {
    emit("open", childNode);
}

function forwardSelect(path) {
    emit("select", path);
}
</script>

<template>
    <li :class="['workspaceTreeNode', `workspaceTreeNode--${props.node?.type || 'unknown'}`]">
        <div
            class="treeRow"
            :class="{ 'treeRow--active': isActive }"
            @click="handleRowClick"
            :title="fileTitle"
        >
            <button
                v-if="isDirectory"
                type="button"
                class="treeCaret"
                @click="handleCaretClick"
                :aria-expanded="isOpen"
                :aria-label="isOpen ? '收合資料夾' : '展開資料夾'"
            >
                <span v-if="isOpen">▾</span>
                <span v-else>▸</span>
            </button>
            <span v-else class="treeCaret treeCaret--placeholder"></span>
            <span class="treeIcon">{{ icon }}</span>
            <span class="treeLabel" :title="props.node?.path">{{ props.node?.name }}</span>
            <span v-if="bigFileLabel" class="treeMetaBadge">{{ bigFileLabel }}</span>
        </div>
        <ul v-if="isDirectory && isOpen" class="treeChildren">
            <TreeNode
                v-for="child in children"
                :key="child.path"
                :node="child"
                :active-path="activePath"
                @open="forwardOpen"
                @select="forwardSelect"
            />
        </ul>
    </li>
</template>

<style scoped>
.workspaceTreeNode {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--tree-text);
}

.treeRow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 8px;
    transition: background 0.2s ease, color 0.2s ease;
    cursor: pointer;
    user-select: none;
}

.treeRow:hover {
    background: var(--tree-row-hover);
}

.treeRow--active {
    background: var(--tree-row-active);
}

.treeCaret {
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    color: var(--tree-icon);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    cursor: pointer;
}

.treeCaret--placeholder {
    cursor: default;
}

.treeIcon {
    width: 20px;
    text-align: center;
    font-size: 16px;
    color: var(--tree-icon);
}

.treeLabel {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13px;
    color: var(--tree-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.treeMetaBadge {
    flex: 0 0 auto;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    background: var(--panel-accent-soft);
    color: var(--panel-heading);
}

.treeChildren {
    list-style: none;
    margin: 4px 0 0 22px;
    padding: 0 0 0 16px;
    border-left: 1px dashed var(--tree-connector);
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.treeChildren:empty {
    display: none;
    margin: 0;
    padding: 0;
    border-left: none;
}
</style>
