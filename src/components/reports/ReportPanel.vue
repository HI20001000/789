<script setup>
import { computed, ref, watch } from "vue";
import ReportTreeNode from "./ReportTreeNode.vue";

const props = defineProps({
    entries: {
        type: Array,
        default: () => []
    },
    panelTitle: {
        type: String,
        default: ""
    },
    normaliseProjectId: {
        type: Function,
        required: true
    },
    isNodeExpanded: {
        type: Function,
        required: true
    },
    toggleNode: {
        type: Function,
        required: true
    },
    getReportState: {
        type: Function,
        required: true
    },
    onGenerate: {
        type: Function,
        required: true
    },
    onSelect: {
        type: Function,
        required: true
    },
    getStatusLabel: {
        type: Function,
        required: true
    },
    onReloadProject: {
        type: Function,
        required: true
    },
    onGenerateProject: {
        type: Function,
        required: true
    },
    getProjectBatchState: {
        type: Function,
        required: true
    },
    getProjectIssueCount: {
        type: Function,
        default: null
    },
    activeTarget: {
        type: Object,
        default: null
    },
    showProjectActions: {
        type: Boolean,
        default: true
    },
    showIssueBadge: {
        type: Boolean,
        default: true
    },
    showFileActions: {
        type: Boolean,
        default: true
    },
    allowSelectWithoutReport: {
        type: Boolean,
        default: false
    }
});

const hasEntries = computed(() => (props.entries || []).length > 0);

const collapsedProjects = ref({});

watch(
    () => (props.entries || []).map((entry) => props.normaliseProjectId(entry?.project?.id)).filter(Boolean),
    (ids) => {
        const next = {};
        ids.forEach((id) => {
            if (!id) return;
            const current = collapsedProjects.value[id];
            next[id] = typeof current === "boolean" ? current : true;
        });
        collapsedProjects.value = next;
    },
    { immediate: true }
);

function isProjectCollapsed(projectId) {
    const key = props.normaliseProjectId(projectId);
    if (!key) return false;
    const map = collapsedProjects.value;
    if (Object.prototype.hasOwnProperty.call(map, key)) {
        return Boolean(map[key]);
    }
    return true;
}

function setProjectCollapsed(projectId, collapsed) {
    const key = props.normaliseProjectId(projectId);
    if (!key) return;
    collapsedProjects.value = {
        ...collapsedProjects.value,
        [key]: Boolean(collapsed)
    };
}

function toggleProjectCollapsed(projectId) {
    setProjectCollapsed(projectId, !isProjectCollapsed(projectId));
}

function projectIssueCount(projectId) {
    if (typeof props.getProjectIssueCount !== "function") {
        return null;
    }
    const value = props.getProjectIssueCount(projectId);
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    return null;
}

const handleProjectGenerateClick = (event, project) => {
    event?.stopPropagation?.();
    props.onGenerateProject(project);
};

const projectBatchRunning = (projectId) => {
    const state = props.getProjectBatchState(projectId);
    return Boolean(state?.running);
};

const projectBatchProgress = (projectId) => {
    const state = props.getProjectBatchState(projectId);
    if (!state?.running) return "";
    return `${state.processed}/${state.total}`;
};
</script>

