<script setup>
import { computed, ref, useSlots } from "vue";
import ReportPanel from "../reports/ReportPanel.vue";
import TreeNode from "./TreeNode.vue";

const props = defineProps({
    styleWidth: {
        type: Object,
        required: true
    },
    mode: {
        type: String,
        default: "projects"
    },
    projects: {
        type: Array,
        default: () => []
    },
    selectedProjectId: {
        type: [String, Number],
        default: null
    },
    onSelectProject: {
        type: Function,
        required: true
    },
    onDeleteProject: {
        type: Function,
        required: true
    },
    tree: {
        type: Array,
        default: () => []
    },
    activeTreePath: {
        type: String,
        default: ""
    },
    isLoadingTree: {
        type: Boolean,
        default: false
    },
    openNode: {
        type: Function,
        required: true
    },
    selectTreeNode: {
        type: Function,
        required: true
    },
    isTreeCollapsed: {
        type: Boolean,
        default: false
    },
    showContent: {
        type: Boolean,
        default: true
    },
    reportConfig: {
        type: Object,
        default: null
    },
    isReportTreeCollapsed: {
        type: Boolean,
        default: false
    },
    toggleReportTree: {
        type: Function,
        default: null
    }
});

const emit = defineEmits(["resizeStart"]);

const slots = useSlots();

const isProjectsMode = computed(() => props.mode === "projects");
const isReportsMode = computed(() => props.mode === "reports");
const hasCustomContent = computed(() => !!slots.default);

const hasProjects = computed(() => (props.projects || []).length > 0);
const isHoveringResizeEdge = ref(false);

const EDGE_THRESHOLD = 8;

const reportPanelProps = computed(() => {
    const config = props.reportConfig;
    if (!config || typeof config !== "object") {
        return null;
    }
    return { ...config };
});

const treeHeaderLabel = computed(() => {
    if (configHasTitle(props.reportConfig)) {
        return props.reportConfig.panelTitle;
    }
    return isProjectsMode.value ? "專案檔案" : "代碼審查";
});

const showReportTree = computed(() => isReportsMode.value && Boolean(reportPanelProps.value));
const treeAreaCollapsed = computed(() => {
    if (isProjectsMode.value) {
        return Boolean(props.isTreeCollapsed);
    }
    return false;
});

function forwardOpenNode(node) {
    if (typeof props.openNode === "function") {
        props.openNode(node);
    }
}

function forwardSelectNode(path) {
    if (typeof props.selectTreeNode === "function") {
        props.selectTreeNode(path);
    }
}

function configHasTitle(config) {
    return Boolean(config && typeof config === "object" && config.panelTitle);
}

function updateResizeHoverState(event) {
    const panel = event.currentTarget;
    if (!panel) return false;
    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const hovering = rect.width - offsetX <= EDGE_THRESHOLD;
    if (isHoveringResizeEdge.value !== hovering) {
        isHoveringResizeEdge.value = hovering;
    }
    return hovering;
}

function handlePointerMove(event) {
    updateResizeHoverState(event);
}

function handlePointerLeave() {
    isHoveringResizeEdge.value = false;
}

function handlePointerDown(event) {
    const hovering = updateResizeHoverState(event);
    if (!hovering) return;
    emit("resizeStart", event);
}

</script>

<template>
    <section
        class="panelRail"
        :class="{ 'panelRail--resizeEdge': isHoveringResizeEdge }"
        :style="styleWidth"
        @pointermove="handlePointerMove"
        @pointerleave="handlePointerLeave"
        @pointerdown="handlePointerDown"
    >
        <template v-if="showContent">
            <div v-if="isProjectsMode" class="projectPanel">
                <div class="panelHeader">專案列表</div>
                <template v-if="hasProjects">
                    <ul class="projectList themed-scrollbar">
                        <li
                            v-for="p in projects"
                            :key="p.id"
                            :class="['projectItem', { active: p.id === selectedProjectId }]"
                        >
                            <div class="projectHeader" @click="onSelectProject(p)">
                                <span class="projName">{{ p.name }}</span>
                                <span class="rightSide">
                                    <span class="badge" :title="p.mode">{{ p.mode }}</span>
                                    <button
                                        class="delBtn"
                                        title="Delete project (DB only)"
                                        @click.stop="onDeleteProject($event, p)"
                                    >
                                        ❌
                                    </button>
                                </span>
                            </div>
                        </li>
                    </ul>
                </template>
                <p v-else class="emptyProjects">尚未匯入任何專案。</p>
            </div>

            <div
                v-if="isProjectsMode || isReportsMode"
                class="treeArea"
                :class="{
                    collapsed: treeAreaCollapsed,
                    'treeArea--reports': isReportsMode,
                    'treeArea--projects': isProjectsMode
                }"
            >
                <div class="treeHeaderRow">
                    <div class="panelHeader">{{ treeHeaderLabel }}</div>
                </div>
                <template v-if="isProjectsMode">
                    <div v-if="treeAreaCollapsed" class="collapsedNotice">
                        檔案樹已折疊，點擊專案可再次展開。
                    </div>
                    <div v-else>
                        <div v-if="isLoadingTree" class="loading">載入檔案樹…</div>
                        <ul
                            v-else-if="tree && tree.length"
                            class="treeRoot themed-scrollbar"
                            role="tree"
                            aria-label="專案檔案"
                        >
                            <TreeNode
                                v-for="node in tree"
                                :key="node.path"
                                :node="node"
                                :active-path="activeTreePath"
                                @open="forwardOpenNode"
                                @select="forwardSelectNode"
                            />
                        </ul>
                        <p v-else class="emptyTree">尚未載入任何檔案，請先匯入專案。</p>
                    </div>
                </template>
                <template v-else>
                    <div v-if="showReportTree" class="reportPanelWrapper">
                        <ReportPanel v-bind="reportPanelProps" />
                    </div>
                    <div v-else class="emptyTree">尚未載入任何報告專案。</div>
                </template>
            </div>

            <template v-if="!isProjectsMode && !isReportsMode && hasCustomContent">
                <slot />
            </template>
        </template>

        <div v-else class="panelEmpty">
            <div class="panelHeader">工具列</div>
            <p class="emptyTree">選擇左側的工具以顯示內容。</p>
        </div>
    </section>
