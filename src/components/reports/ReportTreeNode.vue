<script setup>
import { computed, ref } from "vue";

defineOptions({ name: "ReportTreeNode" });

const props = defineProps({
    node: { type: Object, required: true },
    project: { type: Object, required: true },
    projectId: { type: String, required: true },
    isExpanded: { type: Function, required: true },
    toggle: { type: Function, required: true },
    getState: { type: Function, required: true },
    onGenerate: { type: Function, required: true },
    onSelect: { type: Function, required: true },
    getStatusLabel: { type: Function, required: true },
    activeTarget: { type: Object, default: null },
    showFileActions: { type: Boolean, default: true },
    allowSelectWithoutReport: { type: Boolean, default: false }
});

const isDirectory = computed(() => props.node.type === "dir");
const isFile = computed(() => props.node.type === "file");

const fileState = computed(() => {
    if (!isFile.value) return null;
    return props.getState(props.projectId, props.node.path);
});

const statusLabel = computed(() => {
    if (!fileState.value) return "";
    return props.getStatusLabel(fileState.value.status);
});

const issueTooltip = computed(() => {
    if (!isFile.value) return "";
    const summary = fileState.value?.issueSummary;
    if (!summary || !summary.raw) return "";

    const lines = [];
    const total = summary.totalIssues;
    if (Number.isFinite(total)) {
        lines.push(`總問題：${total}`);
    }

    const raw = summary.raw || {};
    const issues = Array.isArray(raw.issues) ? raw.issues : [];
    const ruleCounts = new Map();
    const severityCounts = new Map();

    if (issues.length) {
        for (const issue of issues) {
            const severityKey = typeof issue?.severity === "string"
                ? issue.severity.trim().toUpperCase()
                : "未標示";
            const severity = severityKey || "未標示";
            severityCounts.set(severity, (severityCounts.get(severity) || 0) + 1);

            const rule =
                (typeof issue?.rule_id === "string" && issue.rule_id.trim()) ||
                (typeof issue?.ruleId === "string" && issue.ruleId.trim()) ||
                (typeof issue?.rule === "string" && issue.rule.trim()) ||
                "未分類";
            ruleCounts.set(rule, (ruleCounts.get(rule) || 0) + 1);
        }
    } else if (raw?.summary && typeof raw.summary === "object") {
        const byRule = raw.summary.by_rule || raw.summary.byRule;
        if (byRule && typeof byRule === "object") {
            for (const [rule, value] of Object.entries(byRule)) {
                const numeric = Number(value);
                if (!Number.isFinite(numeric)) continue;
                const ruleName = rule && typeof rule === "string" ? rule : "未分類";
                ruleCounts.set(ruleName, numeric);
            }
        }
    }

    if (severityCounts.size) {
        const severityParts = Array.from(severityCounts.entries()).map(
            ([key, count]) => `${key} ${count}`
        );
        if (severityParts.length) {
            lines.push(`嚴重度：${severityParts.join("，")}`);
        }
    }

    if (ruleCounts.size) {
        const ruleParts = Array.from(ruleCounts.entries()).map(
            ([rule, count]) => `${rule} (${count})`
        );
        if (ruleParts.length) {
            lines.push(`規則：${ruleParts.join("，")}`);
        }
    }

    return lines.join("\n");
});

const hasChildren = computed(
    () => Array.isArray(props.node.children) && props.node.children.length > 0
);

const isNodeExpanded = computed(() => {
    if (!isDirectory.value) return false;
    return props.isExpanded(props.projectId, props.node.path);
});

const icon = computed(() => {
    if (isDirectory.value) {
        return isNodeExpanded.value ? "📂" : "📁";
    }
    return "📄";
});

const isActive = computed(() => {
    if (!props.activeTarget || !isFile.value) return false;
    return (
        props.activeTarget.projectId === props.projectId &&
        props.activeTarget.path === props.node.path
    );
});