<template>
    <template v-if="hasEntries">
        <ul class="reportProjectList">
            <li
                v-for="entry in entries"
                :key="entry.project.id"
                :class="[
                    'reportProjectItem',
                    { 'reportProjectItem--collapsed': isProjectCollapsed(entry.project.id) }
                ]"
            >
                <div class="projectHeader">
                        <button
                            type="button"
                            class="projectToggle"
                            :aria-expanded="!isProjectCollapsed(entry.project.id)"
                            :title="isProjectCollapsed(entry.project.id) ? '展開專案' : '收合專案'"
                            @click.stop="toggleProjectCollapsed(entry.project.id)"
                        >
                            <span class="projectToggleIcon" :class="{ 'projectToggleIcon--collapsed': isProjectCollapsed(entry.project.id) }"></span>
                        </button>
                        <span class="projName" :title="entry.project.name">{{ entry.project.name }}</span>
                        <span
                            v-if="showIssueBadge && projectIssueCount(entry.project.id) !== null"
                            class="projectIssueBadge"
                        >
                            問題 {{ projectIssueCount(entry.project.id) }}
                        </span>
                        <div
                            v-if="showProjectActions || entry.cache.error"
                            class="projectActions"
                        >
                            <button
                                v-if="showProjectActions && !entry.cache.error"
                                type="button"
                                class="reportBatchBtn"
                                :disabled="entry.cache.loading || projectBatchRunning(entry.project.id)"
                                @click="handleProjectGenerateClick($event, entry.project)"
                            >
                                <span v-if="projectBatchRunning(entry.project.id)">
                                    批次生成中 {{ projectBatchProgress(entry.project.id) }}
                                </span>
                                <span v-else>一鍵生成</span>
                            </button>
                            <button
                                v-else-if="entry.cache.error"
                                type="button"
                                class="reportRetryBtn"
                                @click.stop="onReloadProject(entry.project.id)"
                            >
                                重新載入
                            </button>
                            <span
                                v-if="showProjectActions && !entry.cache.error && entry.cache.loading"
                                class="reportMeta"
                            >
                                載入中…
                            </span>
                        </div>
                    </div>
                    <div v-if="!isProjectCollapsed(entry.project.id)" class="reportProjectBody">
                        <p v-if="entry.cache.error" class="reportError">無法載入：{{ entry.cache.error }}</p>
                        <div v-else-if="entry.cache.loading" class="reportLoading">正在載入檔案清單…</div>
                        <p v-else-if="!entry.cache.nodes.length" class="reportEmpty">此專案尚未索引任何檔案。</p>
                        <div v-else class="reportTreeWrapper">
                            <ul class="reportFileTree">
                                <ReportTreeNode
                                    v-for="node in entry.cache.nodes"
                                    :key="node.path"
                                    :node="node"
                                    :project="entry.project"
                                    :project-id="normaliseProjectId(entry.project.id)"
                                    :is-expanded="isNodeExpanded"
                                    :toggle="toggleNode"
                                    :get-state="getReportState"
                                    :on-generate="onGenerate"
                                    :on-select="onSelect"
                                    :get-status-label="getStatusLabel"
                                    :active-target="activeTarget"
                                    :show-file-actions="showFileActions"
                                    :allow-select-without-report="allowSelectWithoutReport"
                                />
                            </ul>
                        </div>
                    </div>
            </li>
        </ul>
    </template>
    <p v-else class="reportEmpty">尚未載入任何報告專案。</p>
</template>

<style scoped>
.reportProjectList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reportProjectItem {
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    background: var(--panel-surface);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-x: auto;
    transition: border-color 0.2s ease, transform 0.2s ease;
}

.reportProjectItem:hover {
    border-color: var(--panel-border-strong);
    transform: translateY(-1px);
}

.projectHeader {
    display: flex;
    align-items: center;
    gap: 12px;
}

.projectToggle {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--panel-muted);
    cursor: pointer;
    padding: 0;
    transition: color 0.2s ease;
}

.projectToggle:hover {
    color: var(--panel-heading);
}

.projectToggleIcon {
    display: inline-block;
    width: 0;
    height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 8px solid currentColor;
    transition: transform 0.2s ease;
}

.projectToggleIcon--collapsed {
    transform: rotate(-90deg);
}

.projName {
    flex: 1 1 auto;
    min-width: 0;
    font-weight: 600;
    color: var(--tree-text);
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
}

.projectActions {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
}

.reportBatchBtn {
    flex: 0 0 auto;
    padding: 4px 10px;
    font-size: 12px;
    border-radius: 6px;
    border: 1px solid var(--panel-border);
    background: var(--panel-surface-alt);
    color: var(--panel-heading);
    cursor: pointer;
    transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}

.projectIssueBadge {
    flex: 0 0 auto;
    font-size: 12px;
    line-height: 1;
    padding: 4px 8px;
    border-radius: 9999px;
    border: 1px solid var(--panel-border-strong);
    background: rgba(148, 163, 184, 0.12);
    color: #fbbf24;
    white-space: nowrap;
}

.reportProjectItem--collapsed {
    gap: 4px;
}

.reportProjectBody {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.reportBatchBtn:hover {
    background: var(--panel-accent-soft);
    border-color: var(--panel-border-strong);
    color: var(--panel-heading);
}

.reportBatchBtn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
    background: rgba(148, 163, 184, 0.08);
    color: var(--panel-muted);
    border-color: var(--panel-border);
}

.reportMeta {
    font-size: 12px;
    color: #94a3b8;
}

.reportRetryBtn {
    margin-left: auto;
    padding: 4px 10px;
    border-radius: 0;
    border: 1px solid rgba(239, 68, 68, 0.5);
    background: rgba(239, 68, 68, 0.1);
    color: #fca5a5;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
}

.reportRetryBtn:hover {
    background: rgba(239, 68, 68, 0.2);
    border-color: rgba(248, 113, 113, 0.7);
}

.reportLoading,
.reportEmpty {
    margin: 0;
    font-size: 13px;
    color: var(--panel-muted);
}

.reportError {
    margin: 0;
    font-size: 13px;
    color: #f87171;
}

.reportTreeWrapper {
    border-top: 1px solid var(--panel-divider);
    padding-top: 8px;
}

.reportFileTree {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
</style>