</template>

<style scoped>
.panelRail {
    flex: 0 0 320px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    max-height: 100%;
    background: linear-gradient(180deg, rgba(148, 163, 184, 0.12) 0%, rgba(148, 163, 184, 0.04) 100%),
        var(--panel-surface-alt);
    border: 1px solid var(--panel-border);
    
    box-sizing: border-box;
    overflow-x: hidden;
    overflow-y: auto;
    position: relative;
    box-shadow: 0 24px 44px rgba(148, 163, 184, 0.28);
}

.panelRail--resizeEdge {
    cursor: col-resize;
}

.panelHeader {
    font-weight: 700;
    color: var(--panel-heading);
    margin-bottom: 12px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: 12px;
}

.projectPanel {
    flex: 0 0 auto;
    background: linear-gradient(180deg, rgba(148, 163, 184, 0.08) 0%, rgba(148, 163, 184, 0.02) 100%),
        var(--panel-surface);
    border: 1px solid var(--panel-border);
 
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 18px 30px rgba(15, 23, 42, 0.08), inset 0 0 0 1px rgba(255, 255, 255, 0.02);
}

.reportPanelWrapper {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.projectList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 220px;
    overflow: auto;
    scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
}

.projectItem {
    background: var(--panel-surface-alt);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 10px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    transition: border-color 0.2s ease, background-color 0.2s ease, transform 0.2s ease;
}

.projectItem:hover {
    border-color: var(--panel-border-strong);
    background: var(--panel-surface);
    transform: translateY(-1px);
}

.projectItem.active {
    border-color: var(--panel-border-strong);
    background: var(--panel-accent-soft);
}

.projectHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    color: var(--tree-text);
    cursor: pointer;
}

.projName {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.rightSide {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.badge {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--panel-muted);
}

.delBtn {
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.35);
    color: #dc2626;
    font-size: 12px;
    line-height: 1;
    padding: 4px 6px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
}

.delBtn:hover {
    background: rgba(239, 68, 68, 0.18);
    border-color: rgba(239, 68, 68, 0.5);
}

.emptyProjects {
    margin: 0;
    font-size: 13px;
    color: var(--panel-muted);
}

.treeArea,
.treePlaceholder {
    flex: 1 1 auto;
    min-width: 0;
    background: linear-gradient(180deg, rgba(148, 163, 184, 0.08) 0%, rgba(148, 163, 184, 0.02) 100%),
        var(--panel-surface);
    border: 1px solid var(--panel-border);

    padding: 18px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    box-shadow:
        0 18px 34px rgba(15, 23, 42, 0.08),
        inset 0 0 0 1px rgba(255, 255, 255, 0.02);
}

.panelEmpty {
    flex: 1 1 auto;
    min-width: 0;
    background: linear-gradient(180deg, rgba(148, 163, 184, 0.08) 0%, rgba(148, 163, 184, 0.02) 100%),
        var(--panel-surface);
    border: 1px solid var(--panel-border);
    border-radius: 16px;
    padding: 18px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 8px;
    text-align: center;
    box-shadow:
        0 18px 34px rgba(15, 23, 42, 0.08),
        inset 0 0 0 1px rgba(255, 255, 255, 0.02);
}

.treeArea.collapsed {
    justify-content: flex-start;
}

.treeArea--reports.collapsed {
    align-items: flex-start;
}

.treeHeaderRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
}

.treeHeaderRow .panelHeader {
    margin-bottom: 0;
}

.treeArea .panelHeader,
.treePlaceholder .panelHeader {
    margin-bottom: 12px;
}

.treeArea .loading {
    padding: 10px;
    opacity: 0.8;
    color: var(--panel-muted);
}

.emptyTree {
    margin: 0;
    color: var(--panel-muted);
}

.collapsedNotice {
    margin: 0;
    color: var(--panel-muted);
    line-height: 1.4;
}

.treeArea .treeRoot {
    list-style: none;
    margin: 0;
    padding: 0 8px 8px 0;
    overflow: auto;
    scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
}

@media (max-width: 900px) {
    .panelRail {
        width: 100% !important;
        flex: 1 1 auto !important;
    }
}
</style>