const statusClass = computed(() => {
    if (!fileState.value) return "";
    return `statusBadge--${fileState.value.status}`;
});

const isProcessing = computed(() => fileState.value?.status === "processing");
const isReady = computed(() => fileState.value?.status === "ready");
const isError = computed(() => fileState.value?.status === "error");
const isViewable = computed(() => isReady.value || isError.value);
const allowSelect = computed(() => {
    if (!isFile.value) return false;
    if (props.allowSelectWithoutReport) return true;
    return isViewable.value;
});
const showActions = computed(() => Boolean(props.showFileActions));
const shouldShowGenerateButton = computed(
    () => showActions.value && !isReady.value && Boolean(fileState.value)
);
const canTriggerRegenerate = computed(() => showActions.value && isReady.value);
const statusTooltip = computed(() => {
    const baseTooltip = issueTooltip.value || "";
    const regenHint = canTriggerRegenerate.value ? "點擊重新生成報告" : "";
    if (baseTooltip && regenHint) {
        return `${baseTooltip}\n${regenHint}`;
    }
    return baseTooltip || regenHint || "";
});

const isStatusBadgeHovered = ref(false);
const statusLabelDisplay = computed(() => {
    if (isStatusBadgeHovered.value && canTriggerRegenerate.value) {
        return "重新生成報告";
    }
    return statusLabel.value;
});

function handleToggle() {
    if (!isDirectory.value) return;
    props.toggle(props.projectId, props.node.path);
}

function handleRowClick() {
    if (isDirectory.value) {
        handleToggle();
        return;
    }
    if (allowSelect.value) {
        props.onSelect(props.projectId, props.node.path);
    }
}

function handleGenerate(event) {
    event?.stopPropagation?.();
    props.onGenerate(props.project, props.node);
}

</script>

<template>
    <li :class="['reportTreeNode', `reportTreeNode--${node.type}`]">
        <div
            class="reportTreeRow"
            :class="{ 'reportTreeRow--active': isActive }"
            @click="handleRowClick"
        >
            <button
                v-if="isDirectory"
                type="button"
                class="reportTreeCaret"
                @click.stop="handleToggle"
                :aria-label="isNodeExpanded ? '收合資料夾' : '展開資料夾'"
                :aria-expanded="isNodeExpanded"
            >
                <span v-if="isNodeExpanded">▾</span>
                <span v-else>▸</span>
            </button>
            <span v-else class="reportTreeCaret reportTreeCaret--placeholder"></span>
            <span class="reportTreeIcon">{{ icon }}</span>
            <span class="reportTreeLabel" :title="node.path">{{ node.name }}</span>
            <template v-if="isFile && fileState">
                <button
                    v-if="canTriggerRegenerate"
                    type="button"
                    class="statusBadge statusBadgeButton statusBadge--actionable"
                    :class="statusClass"
                    :title="statusTooltip || null"
                    @click.stop="handleGenerate"
                    @mouseenter="isStatusBadgeHovered = true"
                    @mouseleave="isStatusBadgeHovered = false"
                >
                    {{ statusLabelDisplay }}
                </button>
                <span
                    v-else
                    class="statusBadge"
                    :class="statusClass"
                    :title="statusTooltip || null"
                >
                    {{ statusLabel }}
                </span>
                <button
                    v-if="shouldShowGenerateButton"
                    type="button"
                    class="reportActionBtn"
                    :disabled="isProcessing"
                    @click="handleGenerate"
                >
                    <span v-if="isProcessing">處理中...</span>
                    <span v-else>生成報告</span>
                </button>
            </template>
        </div>
        <p
            v-if="isFile && fileState?.status === 'error' && fileState?.error"
            class="reportErrorMessage"
        >
            {{ fileState.error }}
        </p>
        <p v-if="isFile && fileState?.status === 'ready' && fileState?.updatedAtDisplay" class="reportTimestamp">
            最後更新：{{ fileState.updatedAtDisplay }}
        </p>
        <ul v-if="isDirectory && hasChildren && isNodeExpanded" class="reportFileTreeChildren">
            <ReportTreeNode
                v-for="child in node.children"
                :key="child.path"
                :node="child"
                :project="project"
                :project-id="projectId"
                :is-expanded="isExpanded"
                :toggle="toggle"
                :get-state="getState"
                :on-generate="onGenerate"
                :on-select="onSelect"
                :get-status-label="getStatusLabel"
                :active-target="activeTarget"
            />
        </ul>
    </li>
