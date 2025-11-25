<script setup>
import { computed, ref } from "vue";

const emit = defineEmits(["select-issue"]);

const props = defineProps({
    previews: {
        type: Array,
        default: () => []
    },
    loading: {
        type: Boolean,
        default: false
    },
    showSummary: {
        type: Boolean,
        default: false
    },
    compact: {
        type: Boolean,
        default: false
    }
});

const hasPreviews = computed(() => (props.previews || []).length > 0);
const expandedProjects = ref(new Set());

function isProjectExpanded(projectId) {
    const key = projectId === null || projectId === undefined ? "" : String(projectId);
    return expandedProjects.value.has(key);
}

function toggleProject(projectId) {
    const key = projectId === null || projectId === undefined ? "" : String(projectId);
    if (!key) return;
    const next = new Set(expandedProjects.value);
    if (next.has(key)) {
        next.delete(key);
    } else {
        next.add(key);
    }
    expandedProjects.value = next;
}

function handleSelectIssue(entry, report, issue) {
    emit("select-issue", {
        projectId: entry?.project?.id,
        projectName: entry?.project?.name,
        path: report?.path,
        lineStart: issue?.lineStart ?? issue?.lineEnd,
        lineEnd: issue?.lineEnd ?? issue?.lineStart
    });
}
</script>

<template>
    <section class="previewPanel">
        <div class="panelHeader">報告預覽</div>
        <p v-if="loading" class="previewStatus">正在彙整報告資料…</p>
        <p v-else-if="!hasPreviews" class="previewStatus">目前沒有可預覽的報告摘要。</p>
        <ul v-else class="previewProjectList themed-scrollbar">
            <li v-for="entry in previews" :key="entry.project.id" class="previewProjectItem"
                :class="{ 'previewProjectItem--compact': compact }">
                <header class="previewProjectHeader">
                    <button type="button" class="previewProjectToggle"
                        :aria-expanded="isProjectExpanded(entry.project.id) ? 'true' : 'false'"
                        @click="toggleProject(entry.project.id)"
                        :title="isProjectExpanded(entry.project.id) ? '收起預覽' : '展開預覽'">
                        <span class="previewProjectCaret"
                            :class="{ 'previewProjectCaret--open': isProjectExpanded(entry.project.id) }">
                            <svg class="caret" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"
                                aria-hidden="true">
                                <path d="M9 6l8 6-8 6z" />
                            </svg>

                        </span>
                    </button>
                    <div class="previewProjectMeta">
                        <div class="previewProjectName" :title="entry.project.name">{{ entry.project.name }}</div>
                        <p class="previewProjectId">{{ entry.project.id }}</p>
                    </div>
                    <span class="previewProjectBadge">問題 {{ entry.issueCount }}</span>
                </header>
                <ol v-if="isProjectExpanded(entry.project.id)" class="previewReportList">
                    <li v-for="report in entry.reports" :key="`${entry.project.id}-${report.path}`"
                        class="previewReportItem">
                        <div class="previewReportPath" :title="report.path">{{ report.path }}</div>
                        <ul class="previewIssueList">
                            <li v-for="issue in report.issues" :key="issue.id" class="previewIssueItem">
                                <button type="button" class="previewIssueButton"
                                    @click="handleSelectIssue(entry, report, issue)">
                                    <div class="previewIssueTitleGroup">
                                        <span v-if="issue.severity" class="previewIssueSeverity">{{ issue.severity
                                            }}</span>
                                        <span v-if="issue.issueCount !== null && issue.issueCount !== undefined"
                                            class="previewIssueCount">
                                            問題 {{ issue.issueCount }}
                                        </span>
                                        <span class="previewIssueTitle">{{ issue.title }}</span>
                                    </div>
                                    <span v-if="issue.lineLabel" class="previewIssueLine">{{ issue.lineLabel }}</span>
                                </button>
                            </li>
                        </ul>
                        <div v-if="showSummary && report.summary.length" class="previewSummary">
                            <div class="previewSummaryHeader">摘要</div>
                            <ul class="previewSummaryList">
                                <li v-for="item in report.summary" :key="`${report.path}-${item.label}-${item.value}`">
                                    <span class="previewSummaryLabel">{{ item.label }}</span>
                                    <span class="previewSummaryValue">{{ item.value }}</span>
                                </li>
                            </ul>
                        </div>
                    </li>
                </ol>
            </li>
        </ul>
    </section>
</template>

<style scoped>
.previewPanel {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.previewStatus {
    margin: 0;
    color: var(--panel-muted);
    font-size: 13px;
}

.previewProjectList {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.previewProjectItem {
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    background: var(--panel-surface);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: 0 12px 24px rgba(15, 23, 42, 0.06);
}

.previewProjectItem--compact {
    padding: 10px;
}

.previewProjectHeader {
    display: flex;
    align-items: center;
    gap: 10px;
}

.previewProjectToggle {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    border: 1px solid var(--panel-border);
    background: var(--panel-surface-alt);
    color: var(--panel-heading);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
}

.previewProjectToggle:hover {
    background: var(--panel-accent-soft);
    border-color: var(--panel-border-strong);
    transform: translateY(-1px);
}

.previewProjectCaret {
    display: inline-block;
    transform: rotate(0deg);
    transition: transform 0.2s ease;
}

.previewProjectCaret--open {
    transform: rotate(90deg);
}

.previewProjectMeta {
    flex: 1 1 auto;
    min-width: 0;
}

.previewProjectName {
    font-weight: 700;
    color: var(--panel-heading);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.previewProjectId {
    margin: 0;
    color: var(--panel-muted);
    font-size: 12px;
}

.previewProjectBadge {
    flex: 0 0 auto;
    padding: 4px 8px;
    border-radius: 999px;
    border: 1px solid var(--panel-border-strong);
    background: rgba(148, 163, 184, 0.12);
    color: var(--panel-heading);
    font-size: 12px;
}

.previewReportList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.previewReportItem {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-top: 1px solid var(--panel-divider);
    padding-top: 8px;
}

.previewReportItem:first-of-type {
    border-top: none;
    padding-top: 0;
}

.previewReportPath {
    font-weight: 600;
    color: var(--tree-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.previewIssueList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.previewIssueItem {
    margin: 0;
}

.previewIssueButton {
    width: 100%;
    text-align: left;
    padding: 8px 10px;
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    background: var(--panel-surface-alt);
    color: var(--panel-heading);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
}

.previewIssueButton:hover {
    background: var(--panel-accent-soft);
    border-color: var(--panel-border-strong);
    transform: translateY(-1px);
}

.previewIssueTitle {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.previewIssueTitleGroup {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex: 1 1 auto;
}

.previewIssueSeverity,
.previewIssueCount {
    flex: 0 0 auto;
    font-size: 12px;
    color: var(--panel-muted);
    border: 1px solid var(--panel-border);
    border-radius: 999px;
    padding: 2px 8px;
    background: rgba(148, 163, 184, 0.12);
}

.previewIssueLine {
    flex: 0 0 auto;
    font-size: 12px;
    color: var(--panel-muted);
}

.previewSummary {
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 8px 10px;
    background: rgba(148, 163, 184, 0.04);
}

.previewSummaryHeader {
    font-weight: 600;
    color: var(--panel-heading);
    margin-bottom: 6px;
}

.previewSummaryList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.previewSummaryLabel {
    color: var(--panel-muted);
    margin-right: 6px;
}

.previewSummaryValue {
    color: var(--panel-heading);
    font-weight: 500;
}
</style>