</template>

<style scoped>
.reportTreeNode {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.reportTreeRow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 8px;
    transition: background 0.2s ease, color 0.2s ease;
}

.reportTreeRow:hover {
    background: var(--tree-row-hover);
}

.reportTreeRow--active {
    background: var(--tree-row-active);
}

.reportTreeCaret {
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    color: var(--tree-icon);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 13px;
    user-select: none;
}

.reportTreeCaret--placeholder {
    cursor: default;
}

.reportTreeIcon {
    width: 20px;
    text-align: center;
    font-size: 16px;
    color: var(--tree-icon);
}

.reportTreeLabel {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13px;
    color: var(--tree-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.statusBadge {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid transparent;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--tree-badge-text);
    line-height: 1.25;
    transition: background-color 0.3s ease, color 0.3s ease, box-shadow 0.3s ease,
        border-color 0.3s ease;
}

.statusBadgeButton {
    border: none;
    background: transparent;
    transition: color 0.3s ease, background-color 0.3s ease;
}

.statusBadgeButton:focus-visible {
    outline: 2px solid var(--panel-accent);
    outline-offset: 2px;
}

.statusBadge--actionable {
    cursor: pointer;
    transition: transform 0.3s ease, box-shadow 0.3s ease, background-color 0.3s ease,
        color 0.3s ease;
}

.statusBadge--actionable:hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 6px rgba(15, 23, 42, 0.2);
}

.statusBadge--idle {
    background: var(--tree-badge-idle);
}

.statusBadge--processing {
    background: var(--tree-badge-processing);
}

.statusBadge--ready {
    background: var(--tree-badge-ready);
}

.statusBadge--actionable.statusBadge--ready:hover {
    background: #1d4ed8;
    color: #eff6ff;
    box-shadow: 0 2px 8px rgba(30, 64, 175, 0.35);
}

.statusBadge--error {
    background: var(--tree-badge-error);
}

.reportActionBtn {
    flex: 0 0 auto;
    padding: 0px 6px;
    border-radius: 6px;
    border: 1px solid var(--panel-accent);
    background: var(--panel-accent-soft);
    color: var(--panel-heading);
    font-size: 11px;
    cursor: pointer;
    transition: transform 0.2s ease, background 0.2s ease, border-color 0.2s ease;
}

.reportActionBtn:hover {
    transform: translateY(-1px);
    background: rgba(96, 165, 250, 0.24);
    border-color: var(--panel-border-strong);
}

.reportActionBtn:disabled {
    cursor: progress;
    opacity: 0.75;
    transform: none;
    background: rgba(148, 163, 184, 0.12);
    border-color: rgba(148, 163, 184, 0.35);
    color: var(--panel-muted);
}

.reportErrorMessage {
    margin: 0;
    font-size: 12px;
    color: #f87171;
    padding-left: 62px;
}

.reportTimestamp {
    margin: 0;
    font-size: 11px;
    color: var(--panel-muted);
    padding-left: 62px;
}

.reportFileTreeChildren {
    list-style: none;
    margin: 4px 0 0 22px;
    padding: 0 0 0 16px;
    border-left: 1px dashed var(--tree-connector);
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.reportFileTreeChildren:empty {
    display: none;
    margin: 0;
    padding: 0;
    border-left: none;
}
</style>
