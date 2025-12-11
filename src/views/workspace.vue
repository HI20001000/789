<script setup>
import { ref, reactive, watch, onMounted, onBeforeUnmount, computed, nextTick } from "vue";
import { usePreview } from "../scripts/composables/usePreview.js";
import { useTreeStore } from "../scripts/composables/useTreeStore.js";
import { useProjectsStore } from "../scripts/composables/useProjectsStore.js";
import { useAiAssistant } from "../scripts/composables/useAiAssistant.js";
import * as fileSystemService from "../scripts/services/fileSystemService.js";
import {
    generateReportViaDify,
    generateDocumentReviewReport,
    fetchProjectReports
} from "../scripts/services/reportService.js";
import {
    fetchAiReviewSetting,
    fetchDocumentReviewSetting,
    fetchSettingRules,
    saveAiReviewSetting,
    saveDocumentReviewSetting,
    saveSettingRules
} from "../scripts/services/apiService.js";
import {
    buildSummaryDetailList,
    updateIssueSummaryTotals,
    buildCombinedReportPayload,
    buildCombinedReportJsonExport,
    buildIssueDistributions,
    buildSourceSummaries,
    buildAggregatedSummaryRecords,
    collectAggregatedIssues,
    collectIssueSummaryTotals
} from "../scripts/reports/combinedReport.js";
import {
    collectStaticReportIssues,
    mergeStaticReportIntoAnalysis,
    buildStaticReportDetails
} from "../scripts/reports/staticReport.js";
import {
    collectAiReviewIssues,
    mergeAiReviewReportIntoAnalysis,
    applyAiReviewResultToState,
    hydrateAiReviewStateFromRecord,
    buildAiReviewSourceSummaryConfig,
    buildAiReviewPersistencePayload,
    filterDmlIssues
} from "../scripts/reports/aiReviewReport.js";
import { exportJsonReport, normaliseJsonContent } from "../scripts/reports/exportJson.js";
import {
    isPlainObject,
    normaliseReportObject,
    normaliseAiReviewPayload,
    parseReportJson
} from "../scripts/reports/shared.js";
import { buildProjectPreviewIndex } from "../scripts/projectPreview/index.js";
import PanelRail from "../components/workspace/PanelRail.vue";
import ChatAiWindow from "../components/ChatAiWindow.vue";
import ProjectPreviewPanel from "../components/project/ProjectPreviewPanel.vue";

const workspaceLogoModules = import.meta.glob("../assets/InfoMacro_logo.jpg", {
    eager: true,
    import: "default"
});
const workspaceLogoSrc = Object.values(workspaceLogoModules)[0] ?? "";
const DOCUMENT_REVIEW_PATH = "__documents__/ai-status.json";
const DEFAULT_DOCUMENT_PROMPT =
    "你是一位軟體交付與作業稽核專家，請根據以下樹狀圖與規則引擎清單，輸出 JSON 描述缺漏、風險與改善建議。\n{{content}}";
const DEFAULT_DOCUMENT_RULES = [
    {
        key: "approval_form",
        ruleId: "DOC-001",
        description: "是否有提供《演練與投產審批表.docx》",
        riskIndicator: "高",
        enabled: true
    },
    {
        key: "test_logs",
        ruleId: "DOC-002",
        description: "是否提供測試日誌（log 文件）",
        riskIndicator: "中",
        enabled: true
    },
    {
        key: "rollback_script",
        ruleId: "DOC-003",
        description: "是否提供回退腳本（rollback 類文件）",
        riskIndicator: "高",
        enabled: true
    },
    {
        key: "deployment_guide",
        ruleId: "DOC-004",
        description: "是否提供投產指引（guide 類文件）",
        riskIndicator: "中",
        enabled: true
    },
    {
        key: "sql_utf8_nobom",
        ruleId: "DOC-005",
        description: "SQL 腳本是否為 UTF-8 無 BOM 格式",
        riskIndicator: "中",
        enabled: true
    }
];

const preview = usePreview();

const projectsStore = useProjectsStore({
    preview,
    fileSystem: fileSystemService
});

const treeStore = useTreeStore({
    getProjectRootHandleById: projectsStore.getProjectRootHandleById,
    getFileHandleByPath: fileSystemService.getFileHandleByPath,
    previewing: preview.previewing,
    isTextLike: preview.isTextLike,
    isTextPreviewable: preview.isTextPreviewable,
    readTextContent: preview.readTextContent,
    MAX_TEXT_BYTES: preview.MAX_TEXT_BYTES,
    selectedProjectId: projectsStore.selectedProjectId,
    fetchStoredFileContent: projectsStore.fetchStoredFileContent
});

projectsStore.setTreeStore(treeStore);

const aiAssistant = useAiAssistant({ treeStore, projectsStore, fileSystem: fileSystemService, preview });

const {
    showUploadModal,
    projects,
    selectedProjectId,
    supportsFS,
    loadProjectsFromDB,
    cleanupLegacyHandles,
    openProject,
    deleteProject,
    handleDrop,
    handleDragOver,
    handleFolderInput,
    pickFolderAndImport,
    updateCapabilityFlags,
    getProjectRootHandleById,
    fetchStoredFileContent,
    safeAlertFail
} = projectsStore;

const {
    tree,
    activeTreePath,
    activeTreeRevision,
    isLoadingTree,
    openNode,
    selectTreeNode,
    projectTreeUpdateEvent
} = treeStore;

const {
    open: openAssistantSession,
    close: closeAssistantSession,
    contextItems,
    messages,
    addActiveNode,
    addSnippetContext,
    removeContext,
    clearContext,
    sendUserMessage,
    isProcessing,
    isInteractionLocked: isChatLocked,
    connection,
    retryHandshake
} = aiAssistant;

const { previewing } = preview;

const previewLineItems = computed(() => {
    if (previewing.value.kind !== "text") return [];
    const text = previewing.value.text ?? "";
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length === 0) {
        return [{ number: 1, content: "\u00A0" }];
    }
    return lines.map((line, index) => ({
        number: index + 1,
        content: line === "" ? "\u00A0" : line,
        raw: line
    }));
});

const middlePaneWidth = ref(360);
const mainContentRef = ref(null);
const codeScrollRef = ref(null);
const reportViewerContentRef = ref(null);
const reportIssuesContentRef = ref(null);
const pendingReportIssueJump = ref(null);
let pendingReportIssueJumpTimer = null;
const REPORT_ISSUE_JUMP_MAX_ATTEMPTS = 40;
const REPORT_ISSUE_JUMP_INTERVAL = 180;
const codeSelection = ref(null);
let pointerDownInCode = false;
let shouldClearAfterPointerClick = false;
let lastPointerDownWasOutsideCode = false;
const showCodeLineNumbers = ref(true);
const isChatWindowOpen = ref(false);
const activeRailTool = ref("projects");
const lastNonSettingsTool = ref("projects");
const chatWindowState = reactive({ x: 0, y: 80, width: 420, height: 520 });
const chatDragState = reactive({ active: false, offsetX: 0, offsetY: 0 });
const chatResizeState = reactive({
    active: false,
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
    startLeft: 0,
    startTop: 0,
    edges: {
        left: false,
        right: false,
        top: false,
        bottom: false
    }
});
const hasInitializedChatWindow = ref(false);
const isTreeCollapsed = ref(false);
const isReportTreeCollapsed = ref(true);
const reportStates = reactive({});
const reportTreeCache = reactive({});
const reportBatchStates = reactive({});
const activeReportTarget = ref(null);
const pendingReportIssueFocus = ref(null);
const reportExportState = reactive({
    combined: false,
    static: false,
    ai: false
});
const isDmlReportExpanded = ref(false);

const handleToggleDmlSection = (event) => {
    if (event && typeof event.target?.open === "boolean") {
        isDmlReportExpanded.value = event.target.open;
    }
};
const isProjectToolActive = computed(() => activeRailTool.value === "projects");
const isReportToolActive = computed(() => activeRailTool.value === "reports");
const isPreviewToolActive = computed(() => activeRailTool.value === "preview");
const isSettingsViewActive = computed(() => activeRailTool.value === "settings");
const shouldPrepareReportTrees = computed(
    () => isProjectToolActive.value || isReportToolActive.value || isPreviewToolActive.value
);
const panelMode = computed(() => {
    if (isSettingsViewActive.value) return "projects";
    if (isReportToolActive.value) return "reports";
    if (isPreviewToolActive.value) return "preview";
    return "projects";
});
const workSpaceClass = computed(() => ({
    "workSpace--reports": isReportToolActive.value,
    "workSpace--settings": isSettingsViewActive.value
}));
const availableSettingLanguages = ["SQL", "Java"];
const settingLanguage = ref("SQL");
const ruleSettingsByLanguage = reactive({ SQL: [], Java: [] });
const aiReviewContentByLanguage = reactive({ SQL: "", Java: "" });
const aiReviewInputRef = ref(null);
const ruleSettingsState = reactive({
    loading: false,
    saving: false,
    message: "",
    loaded: { SQL: false, Java: false }
});
const aiReviewState = reactive({
    loading: false,
    saving: false,
    message: "",
    loaded: { SQL: false, Java: false }
});
const documentSettingState = reactive({
    loading: false,
    saving: false,
    message: "",
    loaded: false,
    checks: DEFAULT_DOCUMENT_RULES.map((rule, index) => ({
        ...rule,
        localId: `doc-${Date.now()}-${index}`
    })),
    promptTemplate: DEFAULT_DOCUMENT_PROMPT
});
const activeRuleSettings = computed(() => {
    const language = settingLanguage.value;
    if (!Array.isArray(ruleSettingsByLanguage[language])) {
        ruleSettingsByLanguage[language] = [];
    }
    return ruleSettingsByLanguage[language];
});
const activeAiReviewContent = computed({
    get() {
        return aiReviewContentByLanguage[settingLanguage.value] ?? "";
    },
    set(value) {
        aiReviewContentByLanguage[settingLanguage.value] = value;
    }
});
const ruleDescriptionPlaceholder = computed(() =>
    settingLanguage.value === "SQL" ? "例如：避免使用 SELECT *" : "例如：確保資料庫連線關閉"
);
const riskIndicatorPlaceholder = computed(() =>
    settingLanguage.value === "SQL" ? "高 / 中 / 低" : "Critical / Major / Minor"
);
const aiReviewPlaceholder = computed(() =>
    settingLanguage.value === "SQL"
        ? "輸入要送給 Dify 的 SQL 審查樣板"
        : "輸入 Java AI 審查時要傳送的程式碼範本"
);
const aiReviewPlaceholders = [
    { key: "project_name", label: "專案名稱", description: "專案名稱", group: "basic", required: true },
    { key: "file_path", label: "檔案路徑", description: "檔案路徑", group: "basic", required: true },
    {
        key: "chunk_index",
        label: "片段索引",
        description: "當前片段索引（從 1 開始）",
        group: "basic",
        required: true
    },
    { key: "chunk_total", label: "總片段數", description: "總片段數", group: "basic", required: true },
    {
        key: "line",
        label: "程式碼位置",
        description: "行號範圍（例如：第 44-56 行）",
        group: "basic",
        required: true
    },
    { key: "rules", label: "規則集", description: "該語言啟用的規則說明", group: "basic" },
    { key: "code", label: "程式碼片段", description: "當前程式碼區塊內容", group: "basic", required: true },
    { key: "chunk_start_line", label: "片段起始行", description: "片段起始行", group: "range" },
    { key: "chunk_end_line", label: "片段結束行", description: "片段結束行", group: "range" },
    { key: "chunk_start_column", label: "片段起始欄位", description: "片段起始欄位", group: "range" },
    { key: "chunk_end_column", label: "片段結束欄位", description: "片段結束欄位", group: "range" },
    {
        key: "code_location",
        label: "程式碼定位",
        description: "若為 Java method，可包含 method / class / signature 標籤",
        group: "range"
    },
    { key: "selection_start_line", label: "選取起始行", description: "使用者選取的起始行", group: "selection" },
    { key: "selection_end_line", label: "選取結束行", description: "使用者選取的結束行", group: "selection" },
    { key: "selection_start_column", label: "選取起始欄位", description: "選取起始欄位", group: "selection" },
    { key: "selection_end_column", label: "選取結束欄位", description: "選取結束欄位", group: "selection" },
    { key: "selection_line_count", label: "選取行數", description: "選取行數", group: "selection" },
    { key: "selection_label", label: "選取標籤", description: "前端傳入的標籤（如 選取區段）", group: "selection" },
    { key: "selection_code", label: "選取程式碼", description: "前端傳入的選取程式碼內容", group: "selection" }
];
const aiReviewPlaceholderGroups = [
    { key: "basic", label: "基本占位符（每段必傳）" },
    { key: "range", label: "片段範圍資訊（若可用則提供）" },
    { key: "selection", label: "選取範圍（前端提供時附加）" }
];
const aiReviewPlaceholderUsage = computed(() => {
    const text = typeof activeAiReviewContent.value === "string" ? activeAiReviewContent.value : "";
    const matches = text.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g);
    const tokens = new Set();
    for (const match of matches) {
        const token = match?.[1];
        if (token) {
            tokens.add(token);
        }
    }
    return tokens;
});
const aiReviewPlaceholderPanels = computed(() =>
    aiReviewPlaceholderGroups.map((group) => ({
        ...group,
        placeholders: aiReviewPlaceholders
            .filter((entry) => entry.group === group.key)
            .map((entry) => ({ ...entry, used: aiReviewPlaceholderUsage.value.has(entry.key) }))
    }))
);
const aiReviewMissingRequiredPlaceholders = computed(() =>
    aiReviewPlaceholders.filter((entry) => entry.required && !aiReviewPlaceholderUsage.value.has(entry.key))
);
const aiReviewPlaceholderStatusText = computed(() => {
    if (aiReviewMissingRequiredPlaceholders.value.length) {
        const missing = aiReviewMissingRequiredPlaceholders.value
            .map((entry) => `{{${entry.key}}}`)
            .join("、");
        return `請插入必要占位符：${missing}`;
    }
    return "所有必填占位符已插入，可自由加入可選欄位。";
});
const reportProjectEntries = computed(() => {
    const list = Array.isArray(projects.value) ? projects.value : [];
    return list.map((project) => {
        const projectKey = normaliseProjectId(project.id);
        return {
            project,
            cache: reportTreeCache[projectKey] || {
                nodes: [],
                loading: false,
                error: "",
                expandedPaths: [],
                hydratedReports: false,
                hydratingReports: false,
                reportHydrationError: ""
            }
        };
    });
});

const activePreviewTarget = computed(() => {
    const projectId = normaliseProjectId(selectedProjectId.value);
    const path = activeTreePath.value || "";
    if (!projectId || !path) return null;
    return { projectId, path };
});

const reportPanelConfig = computed(() => {
    const viewMode = isReportToolActive.value ? "reports" : "projects";
    const showProjectActions = isReportToolActive.value;
    const showIssueBadge = isReportToolActive.value;
    const showFileActions = isReportToolActive.value;
    const allowSelectWithoutReport = !isReportToolActive.value;
    const projectIssueGetter = showIssueBadge ? getProjectIssueCount : null;

    return {
        panelTitle: viewMode === "reports" ? "代碼審查" : "專案檔案",
        showProjectActions,
        showIssueBadge,
        showFileActions,
        allowSelectWithoutReport,
        entries: reportProjectEntries.value,
        normaliseProjectId,
        isNodeExpanded: isReportNodeExpanded,
        toggleNode: toggleReportNode,
        getReportState: getReportStateForFile,
        onGenerate: generateReportForFile,
        onGenerateDocument: generateDocumentReview,
        onSelect: viewMode === "reports" ? selectReport : openProjectFileFromReportTree,
        getStatusLabel,
        onReloadProject: loadReportTreeForProject,
        onGenerateProject: generateProjectReports,
        getProjectBatchState,
        getProjectIssueCount: projectIssueGetter,
        activeTarget: isReportToolActive.value
            ? activeReportTarget.value
            : activePreviewTarget.value
    };
});
const readyReports = computed(() => {
    const list = [];
    const projectList = Array.isArray(projects.value) ? projects.value : [];
    const projectMap = new Map(projectList.map((project) => [String(project.id), project]));

    Object.entries(reportStates).forEach(([key, state]) => {
        if (state.status !== "ready") return;
        const parsed = parseReportKey(key);
        const project = projectMap.get(parsed.projectId);
        if (!project || !parsed.path) return;
        list.push({
            key,
            project,
            path: parsed.path,
            state
        });
    });

    list.sort((a, b) => {
        if (a.project.name === b.project.name) return a.path.localeCompare(b.path);
        return a.project.name.localeCompare(b.project.name);
    });

    return list;
});

const projectIssueTotals = computed(() =>
    collectIssueSummaryTotals(reportStates, { parseKey: parseReportKey })
);
const projectPreviewEntries = computed(() =>
    buildProjectPreviewIndex({
        projects: projects.value,
        reportStates,
        parseKey: parseReportKey
    })
);
const isProjectPreviewLoading = computed(() => {
    const caches = Object.values(reportTreeCache);
    if (!caches.length) return false;
    return caches.some((entry) => entry.loading || entry.hydratingReports);
});
const hasReadyReports = computed(() => readyReports.value.length > 0);
const activeReport = computed(() => {
    const target = activeReportTarget.value;
    if (!target) return null;
    const key = toReportKey(target.projectId, target.path);
    if (!key) return null;
    const state = reportStates[key];
    if (
        !state ||
        (state.status !== "ready" && state.status !== "error" && state.status !== "processing")
    ) {
        return null;
    }
    const projectList = Array.isArray(projects.value) ? projects.value : [];
    const project = projectList.find((item) => String(item.id) === target.projectId);
    if (!project) return null;
    return {
        project,
        state,
        path: target.path
    };
});

const isActiveReportProcessing = computed(
    () => activeReport.value?.state?.status === "processing"
);

const viewerHasContent = computed(() => {
    const report = activeReport.value;
    if (!report) return false;
    return (
        report.state.status === "ready" ||
        report.state.status === "error" ||
        report.state.status === "processing"
    );
});

const activeReportIssueSources = computed(() => {
    const report = activeReport.value;
    if (!report || !report.state) {
        return {
            state: null,
            staticIssues: [],
            aiIssues: [],
            aggregatedIssues: []
        };
    }

    const state = report.state;
    return {
        state,
        staticIssues: collectStaticReportIssues(state),
        aiIssues: collectAiReviewIssues(state),
        aggregatedIssues: collectAggregatedIssues(state)
    };
});

const activeReportDetails = computed(() => {
    const report = activeReport.value;
    if (!report || report.state.status !== "ready") return null;
    const parsed = report.state.parsedReport;
    if (!parsed || typeof parsed !== "object") return null;

    const reports = parsed.reports && typeof parsed.reports === "object" ? parsed.reports : null;
    const dmlReport = reports?.dml_prompt || reports?.dmlPrompt || null;

    const aggregatedPayload = isPlainObject(parsed) ? parsed : null;
    const parseAggregatedReportsCandidate = (candidate) => {
        if (!candidate) {
            return null;
        }
        if (typeof candidate === "string") {
            const trimmed = candidate.trim();
            if (!trimmed) {
                return null;
            }
            try {
                const parsedCandidate = JSON.parse(trimmed);
                return parsedCandidate && typeof parsedCandidate === "object" ? parsedCandidate : null;
            } catch (error) {
                console.warn("[Report] Failed to parse aggregated report payload", error);
                return null;
            }
        }
        if (typeof candidate === "object") {
            return candidate;
        }
        return null;
    };

    const aggregatedReportsSources = [];
    const combinedReportJson = normaliseJsonContent(report.state?.combinedReportJson);
    if (combinedReportJson) {
        aggregatedReportsSources.push(combinedReportJson);
    }
    if (report.state?.analysis?.aggregatedReports) {
        aggregatedReportsSources.push(report.state.analysis.aggregatedReports);
    }
    if (aggregatedPayload?.aggregated_reports) {
        aggregatedReportsSources.push(aggregatedPayload.aggregated_reports);
    }
    if (aggregatedPayload?.aggregatedReports) {
        aggregatedReportsSources.push(aggregatedPayload.aggregatedReports);
    }

    let aggregatedReports = null;
    for (const candidate of aggregatedReportsSources) {
        const resolved = parseAggregatedReportsCandidate(candidate);
        if (resolved) {
            aggregatedReports = resolved;
            break;
        }
    }

    const { staticIssues, aiIssues, aggregatedIssues: derivedAggregatedIssues } =
        activeReportIssueSources.value;
    let aggregatedIssues = Array.isArray(aggregatedReports?.issues)
        ? aggregatedReports.issues
        : Array.isArray(aggregatedPayload?.issues)
            ? aggregatedPayload.issues
            : derivedAggregatedIssues;
    if (!Array.isArray(aggregatedIssues)) {
        aggregatedIssues = [];
    }

    let summaryRecords = Array.isArray(aggregatedReports?.summary)
        ? aggregatedReports.summary
        : null;
    if (!Array.isArray(summaryRecords) || !summaryRecords.length) {
        summaryRecords = Array.isArray(aggregatedPayload?.summary) ? aggregatedPayload.summary : null;
    }
    if (!Array.isArray(summaryRecords) || !summaryRecords.length) {
        summaryRecords = buildAggregatedSummaryRecords(
            report.state,
            staticIssues,
            aiIssues,
            aggregatedIssues
        );
    }

    const toSummaryKey = (value) => (typeof value === "string" ? value.toLowerCase() : "");
    const combinedSummaryRecord = Array.isArray(summaryRecords)
        ? summaryRecords.find((record) => toSummaryKey(record?.source) === toSummaryKey("combined"))
        : null;

    const globalSummary = parsed.summary && typeof parsed.summary === "object" ? parsed.summary : null;

    const {
        staticReport,
        summary,
        summaryObject,
        summaryText,
        staticSummary,
        staticSummaryDetails,
        staticMetadata,
        staticMetadataDetails,
        issues: normalisedIssues,
        severityBreakdown,
        ruleBreakdown,
        totalIssues: staticTotalIssues,
        sourceSummaryConfig: staticSourceSummaryConfig
    } = buildStaticReportDetails({
        state: report.state,
        parsedReport: parsed,
        aggregatedIssues,
        summaryRecords,
        combinedSummaryRecord,
        globalSummary
    });

    const total = staticTotalIssues;
    const combinedSummarySource =
        (combinedSummaryRecord && typeof combinedSummaryRecord === "object"
            ? combinedSummaryRecord
            : null) || globalSummary;

    const normaliseKey = (value) => (typeof value === "string" ? value.toLowerCase() : "");
    const pickString = (...candidates) => {
        for (const candidate of candidates) {
            if (typeof candidate === "string") {
                const trimmed = candidate.trim();
                if (trimmed) {
                    return trimmed;
                }
            }
        }
        return "";
    };
    const pickFirstValue = (...candidates) => {
        for (const candidate of candidates) {
            if (candidate !== null && candidate !== undefined && candidate !== "") {
                return candidate;
            }
        }
        return null;
    };

    const combinedSummaryDetails = buildSummaryDetailList(combinedSummarySource, {
        omitKeys: ["sources", "by_rule", "byRule", "source", "label"]
    });

    const combinedSummaryTextValue = pickString(
        combinedSummarySource?.message,
        typeof combinedSummarySource?.summary === "string" ? combinedSummarySource.summary : "",
        combinedSummarySource?.note,
        typeof combinedSummarySource === "string" ? combinedSummarySource : ""
    );

    const combinedSummaryByRule =
        (combinedSummarySource?.by_rule && typeof combinedSummarySource.by_rule === "object"
            ? combinedSummarySource.by_rule
            : null) ||
        (combinedSummarySource?.byRule && typeof combinedSummarySource.byRule === "object"
            ? combinedSummarySource.byRule
            : null);

    const combinedDistributions = buildIssueDistributions(aggregatedIssues, {
        summaryByRule: combinedSummaryByRule
    });

    let combinedTotalIssueCount = null;
    if (combinedSummarySource && typeof combinedSummarySource === "object") {
        const combinedTotalCandidate = Number(
            combinedSummarySource.total_issues ?? combinedSummarySource.totalIssues
        );
        if (Number.isFinite(combinedTotalCandidate)) {
            combinedTotalIssueCount = combinedTotalCandidate;
        }
    }
    if (!Number.isFinite(combinedTotalIssueCount)) {
        combinedTotalIssueCount = aggregatedIssues.length;
    }

    const buildSourceMetrics = (...sources) => {
        const metrics = [];
        const seen = new Set();
        const pushMetric = (label, rawValue, transform = (value) => value) => {
            if (!label || rawValue === undefined || rawValue === null) return;
            const value = transform(rawValue);
            if (value === null || value === undefined || value === "") return;
            if (seen.has(label)) return;
            seen.add(label);
            metrics.push({ label, value });
        };

        for (const source of sources) {
            if (!source || typeof source !== "object") continue;
            pushMetric(
                "問題數",
                source.total_issues ?? source.totalIssues,
                (candidate) => {
                    const numeric = Number(candidate);
                    return Number.isFinite(numeric) ? numeric : Number(candidate ?? 0) || 0;
                }
            );
            if (source.by_rule || source.byRule) {
                const byRuleEntries = Object.entries(source.by_rule || source.byRule || {});
                pushMetric("規則數", byRuleEntries.length, (count) => Number(count) || 0);
            }
            pushMetric(
                "拆分語句",
                source.total_segments ?? source.totalSegments,
                (candidate) => {
                    const numeric = Number(candidate);
                    return Number.isFinite(numeric) ? numeric : Number(candidate ?? 0) || 0;
                }
            );
            pushMetric(
                "已分析段數",
                source.analyzed_segments ?? source.analyzedSegments,
                (candidate) => {
                    const numeric = Number(candidate);
                    return Number.isFinite(numeric) ? numeric : Number(candidate ?? 0) || 0;
                }
            );
        }

        return metrics;
    };
    const mergeMetrics = (base, extra) => {
        if (!Array.isArray(base) || !base.length) return Array.isArray(extra) ? [...extra] : [];
        if (!Array.isArray(extra) || !extra.length) return [...base];
        const merged = [...base];
        const seen = new Set(base.map((item) => item.label));
        extra.forEach((item) => {
            if (!item || typeof item !== "object") return;
            if (seen.has(item.label)) return;
            seen.add(item.label);
            merged.push(item);
        });
        return merged;
    };

    const sourceSummaries = [];
    if (globalSummary?.sources && typeof globalSummary.sources === "object") {
        for (const [key, value] of Object.entries(globalSummary.sources)) {
            if (!value || typeof value !== "object") continue;
            const keyLower = normaliseKey(key);
            let label = key;
            if (keyLower === "static_analyzer" || keyLower === "staticanalyzer") {
                label = "靜態分析器";
            } else if (keyLower === "dml_prompt" || keyLower === "dmlprompt") {
                label = "AI審查";
            } else if (keyLower === "dify_workflow" || keyLower === "difyworkflow") {
                label = "聚合報告";
            }

            const metrics = buildSourceMetrics(value);
            const status = pickString(value.status);
            const errorMessage = pickString(value.error_message, value.errorMessage);
            const generatedAt = pickFirstValue(value.generated_at, value.generatedAt);

            sourceSummaries.push({
                key,
                keyLower,
                label,
                metrics,
                status,
                errorMessage,
                generatedAt
            });
        }
    }

    const enhanceSourceSummary = (keyLower, label, options = {}) => {
        const entry = sourceSummaries.find((item) => item.keyLower === keyLower);
        const metrics = buildSourceMetrics(...(options.metricsSources || []));
        const status = pickString(...(options.statusCandidates || []));
        const errorMessage = pickString(...(options.errorCandidates || []));
        const generatedAt = pickFirstValue(...(options.generatedAtCandidates || []));

        if (entry) {
            entry.label = label;
            if (metrics.length) {
                entry.metrics = mergeMetrics(entry.metrics, metrics);
            }
            if (!entry.status) {
                entry.status = status;
            }
            if (!entry.errorMessage) {
                entry.errorMessage = errorMessage;
            }
            if (!entry.generatedAt) {
                entry.generatedAt = generatedAt;
            }
        } else if (metrics.length || status || errorMessage || generatedAt) {
            sourceSummaries.push({
                key: options.key || keyLower,
                keyLower,
                label,
                metrics,
                status,
                errorMessage,
                generatedAt
            });
        }
    };

    const applySummaryRecords = (records) => {
        if (!Array.isArray(records)) return;
        records.forEach((record) => {
            if (!record || typeof record !== "object") return;
            const keyLower = normaliseKey(record.source);
            if (!keyLower) return;
            const label =
                typeof record.label === "string" && record.label.trim()
                    ? record.label.trim()
                    : record.source || keyLower;
            const existingIndex = sourceSummaries.findIndex((item) => item.keyLower === keyLower);
            if (existingIndex !== -1) {
                sourceSummaries.splice(existingIndex, 1);
            }
            enhanceSourceSummary(keyLower, label, {
                key: record.source || keyLower,
                metricsSources: [record],
                statusCandidates: [record.status],
                errorCandidates: [record.error_message, record.errorMessage, record.message],
                generatedAtCandidates: [record.generated_at, record.generatedAt]
            });
        });
    };

    applySummaryRecords(summaryRecords);

    if (staticSourceSummaryConfig) {
        enhanceSourceSummary("static_analyzer", "靜態分析器", staticSourceSummaryConfig);
    }

    const dmlSourceValue = globalSummary?.sources?.dml_prompt || globalSummary?.sources?.dmlPrompt || null;
    const aiSourceSummary = buildAiReviewSourceSummaryConfig({
        report: dmlReport,
        globalSource: dmlSourceValue,
        analysis: report.state?.analysis
    });
    const dmlSummary = aiSourceSummary.summary;
    const dmlDetails = aiSourceSummary.details;

    enhanceSourceSummary("dml_prompt", "AI審查", {
        metricsSources: aiSourceSummary.metricsSources,
        statusCandidates: aiSourceSummary.statusCandidates,
        errorCandidates: aiSourceSummary.errorCandidates,
        generatedAtCandidates: aiSourceSummary.generatedAtCandidates
    });

    const combinedSummarySourceValue =
        globalSummary?.sources?.dify_workflow || globalSummary?.sources?.difyWorkflow || null;
    enhanceSourceSummary("dify_workflow", "聚合報告", {
        metricsSources: [combinedSummarySourceValue, globalSummary],
        statusCandidates: [
            combinedSummarySourceValue?.status,
            globalSummary?.status,
            report.state?.analysis?.dify?.status
        ],
        errorCandidates: [
            combinedSummarySourceValue?.error_message,
            combinedSummarySourceValue?.errorMessage,
            globalSummary?.error_message,
            globalSummary?.errorMessage,
            report.state?.analysis?.difyErrorMessage,
            report.state?.difyErrorMessage
        ],
        generatedAtCandidates: [
            combinedSummarySourceValue?.generated_at,
            combinedSummarySourceValue?.generatedAt,
            globalSummary?.generated_at,
            globalSummary?.generatedAt
        ]
    });

    return {
        totalIssues: Number.isFinite(total) ? Number(total) : null,
        summary,
        summaryObject,
        summaryText,
        staticSummary,
        staticSummaryDetails,
        staticMetadata,
        staticMetadataDetails,
        issues: normalisedIssues,
        severityBreakdown,
        ruleBreakdown,
        raw: parsed,
        sourceSummaries,
        combinedSummary: combinedSummarySource,
        combinedSummaryDetails,
        combinedSummaryText: combinedSummaryTextValue,
        combinedSeverityBreakdown: combinedDistributions.severityBreakdown,
        combinedRuleBreakdown: combinedDistributions.ruleBreakdown,
        combinedTotalIssues: Number.isFinite(combinedTotalIssueCount)
            ? Number(combinedTotalIssueCount)
            : null,
        aggregatedIssues,
        staticReport,
        dmlReport: dmlDetails,
        aggregatedReports: aggregatedReports && typeof aggregatedReports === "object" ? aggregatedReports : null,
        aggregatedSummaryRecords: Array.isArray(aggregatedReports?.summary) ? aggregatedReports.summary : null,
        combinedSummaryByRule
    };
});


const hasStructuredReport = computed(() => Boolean(activeReportDetails.value));
const ruleBreakdownItems = computed(() => {
    const details = activeReportDetails.value;
    const combined = details?.combinedRuleBreakdown;
    if (Array.isArray(combined) && combined.length) {
        return combined;
    }
    const aggregatedByRule = details?.combinedSummaryByRule;
    if (aggregatedByRule && typeof aggregatedByRule === "object") {
        const fallbackItems = Object.entries(aggregatedByRule)
            .map(([rawLabel, rawCount]) => {
                const count = Number(rawCount);
                if (!Number.isFinite(count) || count <= 0) {
                    return null;
                }
                const labelValue =
                    typeof rawLabel === "string"
                        ? rawLabel.trim()
                        : String(rawLabel ?? "").trim();
                const label = labelValue || "未分類";
                return { label, count };
            })
            .filter((entry) => entry !== null);
        if (fallbackItems.length) {
            fallbackItems.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
            return fallbackItems;
        }
    }
    const items = details?.ruleBreakdown;
    return Array.isArray(items) ? items : [];
});
const severityBreakdownItems = computed(() => {
    const details = activeReportDetails.value;
    const combined = details?.combinedSeverityBreakdown;
    if (Array.isArray(combined) && combined.length) {
        return combined;
    }
    const items = details?.severityBreakdown;
    return Array.isArray(items) ? items : [];
});
const activeReportSummaryText = computed(() => {
    const text =
        activeReportDetails.value?.combinedSummaryText || activeReportDetails.value?.summaryText;
    return typeof text === "string" ? text : "";
});
const shouldShowNoIssueSummary = computed(() => {
    const details = activeReportDetails.value;
    if (!details || activeReportSummaryText.value) {
        return false;
    }
    if (Number.isFinite(details?.combinedTotalIssues)) {
        return Number(details.combinedTotalIssues) === 0;
    }
    return details?.totalIssues === 0;
});
const activeReportTotalIssuesDisplay = computed(() => {
    const details = activeReportDetails.value;
    if (!details) {
        return "—";
    }
    const combinedValue = details.combinedTotalIssues;
    if (Number.isFinite(combinedValue)) {
        return String(Number(combinedValue));
    }
    const value = details.totalIssues;
    if (value === null || value === undefined) {
        return "—";
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    return String(value);
});
const staticSummaryDetailsItems = computed(() => {
    const items = activeReportDetails.value?.staticSummaryDetails;
    return Array.isArray(items) ? items : [];
});
const staticMetadataDetailsItems = computed(() => {
    const items = activeReportDetails.value?.staticMetadataDetails;
    return Array.isArray(items) ? items : [];
});
const hasStaticDetailContent = computed(
    () => staticSummaryDetailsItems.value.length > 0 || staticMetadataDetailsItems.value.length > 0
);
const staticEngineName = computed(() => {
    const engine = activeReportDetails.value?.staticMetadata?.engine;
    return typeof engine === "string" ? engine : "";
});
const staticSourceName = computed(() => {
    const source = activeReportDetails.value?.staticSummary?.analysis_source;
    return typeof source === "string" ? source : "";
});
const trimLeadingWhitespace = (value) => {
    if (typeof value !== "string") return value;
    return value.replace(/^\s+/, "");
};
const dmlReportDetails = computed(() => {
    const report = activeReportDetails.value?.dmlReport;
    if (!report || typeof report !== "object") return null;

    const normalised = { ...report };

    if (typeof normalised.reportText === "string") {
        normalised.reportText = trimLeadingWhitespace(normalised.reportText);
    }

    if (Array.isArray(normalised.segments)) {
        normalised.segments = normalised.segments.map((segment) => {
            if (!isPlainObject(segment)) return segment;
            const next = { ...segment };
            if (typeof next.text === "string") {
                next.text = trimLeadingWhitespace(next.text);
            }
            if (typeof next.sql === "string") {
                next.sql = trimLeadingWhitespace(next.sql);
            }
            if (typeof next.analysis === "string") {
                next.analysis = trimLeadingWhitespace(next.analysis);
            }
            return next;
        });
    }

    if (Array.isArray(normalised.chunks)) {
        normalised.chunks = normalised.chunks.map((chunk) => {
            if (!isPlainObject(chunk)) return chunk;
            const nextChunk = { ...chunk };
            if (typeof nextChunk.report === "string") {
                nextChunk.report = trimLeadingWhitespace(nextChunk.report);
            }
            if (typeof nextChunk.summary === "string") {
                nextChunk.summary = trimLeadingWhitespace(nextChunk.summary);
            }
            return nextChunk;
        });
    }

    return normalised;
});
const dmlSegments = computed(() => {
    const segments = dmlReportDetails.value?.segments;
    return Array.isArray(segments) ? segments : [];
});
const hasDmlSegments = computed(() => dmlSegments.value.length > 0);
const dmlChunkDetails = computed(() => {
    const report = dmlReportDetails.value;
    if (!report) return [];
    const chunks = Array.isArray(report.chunks) ? report.chunks : [];
    if (!chunks.length) return [];

    const totalCandidates = chunks.map((chunk, offset) => {
        const totalCandidate = Number(chunk?.total);
        if (Number.isFinite(totalCandidate) && totalCandidate > 0) {
            return Math.floor(totalCandidate);
        }
        const indexCandidate = Number(chunk?.index);
        if (Number.isFinite(indexCandidate) && indexCandidate > 0) {
            return Math.floor(indexCandidate);
        }
        return offset + 1;
    });
    const fallbackTotal = Math.max(chunks.length, ...totalCandidates);

    const normaliseIssue = (issue) => {
        if (isPlainObject(issue)) {
            const message =
                pickFirstNonEmptyString(
                    issue.message,
                    Array.isArray(issue.messages) ? issue.messages : [],
                    issue.description,
                    issue.detail,
                    issue.summary,
                    issue.statement,
                    issue.snippet,
                    issue.text,
                    issue.report,
                    issue.reason,
                    issue.evidence
                ) || "未提供訊息";
            const severity = pickFirstNonEmptyString(
                Array.isArray(issue.severity_levels) ? issue.severity_levels : [],
                issue.severity,
                issue.level
            );
            const rule = pickFirstNonEmptyString(
                Array.isArray(issue.rule_ids) ? issue.rule_ids : [],
                Array.isArray(issue.ruleIds) ? issue.ruleIds : [],
                issue.rule_id,
                issue.ruleId,
                issue.rule
            );
            const context = pickFirstNonEmptyString(
                issue.snippet,
                issue.statement,
                issue.sql,
                issue.segment,
                issue.text,
                issue.raw
            );
            const lineMeta = ensureIssueLineMeta(issue);
            const line = lineMeta.label || null;

            return {
                message,
                severity,
                rule,
                line,
                lineStart: lineMeta.start,
                lineEnd: lineMeta.end,
                context,
                original: issue
            };
        }
        if (typeof issue === "string") {
            const trimmed = issue.trim();
            return {
                message: trimmed || "未提供訊息",
                severity: "",
                rule: "",
                line: null,
                context: "",
                original: issue
            };
        }
        try {
            return {
                message: JSON.stringify(issue),
                severity: "",
                rule: "",
                line: null,
                context: "",
                original: issue
            };
        } catch (_error) {
            return {
                message: "未提供訊息",
                severity: "",
                rule: "",
                line: null,
                context: "",
                original: issue
            };
        }
    };

    return chunks.map((chunk, offset) => {
        const indexCandidate = Number(chunk?.index);
        const index = Number.isFinite(indexCandidate) && indexCandidate > 0 ? Math.floor(indexCandidate) : offset + 1;
        const totalCandidate = Number(chunk?.total);
        const total = Number.isFinite(totalCandidate) && totalCandidate > 0
            ? Math.floor(totalCandidate)
            : Math.max(fallbackTotal, index);
        const issues = Array.isArray(chunk?.issues) ? chunk.issues : [];
        return {
            index,
            total,
            issues: issues.map(normaliseIssue)
        };
    });
});
function normaliseComparablePath(path) {
    if (!path) return "";
    return String(path)
        .replace(/\\/g, "/")
        .replace(/\/{2,}/g, "/")
        .replace(/^\.\//, "")
        .replace(/^\/+/, "")
        .trim();
}

const activeReportSourceText = computed(() => {
    const report = activeReport.value;
    if (!report) return "";

    const reportPath = normaliseComparablePath(report.path);
    const previewPath = normaliseComparablePath(previewing.value?.path);
    const previewText = previewing.value?.text;
    const previewMatchesReport = Boolean(reportPath && previewPath && previewPath === reportPath);

    if (previewMatchesReport && typeof previewText === "string" && previewText.length) {
        return previewText;
    }

    const text = report.state?.sourceText;
    if (typeof text === "string" && text.length) {
        return text;
    }

    if (previewMatchesReport && typeof previewText === "string") {
        return previewText;
    }

    return "";
});

const activeReportSourceLines = computed(() => {
    const text = activeReportSourceText.value;
    if (!text) {
        return [];
    }
    const normalised = text.replace(/\r\n?/g, "\n").split("\n");
    if (!normalised.length) {
        return [];
    }
    return normalised.map((raw, index) => ({
        number: index + 1,
        raw,
        html: escapeHtml(raw) || "&nbsp;"
    }));
});

const MAX_ISSUE_LINE_SPAN = 500;

const ISSUE_LINE_VALUE_KEYS = [
    "line",
    "line_text",
    "lineText",
    "line_number",
    "lineNumber",
    "line_no",
    "lineNo",
    "line_range",
    "lineRange",
    "line_label",
    "lineLabel",
    "range",
    "lineDisplay",
    "line_range_text",
    "lineRangeText"
];

function serialiseLineSignatureValue(value) {
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch (_error) {
        return "[unserialisable]";
    }
}

function buildIssueLineSignature(issue) {
    const parts = [];

    const collectFromSource = (source) => {
        if (!source || typeof source !== "object") return;
        for (const key of ISSUE_LINE_VALUE_KEYS) {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                parts.push(`${key}:${serialiseLineSignatureValue(source[key])}`);
            }
        }
        if (Object.prototype.hasOwnProperty.call(source, "start")) {
            parts.push(`start:${serialiseLineSignatureValue(source.start)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "end")) {
            parts.push(`end:${serialiseLineSignatureValue(source.end)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "begin")) {
            parts.push(`begin:${serialiseLineSignatureValue(source.begin)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "finish")) {
            parts.push(`finish:${serialiseLineSignatureValue(source.finish)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "from")) {
            parts.push(`from:${serialiseLineSignatureValue(source.from)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "to")) {
            parts.push(`to:${serialiseLineSignatureValue(source.to)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "start_line")) {
            parts.push(`start_line:${serialiseLineSignatureValue(source.start_line)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "end_line")) {
            parts.push(`end_line:${serialiseLineSignatureValue(source.end_line)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "startLine")) {
            parts.push(`startLine:${serialiseLineSignatureValue(source.startLine)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "endLine")) {
            parts.push(`endLine:${serialiseLineSignatureValue(source.endLine)}`);
        }
        if (source.metadata && typeof source.metadata === "object") {
            collectFromSource(source.metadata);
        }
        if (source.meta && typeof source.meta === "object") {
            collectFromSource(source.meta);
        }
    };

    collectFromSource(issue);

    if (Array.isArray(issue?.details)) {
        issue.details.forEach((detail) => collectFromSource(detail));
    }

    return parts.join("|");
}

function normaliseLineEndpoint(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return null;
    }
    return Math.floor(numeric);
}

function parseLineRangeValue(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "number") {
        const endpoint = normaliseLineEndpoint(value);
        return endpoint ? { start: endpoint, end: endpoint } : null;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        const rangeMatch = trimmed.match(/^(\d+)\s*[-~–]\s*(\d+)$/);
        if (rangeMatch) {
            const start = normaliseLineEndpoint(rangeMatch[1]);
            const end = normaliseLineEndpoint(rangeMatch[2]);
            if (start && end) {
                return { start: Math.min(start, end), end: Math.max(start, end) };
            }
        }
        const numeric = normaliseLineEndpoint(trimmed);
        return numeric ? { start: numeric, end: numeric } : null;
    }
    if (Array.isArray(value)) {
        const endpoints = value
            .map((entry) => normaliseLineEndpoint(entry))
            .filter((entry) => entry !== null);
        if (!endpoints.length) {
            return null;
        }
        return { start: Math.min(...endpoints), end: Math.max(...endpoints) };
    }
    if (value && typeof value === "object") {
        if (value.line !== undefined) {
            const parsed = parseLineRangeValue(value.line);
            if (parsed) {
                return parsed;
            }
        }
        const start = normaliseLineEndpoint(value.start ?? value.begin ?? value.from);
        const end = normaliseLineEndpoint(value.end ?? value.finish ?? value.to);
        if (start !== null || end !== null) {
            const safeStart = start ?? end;
            const safeEnd = end ?? start ?? safeStart;
            return safeStart ? { start: safeStart, end: safeEnd } : null;
        }
        if (typeof value.label === "string") {
            return parseLineRangeValue(value.label);
        }
    }
    return null;
}

function extractLineRangeFromIssue(issue) {
    if (!issue || typeof issue !== "object") {
        return null;
    }

    const extractRangeFromMeta = (meta) => {
        if (meta && typeof meta === "object") {
            const parsed = parseLineRangeValue(meta.line ?? meta.lineRange ?? meta.range);
            if (parsed) {
                return parsed;
            }
            const start = normaliseLineEndpoint(meta.start_line ?? meta.startLine);
            const end = normaliseLineEndpoint(meta.end_line ?? meta.endLine);
            if (start !== null || end !== null) {
                const safeStart = start ?? end;
                const safeEnd = end ?? start ?? safeStart;
                if (safeStart) {
                    return { start: safeStart, end: safeEnd };
                }
            }
        }
        return null;
    };

    const tryParseFromObject = (source) => {
        if (!source || typeof source !== "object") return null;
        for (const key of ISSUE_LINE_VALUE_KEYS) {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                const parsed = parseLineRangeValue(source[key]);
                if (parsed) {
                    return parsed;
                }
            }
        }
        const metaCandidates = [source.metadata, source.meta];
        for (const meta of metaCandidates) {
            const parsed = extractRangeFromMeta(meta);
            if (parsed) {
                return parsed;
            }
        }
        const start = normaliseLineEndpoint(source.start_line ?? source.startLine);
        const end = normaliseLineEndpoint(source.end_line ?? source.endLine);
        if (start !== null || end !== null) {
            const safeStart = start ?? end;
            const safeEnd = end ?? start ?? safeStart;
            if (safeStart) {
                return { start: safeStart, end: safeEnd };
            }
        }
        return null;
    };

    const parsedFromIssue = tryParseFromObject(issue);
    if (parsedFromIssue) {
        return parsedFromIssue;
    }

    if (Array.isArray(issue.details)) {
        for (const detail of issue.details) {
            const parsed = tryParseFromObject(detail);
            if (parsed) {
                return parsed;
            }
        }
    }
    return null;
}

function formatLineRangeLabel(range) {
    if (!range) {
        return "";
    }
    if (range.start === range.end) {
        return String(range.start);
    }
    return `${range.start}-${range.end}`;
}

function normaliseIssueLineMeta(meta) {
    if (!meta || typeof meta !== "object") {
        return { start: null, end: null, label: "" };
    }

    const parsedFromRange =
        parseLineRangeValue(meta.line ?? meta.lineRange ?? meta.range ?? meta.label) || null;

    let start =
        normaliseLineEndpoint(meta.start ?? meta.begin ?? meta.from) ?? parsedFromRange?.start ?? null;
    let end = normaliseLineEndpoint(meta.end ?? meta.finish ?? meta.to) ?? parsedFromRange?.end ?? null;

    if (Number.isFinite(start) && Number.isFinite(end) && start > end) {
        [start, end] = [end, start];
    }

    const hasStart = start !== null;
    const hasEnd = end !== null;
    const safeStart = hasStart ? start : hasEnd ? end : null;
    const safeEnd = hasEnd ? end : hasStart ? start : null;
    const label =
        (typeof meta.label === "string" && meta.label.trim()) ||
        formatLineRangeLabel(safeStart ? { start: safeStart, end: safeEnd ?? safeStart } : null);

    const signature = typeof meta.signature === "string" ? meta.signature : undefined;

    return {
        start: safeStart,
        end: safeEnd,
        label: typeof label === "string" ? label : "",
        signature
    };
}

function ensureIssueLineMeta(issue) {
    if (!issue || typeof issue !== "object") {
        return { start: null, end: null, label: "" };
    }

    const signature = buildIssueLineSignature(issue);

    if (issue.__lineMeta && typeof issue.__lineMeta === "object") {
        const cached = normaliseIssueLineMeta(issue.__lineMeta);
        const hasLabel = typeof cached.label === "string" && cached.label.trim();
        const hasRange =
            Number.isFinite(cached.start) &&
            cached.start > 0 &&
            Number.isFinite(cached.end) &&
            cached.end > 0;
        if ((hasLabel || hasRange) && cached.signature === signature) {
            issue.__lineMeta = cached;
            return cached;
        }
    }

    const range = extractLineRangeFromIssue(issue);
    const meta = normaliseIssueLineMeta({
        start: range?.start ?? null,
        end: range?.end ?? null,
        label: formatLineRangeLabel(range)
    });

    meta.signature = signature;

    issue.__lineMeta = meta;
    return meta;
}

function describeIssueLineRange(issue) {
    const meta = ensureIssueLineMeta(issue);
    return meta.label;
}

const reportIssueLines = computed(() => {
    const details = activeReportDetails.value;
    const sourceLines = activeReportSourceLines.value;
    const normalised = Array.isArray(details?.issues) ? details.issues : [];
    const aggregated = Array.isArray(details?.aggregatedIssues) ? details.aggregatedIssues : [];
    // Prefer aggregated issues when present so we retain full line ranges (e.g. "2-5")
    // instead of any normalised summaries that may have lost span information.
    const issues = aggregated.length ? aggregated : normalised.length ? normalised : [];

    const sourceLineCount = sourceLines.length;
    let maxLine = sourceLineCount;
    const issuesByLine = new Map();
    const issuesEndingByLine = new Map();
    const orphanIssues = [];

    for (const issue of issues) {
        const lineMeta = ensureIssueLineMeta(issue);
        const hasStart = Number.isFinite(lineMeta.start) && lineMeta.start > 0;
        if (!hasStart) {
            orphanIssues.push(issue);
            continue;
        }
        const startLine = Math.max(1, Math.floor(lineMeta.start));
        if (!sourceLineCount || startLine > sourceLineCount) {
            orphanIssues.push(issue);
            continue;
        }
        const hasEnd = Number.isFinite(lineMeta.end) && lineMeta.end > 0;
        const endCandidate = hasEnd ? Math.floor(lineMeta.end) : startLine;
        const effectiveEnd = Math.max(startLine, endCandidate);
        const cappedEnd = Math.min(
            effectiveEnd,
            startLine + MAX_ISSUE_LINE_SPAN - 1,
            sourceLineCount
        );
        for (let lineNumber = startLine; lineNumber <= cappedEnd; lineNumber += 1) {
            const bucket = issuesByLine.get(lineNumber) || [];
            bucket.push(issue);
            issuesByLine.set(lineNumber, bucket);
        }
        const endBucket = issuesEndingByLine.get(cappedEnd) || [];
        endBucket.push(issue);
        issuesEndingByLine.set(cappedEnd, endBucket);
        if (effectiveEnd > sourceLineCount && !orphanIssues.includes(issue)) {
            orphanIssues.push(issue);
        }
        if (cappedEnd > maxLine) {
            maxLine = cappedEnd;
        }
    }

    const result = [];

    const ensureLineEntry = (lineNumber) => {
        const index = lineNumber - 1;
        if (index < sourceLines.length) {
            return sourceLines[index];
        }
        return { number: lineNumber, raw: "", html: "&nbsp;" };
    };

    for (let lineNumber = 1; lineNumber <= Math.max(1, maxLine); lineNumber += 1) {
        const baseLine = ensureLineEntry(lineNumber);
        const lineIssues = issuesByLine.get(lineNumber) || [];
        const endingIssues = issuesEndingByLine.get(lineNumber) || [];
        const hasIssue = lineIssues.length > 0;

        result.push({
            key: `code-${lineNumber}`,
            type: "code",
            number: lineNumber,
            displayNumber: String(lineNumber),
            html: baseLine.html,
            hasIssue,
            issues: lineIssues
        });

        if (endingIssues.length) {
            const lineRanges = endingIssues
                .map((issue) => ensureIssueLineMeta(issue)?.label || "")
                .filter(Boolean);
            result.push(buildIssueMetaLine("issues", lineNumber, endingIssues));
            result.push(buildIssueMetaLine("fix", lineNumber, endingIssues));
        }
    }

    if (orphanIssues.length) {
        result.push(buildIssueMetaLine("issues", "orphan", orphanIssues, true));
        result.push(buildIssueMetaLine("fix", "orphan", orphanIssues, true));
    }

    return result;
});

const hasReportIssueLines = computed(() => reportIssueLines.value.length > 0);

const structuredReportViewMode = ref("combined");
const shouldShowDmlChunkDetails = computed(() => {
    if (!dmlChunkDetails.value.length) {
        return false;
    }
    if (!hasStructuredReport.value) {
        return true;
    }
    return structuredReportViewMode.value === "dml";
});

const canShowStructuredSummary = computed(() => Boolean(activeReportDetails.value));

const canShowStructuredStatic = computed(() => {
    const reportState = activeReport.value?.state;
    if (reportState && normaliseJsonContent(reportState.staticReportJson)) {
        return true;
    }

    const details = activeReportDetails.value;
    if (!details) return false;

    if (details.staticReport && typeof details.staticReport === "object") {
        if (Object.keys(details.staticReport).length > 0) {
            return true;
        }
    }

    if (Array.isArray(details.staticSummaryDetails) && details.staticSummaryDetails.length) {
        return true;
    }

    if (Array.isArray(details.staticMetadataDetails) && details.staticMetadataDetails.length) {
        return true;
    }

    if (details.staticSummary) {
        if (typeof details.staticSummary === "string") {
            if (details.staticSummary.trim().length) return true;
        } else if (typeof details.staticSummary === "object") {
            if (Object.keys(details.staticSummary).length) return true;
        }
    }

    if (details.staticMetadata && typeof details.staticMetadata === "object") {
        if (Object.keys(details.staticMetadata).length) {
            return true;
        }
    }

    return false;
});

const canShowStructuredDml = computed(() => {
    const reportState = activeReport.value?.state;
    if (reportState && normaliseJsonContent(reportState.aiReportJson)) {
        return true;
    }

    const report = activeReportDetails.value?.dmlReport;
    if (!report) return false;

    if (Array.isArray(report.segments) && report.segments.length) {
        return true;
    }

    if (Array.isArray(report.issues) && report.issues.length) {
        return true;
    }

    if (typeof report.aggregatedText === "string" && report.aggregatedText.trim().length) {
        return true;
    }

    if (report.aggregated && typeof report.aggregated === "object") {
        if (Object.keys(report.aggregated).length) {
            return true;
        }
    }

    if (typeof report.reportText === "string" && report.reportText.trim().length) {
        return true;
    }

    if (typeof report.error === "string" && report.error.trim().length) {
        return true;
    }

    if (typeof report.status === "string" && report.status.trim().length) {
        return true;
    }

    if (report.generatedAt) {
        return true;
    }

    return false;
});

const canExportCombinedReport = computed(() => canShowStructuredSummary.value);
const canExportStaticReport = computed(() => canShowStructuredStatic.value);
const canExportAiReport = computed(() => canShowStructuredDml.value);

const STRUCTURED_EXPORT_CONFIG = {
    combined: {
        type: "combined",
        heading: "聚合報告 JSON",
        exportLabel: "匯出聚合報告 JSON"
    },
    static: {
        type: "static",
        heading: "靜態分析 JSON",
        exportLabel: "匯出靜態分析 JSON"
    },
    dml: {
        type: "ai",
        heading: "AI 審查 JSON",
        exportLabel: "匯出 AI 審查 JSON"
    }
};

function extractAiIssuesForJsonExport(state) {
    if (!state || typeof state !== "object") {
        return [];
    }
    const reports = state.parsedReport?.reports;
    const candidates = [
        state.analysis?.dmlIssues,
        state.analysis?.dmlReport?.issues,
        state.dml?.issues,
        state.dml?.aggregated?.issues,
        reports?.dml_prompt?.issues,
        reports?.dmlPrompt?.issues
    ];
    let selected = null;
    for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length) {
            selected = candidate;
            break;
        }
        if (!selected && Array.isArray(candidate)) {
            selected = candidate;
        }
    }
    return filterDmlIssues(Array.isArray(selected) ? selected : []);
}

function buildJsonInfo(candidate) {
    const raw = normaliseJsonContent(candidate);
    if (!raw) {
        return { raw: "", preview: "" };
    }
    let preview = raw;
    try {
        preview = JSON.stringify(JSON.parse(raw), null, 2);
    } catch (error) {
        preview = raw;
    }
    return { raw, preview };
}

const combinedReportJsonInfo = computed(() => {
    const report = activeReport.value;
    if (!report || !report.state) {
        return { raw: "", preview: "" };
    }

    const combinedPayload = buildCombinedReportJsonExport(report.state);
    return buildJsonInfo(combinedPayload);
});

function filterStaticIssuesForJsonExport(issues) {
    if (!Array.isArray(issues)) {
        return [];
    }
    return issues.filter((issue) => issue !== null && issue !== undefined);
}

function extractStaticIssuesForJsonExport(state) {
    if (!state || typeof state !== "object") {
        return [];
    }
    const reports = state.parsedReport?.reports;
    const staticEntry = reports?.static_analyzer || reports?.staticAnalyzer || null;
    if (staticEntry && Array.isArray(staticEntry.issues)) {
        return filterStaticIssuesForJsonExport(staticEntry.issues);
    }
    const analysisIssues = state.analysis?.staticReport?.issues;
    if (Array.isArray(analysisIssues)) {
        return filterStaticIssuesForJsonExport(analysisIssues);
    }
    return filterStaticIssuesForJsonExport(collectStaticReportIssues(state));
}

const staticReportJsonInfo = computed(() => {
    const report = activeReport.value;
    if (!report || !report.state) {
        return { raw: "", preview: "" };
    }
    const stored = normaliseJsonContent(report.state.staticReportJson);
    if (stored) {
        return buildJsonInfo(stored);
    }
    const issues = extractStaticIssuesForJsonExport(report.state);
    return buildJsonInfo({ issues });
});

const aiReportJsonInfo = computed(() => {
    const report = activeReport.value;
    if (!report || !report.state) {
        return { raw: "", preview: "" };
    }
    const stored = normaliseJsonContent(report.state.aiReportJson);
    if (stored) {
        return buildJsonInfo(stored);
    }
    const issues = extractAiIssuesForJsonExport(report.state);
    return buildJsonInfo({ issues });
});

const structuredReportExportConfig = computed(() => {
    const mode = structuredReportViewMode.value;
    const base = STRUCTURED_EXPORT_CONFIG[mode] || STRUCTURED_EXPORT_CONFIG.combined;
    let info = combinedReportJsonInfo.value;
    let canExport = canExportCombinedReport.value;
    let busy = reportExportState.combined;

    if (mode === "static") {
        info = staticReportJsonInfo.value;
        canExport = canExportStaticReport.value;
        busy = reportExportState.static;
    } else if (mode === "dml") {
        info = aiReportJsonInfo.value;
        canExport = canExportAiReport.value;
        busy = reportExportState.ai;
    }

    return {
        ...base,
        info,
        canExport: canExport && Boolean(info.raw),
        busy
    };
});

const structuredReportJsonHeading = computed(
    () => structuredReportExportConfig.value.heading || "報告 JSON"
);
const structuredReportExportLabel = computed(
    () => structuredReportExportConfig.value.exportLabel || "匯出 JSON"
);
const structuredReportJsonPreview = computed(() => {
    const preview = structuredReportExportConfig.value.info.preview;
    return typeof preview === "string" ? trimLeadingWhitespace(preview) : preview;
});
const shouldShowStructuredExportButton = computed(
    () => structuredReportExportConfig.value.canExport
);

const hasStructuredReportToggle = computed(
    () => canShowStructuredSummary.value || canShowStructuredStatic.value || canShowStructuredDml.value
);

const canShowCodeIssues = computed(() => {
    const report = activeReport.value;
    if (!report) return false;
    if (report.state?.sourceLoading || report.state?.sourceError) {
        return true;
    }
    return hasReportIssueLines.value;
});

const activeReportAiErrorMessage = computed(() => {
    const report = activeReport.value;
    if (!report) return "";

    const direct = typeof report.state?.difyErrorMessage === "string" ? report.state.difyErrorMessage : "";
    if (direct && direct.trim()) {
        return direct.trim();
    }

    const nested = typeof report.state?.analysis?.difyErrorMessage === "string"
        ? report.state.analysis.difyErrorMessage
        : "";
    if (nested && nested.trim()) {
        return nested.trim();
    }

    return "";
});

const shouldShowAiUnavailableNotice = computed(() => {
    const details = activeReportDetails.value;
    if (!details) return false;

    const hasStaticContent =
        canShowStructuredStatic.value ||
        (Array.isArray(details.issues) && details.issues.length > 0) ||
        Boolean(details.staticSummary) ||
        Boolean(details.staticMetadata);
    if (!hasStaticContent) {
        return false;
    }

    const aiReport = details.dmlReport;
    const hasAiContent = Boolean(
        aiReport &&
        ((Array.isArray(aiReport.issues) && aiReport.issues.length) ||
            (Array.isArray(aiReport.segments) && aiReport.segments.length) ||
            (typeof aiReport.aggregatedText === "string" && aiReport.aggregatedText.trim()) ||
            (typeof aiReport.reportText === "string" && aiReport.reportText.trim()) ||
            (aiReport.aggregated && Object.keys(aiReport.aggregated).length))
    );

    return !hasAiContent;
});

const reportAiUnavailableNotice = computed(() => {
    if (!shouldShowAiUnavailableNotice.value) return "";
    const detail = activeReportAiErrorMessage.value;
    if (detail) {
        return `無法取得 AI審查報告：${detail}。目前僅顯示靜態分析器報告。`;
    }
    return "無法取得 AI審查報告，僅顯示靜態分析器報告。";
});

const shouldShowReportIssuesSection = computed(
    () => Boolean(activeReportDetails.value) || canShowCodeIssues.value
);

const activeReportIssueCount = computed(() => {
    const details = activeReportDetails.value;
    if (!details) return null;
    if (Number.isFinite(details.combinedTotalIssues)) {
        return Number(details.combinedTotalIssues);
    }
    if (Number.isFinite(details.totalIssues)) return Number(details.totalIssues);
    const list = Array.isArray(details.issues) ? details.issues : [];
    if (Array.isArray(details.aggregatedIssues) && details.aggregatedIssues.length) {
        return details.aggregatedIssues.length;
    }
    return list.length;
});

function setStructuredReportViewMode(mode) {
    if (!mode) return;
    if (mode !== "combined" && mode !== "static" && mode !== "dml") return;
    if (mode === structuredReportViewMode.value) return;
    if (mode === "combined" && !canShowStructuredSummary.value) return;
    if (mode === "static" && !canShowStructuredStatic.value) return;
    if (mode === "dml" && !canShowStructuredDml.value) return;
    structuredReportViewMode.value = mode;
}

function ensureStructuredReportViewMode(preferred) {
    const order = [];
    if (preferred) {
        order.push(preferred);
    }
    order.push("combined", "static", "dml");

    for (const mode of order) {
        if (mode === "combined" && canShowStructuredSummary.value) {
            if (structuredReportViewMode.value !== "combined") {
                structuredReportViewMode.value = "combined";
            }
            return;
        }
        if (mode === "static" && canShowStructuredStatic.value) {
            if (structuredReportViewMode.value !== "static") {
                structuredReportViewMode.value = "static";
            }
            return;
        }
        if (mode === "dml" && canShowStructuredDml.value) {
            if (structuredReportViewMode.value !== "dml") {
                structuredReportViewMode.value = "dml";
            }
            return;
        }
    }

    if (structuredReportViewMode.value !== "combined") {
        structuredReportViewMode.value = "combined";
    }
}

watch(
    [canShowStructuredSummary, canShowStructuredStatic, canShowStructuredDml],
    () => {
        ensureStructuredReportViewMode(structuredReportViewMode.value);
    },
    { immediate: true }
);

function normaliseErrorMessage(error) {
    if (!error) return "未知錯誤";
    if (typeof error === "string") {
        return error;
    }
    if (error instanceof Error) {
        return error.message || "未知錯誤";
    }
    if (typeof error.message === "string" && error.message.trim()) {
        return error.message.trim();
    }
    return String(error);
}

function buildReportExportMetadata(type, overrides = {}) {
    const report = activeReport.value;
    const projectName = report?.project?.name ?? "";
    const filePath = report?.path ?? "";
    const updatedAt = report?.state?.updatedAt ?? null;
    const updatedAtDisplay = report?.state?.updatedAtDisplay ?? "";

    return {
        projectName,
        filePath,
        updatedAt,
        updatedAtDisplay,
        type,
        ...overrides
    };
}

async function exportCombinedReportJson() {
    if (!canExportCombinedReport.value || reportExportState.combined) {
        return;
    }
    if (!activeReportDetails.value) {
        return;
    }

    const info = combinedReportJsonInfo.value;
    if (!info.raw) {
        if (typeof safeAlertFail === "function") {
            safeAlertFail("尚無可匯出的聚合報告 JSON 內容");
        }
        return;
    }

    reportExportState.combined = true;
    try {
        const aggregatedSource = activeReportDetails.value.combinedSummary || {};
        const metadata = buildReportExportMetadata("combined", {
            generatedAt:
                aggregatedSource?.generated_at ||
                aggregatedSource?.generatedAt ||
                activeReport.value?.state?.updatedAt ||
                null,
            typeLabel: "聚合報告",
            extension: "json"
        });
        await exportJsonReport({
            json: info.raw,
            metadata
        });
    } catch (error) {
        console.error("Failed to export combined report JSON", error);
        if (typeof safeAlertFail === "function") {
            safeAlertFail(`匯出聚合報告 JSON 失敗：${normaliseErrorMessage(error)}`);
        }
    } finally {
        reportExportState.combined = false;
    }
}

async function exportStaticReportJson() {
    if (!canExportStaticReport.value || reportExportState.static) {
        return;
    }
    if (!activeReportDetails.value) {
        return;
    }

    const info = staticReportJsonInfo.value;
    if (!info.raw) {
        if (typeof safeAlertFail === "function") {
            safeAlertFail("尚無可匯出的靜態分析 JSON 內容");
        }
        return;
    }

    reportExportState.static = true;
    try {
        const metadata = buildReportExportMetadata("static", {
            typeLabel: "靜態分析報告",
            extension: "json"
        });
        await exportJsonReport({
            json: info.raw,
            metadata
        });
    } catch (error) {
        console.error("Failed to export static report JSON", error);
        if (typeof safeAlertFail === "function") {
            safeAlertFail(`匯出靜態分析 JSON 失敗：${normaliseErrorMessage(error)}`);
        }
    } finally {
        reportExportState.static = false;
    }
}

async function exportAiReportJson() {
    if (!canExportAiReport.value || reportExportState.ai) {
        return;
    }
    const dmlDetails = dmlReportDetails.value;
    if (!dmlDetails) {
        return;
    }

    const info = aiReportJsonInfo.value;
    if (!info.raw) {
        if (typeof safeAlertFail === "function") {
            safeAlertFail("尚無可匯出的 AI 審查 JSON 內容");
        }
        return;
    }

    reportExportState.ai = true;
    try {
        const metadata = buildReportExportMetadata("ai", {
            generatedAt: dmlDetails.generatedAt ?? null,
            typeLabel: "AI 審查報告",
            extension: "json"
        });
        await exportJsonReport({
            json: info.raw,
            metadata
        });
    } catch (error) {
        console.error("Failed to export AI review report JSON", error);
        if (typeof safeAlertFail === "function") {
            safeAlertFail(`匯出 AI 審查 JSON 失敗：${normaliseErrorMessage(error)}`);
        }
    } finally {
        reportExportState.ai = false;
    }
}

async function exportCurrentStructuredReportJson() {
    const config = structuredReportExportConfig.value;
    if (!config.canExport || config.busy) {
        return;
    }
    if (config.type === "static") {
        await exportStaticReportJson();
        return;
    }
    if (config.type === "ai") {
        await exportAiReportJson();
        return;
    }
    await exportCombinedReportJson();
}

watch(activeReport, (report) => {
    if (!report) {
        structuredReportViewMode.value = "combined";
        return;
    }
    ensureStructuredReportViewMode("combined");
});

watch(
    [activeReport, activeReportDetails],
    ([report, details]) => {
        if (report && details) {
            logReportDebugInfo(report, details);
        }
    },
    { flush: "post" }
);

const middlePaneStyle = computed(() => {
    const hasActiveTool = isProjectToolActive.value || isReportToolActive.value;
    const width = hasActiveTool ? middlePaneWidth.value : 0;
    const widthValue = `${width}px`;
    return {
        flex: hasActiveTool ? `0 0 ${widthValue}` : "0 0 0px",
        width: widthValue,
        maxWidth: "100%"
    };
});

const chatWindowStyle = computed(() => ({
    width: `${chatWindowState.width}px`,
    height: `${chatWindowState.height}px`,
    left: `${chatWindowState.x}px`,
    top: `${chatWindowState.y}px`
}));

const isChatToggleDisabled = computed(() => isChatLocked.value && isChatWindowOpen.value);

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function resolveSeverityInfo(detail, issue) {
    const candidates = [];
    const push = (value) => {
        if (typeof value !== "string") return;
        const trimmed = value.trim();
        if (!trimmed) return;
        candidates.push(trimmed);
    };

    const pushList = (list) => {
        if (!Array.isArray(list)) return;
        list.forEach((entry) => push(entry));
    };

    if (detail && typeof detail === "object") {
        push(detail.severityLabel);
        push(detail.severity_label);
        push(detail.severity);
        pushList(detail.severityLevels);
        pushList(detail.severity_levels);
    }

    if (issue && typeof issue === "object") {
        push(issue.severityLabel);
        push(issue.severity_label);
        push(issue.severity);
        pushList(issue.severityLevels);
        pushList(issue.severity_levels);
    }

    const label = candidates[0] || "未標示";
    const normalizedCandidates = candidates
        .map((entry) => (typeof entry === "string" ? entry.toLowerCase() : ""))
        .filter(Boolean);

    const mapSeverityClass = (value) => {
        if (!value) return null;
        if (value.includes("crit") || value.includes("fatal") || value.includes("err") || value === "high") {
            return "high";
        }
        if (value.includes("warn") || value.includes("mid") || value.includes("med")) {
            return "mid";
        }
        if (value.includes("info") || value.includes("low")) {
            return "low";
        }
        return null;
    };

    const normalizedLabel = typeof label === "string" ? label.toLowerCase() : "";
    let severityClass = mapSeverityClass(normalizedCandidates.find((value) => mapSeverityClass(value)))
        || mapSeverityClass(normalizedLabel)
        || detail?.severityClass
        || issue?.severityClass
        || "info";

    if (!label || normalizedLabel === "未標示") {
        severityClass = "muted";
    }

    return { label, severityClass };
}


function buildIssueMetaLine(type, keySource, issues, isOrphan = false) {
    const label = type === "fix" ? "Fix" : "Issues";
    const keySuffix = typeof keySource === "number" ? keySource : String(keySource || type);
    const html = type === "fix"
        ? buildIssueFixHtml(issues)
        : buildIssueDetailsHtml(issues, isOrphan);
    return {
        key: `${type}-${keySuffix}`,
        type,
        number: typeof keySource === "number" ? keySource : null,
        displayNumber: "",
        iconLabel: label,
        html: html || "&nbsp;",
        hasIssue: true,
        issues,
        isMeta: true,
        isOrphan: Boolean(isOrphan)
    };
}

function buildIssueLineDebugInfo(issues) {
    if (!Array.isArray(issues) || !issues.length) {
        return [];
    }

    return issues.map((issue, index) => {
        const meta = ensureIssueLineMeta(issue);
        return {
            index,
            rule: issue?.rule_id ?? issue?.ruleId ?? issue?.rule ?? "",
            title: issue?.title ?? issue?.message ?? "",
            line: meta.label,
            start: meta.start,
            end: meta.end
        };
    });
}

function logReportDebugInfo(report, details) {
    if (!report || !report.state || report.state.status !== "ready") {
        return;
    }

    const { state, path, project } = report;
    const projectId = project?.id ?? null;
    const projectName = project?.name ?? "";
    const combinedReportJson = normaliseJsonContent(state.combinedReportJson);

    const { staticIssues, aiIssues, aggregatedIssues } = activeReportIssueSources.value;
    const issueDebugEntries = buildIssueLineDebugInfo([
        ...(Array.isArray(staticIssues) ? staticIssues : []),
        ...(Array.isArray(aiIssues) ? aiIssues : []),
        ...(Array.isArray(aggregatedIssues) ? aggregatedIssues : [])
    ]);

    const payload = {
        projectId,
        projectName,
        path,
        combinedReportJson: combinedReportJson || null,
        parsedReport: state.parsedReport || null
    };

}

function buildIssueDetailsHtml(issues, isOrphan = false) {
    if (!Array.isArray(issues) || !issues.length) {
        return '<div class="reportIssueInlineRow reportIssueInlineRow--empty">未檢測到問題</div>';
    }

    const rows = [];

    const buildSeverityRuleIssueTuples = (issue) => {
        const severityLevels = Array.isArray(issue?.severity_levels)
            ? issue.severity_levels
            : [];
        const ruleIds = Array.isArray(issue?.rule_ids) ? issue.rule_ids : [];
        const issueMessages = Array.isArray(issue?.issues) ? issue.issues : [];
        const maxLen = Math.max(severityLevels.length, ruleIds.length, issueMessages.length);

        if (!maxLen) return "";

        const tupleRows = [];

        for (let index = 0; index < maxLen; index += 1) {
            const severity = typeof severityLevels[index] === "string" ? severityLevels[index].trim() : "";
            const ruleId = typeof ruleIds[index] === "string" ? ruleIds[index].trim() : "";
            const issueText = typeof issueMessages[index] === "string" ? issueMessages[index].trim() : "";

            tupleRows.push(
                `<li class="reportIssueInlineTuple">` +
                `<span class="reportIssueInlineTupleItem reportIssueInlineTupleItem--severity">${escapeHtml(severity)}</span>` +
                `<span class="reportIssueInlineTupleItem reportIssueInlineTupleItem--rule">${escapeHtml(ruleId)}</span>` +
                `<span class="reportIssueInlineTupleItem reportIssueInlineTupleItem--message">${escapeHtml(issueText)}</span>` +
                `</li>`
            );
        }

        return `<ul class="reportIssueInlineTupleList">${tupleRows.join("")}</ul>`;
    };

    issues.forEach((issue) => {
        const details = Array.isArray(issue?.details) && issue.details.length ? issue.details : [issue];
        const issueItems = Array.isArray(issue?.issues)
            ? issue.issues.filter((entry) => typeof entry === "string" && entry.trim())
            : [];
        details.forEach((detail, detailIndex) => {
            const lineIndex = Number(detail?.index ?? detailIndex + 1);
            const lineMeta = ensureIssueLineMeta(issue);
            const lineLabel = lineMeta.label || (Number.isFinite(lineIndex) ? `#${lineIndex}` : "");
            const badges = [];
            if (lineLabel) {
                badges.push(`<span class="reportIssueInlineLine">Line ${escapeHtml(lineLabel)}</span>`);
            }
            if (detail?.ruleId) {
                badges.push(`<span class="reportIssueInlineRule">${escapeHtml(detail.ruleId)}</span>`);
            }
            const { label: severityLabel, severityClass } = resolveSeverityInfo(detail, issue);
            badges.push(
                `<span class="reportIssueInlineSeverity reportIssueInlineSeverity--${severityClass}">${escapeHtml(
                    severityLabel
                )}</span>`
            );

            const badgeBlock = badges.length
                ? `<span class="reportIssueInlineBadges">${badges.join(" ")}</span>`
                : "";

            const messageText =
                typeof detail?.message === "string" && detail.message.trim()
                    ? detail.message.trim()
                    : typeof issue?.message === "string" && issue.message.trim()
                        ? issue.message.trim()
                        : "未提供說明";
            const message = `<span class="reportIssueInlineMessage">${escapeHtml(messageText)}</span>`;

            const issueList = (() => {
                const tupleList = buildSeverityRuleIssueTuples(issue);
                if (tupleList) return tupleList;

                return issueItems.length
                    ? `<ul class="reportIssueInlineList">${issueItems
                        .map((text) => `<li>${escapeHtml(text)}</li>`)
                        .join("")}</ul>`
                    : "";
            })();

            const metaParts = [];
            if (issue?.objectName) {
                metaParts.push(`<span class="reportIssueInlineObject">${escapeHtml(issue.objectName)}</span>`);
            }
            if (Number.isFinite(detail?.column)) {
                metaParts.push(`<span class="reportIssueInlineColumn">列 ${escapeHtml(String(detail.column))}</span>`);
            }
            const meta = metaParts.length
                ? `<span class="reportIssueInlineMeta">${metaParts.join(" · ")}</span>`
                : "";

            rows.push(`<div class="reportIssueInlineRow">${badgeBlock}${message}${issueList}${meta}</div>`);
        });
    });

    if (!rows.length) {
        return '<div class="reportIssueInlineRow reportIssueInlineRow--empty">未檢測到問題</div>';
    }

    return rows.join("");
}

const buildIssueFixHtml = (issues) => {
    if (!Array.isArray(issues) || !issues.length) {
        return '<div class="reportIssueInlineRow reportIssueInlineRow--empty">暫無建議</div>';
    }

    const rows = [];

    const collectRecommendations = (issue) => {
        const entries = [];
        const push = (value) => {
            if (typeof value !== "string") return;
            const trimmed = value.trim();
            if (!trimmed) return;
            entries.push(trimmed);
        };

        const pushList = (list) => {
            if (!Array.isArray(list)) return;
            list.forEach((item) => push(item));
        };

        const details = Array.isArray(issue?.details) ? issue.details : [];
        details.forEach((detail) => {
            if (typeof detail?.recommendation === "string") {
                push(detail.recommendation);
            }
            if (Array.isArray(detail?.recommendation)) {
                pushList(detail.recommendation);
            }
            if (typeof detail?.suggestion === "string") {
                push(detail.suggestion);
            }
            if (Array.isArray(detail?.suggestion)) {
                pushList(detail.suggestion);
            }
        });

        if (typeof issue?.recommendation === "string") {
            push(issue.recommendation);
        }
        if (Array.isArray(issue?.recommendation)) {
            pushList(issue.recommendation);
        }
        if (Array.isArray(issue?.recommendations)) {
            pushList(issue.recommendations);
        }
        if (typeof issue?.suggestion === "string") {
            push(issue.suggestion);
        }
        if (Array.isArray(issue?.suggestionList)) {
            pushList(issue.suggestionList);
        }

        return entries;
    };

    const extractFixedCode = (issue) => {
        const details = Array.isArray(issue?.details) ? issue.details : [];
        for (const detail of details) {
            const candidate =
                typeof detail?.fixed_code === "string"
                    ? detail.fixed_code
                    : typeof detail?.fixedCode === "string"
                        ? detail.fixedCode
                        : "";
            if (candidate && candidate.trim()) {
                return candidate.trim();
            }
        }

        if (typeof issue?.fixed_code === "string" && issue.fixed_code.trim()) {
            return issue.fixed_code.trim();
        }
        if (typeof issue?.fixedCode === "string" && issue.fixedCode.trim()) {
            return issue.fixedCode.trim();
        }
        return "";
    };

    issues.forEach((issue) => {
        const recommendations = collectRecommendations(issue);
        if (recommendations.length) {
            const items = recommendations
                .map(
                    (text) =>
                        `<li class="reportIssueInlineRow reportIssueInlineRecommendation">${escapeHtml(text)}</li>`
                )
                .join("");
            rows.push(`<ul class="reportIssueInlineRecommendationList">${items}</ul>`);
        } else {
            rows.push('<div class="reportIssueInlineRow reportIssueInlineRow--empty">&nbsp;</div>');
        }

        const fixedCode = extractFixedCode(issue);
        if (fixedCode) {
            rows.push(
                `<pre class="reportIssueInlineRow reportIssueInlineCode"><code>${escapeHtml(fixedCode)}</code></pre>`
            );
        } else {
            rows.push('<div class="reportIssueInlineRow reportIssueInlineRow--empty">&nbsp;</div>');
        }
    });

    if (!rows.length) {
        return '<div class="reportIssueInlineRow reportIssueInlineRow--empty">暫無建議</div>';
    }

    return rows.join("");
};

function renderLineContent(line) {
    const rawText = typeof line?.raw === "string" ? line.raw : (line?.content || "").replace(/ /g, " ");
    const selection = codeSelection.value;
    const safe = escapeHtml(rawText);

    if (!selection || !selection.startLine || !selection.endLine || !Number.isFinite(line?.number)) {
        return safe.length ? safe : "&nbsp;";
    }

    const lineNumber = line.number;
    if (lineNumber < selection.startLine || lineNumber > selection.endLine) {
        return safe.length ? safe : "&nbsp;";
    }

    const plain = rawText;
    const lineLength = plain.length;
    const startIndex = lineNumber === selection.startLine ? Math.max(0, (selection.startColumn ?? 1) - 1) : 0;
    const endIndex = lineNumber === selection.endLine
        ? Math.min(lineLength, selection.endColumn ?? lineLength)
        : lineLength;

    const safeBefore = escapeHtml(plain.slice(0, startIndex));
    const highlightEnd = Math.max(startIndex, endIndex);
    const middleRaw = plain.slice(startIndex, highlightEnd);
    const safeMiddle = escapeHtml(middleRaw);
    const safeAfter = escapeHtml(plain.slice(highlightEnd));

    const highlighted = `<span class="codeSelectionHighlight">${safeMiddle.length ? safeMiddle : "&nbsp;"}</span>`;
    const combined = `${safeBefore}${highlighted}${safeAfter}`;
    return combined.length ? combined : "&nbsp;";
}

function clearCodeSelection() {
    if (codeSelection.value) {
        codeSelection.value = null;
    }
    shouldClearAfterPointerClick = false;
    lastPointerDownWasOutsideCode = false;
}

function isWithinCodeLine(target) {
    const root = codeScrollRef.value;
    if (!root || !target) return false;

    let current = target;
    while (current && current !== root) {
        if (current.classList && (current.classList.contains("codeLine") || current.classList.contains("codeLineContent") || current.classList.contains("codeLineNo"))) {
            return true;
        }
        current = current.parentNode;
    }

    return false;
}

function resolveLineInfo(node) {
    if (!node) return null;
    let current = node.nodeType === 3 ? node.parentElement : node;
    while (current && current !== codeScrollRef.value) {
        if (current.classList && current.classList.contains("codeLine")) {
            const lineNumber = Number.parseInt(current.dataset?.line || "", 10);
            const contentEl = current.querySelector(".codeLineContent");
            return {
                lineEl: current,
                contentEl,
                lineNumber: Number.isFinite(lineNumber) ? lineNumber : null
            };
        }
        current = current.parentElement;
    }
    return null;
}

function normaliseSelectionRangeText(range) {
    return range
        .toString()
        .replace(/\u00A0/g, " ")
        .replace(/\r\n|\r/g, "\n");
}

function measureColumn(lineInfo, container, offset, mode) {
    if (!lineInfo?.contentEl || typeof document === "undefined") return null;
    const targetContainer = container?.nodeType === 3 ? container : container;
    if (!lineInfo.contentEl.contains(targetContainer)) {
        if (mode === "end") {
            const fullRange = document.createRange();
            fullRange.selectNodeContents(lineInfo.contentEl);
            return normaliseSelectionRangeText(fullRange).length || null;
        }
        return 1;
    }
    const range = document.createRange();
    range.selectNodeContents(lineInfo.contentEl);
    try {
        range.setEnd(container, offset);
    } catch (error) {
        return null;
    }
    const length = normaliseSelectionRangeText(range).length;
    if (mode === "start") {
        return Math.max(1, length + 1);
    }
    return Math.max(1, length);
}

function buildSelectedSnippet() {
    if (typeof window === "undefined") return null;
    const root = codeScrollRef.value;
    if (!root) return null;
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
        return null;
    }

    const rawText = normaliseSelectionRangeText(range);
    if (!rawText.trim()) return null;

    const startInfo = resolveLineInfo(range.startContainer);
    const endInfo = resolveLineInfo(range.endContainer);
    if (!startInfo || !endInfo) return null;

    const startLine = startInfo.lineNumber;
    const endLine = endInfo.lineNumber;
    const startColumn = measureColumn(startInfo, range.startContainer, range.startOffset, "start");
    const endColumn = measureColumn(endInfo, range.endContainer, range.endOffset, "end");
    const lineCount = startLine !== null && endLine !== null ? endLine - startLine + 1 : null;

    const path = previewing.value.path || treeStore.activeTreePath.value || "";
    const name = previewing.value.name || path || "選取片段";

    const snippet = {
        path,
        name,
        label: name,
        startLine,
        endLine,
        startColumn,
        endColumn,
        lineCount,
        text: rawText
    };

    codeSelection.value = snippet;
    shouldClearAfterPointerClick = false;
    return snippet;
}

function handleDocumentSelectionChange() {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    if (previewing.value.kind !== "text") return;
    const root = codeScrollRef.value;
    if (!root) return;
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;

    if (selection.isCollapsed) {
        return;
    }

    const snippet = buildSelectedSnippet();
    if (!snippet) {
        clearCodeSelection();
    }
}

function handleDocumentPointerUp(event) {
    const root = codeScrollRef.value;
    if (!root) {
        pointerDownInCode = false;
        shouldClearAfterPointerClick = false;
        lastPointerDownWasOutsideCode = false;
        return;
    }

    const target = event?.target || null;
    const pointerUpInside = target ? root.contains(target) : false;

    const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
    const selectionInCode =
        !!selection &&
        selection.rangeCount > 0 &&
        root.contains(selection.anchorNode) &&
        root.contains(selection.focusNode);
    const hasActiveSelection = !!selectionInCode && selection && !selection.isCollapsed;

    if (hasActiveSelection) {
        // Ensure the most recent drag selection is captured even if the
        // browser collapses the native selection highlight after mouseup.
        const snippet = buildSelectedSnippet();
        if (!snippet && codeSelection.value) {
            // Re-emit the existing selection so the custom highlight remains
            // visible when the document selection collapses immediately.
            codeSelection.value = { ...codeSelection.value };
        }
        shouldClearAfterPointerClick = false;
        lastPointerDownWasOutsideCode = false;
    } else if (pointerDownInCode && pointerUpInside && shouldClearAfterPointerClick) {
        clearCodeSelection();
    } else if (lastPointerDownWasOutsideCode && !pointerUpInside) {
        // Preserve the current highlight when the interaction happens completely outside the editor
        // by re-emitting the stored selection so Vue keeps the custom highlight rendered.
        if (codeSelection.value) {
            codeSelection.value = { ...codeSelection.value };
        }
    }

    pointerDownInCode = false;
    shouldClearAfterPointerClick = false;
    lastPointerDownWasOutsideCode = false;
}

function handleCodeScrollPointerDown(event) {
    if (event.button !== 0) return;
    if (previewing.value.kind !== "text") return;
    const target = event?.target || null;
    const withinLine = isWithinCodeLine(target);
    pointerDownInCode = withinLine;
    shouldClearAfterPointerClick = withinLine && !!codeSelection.value;
    lastPointerDownWasOutsideCode = !withinLine;
}

function handleDocumentPointerDown(event) {
    const root = codeScrollRef.value;
    if (!root) return;
    const target = event?.target || null;
    const pointerDownInside = target ? root.contains(target) : false;
    if (pointerDownInside) {
        lastPointerDownWasOutsideCode = false;
        return;
    }

    lastPointerDownWasOutsideCode = true;
    pointerDownInCode = false;
    shouldClearAfterPointerClick = false;

    if (codeSelection.value) {
        // Touching other panes should not discard the stored snippet, so keep the
        // highlight alive by nudging Vue's reactivity system.
        codeSelection.value = { ...codeSelection.value };
    }
}

let wrapMeasureFrame = null;
let codeScrollResizeObserver = null;

function runLineWrapMeasurement() {
    if (!showCodeLineNumbers.value) {
        showCodeLineNumbers.value = true;
    }
}

function scheduleLineWrapMeasurement() {
    if (typeof window === "undefined") return;
    if (wrapMeasureFrame !== null) {
        window.cancelAnimationFrame(wrapMeasureFrame);
        wrapMeasureFrame = null;
    }
    wrapMeasureFrame = window.requestAnimationFrame(() => {
        wrapMeasureFrame = null;
        runLineWrapMeasurement();
    });
}

watch(isChatWindowOpen, (visible) => {
    if (visible) {
        openAssistantSession();
        const shouldForce = connection.value.status === "error";
        retryHandshake({ force: shouldForce });
        if (!hasInitializedChatWindow.value) {
            chatWindowState.width = 420;
            chatWindowState.height = 520;
            chatWindowState.x = Math.max(20, window.innerWidth - chatWindowState.width - 40);
            chatWindowState.y = 80;
            hasInitializedChatWindow.value = true;
        } else {
            ensureChatWindowInView();
        }
        nextTick(() => {
            ensureChatWindowInView();
        });
    } else {
        closeAssistantSession();
    }
});

watch(
    () => previewing.value.kind,
    () => {
        scheduleLineWrapMeasurement();
    }
);

watch(
    () => previewing.value.text,
    () => {
        scheduleLineWrapMeasurement();
    },
    { flush: "post" }
);

watch(
    () => previewLineItems.value.length,
    () => {
        scheduleLineWrapMeasurement();
    }
);

watch(
    () => reportIssueLines.value,
    () => {
        focusPendingReportIssue();
    },
    { flush: "post" }
);

watch(
    () => activeReportTarget.value,
    () => {
        focusPendingReportIssue();
    }
);

watch(
    () => codeScrollRef.value,
    (next, prev) => {
        if (codeScrollResizeObserver && prev) {
            codeScrollResizeObserver.unobserve(prev);
        }
        if (codeScrollResizeObserver && next) {
            codeScrollResizeObserver.observe(next);
        }
        scheduleLineWrapMeasurement();
    }
);

onMounted(() => {
    if (typeof window !== "undefined" && "ResizeObserver" in window) {
        codeScrollResizeObserver = new window.ResizeObserver(() => {
            scheduleLineWrapMeasurement();
        });
        if (codeScrollRef.value) {
            codeScrollResizeObserver.observe(codeScrollRef.value);
        }
    }
    scheduleLineWrapMeasurement();
});

onBeforeUnmount(() => {
    if (wrapMeasureFrame !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(wrapMeasureFrame);
        wrapMeasureFrame = null;
    }
    if (codeScrollResizeObserver) {
        if (codeScrollRef.value) {
            codeScrollResizeObserver.unobserve(codeScrollRef.value);
        }
        if (typeof codeScrollResizeObserver.disconnect === "function") {
            codeScrollResizeObserver.disconnect();
        }
        codeScrollResizeObserver = null;
    }
});

watch(
    () => previewing.value.kind,
    (kind) => {
        if (kind !== "text") {
            clearCodeSelection();
        }
    }
);

watch(
    () => previewing.value.path,
    () => {
        clearCodeSelection();
    }
);

watch(
    () => activeTreePath.value,
    () => {
        clearCodeSelection();
    }
);

watch(
    () => activeTreeRevision.value,
    () => {
        clearCodeSelection();
    }
);

watch(
    () => previewing.value.text,
    () => {
        if (previewing.value.kind === "text") {
            clearCodeSelection();
        }
    }
);

watch(
    [pendingReportIssueJump, activeReport, reportIssueLines],
    () => {
        focusPendingReportIssue();
    },
    { deep: true, flush: "post" }
);

watch(
    [reportIssuesContentRef, reportViewerContentRef],
    () => {
        focusPendingReportIssue();
    },
    { flush: "post" }
);

async function ensureActiveProject() {
    const list = Array.isArray(projects.value) ? projects.value : [];
    if (!list.length) return;

    const selectedIdValue = selectedProjectId.value;
    if (!selectedIdValue) {
        return;
    }

    const current = list.find((project) => project.id === selectedIdValue);
    if (!current) {
        selectedProjectId.value = null;
        return;
    }

    if (!tree.value.length && !isLoadingTree.value) {
        isTreeCollapsed.value = false;
        await openProject(current);
    }
}

watch(
    [projects, selectedProjectId],
    async () => {
        await ensureActiveProject();
    },
    { immediate: true }
);

watch(selectedProjectId, (projectId) => {
    if (projectId === null || projectId === undefined) {
        isTreeCollapsed.value = false;
    }
});

watch(isSettingsViewActive, (active) => {
    if (active) {
        ensureSettingsLoaded();
    }
});

watch(settingLanguage, (language) => {
    if (isSettingsViewActive.value) {
        ensureSettingsLoaded(language);
    }
});

function handleSelectProject(project) {
    if (!project) return;
    const currentId = selectedProjectId.value;
    const treeHasNodes = Array.isArray(tree.value) && tree.value.length > 0;
    if (currentId === project.id) {
        if (isTreeCollapsed.value) {
            isTreeCollapsed.value = false;
            if (!treeHasNodes && !isLoadingTree.value) {
                openProject(project);
            }
        } else {
            if (!isLoadingTree.value && !treeHasNodes) {
                openProject(project);
            } else {
                isTreeCollapsed.value = true;
            }
        }
        return;
    }
    isTreeCollapsed.value = false;
    openProject(project);
}

function toggleProjectTool() {
    if (isProjectToolActive.value && !isSettingsViewActive.value) return;
    activateRailTool("projects");
}

function toggleReportTool() {
    if (isReportToolActive.value && !isSettingsViewActive.value) return;
    activateRailTool("reports");
    isReportTreeCollapsed.value = true;
}

function togglePreviewTool() {
    if (isPreviewToolActive.value && !isSettingsViewActive.value) return;
    activateRailTool("preview");
    isReportTreeCollapsed.value = true;
}

function toggleSettingsView() {
    if (isSettingsViewActive.value) {
        activateRailTool(lastNonSettingsTool.value || "projects");
        return;
    }
    activateRailTool("settings");
    ensureSettingsLoaded();
}

function activateRailTool(tool) {
    if (tool !== "settings") {
        lastNonSettingsTool.value = tool;
    }
    activeRailTool.value = tool;
}

function ensureSettingsLoaded(language = settingLanguage.value) {
    const targetLanguage = availableSettingLanguages.includes(language) ? language : "SQL";
    if (!ruleSettingsState.loaded[targetLanguage] && !ruleSettingsState.loading) {
        loadRuleSettings(targetLanguage);
    }
    if (!aiReviewState.loaded[targetLanguage] && !aiReviewState.loading) {
        loadAiReviewSettingContent(targetLanguage);
    }
    if (!documentSettingState.loaded && !documentSettingState.loading) {
        loadDocumentReviewSettingContent();
    }
}

function createEmptyRule(language) {
    return {
        localId: `${language}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ruleId: "",
        description: "",
        enabled: true,
        riskIndicator: ""
    };
}

async function loadRuleSettings(language = settingLanguage.value) {
    const targetLanguage = availableSettingLanguages.includes(language) ? language : "SQL";
    ruleSettingsState.loading = true;
    try {
        const response = await fetchSettingRules(targetLanguage);
        const rules = Array.isArray(response?.rules) ? response.rules : [];
        const hydrated = rules.map((rule, index) => ({
            localId: `${targetLanguage}-${Date.now()}-${index}`,
            ruleId: rule?.ruleId || "",
            description: rule?.description || "",
            enabled: Boolean(rule?.enabled),
            riskIndicator: rule?.riskIndicator || ""
        }));
        ruleSettingsByLanguage[targetLanguage] = hydrated.length
            ? hydrated
            : [createEmptyRule(targetLanguage)];
        ruleSettingsState.loaded[targetLanguage] = true;
        ruleSettingsState.message = "";
    } catch (error) {
        safeAlertFail(error);
    } finally {
        ruleSettingsState.loading = false;
    }
}

function addRuleRow() {
    activeRuleSettings.value.push(createEmptyRule(settingLanguage.value));
}

function removeRuleRow(index) {
    const list = activeRuleSettings.value;
    if (!Array.isArray(list)) return;
    list.splice(index, 1);
}

function createEmptyDocumentRule() {
    return {
        localId: `doc-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        key: "",
        ruleId: "",
        description: "",
        enabled: true,
        riskIndicator: ""
    };
}

function addDocumentRuleRow() {
    documentSettingState.checks.push(createEmptyDocumentRule());
}

function removeDocumentRuleRow(index) {
    if (!Array.isArray(documentSettingState.checks)) return;
    documentSettingState.checks.splice(index, 1);
}

async function handleSaveRules() {
    const language = availableSettingLanguages.includes(settingLanguage.value)
        ? settingLanguage.value
        : "SQL";
    const rules = Array.isArray(activeRuleSettings.value) ? activeRuleSettings.value : [];
    const normalizedRules = rules.map((rule) => ({
        ruleId: typeof rule?.ruleId === "string" ? rule.ruleId.trim() : String(rule?.ruleId || ""),
        description: typeof rule?.description === "string" ? rule.description.trim() : "",
        enabled: Boolean(rule?.enabled),
        riskIndicator: typeof rule?.riskIndicator === "string" ? rule.riskIndicator.trim() : ""
    }));

    const missingRequiredRule = normalizedRules.find(
        (rule) => !rule.ruleId || !rule.description || !rule.riskIndicator
    );
    if (missingRequiredRule) {
        ruleSettingsState.message = "請完整填寫規則ID、描述與風險指標";
        return;
    }

    const payload = normalizedRules.filter((rule) => {
        const hasContent = rule.ruleId || rule.description || rule.riskIndicator;
        return hasContent;
    });

    const duplicates = new Set();
    const hasDuplicateRuleId = payload.some((rule) => {
        if (duplicates.has(rule.ruleId)) return true;
        duplicates.add(rule.ruleId);
        return false;
    });
    if (hasDuplicateRuleId) {
        ruleSettingsState.message = "規則ID 不可重覆";
        return;
    }

    const missingRequiredPlaceholders = aiReviewMissingRequiredPlaceholders.value;
    if (missingRequiredPlaceholders.length) {
        const missingText = missingRequiredPlaceholders.map((entry) => `{{${entry.key}}}`).join("、");
        aiReviewState.message = `請先插入所有必要占位符：${missingText}`;
        return;
    }

    ruleSettingsState.saving = true;
    aiReviewState.saving = true;
    ruleSettingsState.message = "";
    aiReviewState.message = "";
    try {
        await Promise.all([
            saveSettingRules(language, payload),
            saveAiReviewSetting(language, activeAiReviewContent.value || "")
        ]);
        ruleSettingsState.message = "規則與 AI 模版已保存";
        aiReviewState.message = "";
        ruleSettingsState.loaded[language] = true;
        aiReviewState.loaded[language] = true;
    } catch (error) {
        safeAlertFail(error);
    } finally {
        ruleSettingsState.saving = false;
        aiReviewState.saving = false;
    }
}

async function loadAiReviewSettingContent(language = settingLanguage.value) {
    const targetLanguage = availableSettingLanguages.includes(language) ? language : "SQL";
    aiReviewState.loading = true;
    try {
        const response = await fetchAiReviewSetting(targetLanguage);
        const content = typeof response?.codeBlock === "string" ? response.codeBlock : "";
        aiReviewContentByLanguage[targetLanguage] = content;
        aiReviewState.loaded[targetLanguage] = true;
        aiReviewState.message = "";
    } catch (error) {
        safeAlertFail(error);
    } finally {
        aiReviewState.loading = false;
    }
}

async function loadDocumentReviewSettingContent() {
    documentSettingState.loading = true;
    documentSettingState.message = "";
    try {
        const response = await fetchDocumentReviewSetting();
        const sourceRules = Array.isArray(response?.checks) && response.checks.length
            ? response.checks
            : [...DEFAULT_DOCUMENT_RULES];
        documentSettingState.checks = sourceRules.map((rule, index) => ({
            localId: rule?.localId || `doc-${Date.now()}-${index}`,
            key: rule?.key || rule?.ruleId || "",
            ruleId: rule?.ruleId || "",
            description: rule?.description || "",
            enabled: rule?.enabled !== false,
            riskIndicator: rule?.riskIndicator || ""
        }));
        documentSettingState.promptTemplate =
            typeof response?.promptTemplate === "string" && response.promptTemplate.trim()
                ? response.promptTemplate
                : DEFAULT_DOCUMENT_PROMPT;
        documentSettingState.loaded = true;
    } catch (error) {
        documentSettingState.message = error?.message || "載入文件審查設定失敗";
    } finally {
        documentSettingState.loading = false;
    }
}

async function handleSaveDocumentReviewSetting() {
    documentSettingState.saving = true;
    documentSettingState.message = "";
    try {
        const normalizedRules = (Array.isArray(documentSettingState.checks)
            ? documentSettingState.checks
            : []
        ).map((rule) => ({
            key: typeof rule?.key === "string" ? rule.key.trim() : rule?.ruleId || "",
            ruleId: typeof rule?.ruleId === "string" ? rule.ruleId.trim() : "",
            description: typeof rule?.description === "string" ? rule.description.trim() : "",
            enabled: Boolean(rule?.enabled),
            riskIndicator:
                typeof rule?.riskIndicator === "string" ? rule.riskIndicator.trim() : ""
        }));

        const missingRequired = normalizedRules.find(
            (rule) => !rule.ruleId || !rule.description || !rule.riskIndicator
        );
        if (missingRequired) {
            documentSettingState.message = "請完整填寫規則ID、描述與風險指標";
            documentSettingState.saving = false;
            return;
        }

        const payload = normalizedRules.filter((rule) =>
            rule.ruleId || rule.description || rule.riskIndicator
        );

        const duplicates = new Set();
        const hasDuplicateRuleId = payload.some((rule) => {
            if (duplicates.has(rule.ruleId)) return true;
            duplicates.add(rule.ruleId);
            return false;
        });
        if (hasDuplicateRuleId) {
            documentSettingState.message = "規則ID 不可重覆";
            documentSettingState.saving = false;
            return;
        }

        await saveDocumentReviewSetting({
            checks: payload,
            promptTemplate: documentSettingState.promptTemplate
        });
        documentSettingState.message = "文件審查設定已保存";
        documentSettingState.loaded = true;
    } catch (error) {
        documentSettingState.message = error?.message || "保存文件審查設定失敗";
    } finally {
        documentSettingState.saving = false;
    }
}

function insertAiReviewPlaceholder(key) {
    if (!key) return;
    if (aiReviewPlaceholderUsage.value.has(key)) {
        aiReviewState.message = `{{${key}}} 已於模版中使用`;
        return;
    }
    const placeholder = `{{${key}}}`;
    const current = typeof activeAiReviewContent.value === "string" ? activeAiReviewContent.value : "";
    const target = aiReviewInputRef.value;
    if (target && typeof target.selectionStart === "number" && typeof target.selectionEnd === "number") {
        const { selectionStart, selectionEnd } = target;
        activeAiReviewContent.value =
            current.slice(0, selectionStart) + placeholder + current.slice(selectionEnd, current.length);
        nextTick(() => {
            const caret = selectionStart + placeholder.length;
            target.setSelectionRange(caret, caret);
            target.focus();
        });
    } else {
        const prefix = current && !current.endsWith("\n") ? "\n" : "";
        activeAiReviewContent.value = `${current}${prefix}${placeholder}`;
    }
    aiReviewState.message = `${placeholder} 已插入`;
}

function formatAiReviewPlaceholder(key) {
    return key ? `{{${key}}}` : "";
}

function normaliseProjectId(projectId) {
    if (projectId === null || projectId === undefined) return "";
    return String(projectId);
}

function toggleReportTreeCollapsed() {
    isReportTreeCollapsed.value = !isReportTreeCollapsed.value;
}

function toReportKey(projectId, path) {
    const projectKey = normaliseProjectId(projectId);
    if (!projectKey || !path) return "";
    return `${projectKey}::${path}`;
}

function parseReportKey(key) {
    if (!key) return { projectId: "", path: "" };
    const index = key.indexOf("::");
    if (index === -1) {
        return { projectId: key, path: "" };
    }
    return {
        projectId: key.slice(0, index),
        path: key.slice(index + 2)
    };
}

function createDefaultReportState() {
    return {
        status: "idle",
        report: "",
        updatedAt: null,
        updatedAtDisplay: null,
        error: "",
        chunks: [],
        segments: [],
        conversationId: "",
        analysis: null,
        issueSummary: null,
        parsedReport: null,
        rawReport: "",
        dify: null,
        dml: null,
        difyErrorMessage: "",
        dmlErrorMessage: "",
        sourceText: "",
        sourceLoaded: false,
        sourceLoading: false,
        sourceError: "",
        combinedReportJson: "",
        staticReportJson: "",
        aiReportJson: ""
    };
}

function computeIssueSummary(reportText, parsedOverride = null) {
    const parsed = parsedOverride || parseReportJson(reportText);
    if (!parsed || typeof parsed !== "object") {
        return null;
    }
    const summary = parsed?.summary;
    let total = null;
    if (summary && typeof summary === "object") {
        const candidate = summary.total_issues ?? summary.totalIssues;
        const numeric = Number(candidate);
        if (Number.isFinite(numeric)) {
            total = numeric;
        }
        if (!Number.isFinite(total) && summary.sources && typeof summary.sources === "object") {
            const staticSource = summary.sources.static_analyzer || summary.sources.staticAnalyzer;
            if (staticSource && typeof staticSource === "object") {
                const staticTotal = staticSource.total_issues ?? staticSource.totalIssues;
                const staticNumeric = Number(staticTotal);
                if (Number.isFinite(staticNumeric)) {
                    total = staticNumeric;
                }
            }
        }
    }
    if (total === null && Array.isArray(parsed?.issues)) {
        total = parsed.issues.length;
    }
    if (total === null && typeof summary === "string") {
        const normalised = summary.trim();
        if (normalised === "代码正常" || normalised === "代碼正常" || normalised === "OK") {
            total = 0;
        }
    }
    return {
        totalIssues: Number.isFinite(total) ? total : null,
        summary,
        raw: parsed
    };
}

function normaliseReportAnalysisState(state) {
    if (!state) return;

    const rawReport = typeof state.rawReport === "string" ? state.rawReport : "";
    const baseAnalysis =
        state.analysis && typeof state.analysis === "object" && !Array.isArray(state.analysis)
            ? { ...state.analysis }
            : {};
    let difyTarget =
        state.dify && typeof state.dify === "object" && !Array.isArray(state.dify) ? { ...state.dify } : null;

    if (rawReport) {
        if (typeof baseAnalysis.rawReport !== "string") {
            baseAnalysis.rawReport = rawReport;
        }
        if (typeof baseAnalysis.originalResult !== "string") {
            baseAnalysis.originalResult = rawReport;
        }
        if (typeof baseAnalysis.result !== "string") {
            baseAnalysis.result = rawReport;
        }
    }

    const parsedReport = state.parsedReport && typeof state.parsedReport === "object" ? state.parsedReport : null;
    if (parsedReport) {
        const reports =
            parsedReport.reports && typeof parsedReport.reports === "object" ? parsedReport.reports : null;
        if (reports) {
            const staticResult = mergeStaticReportIntoAnalysis({
                state,
                baseAnalysis,
                reports,
                difyTarget
            });
            difyTarget = staticResult.difyTarget;

            mergeAiReviewReportIntoAnalysis({ state, baseAnalysis, reports });

            const difyReport = reports.dify_workflow || reports.difyWorkflow;
            if (difyReport && typeof difyReport === "object") {
                if (!difyTarget) {
                    difyTarget = {};
                }
                const difyRaw = difyReport.raw;
                if (typeof difyRaw === "string" && difyRaw.trim()) {
                    if (!difyTarget.report || !difyTarget.report.trim()) {
                        difyTarget.report = difyRaw.trim();
                    }
                } else if (difyRaw && typeof difyRaw === "object") {
                    difyTarget.raw = difyRaw;
                    if (!difyTarget.report || !difyTarget.report.trim()) {
                        try {
                            difyTarget.report = JSON.stringify(difyRaw);
                        } catch (error) {
                            console.warn("[Report] Failed to stringify dify raw payload", error);
                        }
                    }
                } else if (!difyTarget.report || !difyTarget.report.trim()) {
                    try {
                        const fallback = { ...difyReport };
                        delete fallback.raw;
                        difyTarget.report = JSON.stringify(fallback);
                    } catch (error) {
                        console.warn("[Report] Failed to stringify dify workflow report", error);
                    }
                }
                if (!difyTarget.summary && difyReport.summary && typeof difyReport.summary === "object") {
                    difyTarget.summary = difyReport.summary;
                }
                if (!difyTarget.issues && Array.isArray(difyReport.issues)) {
                    difyTarget.issues = difyReport.issues;
                }
                if (!difyTarget.metadata && difyReport.metadata && typeof difyReport.metadata === "object") {
                    difyTarget.metadata = difyReport.metadata;
                }
            }
        }

        const aiPersistencePatch = buildAiReviewPersistencePayload(state);
        if (aiPersistencePatch) {
            Object.assign(baseAnalysis, aiPersistencePatch);
        }

        const parsedSummaryData =
            parsedReport.summary && typeof parsedReport.summary === "object" ? parsedReport.summary : null;
        if (!state.difyErrorMessage && parsedSummaryData) {
            const sources =
                parsedSummaryData.sources && typeof parsedSummaryData.sources === "object"
                    ? parsedSummaryData.sources
                    : null;
            if (sources) {
                const difySource = sources.dify_workflow || sources.difyWorkflow;
                const difyError =
                    typeof difySource?.error_message === "string"
                        ? difySource.error_message
                        : typeof difySource?.errorMessage === "string"
                            ? difySource.errorMessage
                            : "";
                if (difyError && difyError.trim()) {
                    state.difyErrorMessage = difyError.trim();
                }
            }
        }
    }

    if (difyTarget) {
        const hasReport = typeof difyTarget.report === "string" && difyTarget.report.trim().length > 0;
        if (!hasReport && difyTarget.raw && typeof difyTarget.raw === "object") {
            try {
                difyTarget.report = JSON.stringify(difyTarget.raw);
            } catch (error) {
                console.warn("[Report] Failed to stringify dify raw object for state", error);
            }
        }
        const filteredKeys = Object.keys(difyTarget).filter((key) => {
            const value = difyTarget[key];
            if (value === null || value === undefined) return false;
            if (typeof value === "string") return value.trim().length > 0;
            if (Array.isArray(value)) return value.length > 0;
            if (typeof value === "object") return Object.keys(value).length > 0;
            return true;
        });
        if (filteredKeys.length > 0) {
            state.dify = difyTarget;
        } else {
            state.dify = null;
        }
    } else if (!state.dify) {
        state.dify = null;
    }

    state.analysis = Object.keys(baseAnalysis).length ? baseAnalysis : null;
}

function ensureReportTreeEntry(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    if (!Object.prototype.hasOwnProperty.call(reportTreeCache, key)) {
        reportTreeCache[key] = {
            nodes: [],
            loading: false,
            error: "",
            expandedPaths: [],
            hydratedReports: false,
            hydratingReports: false,
            reportHydrationError: ""
        };
    }
    return reportTreeCache[key];
}

function appendDocumentReviewNode(nodes) {
    const existing = (nodes || []).find((node) => node?.path === DOCUMENT_REVIEW_PATH);
    if (existing) return nodes;
    const docNode = {
        type: "file",
        name: "文件AI審查",
        path: DOCUMENT_REVIEW_PATH,
        parent: "",
        mime: "application/json",
        isDocumentReview: true
    };
    return Array.isArray(nodes) ? [...nodes, docNode] : [docNode];
}

function ensureProjectBatchState(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    if (!Object.prototype.hasOwnProperty.call(reportBatchStates, key)) {
        reportBatchStates[key] = {
            running: false,
            processed: 0,
            total: 0
        };
    }
    return reportBatchStates[key];
}

function getProjectBatchState(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    return reportBatchStates[key] || null;
}

function getProjectIssueCount(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    const totals = projectIssueTotals.value;
    if (!totals.has(key)) return null;
    return totals.get(key);
}

function ensureFileReportState(projectId, path) {
    const key = toReportKey(projectId, path);
    if (!key) return null;
    if (!Object.prototype.hasOwnProperty.call(reportStates, key)) {
        reportStates[key] = createDefaultReportState();
    }
    return reportStates[key];
}

function getReportStateForFile(projectId, path) {
    return ensureFileReportState(projectId, path) || createDefaultReportState();
}

function getStatusLabel(status) {
    switch (status) {
        case "processing":
            return "處理中";
        case "ready":
            return "已完成";
        case "error":
            return "失敗";
        default:
            return "待生成";
    }
}

function isReportNodeExpanded(projectId, path) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry) return false;
    if (!path) return true;
    return entry.expandedPaths.includes(path);
}

function toggleReportNode(projectId, path) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry || !path) return;
    const set = new Set(entry.expandedPaths);
    if (set.has(path)) {
        set.delete(path);
    } else {
        set.add(path);
    }
    entry.expandedPaths = Array.from(set);
}

function collectFileNodes(nodes, bucket = []) {
    for (const node of nodes || []) {
        if (node.type === "file") {
            bucket.push(node);
        } else if (node.children && node.children.length) {
            collectFileNodes(node.children, bucket);
        }
    }
    return bucket;
}

function findTreeNodeByPath(nodes, targetPath) {
    if (!targetPath) return null;
    for (const node of nodes || []) {
        if (!node) continue;
        if (node.path === targetPath) {
            return node;
        }
        if (node.children && node.children.length) {
            const found = findTreeNodeByPath(node.children, targetPath);
            if (found) {
                return found;
            }
        }
    }
    return null;
}

function ensureStatesForProject(projectId, nodes) {
    const fileNodes = collectFileNodes(nodes);
    const validPaths = new Set();
    for (const node of fileNodes) {
        if (!node?.path) continue;
        ensureFileReportState(projectId, node.path);
        validPaths.add(node.path);
    }

    Object.keys(reportStates).forEach((key) => {
        const parsed = parseReportKey(key);
        if (parsed.projectId !== normaliseProjectId(projectId)) return;
        if (parsed.path && !validPaths.has(parsed.path)) {
            if (activeReportTarget.value &&
                activeReportTarget.value.projectId === parsed.projectId &&
                activeReportTarget.value.path === parsed.path) {
                activeReportTarget.value = null;
            }
            delete reportStates[key];
        }
    });
}

function parseHydratedTimestamp(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === "number" && Number.isFinite(value)) {
        return new Date(value);
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) {
            return new Date(parsed);
        }
    }
    return null;
}

function normaliseHydratedReportText(value) {
    if (typeof value === "string") {
        return value;
    }
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch (error) {
            console.warn("[Report] Failed to stringify hydrated report payload", error, value);
            return "";
        }
    }
    return String(value);
}

function normaliseHydratedString(value) {
    return typeof value === "string" ? value : "";
}

function pickFirstNonEmptyString(...candidates) {
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            const resolved = pickFirstNonEmptyString(...candidate);
            if (resolved) {
                return resolved;
            }
            continue;
        }
        if (candidate === null || candidate === undefined) {
            continue;
        }
        const value = typeof candidate === "string" ? candidate : String(candidate);
        const trimmed = value.trim();
        if (trimmed) {
            return trimmed;
        }
    }
    return "";
}

async function hydrateReportsForProject(projectId) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry) return;
    if (entry.hydratedReports || entry.hydratingReports) return;
    entry.hydratingReports = true;
    entry.reportHydrationError = "";
    try {
        const records = await fetchProjectReports(projectId);
        for (const record of records) {
            if (!record || !record.path) continue;
            const state = ensureFileReportState(projectId, record.path);
            if (!state) continue;
            const hydratedStatus = normaliseHydratedString(record.status).trim();
            const hydratedReportText = normaliseHydratedReportText(record.report);
            const trimmedReportText = typeof hydratedReportText === "string" ? hydratedReportText.trim() : "";
            const combinedJson = normaliseHydratedString(record.combinedReportJson).trim();
            const staticJson = normaliseHydratedString(record.staticReportJson).trim();
            const aiJson = normaliseHydratedString(record.aiReportJson).trim();
            const hasStoredSnapshots = Boolean(combinedJson || staticJson || aiJson);

            state.status =
                hydratedStatus ||
                (trimmedReportText || hasStoredSnapshots ? "ready" : "idle");
            state.report = hydratedReportText;
            state.error = normaliseHydratedString(record.error);
            state.chunks = Array.isArray(record.chunks) ? record.chunks : [];
            state.segments = Array.isArray(record.segments) ? record.segments : [];
            state.combinedReportJson = normaliseHydratedString(record.combinedReportJson);
            state.staticReportJson = normaliseHydratedString(record.staticReportJson);
            state.aiReportJson = normaliseHydratedString(record.aiReportJson);
            state.conversationId = normaliseHydratedString(record.conversationId);
            state.analysis =
                record.analysis && typeof record.analysis === "object" && !Array.isArray(record.analysis)
                    ? record.analysis
                    : null;
            const hydratedRawReport = normaliseHydratedString(record.rawReport);
            const analysisResult = normaliseHydratedString(record.analysis?.result);
            const analysisOriginal = normaliseHydratedString(record.analysis?.originalResult);
            state.rawReport = hydratedRawReport || analysisResult || analysisOriginal || "";
            state.dify = normaliseReportObject(record.dify);
            if (!state.dify) {
                state.dify = normaliseReportObject(record.analysis?.dify);
            }
            state.dml = normaliseAiReviewPayload(record.dml);
            if (!state.dml) {
                state.dml = normaliseAiReviewPayload(record.analysis?.dmlReport);
            }
            state.difyErrorMessage = normaliseHydratedString(record.difyErrorMessage);
            if (!state.difyErrorMessage) {
                state.difyErrorMessage = normaliseHydratedString(record.analysis?.difyErrorMessage);
            }
            state.parsedReport = parseReportJson(state.report);
            if ((!state.parsedReport || typeof state.parsedReport !== "object") && hasStoredSnapshots) {
                state.parsedReport = { summary: null, reports: {} };
            }
            state.issueSummary = computeIssueSummary(state.report, state.parsedReport);
            hydrateAiReviewStateFromRecord(state, record);
            normaliseReportAnalysisState(state);
            updateIssueSummaryTotals(state);
            const timestamp = parseHydratedTimestamp(record.generatedAt || record.updatedAt || record.createdAt);
            state.updatedAt = timestamp;
            state.updatedAtDisplay = timestamp ? timestamp.toLocaleString() : null;
            if (typeof state.sourceText !== "string") {
                state.sourceText = "";
            }
            state.sourceLoaded = Boolean(state.sourceText);
            state.sourceLoading = false;
            state.sourceError = "";
        }
        entry.hydratedReports = true;
    } catch (error) {
        console.error("[Report] Failed to hydrate saved reports", { projectId, error });
        entry.reportHydrationError = error?.message ? String(error.message) : String(error);
    } finally {
        entry.hydratingReports = false;
    }
}

async function loadReportTreeForProject(projectId) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry || entry.loading) return;
    entry.loading = true;
    entry.error = "";
    try {
        const nodes = await treeStore.loadTreeFromDB(projectId);
        const augmentedNodes = appendDocumentReviewNode(nodes);
        entry.nodes = augmentedNodes;
        ensureStatesForProject(projectId, augmentedNodes);
        await hydrateReportsForProject(projectId);
        const nextExpanded = new Set(entry.expandedPaths);
        for (const node of augmentedNodes) {
            if (node.type === "dir") {
                nextExpanded.add(node.path);
            }
        }
        entry.expandedPaths = Array.from(nextExpanded);
    } catch (error) {
        console.error("[Report] Failed to load tree for project", projectId, error);
        entry.error = error?.message ? String(error.message) : String(error);
    } finally {
        entry.loading = false;
    }
}

function selectReport(projectId, path) {
    const key = toReportKey(projectId, path);
    if (!key) return;
    const state = reportStates[key];
    if (!state || state.status !== "ready") return;
    activeReportTarget.value = {
        projectId: normaliseProjectId(projectId),
        path
    };
}

function resolveReportIssuesContainer() {
    const containers = [];

    if (reportViewerContentRef.value) {
        containers.push(reportViewerContentRef.value);
    }

    if (typeof document !== "undefined") {
        const docViewer = document.querySelector(".reportViewerContent");
        if (docViewer && !containers.includes(docViewer)) {
            containers.push(docViewer);
        }
    }

    if (reportIssuesContentRef.value) {
        containers.push(reportIssuesContentRef.value);
    }

    if (typeof document !== "undefined") {
        const documentContainer = document.querySelector(".reportIssuesContent");
        if (documentContainer && !containers.includes(documentContainer)) {
            containers.push(documentContainer);
        }
    }

    for (const el of containers) {
        if (el && el.scrollHeight - el.clientHeight > 4) {
            return el;
        }
    }

    return containers[0] || null;
}

function findReportIssueLineElement(lineStart, lineEnd) {
    const selectors = [];
    if (Number.isFinite(lineEnd) && lineEnd !== lineStart) {
        const endLine = Math.max(1, Math.floor(lineEnd));
        selectors.push(`.codeLine[data-line="${endLine}"]`);
        selectors.push(`.codeLine--meta[data-line="${endLine}"]`);
        selectors.push(`.codeLine--fixMeta[data-line="${endLine}"]`);
        selectors.push(`.codeLineNo[data-line="${endLine}"]`);
        selectors.push(`.codeLine--meta .codeLineNo[data-line="${endLine}"]`);
        selectors.push(`.codeLine--fixMeta .codeLineNo[data-line="${endLine}"]`);
    }
    if (Number.isFinite(lineStart)) {
        const startLine = Math.max(1, Math.floor(lineStart));
        selectors.push(`.codeLine[data-line="${startLine}"]`);
        selectors.push(`.codeLine--meta[data-line="${startLine}"]`);
        selectors.push(`.codeLine--fixMeta[data-line="${startLine}"]`);
        selectors.push(`.codeLineNo[data-line="${startLine}"]`);
        selectors.push(`.codeLine--meta .codeLineNo[data-line="${startLine}"]`);
        selectors.push(`.codeLine--fixMeta .codeLineNo[data-line="${startLine}"]`);
    }

    const roots = [];
    if (reportViewerContentRef.value) roots.push(reportViewerContentRef.value);
    if (reportIssuesContentRef.value) roots.push(reportIssuesContentRef.value);
    if (typeof document !== "undefined") roots.push(document);

    for (const root of roots) {
        for (const selector of selectors) {
            const found = root.querySelector(selector);
            if (found) {
                return found.closest(".codeLine") || found;
            }
        }
    }
    return null;
}

function scrollReportIssuesToLine(targetEl, containerEl) {
    if (!targetEl || !containerEl) return false;

    const lineEl = targetEl.closest(".codeLine") || targetEl;
    const containerRect = containerEl.getBoundingClientRect();
    const lineRect = lineEl.getBoundingClientRect();
    const workspaceRect =
        typeof document !== "undefined"
            ? document.querySelector(".workspace--reports")?.getBoundingClientRect() || null
            : null;
    const visibleTop = workspaceRect
        ? Math.max(containerRect.top, workspaceRect.top)
        : containerRect.top;
    const visibleBottom = workspaceRect
        ? Math.min(containerRect.bottom, workspaceRect.bottom)
        : containerRect.bottom;
    const visibleHeight = Math.max(0, visibleBottom - visibleTop) || containerEl.clientHeight;
    const offsetTop = lineRect.top - containerRect.top + containerEl.scrollTop;
    const desiredTop = Math.max(0, offsetTop - visibleHeight + lineRect.height);

    containerEl.scrollTo({ top: desiredTop, behavior: "smooth" });
    return true;
}

function focusPendingReportIssue() {
    if (!pendingReportIssueJump.value) return;
    schedulePendingReportIssueJump(0);
}

function schedulePendingReportIssueJump(delay = REPORT_ISSUE_JUMP_INTERVAL) {
    if (pendingReportIssueJumpTimer) {
        clearTimeout(pendingReportIssueJumpTimer);
    }
    pendingReportIssueJumpTimer = setTimeout(() => {
        pendingReportIssueJumpTimer = null;
        attemptPendingReportIssueJump();
    }, delay);
}

function attemptPendingReportIssueJump() {
    const pending = pendingReportIssueJump.value;
    if (!pending) return;

    const active = activeReport.value;
    const activeProjectId = normaliseProjectId(active?.project?.id);
    if (!active || activeProjectId !== pending.projectId || active.path !== pending.path) {
        schedulePendingReportIssueJump();
        return;
    }

    if (!reportIssueLines.value.length) {
        schedulePendingReportIssueJump();
        return;
    }

    const container = resolveReportIssuesContainer();
    const lineEl = findReportIssueLineElement(pending.lineStart, pending.lineEnd);
    if (container && lineEl && scrollReportIssuesToLine(lineEl, container)) {
        pendingReportIssueJump.value = null;
        return;
    }

    if ((pending.attempts ?? 0) + 1 >= REPORT_ISSUE_JUMP_MAX_ATTEMPTS) {
        pendingReportIssueJump.value = null;
        return;
    }

    pendingReportIssueJump.value = {
        ...pending,
        attempts: (pending.attempts ?? 0) + 1
    };
    schedulePendingReportIssueJump();
}

function handlePreviewIssueSelect(payload) {
    const projectId = normaliseProjectId(payload?.projectId);
    const path = typeof payload?.path === "string" ? payload.path : "";
    const lineStart = Number(payload?.lineStart ?? payload?.lineEnd ?? NaN);
    const lineEnd = Number(payload?.lineEnd ?? payload?.lineStart ?? NaN);

    if (!projectId || !path || !Number.isFinite(lineStart)) {
        return;
    }

    activateRailTool("reports");
    isReportTreeCollapsed.value = true;
    selectReport(projectId, path);

    pendingReportIssueJump.value = {
        projectId,
        path,
        lineStart: Math.max(1, Math.floor(lineStart)),
        lineEnd: Number.isFinite(lineEnd) ? Math.max(1, Math.floor(lineEnd)) : Math.max(1, Math.floor(lineStart)),
        attempts: 0
    };

    schedulePendingReportIssueJump(0);
}

async function openProjectFileFromReportTree(projectId, path) {
    const projectKey = normaliseProjectId(projectId);
    if (!projectKey || !path) return;

    const projectList = Array.isArray(projects.value) ? projects.value : [];
    const project = projectList.find(
        (item) => normaliseProjectId(item.id) === projectKey
    );
    if (!project) return;

    if (isTreeCollapsed.value) {
        isTreeCollapsed.value = false;
    }

    if (selectedProjectId.value !== project.id) {
        await openProject(project);
    } else if (!Array.isArray(tree.value) || tree.value.length === 0) {
        await openProject(project);
    }

    const entry = ensureReportTreeEntry(project.id);
    if (entry && !entry.nodes.length && !entry.loading) {
        loadReportTreeForProject(project.id);
    }

    const searchNodes = (entry && entry.nodes && entry.nodes.length)
        ? entry.nodes
        : tree.value;
    let targetNode = findTreeNodeByPath(searchNodes, path);
    if (!targetNode) {
        const name = path.split("/").pop() || path;
        targetNode = { type: "file", path, name, mime: "" };
    }

    if (targetNode.isDocumentReview) {
        selectReport(project.id, targetNode.path);
        return;
    }

    treeStore.selectTreeNode(path);
    try {
        await treeStore.openNode(targetNode);
    } catch (error) {
        console.error("[Workspace] Failed to preview file from report tree", {
            projectId: project.id,
            path,
            error
        });
    }
}

async function loadTextContentForNode(project, node) {
    try {
        const root = await getProjectRootHandleById(project.id);
        const fileHandle = await fileSystemService.getFileHandleByPath(root, node.path);
        const file = await fileHandle.getFile();
        const mime = node.mime || file.type || "";
        if (!preview.isTextPreviewable(node.name, mime)) {
            throw new Error("目前僅支援純文字、程式碼或包含 SQL 的文件審查");
        }
        const text = await preview.readTextContent(file, {
            name: node.name,
            mime,
            maxBytes: preview.MAX_TEXT_BYTES * 2
        });
        if (!text.trim()) {
            throw new Error("檔案內容為空");
        }
        return { text, mime, size: file.size };
    } catch (error) {
        if (error?.code !== "external-handle-missing") {
            throw error;
        }
        const record = await fetchStoredFileContent(project.id, node.path);
        if (!record || typeof record.content !== "string") {
            throw new Error("無法從資料庫讀取檔案內容，請重新匯入資料夾。");
        }
        const mime = record.mime || node.mime || "text/plain";
        if (!preview.isTextPreviewable(node.name, mime)) {
            throw new Error("目前僅支援純文字、程式碼或包含 SQL 的文件審查");
        }
        const text = record.content;
        if (!text.trim()) {
            throw new Error("檔案內容為空");
        }
        return { text, mime, size: Number(record.size) || text.length };
    }
}

async function generateDocumentReview(project, options = {}) {
    const { autoSelect = true, silent = false } = options;
    if (!project) {
        return { status: "skipped" };
    }
    const projectId = normaliseProjectId(project.id);
    const state = ensureFileReportState(projectId, DOCUMENT_REVIEW_PATH);
    if (!state || state.status === "processing") {
        return { status: "processing" };
    }

    state.status = "processing";
    state.error = "";
    state.report = "";
    state.chunks = [];
    state.segments = [];
    state.conversationId = "";
    state.analysis = null;
    state.issueSummary = null;
    state.parsedReport = null;
    state.rawReport = "";
    state.dify = null;
    state.dml = null;
    state.difyErrorMessage = "";
    state.dmlErrorMessage = "";
    state.sourceText = "";
    state.sourceLoaded = false;
    state.sourceLoading = false;
    state.sourceError = "";
    state.combinedReportJson = "";
    state.staticReportJson = "";
    state.aiReportJson = "";

    try {
        const payload = await generateDocumentReviewReport({
            projectId,
            projectName: project.name,
            path: DOCUMENT_REVIEW_PATH
        });

        const completedAt = payload?.generatedAt ? new Date(payload.generatedAt) : new Date();
        state.status = "ready";
        state.updatedAt = completedAt;
        state.updatedAtDisplay = completedAt.toLocaleString();
        state.report = payload?.report || "";
        state.chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
        state.segments = Array.isArray(payload?.segments) ? payload.segments : [];
        state.conversationId = payload?.conversationId || "";
        state.rawReport = typeof payload?.rawReport === "string" ? payload.rawReport : "";
        state.dify = normaliseReportObject(payload?.dify) || normaliseReportObject(payload?.analysis?.dify);
        state.analysis = payload?.analysis || null;
        state.difyErrorMessage = typeof payload?.difyErrorMessage === "string" ? payload.difyErrorMessage : "";
        applyAiReviewResultToState(state, payload);
        state.parsedReport = parseReportJson(state.report);
        state.issueSummary = computeIssueSummary(state.report, state.parsedReport);
        normaliseReportAnalysisState(state);
        updateIssueSummaryTotals(state);
        state.error = "";
        state.combinedReportJson = typeof payload?.combinedReportJson === "string" ? payload.combinedReportJson : "";
        state.staticReportJson = typeof payload?.staticReportJson === "string" ? payload.staticReportJson : "";
        state.aiReportJson = typeof payload?.aiReportJson === "string" ? payload.aiReportJson : "";
        if (!state.sourceText && state.segments.length) {
            state.sourceText = typeof state.segments[0] === "string" ? state.segments[0] : "";
            state.sourceLoaded = Boolean(state.sourceText);
        }

        if (autoSelect) {
            activeReportTarget.value = {
                projectId,
                path: DOCUMENT_REVIEW_PATH
            };
        }

        return { status: "ready" };
    } catch (error) {
        const message = error?.message ? String(error.message) : String(error);
        state.status = "error";
        state.error = message;
        state.report = "";
        state.chunks = [];
        state.segments = [];
        state.conversationId = "";
        state.analysis = null;
        state.issueSummary = null;
        state.parsedReport = null;
        state.rawReport = "";
        state.dify = null;
        state.dml = null;
        state.difyErrorMessage = "";
        state.dmlErrorMessage = "";
        state.sourceLoading = false;
        state.sourceLoaded = false;
        state.combinedReportJson = "";
        state.staticReportJson = "";
        state.aiReportJson = "";
        const now = new Date();
        state.updatedAt = now;
        state.updatedAtDisplay = now.toLocaleString();

        if (autoSelect) {
            activeReportTarget.value = {
                projectId,
                path: DOCUMENT_REVIEW_PATH
            };
        }

        if (!silent) {
            alert(`生成文件審查報告失敗：${message}`);
        }

        return { status: "error", error };
    }
}

async function generateReportForFile(project, node, options = {}) {
    const { autoSelect = true, silent = false } = options;
    if (!project || !node || node.type !== "file") {
        return { status: "skipped" };
    }
    if (node.isDocumentReview) {
        return await generateDocumentReview(project, { autoSelect, silent });
    }
    const projectId = normaliseProjectId(project.id);
    const state = ensureFileReportState(projectId, node.path);
    if (!state || state.status === "processing") {
        return { status: "processing" };
    }

    state.status = "processing";
    state.error = "";
    state.report = "";
    state.chunks = [];
    state.segments = [];
    state.conversationId = "";
    state.analysis = null;
    state.issueSummary = null;
    state.parsedReport = null;
    state.rawReport = "";
    state.dify = null;
    state.dml = null;
    state.difyErrorMessage = "";
    state.dmlErrorMessage = "";
    state.sourceText = "";
    state.sourceLoaded = false;
    state.sourceLoading = false;
    state.sourceError = "";
    state.combinedReportJson = "";
    state.staticReportJson = "";
    state.aiReportJson = "";

    try {
        const { text } = await loadTextContentForNode(project, node);

        state.sourceText = text;
        state.sourceLoaded = true;
        state.sourceLoading = false;
        state.sourceError = "";

        const payload = await generateReportViaDify({
            projectId,
            projectName: project.name,
            path: node.path,
            content: text
        });

        const completedAt = payload?.generatedAt ? new Date(payload.generatedAt) : new Date();
        state.status = "ready";
        state.updatedAt = completedAt;
        state.updatedAtDisplay = completedAt.toLocaleString();
        state.report = payload?.report || "";
        state.chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
        state.segments = Array.isArray(payload?.segments) ? payload.segments : [];
        state.conversationId = payload?.conversationId || "";
        state.rawReport = typeof payload?.rawReport === "string" ? payload.rawReport : "";
        state.dify = normaliseReportObject(payload?.dify);
        if (!state.dify) {
            state.dify = normaliseReportObject(payload?.analysis?.dify);
        }
        state.dml = normaliseAiReviewPayload(payload?.dml);
        if (!state.dml) {
            state.dml = normaliseAiReviewPayload(payload?.analysis?.dmlReport);
        }
        state.difyErrorMessage = typeof payload?.difyErrorMessage === "string" ? payload.difyErrorMessage : "";
        state.analysis = payload?.analysis || null;
        applyAiReviewResultToState(state, payload);
        state.parsedReport = parseReportJson(state.report);
        state.issueSummary = computeIssueSummary(state.report, state.parsedReport);
        normaliseReportAnalysisState(state);
        updateIssueSummaryTotals(state);
        state.error = "";
        state.combinedReportJson = typeof payload?.combinedReportJson === "string" ? payload.combinedReportJson : "";
        state.staticReportJson = typeof payload?.staticReportJson === "string" ? payload.staticReportJson : "";
        state.aiReportJson = typeof payload?.aiReportJson === "string" ? payload.aiReportJson : "";

        if (autoSelect) {
            activeReportTarget.value = {
                projectId,
                path: node.path
            };
        }

        return { status: "ready" };
    } catch (error) {
        const message = error?.message ? String(error.message) : String(error);
        state.status = "error";
        state.error = message;
        state.report = "";
        state.chunks = [];
        state.segments = [];
        state.conversationId = "";
        state.analysis = null;
        state.issueSummary = null;
        state.parsedReport = null;
        state.rawReport = "";
        state.dify = null;
        state.dml = null;
        state.difyErrorMessage = "";
        state.dmlErrorMessage = "";
        state.sourceLoading = false;
        if (!state.sourceText) {
            state.sourceLoaded = false;
        }
        state.combinedReportJson = "";
        state.staticReportJson = "";
        state.aiReportJson = "";
        const now = new Date();
        state.updatedAt = now;
        state.updatedAtDisplay = now.toLocaleString();

        if (autoSelect) {
            activeReportTarget.value = {
                projectId,
                path: node.path
            };
        }

        if (!silent) {
            if (error?.name === "SecurityError" || error?.name === "NotAllowedError" || error?.name === "TypeError") {
                await safeAlertFail("生成報告失敗", error);
            } else {
                alert(`生成報告失敗：${message}`);
            }
        }

        return { status: "error", error };
    }
}

async function generateProjectReports(project) {
    if (!project) return;
    const projectId = normaliseProjectId(project.id);
    const batchState = ensureProjectBatchState(projectId);
    if (!batchState || batchState.running) return;

    const entry = ensureReportTreeEntry(project.id);
    if (!entry.nodes.length) {
        await loadReportTreeForProject(project.id);
    }

    if (entry.loading) {
        await new Promise((resolve) => {
            const stop = watch(
                () => entry.loading,
                (loading) => {
                    if (!loading) {
                        stop();
                        resolve();
                    }
                }
            );
        });
    }

    if (entry.error) {
        console.warn("[Report] Cannot start batch generation due to tree error", entry.error);
        alert(`無法生成報告：${entry.error}`);
        return;
    }

    const nodes = collectFileNodes(entry.nodes).filter((node) => !node.isDocumentReview);
    if (!nodes.length) {
        alert("此專案尚未索引可供審查的檔案");
        return;
    }

    batchState.running = true;
    batchState.processed = 0;
    batchState.total = nodes.length;

    try {
        for (const node of nodes) {
            await generateReportForFile(project, node, { autoSelect: false, silent: true });
            batchState.processed += 1;
        }
    } finally {
        batchState.running = false;
        if (nodes.length) {
            activeReportTarget.value = {
                projectId,
                path: nodes[nodes.length - 1].path
            };
        }
    }
}

watch(
    projects,
    (list) => {
        const projectList = Array.isArray(list) ? list : [];
        const currentIds = new Set(projectList.map((project) => normaliseProjectId(project.id)));

        projectList.forEach((project) => {
            const entry = ensureReportTreeEntry(project.id);
            if (shouldPrepareReportTrees.value && entry && !entry.nodes.length && !entry.loading) {
                loadReportTreeForProject(project.id);
            }
            if (
                shouldPrepareReportTrees.value &&
                entry &&
                !entry.hydratedReports &&
                !entry.hydratingReports
            ) {
                hydrateReportsForProject(project.id);
            }
        });

        Object.keys(reportTreeCache).forEach((projectId) => {
            if (!currentIds.has(projectId)) {
                delete reportTreeCache[projectId];
            }
        });

        Object.keys(reportBatchStates).forEach((projectId) => {
            if (!currentIds.has(projectId)) {
                delete reportBatchStates[projectId];
            }
        });

        Object.keys(reportStates).forEach((key) => {
            const parsed = parseReportKey(key);
            if (!currentIds.has(parsed.projectId)) {
                if (activeReportTarget.value &&
                    activeReportTarget.value.projectId === parsed.projectId &&
                    activeReportTarget.value.path === parsed.path) {
                    activeReportTarget.value = null;
                }
                delete reportStates[key];
            }
        });
    },
    { immediate: true, deep: true }
);

watch(
    () => projectTreeUpdateEvent.value,
    (event) => {
        const projectKey = normaliseProjectId(event?.projectId);
        if (!projectKey) {
            return;
        }
        const entry = ensureReportTreeEntry(projectKey);
        if (!entry) {
            return;
        }
        entry.nodes = [];
        entry.loading = false;
        entry.error = "";
        entry.hydratedReports = false;
        entry.hydratingReports = false;
        if (shouldPrepareReportTrees.value) {
            loadReportTreeForProject(projectKey);
        }
    },
    { deep: false }
);

watch(
    shouldPrepareReportTrees,
    (active) => {
        if (!active) return;
        const list = Array.isArray(projects.value) ? projects.value : [];
        list.forEach((project) => {
            const entry = ensureReportTreeEntry(project.id);
            if (entry && !entry.nodes.length && !entry.loading) {
                loadReportTreeForProject(project.id);
            }
            if (entry && !entry.hydratedReports && !entry.hydratingReports) {
                hydrateReportsForProject(project.id);
            }
        });
    }
);

watch(
    readyReports,
    (list) => {
        if (!list.length) {
            activeReportTarget.value = null;
            return;
        }
        const target = activeReportTarget.value;
        const hasActive = target
            ? list.some((entry) => normaliseProjectId(entry.project.id) === target.projectId && entry.path === target.path)
            : false;
        if (!hasActive) {
            const next = list[0];
            activeReportTarget.value = {
                projectId: normaliseProjectId(next.project.id),
                path: next.path
            };
        }
    },
    { immediate: true }
);

watch(
    activeReport,
    async (report) => {
        if (!report) return;
        const state = report.state;
        if (state.sourceLoaded || state.sourceLoading) {
            return;
        }
        state.sourceLoading = true;
        state.sourceError = "";
        try {
            const root = await getProjectRootHandleById(report.project.id);
            if (!root) {
                throw new Error("找不到專案根目錄，無法載入檔案內容");
            }
            const fileHandle = await fileSystemService.getFileHandleByPath(root, report.path);
            if (!fileHandle) {
                throw new Error("找不到對應的檔案");
            }
            const file = await fileHandle.getFile();
            const text = await file.text();
            state.sourceText = typeof text === "string" ? text : "";
            state.sourceLoaded = true;
            state.sourceError = "";
        } catch (error) {
            const record = await fetchStoredFileContent(report.project.id, report.path);
            if (record && typeof record.content === "string") {
                state.sourceText = record.content;
                state.sourceLoaded = true;
                state.sourceError = "";
            } else {
                state.sourceText = "";
                state.sourceLoaded = false;
                const baseMessage = error?.message ? String(error.message) : "無法載入檔案內容";
                state.sourceError = `${baseMessage}，且無法從資料庫讀取備份內容。`;
            }
        } finally {
            state.sourceLoading = false;
        }
    },
    { immediate: true }
);

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function shouldIgnoreMouseEvent(event) {
    return (
        event?.type === "mousedown" &&
        typeof window !== "undefined" &&
        "PointerEvent" in window
    );
}

function startPreviewResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = middlePaneWidth.value;
    const containerEl = mainContentRef.value;
    const workspaceEl = containerEl?.querySelector(".workSpace");
    if (!workspaceEl) return;

    const minWidth = 260;
    const workspaceMinWidth = 320;
    const workspaceRect = workspaceEl.getBoundingClientRect();
    const maxAdditional = Math.max(0, workspaceRect.width - workspaceMinWidth);
    const maxWidth = Math.max(minWidth, startWidth + maxAdditional);

    const handleMove = (pointerEvent) => {
        const delta = pointerEvent.clientX - startX;
        middlePaneWidth.value = clamp(startWidth + delta, minWidth, maxWidth);
    };

    const stop = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
}

function clampReportSidebarWidth() {
    const containerEl = mainContentRef.value;
    if (!containerEl) return;

    const navEl = containerEl.querySelector(".toolColumn");
    const availableWidth = containerEl.clientWidth - (navEl?.clientWidth ?? 0);
    if (availableWidth <= 0) return;

    const workspaceMinWidth = 320;
    const minRailWidthDefault = 260;
    const maxRailWidth = Math.max(0, availableWidth - workspaceMinWidth);

    if (maxRailWidth === 0) {
        middlePaneWidth.value = 0;
        return;
    }

    const minRailWidth = Math.min(minRailWidthDefault, maxRailWidth);
    middlePaneWidth.value = clamp(middlePaneWidth.value, minRailWidth, maxRailWidth);
}

async function handleAddActiveContext() {
    const added = await addActiveNode();
    if (added) {
        openChatWindow();
    }
}

function handleAddSelectionContext() {
    let snippet = buildSelectedSnippet();
    if (!snippet) {
        snippet = codeSelection.value ? { ...codeSelection.value } : null;
    }
    if (!snippet) {
        if (typeof safeAlertFail === "function") {
            safeAlertFail("請先在程式碼預覽中選取想加入的內容。");
        }
        return;
    }
    const added = addSnippetContext({ ...snippet });
    if (added) {
        openChatWindow();
        clearCodeSelection();
        if (typeof window !== "undefined") {
            const selection = window.getSelection?.();
            if (selection?.removeAllRanges) {
                selection.removeAllRanges();
            }
        }
    }
}

async function handleSendMessage(content) {
    const text = (content || "").trim();
    if (!text) return;
    openChatWindow();
    await sendUserMessage(text);
}

function openChatWindow() {
    if (!isChatWindowOpen.value) {
        isChatWindowOpen.value = true;
    }
}

function closeChatWindow() {
    if (isChatWindowOpen.value) {
        isChatWindowOpen.value = false;
        stopChatDrag();
        stopChatResize();
    }
}

function toggleChatWindow() {
    if (isChatWindowOpen.value) return;
    if (!isChatToggleDisabled.value) {
        openChatWindow();
    }
}

function ensureChatWindowInView() {
    const maxX = Math.max(0, window.innerWidth - chatWindowState.width);
    const maxY = Math.max(0, window.innerHeight - chatWindowState.height);
    chatWindowState.x = clamp(chatWindowState.x, 0, maxX);
    chatWindowState.y = clamp(chatWindowState.y, 0, maxY);
}

function startChatDrag(event) {
    if (shouldIgnoreMouseEvent(event)) return;
    if (event.button !== 0) return;
    event.preventDefault();
    chatDragState.active = true;
    chatDragState.offsetX = event.clientX - chatWindowState.x;
    chatDragState.offsetY = event.clientY - chatWindowState.y;
    window.addEventListener("pointermove", handleChatDrag);
    window.addEventListener("pointerup", stopChatDrag);
    window.addEventListener("pointercancel", stopChatDrag);
}

function handleChatDrag(event) {
    if (!chatDragState.active) return;
    event.preventDefault();
    const maxX = Math.max(0, window.innerWidth - chatWindowState.width);
    const maxY = Math.max(0, window.innerHeight - chatWindowState.height);
    chatWindowState.x = clamp(event.clientX - chatDragState.offsetX, 0, maxX);
    chatWindowState.y = clamp(event.clientY - chatDragState.offsetY, 0, maxY);
}

function stopChatDrag() {
    chatDragState.active = false;
    window.removeEventListener("pointermove", handleChatDrag);
    window.removeEventListener("pointerup", stopChatDrag);
    window.removeEventListener("pointercancel", stopChatDrag);
}

function startChatResize(payload) {
    const event = payload?.originalEvent ?? payload;
    const edges = payload?.edges ?? { right: true, bottom: true };
    if (!event || shouldIgnoreMouseEvent(event)) return;
    if (event.button !== 0) return;
    if (!edges.left && !edges.right && !edges.top && !edges.bottom) return;

    event.preventDefault();
    chatResizeState.active = true;
    chatResizeState.startX = event.clientX;
    chatResizeState.startY = event.clientY;
    chatResizeState.startWidth = chatWindowState.width;
    chatResizeState.startHeight = chatWindowState.height;
    chatResizeState.startLeft = chatWindowState.x;
    chatResizeState.startTop = chatWindowState.y;
    chatResizeState.edges.left = !!edges.left;
    chatResizeState.edges.right = !!edges.right;
    chatResizeState.edges.top = !!edges.top;
    chatResizeState.edges.bottom = !!edges.bottom;

    window.addEventListener("pointermove", handleChatResize);
    window.addEventListener("pointerup", stopChatResize);
    window.addEventListener("pointercancel", stopChatResize);
}

function handleChatResize(event) {
    if (!chatResizeState.active) return;
    event.preventDefault();
    const deltaX = event.clientX - chatResizeState.startX;
    const deltaY = event.clientY - chatResizeState.startY;
    const minWidth = 320;
    const minHeight = 320;

    if (chatResizeState.edges.left) {
        const proposedLeft = chatResizeState.startLeft + deltaX;
        const maxLeft = chatResizeState.startLeft + chatResizeState.startWidth - minWidth;
        const clampedLeft = clamp(proposedLeft, 0, Math.max(0, maxLeft));
        const widthFromLeft = chatResizeState.startWidth + (chatResizeState.startLeft - clampedLeft);
        const maxWidthFromViewport = Math.max(minWidth, window.innerWidth - clampedLeft);
        chatWindowState.x = clampedLeft;
        chatWindowState.width = clamp(widthFromLeft, minWidth, maxWidthFromViewport);
    }

    if (chatResizeState.edges.top) {
        const proposedTop = chatResizeState.startTop + deltaY;
        const maxTop = chatResizeState.startTop + chatResizeState.startHeight - minHeight;
        const clampedTop = clamp(proposedTop, 0, Math.max(0, maxTop));
        const heightFromTop = chatResizeState.startHeight + (chatResizeState.startTop - clampedTop);
        const maxHeightFromViewport = Math.max(minHeight, window.innerHeight - clampedTop);
        chatWindowState.y = clampedTop;
        chatWindowState.height = clamp(heightFromTop, minHeight, maxHeightFromViewport);
    }

    if (chatResizeState.edges.right) {
        const maxWidth = Math.max(minWidth, window.innerWidth - chatWindowState.x);
        chatWindowState.width = clamp(chatResizeState.startWidth + deltaX, minWidth, maxWidth);
    }

    if (chatResizeState.edges.bottom) {
        const maxHeight = Math.max(minHeight, window.innerHeight - chatWindowState.y);
        chatWindowState.height = clamp(chatResizeState.startHeight + deltaY, minHeight, maxHeight);
    }
}

function stopChatResize() {
    chatResizeState.active = false;
    chatResizeState.edges.left = false;
    chatResizeState.edges.right = false;
    chatResizeState.edges.top = false;
    chatResizeState.edges.bottom = false;
    window.removeEventListener("pointermove", handleChatResize);
    window.removeEventListener("pointerup", stopChatResize);
    window.removeEventListener("pointercancel", stopChatResize);
}

onMounted(async () => {
    await cleanupLegacyHandles();
    updateCapabilityFlags();
    await loadProjectsFromDB();
    clampReportSidebarWidth();
    window.addEventListener("resize", ensureChatWindowInView);
    window.addEventListener("resize", clampReportSidebarWidth);
    if (typeof document !== "undefined") {
        document.addEventListener("pointerdown", handleDocumentPointerDown, true);
        document.addEventListener("selectionchange", handleDocumentSelectionChange);
        document.addEventListener("mouseup", handleDocumentPointerUp);
    }
});

onBeforeUnmount(() => {
    window.removeEventListener("resize", ensureChatWindowInView);
    window.removeEventListener("resize", clampReportSidebarWidth);
    stopChatDrag();
    stopChatResize();
    if (pendingReportIssueJumpTimer) {
        clearTimeout(pendingReportIssueJumpTimer);
    }
    if (typeof document !== "undefined") {
        document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
        document.removeEventListener("selectionchange", handleDocumentSelectionChange);
        document.removeEventListener("mouseup", handleDocumentPointerUp);
    }
});
</script>



<template>
    <div class="page page--light">
        <div class="topBar">
            <div class="topBar_left">
                <h1 class="topBar_title">
                    <img :src="workspaceLogoSrc" alt="Workspace" class="topBar_logo" />
                </h1>
            </div>
            <div class="topBar_spacer"></div>
            <div class="topBar_right">
                <div class="topBar_addProject" @click="showUploadModal = true">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
                        <path
                            d="M256,0C114.6,0,0,114.6,0,256s114.6,256,256,256s256-114.6,256-256S397.4,0,256,0z M405.3,277.3c0,11.8-9.5,21.3-21.3,21.3h-85.3V384c0,11.8-9.5,21.3-21.3,21.3h-42.7c-11.8,0-21.3-9.6-21.3-21.3v-85.3H128c-11.8,0-21.3-9.6-21.3-21.3v-42.7c0-11.8,9.5-21.3,21.3-21.3h85.3V128c0-11.8,9.5-21.3,21.3-21.3h42.7c11.8,0,21.3,9.6,21.3,21.3v85.3H384c11.8,0,21.3,9.6,21.3,21.3V277.3z" />
                    </svg>
                    <p>新增專案</p>
                </div>
            </div>
        </div>

        <div class="mainContent themed-scrollbar" :class="{ 'mainContent--settings': isSettingsViewActive }"
            ref="mainContentRef">
            <nav class="toolColumn">
                <button type="button" class="toolColumn_btn" :class="{ active: isProjectToolActive }"
                    @click="toggleProjectTool" :aria-pressed="isProjectToolActive" title="專案列表">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="5" width="18" height="14" rx="2" ry="2" fill="currentColor" opacity="0.18" />
                        <path d="M5 7h5l1.5 2H19v8H5V7Z" fill="currentColor" />
                    </svg>
                </button>
                <button type="button" class="toolColumn_btn" :class="{ active: isPreviewToolActive }"
                    @click="togglePreviewTool" :aria-pressed="isPreviewToolActive" title="報告預覽">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"
                        stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="2.5" y="3.5" width="19" height="17" rx="2.5" ry="2.5" fill="currentColor"
                            opacity="0.18" />
                        <path
                            d="M6.5 4h7.5l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 19V5.5A1.5 1.5 0 0 1 6.5 4Z"
                            fill="none" />
                        <path d="M14 4v4h4" />
                        <path d="M8.5 12.5h7" />
                        <path d="M8.5 15h5.5" />
                    </svg>
                </button>
                <button type="button" class="toolColumn_btn" :class="{ active: isReportToolActive }"
                    @click="toggleReportTool" :aria-pressed="isReportToolActive" title="報告審查">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="9" fill="currentColor" opacity="0.18" />
                        <path
                            d="M14.8 13.4a4.5 4.5 0 1 0-1.4 1.4l3.5 3.5 1.4-1.4-3.5-3.5Zm-3.8.6a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z"
                            fill="currentColor" />
                    </svg>
                </button>
                <button type="button" class="toolColumn_btn toolColumn_btn--chat" :class="{ active: isChatWindowOpen }"
                    :disabled="isChatToggleDisabled" @click="toggleChatWindow" :aria-pressed="isChatWindowOpen"
                    title="Chat AI">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <!-- background stays the same size -->
                        <rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" opacity="0.12" />

                        <!-- scale the chat bubble up slightly around center (12,12) -->
                        <g transform="translate(12 12) scale(1.12) translate(-12 -12)">
                            <path
                                d="M8.5 8h7c.83 0 1.5.67 1.5 1.5v3c0 .83-.67 1.5-1.5 1.5h-.94l-1.8 1.88c-.31.33-.76.12-.76-.32V14.5h-3.5c-.83 0-1.5-.67-1.5-1.5v-3C7 8.67 7.67 8 8.5 8Z"
                                fill="currentColor" />
                        </g>
                    </svg>
                </button>
                <button type="button" class="toolColumn_btn toolColumn_btn--setting"
                    :class="{ active: isSettingsViewActive }" @click="toggleSettingsView"
                    :aria-pressed="isSettingsViewActive" title="Setting">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="0.5" y="0.5" width="23" height="23" rx="10" fill="currentColor" opacity="0.12" />
                        <g transform="translate(12 12) scale(0.04296875) translate(-256 -256)" fill="currentColor">
                            <path class="st0" d="M471.46,212.99l-42.07-7.92c-3.63-12.37-8.58-24.3-14.79-35.64l24.16-35.37c4.34-6.35,3.54-14.9-1.9-20.34
        l-38.58-38.58c-5.44-5.44-13.99-6.24-20.34-1.9L342.57,97.4c-11.34-6.21-23.27-11.16-35.64-14.78l-7.92-42.07
        c-1.42-7.56-8.03-13.04-15.72-13.04h-54.57c-7.69,0-14.3,5.48-15.72,13.04l-7.92,42.07c-12.37,3.63-24.3,8.58-35.64,14.78
        l-35.37-24.16c-6.35-4.34-14.9-3.54-20.34,1.9l-38.58,38.58c-5.44,5.44-6.24,13.98-1.9,20.34l24.16,35.37
        c-6.21,11.34-11.16,23.27-14.79,35.64l-42.07,7.92c-7.56,1.42-13.04,8.03-13.04,15.72v54.57c0,7.69,5.48,14.3,13.04,15.72
        l42.07,7.92c3.63,12.37,8.58,24.3,14.79,35.64l-24.16,35.37c-4.34,6.35-3.54,14.9,1.9,20.34l38.58,38.58
        c5.44,5.44,13.99,6.24,20.34,1.9l35.37-24.16c11.34,6.21,23.27,11.16,35.64,14.79l7.92,42.07c1.42,7.56,8.03,13.04,15.72,13.04
        h54.57c7.69,0,14.3-5.48,15.72-13.04l7.92-42.07c12.37-3.63,24.3-8.58,35.64-14.79l35.37,24.16c6.35,4.34,14.9,3.54,20.34-1.9
        l38.58-38.58c5.44-5.44,6.24-13.98,1.9-20.34l-24.16-35.37c6.21-11.34,11.16-23.27,14.79-35.64l42.07-7.92
        c7.56-1.42,13.04-8.03,13.04-15.72v-54.57C484.5,221.02,479.02,214.42,471.46,212.99z M452.5,270.01l-38.98,7.34
        c-6.25,1.18-11.21,5.94-12.63,12.14c-3.69,16.02-10,31.25-18.77,45.25c-3.37,5.39-3.24,12.26,0.35,17.51l22.39,32.78l-19.82,19.82
        l-32.78-22.39c-5.25-3.59-12.12-3.73-17.51-0.35c-14.01,8.77-29.24,15.08-45.25,18.77c-6.2,1.43-10.96,6.38-12.14,12.63
        l-7.34,38.98h-28.03l-7.34-38.98c-1.18-6.25-5.94-11.21-12.14-12.63c-16.02-3.69-31.24-10-45.25-18.77
        c-5.39-3.37-12.26-3.24-17.51,0.35l-32.78,22.39l-19.82-19.82l22.39-32.78c3.59-5.25,3.72-12.12,0.35-17.51
        c-8.77-14.01-15.08-29.24-18.77-45.25c-1.43-6.2-6.38-10.96-12.63-12.14l-38.98-7.34v-28.03l38.98-7.34
        c6.25-1.18,11.21-5.94,12.63-12.14c3.69-16.02,10-31.25,18.77-45.25c3.37-5.39,3.24-12.26-0.35-17.51l-22.39-32.78l19.82-19.82
        l32.78,22.39c5.25,3.58,12.12,3.72,17.51,0.35c14.01-8.77,29.24-15.08,45.25-18.77c6.2-1.43,10.96-6.38,12.14-12.63l7.34-38.98
        h28.03l7.34,38.98c1.18,6.25,5.94,11.21,12.14,12.63c16.02,3.69,31.24,10,45.25,18.77c5.39,3.37,12.26,3.24,17.51-0.35
        l32.78-22.39l19.82,19.82l-22.39,32.78c-3.59,5.25-3.72,12.12-0.35,17.51c8.77,14.01,15.08,29.24,18.77,45.25
        c1.43,6.2,6.38,10.96,12.63,12.14l38.98,7.34V270.01z" />
                            <path class="st0" d="M256,148.26c-59.41,0-107.74,48.33-107.74,107.74c0,59.41,48.33,107.74,107.74,107.74
        S363.74,315.41,363.74,256C363.74,196.59,315.41,148.26,256,148.26z M256,331.74c-41.76,0-75.74-33.98-75.74-75.74
        c0-41.76,33.98-75.74,75.74-75.74s75.74,33.98,75.74,75.74C331.74,297.76,297.76,331.74,256,331.74z" />
                        </g>
                    </svg>
                </button>
            </nav>
            <PanelRail v-if="!isSettingsViewActive" :style-width="middlePaneStyle" :mode="panelMode"
                :projects="projects" :selected-project-id="selectedProjectId" :on-select-project="handleSelectProject"
                :on-delete-project="deleteProject" :is-tree-collapsed="isTreeCollapsed"
                :is-report-tree-collapsed="isReportTreeCollapsed"
                :show-content="isProjectToolActive || isReportToolActive || isPreviewToolActive" :tree="tree"
                :active-tree-path="activeTreePath" :is-loading-tree="isLoadingTree" :open-node="openNode"
                :select-tree-node="selectTreeNode" :report-config="reportPanelConfig"
                :toggle-report-tree="toggleReportTreeCollapsed" @resize-start="startPreviewResize">
                <template v-if="isPreviewToolActive" #default>
                    <ProjectPreviewPanel :previews="projectPreviewEntries" :loading="isProjectPreviewLoading"
                        :compact="true" @select-issue="handlePreviewIssueSelect" />
                </template>
            </PanelRail>

            <section class="workSpace" :class="workSpaceClass">
                <template v-if="isSettingsViewActive">
                    <div class="settingsPanel">
                        <div class="settingsHeader">
                            <div>
                                <div class="panelHeader">設定</div>
                                <p class="settingsIntro">隱藏側邊欄後，集中調整規則引擎與 AI 審查模板。</p>
                            </div>
                            <div class="settingsLanguagePicker">
                                <label class="settingsLabel" for="settingsLanguage">設定語言</label>
                                <select id="settingsLanguage" v-model="settingLanguage">
                                    <option v-for="lang in availableSettingLanguages" :key="lang" :value="lang">
                                        {{ lang }}
                                    </option>
                                </select>
                            </div>
                            <button type="button" class="btn ghost settingsClose" @click="toggleSettingsView">
                                返回工作區
                            </button>
                        </div>

                        <div class="settingsContent">
                            <div class="settingsCard">
                                <div class="settingsActions">
                                    <p class="settingsStatus" v-if="ruleSettingsState.loading || aiReviewState.loading">
                                        設定載入中...
                                    </p>
                                    <p class="settingsStatus success"
                                        v-else-if="ruleSettingsState.message || aiReviewState.message">
                                        {{ ruleSettingsState.message || aiReviewState.message }}
                                    </p>
                                    <button type="button" class="btn outline" @click="addRuleRow"
                                        :disabled="ruleSettingsState.loading || ruleSettingsState.saving || aiReviewState.loading || aiReviewState.saving">
                                        新增規則
                                    </button>
                                    <button type="button" class="btn" @click="handleSaveRules"
                                        :disabled="ruleSettingsState.saving || ruleSettingsState.loading || aiReviewState.saving || aiReviewState.loading">
                                        {{ ruleSettingsState.saving ? "保存中..." : "保存設定" }}
                                    </button>
                                </div>

                                <div class="ruleGrid" role="table" aria-label="規則列表">
                                    <div class="ruleRow ruleRow--header" role="row">
                                        <div class="ruleCell" role="columnheader">規則 ID</div>
                                        <div class="ruleCell" role="columnheader">描述</div>
                                        <div class="ruleCell" role="columnheader">啟用</div>
                                        <div class="ruleCell" role="columnheader">風險指標</div>
                                        <div class="ruleCell" role="columnheader">操作</div>
                                    </div>
                                    <div v-for="(rule, index) in activeRuleSettings"
                                        :key="rule.localId || `rule-${index}`" class="ruleRow" role="row">
                                        <div class="ruleCell" role="cell">
                                            <input v-model="rule.ruleId" type="text" class="ruleInput"
                                                :aria-label="`規則 ${index + 1} ID`" placeholder="R-001" />
                                        </div>
                                        <div class="ruleCell" role="cell">
                                            <input v-model="rule.description" type="text" class="ruleInput"
                                                :aria-label="`規則 ${index + 1} 描述`"
                                                :placeholder="ruleDescriptionPlaceholder" />
                                        </div>
                                        <div class="ruleCell" role="cell">
                                            <label class="toggle">
                                                <input v-model="rule.enabled" type="checkbox" />
                                                <span>啟用</span>
                                            </label>
                                        </div>
                                        <div class="ruleCell" role="cell">
                                            <input v-model="rule.riskIndicator" type="text" class="ruleInput"
                                                :aria-label="`規則 ${index + 1} 風險指標`"
                                                :placeholder="riskIndicatorPlaceholder" />
                                        </div>
                                        <div class="ruleCell ruleCell--actions" role="cell">
                                            <button type="button" class="btn ghost" @click="removeRuleRow(index)"
                                                :disabled="ruleSettingsState.loading || ruleSettingsState.saving || aiReviewState.loading || aiReviewState.saving">
                                                刪除
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                <label class="settingsLabel" for="aiReviewContent">AI 審查程式碼區塊</label>
                                <div class="aiReviewPlaceholderPanel">
                                    <div class="aiReviewPlaceholderHeader">
                                        <p class="aiReviewPlaceholderTitle">可用占位符</p>
                                        <p class="aiReviewPlaceholderStatusText">{{ aiReviewPlaceholderStatusText }}
                                        </p>
                                    </div>
                                    <div v-for="group in aiReviewPlaceholderPanels" :key="group.key"
                                        class="aiReviewPlaceholderGroup">
                                        <p class="aiReviewPlaceholderGroupLabel">{{ group.label }}</p>
                                        <ul class="aiReviewPlaceholderList">
                                            <li v-for="placeholder in group.placeholders" :key="placeholder.key"
                                                class="aiReviewPlaceholderItem">
                                                <button type="button" class="aiReviewPlaceholderButton"
                                                    :class="{ used: placeholder.used }"
                                                    :disabled="placeholder.used || aiReviewState.loading || aiReviewState.saving"
                                                    :title="placeholder.used ? '此占位符已於模版中使用' : placeholder.description"
                                                    @click="insertAiReviewPlaceholder(placeholder.key)">
                                                    {{ formatAiReviewPlaceholder(placeholder.key) }}
                                                </button>
                                                <span class="aiReviewPlaceholderDescription">{{
                                                    placeholder.description }}</span>
                                                <span v-if="placeholder.used"
                                                    class="aiReviewPlaceholderHint">此占位符已於模版中使用</span>
                                            </li>
                                        </ul>
                                    </div>
                                </div>
                                <textarea id="aiReviewContent" v-model="activeAiReviewContent"
                                    class="aiReviewInput" ref="aiReviewInputRef" rows="8"
                                    :placeholder="aiReviewPlaceholder"
                                    :disabled="aiReviewState.loading || aiReviewState.saving"></textarea>
                            </div>

                            <div class="settingsCard">
                                <div class="settingsActions">
                                    <p class="settingsStatus" v-if="documentSettingState.loading">設定載入中...</p>
                                    <p class="settingsStatus success" v-else-if="documentSettingState.message">
                                        {{ documentSettingState.message }}
                                    </p>
                                    <button type="button" class="btn outline" @click="addDocumentRuleRow"
                                        :disabled="documentSettingState.loading || documentSettingState.saving">
                                        新增規則
                                    </button>
                                    <button type="button" class="btn" @click="handleSaveDocumentReviewSetting"
                                        :disabled="documentSettingState.saving || documentSettingState.loading">
                                        {{ documentSettingState.saving ? "保存中..." : "保存文件設定" }}
                                    </button>
                                </div>

                                <div class="ruleGrid" role="table" aria-label="文件規則列表">
                                    <div class="ruleRow ruleRow--header" role="row">
                                        <div class="ruleCell" role="columnheader">規則 ID</div>
                                        <div class="ruleCell" role="columnheader">描述</div>
                                        <div class="ruleCell" role="columnheader">啟用</div>
                                        <div class="ruleCell" role="columnheader">風險指標</div>
                                        <div class="ruleCell" role="columnheader">操作</div>
                                    </div>
                                    <div v-for="(check, index) in documentSettingState.checks"
                                        :key="check.localId || check.ruleId || `doc-check-${index}`"
                                        class="ruleRow" role="row">
                                        <div class="ruleCell" role="cell">
                                            <input v-model="check.ruleId" type="text" class="ruleInput"
                                                :aria-label="`文件規則 ${index + 1} ID`" placeholder="DOC-001" />
                                        </div>
                                        <div class="ruleCell" role="cell">
                                            <input v-model="check.description" type="text" class="ruleInput"
                                                :aria-label="`文件規則 ${index + 1} 描述`"
                                                :placeholder="ruleDescriptionPlaceholder" />
                                        </div>
                                        <div class="ruleCell" role="cell">
                                            <label class="toggle">
                                                <input v-model="check.enabled" type="checkbox" />
                                                <span>啟用</span>
                                            </label>
                                        </div>
                                        <div class="ruleCell" role="cell">
                                            <input v-model="check.riskIndicator" type="text" class="ruleInput"
                                                :aria-label="`文件規則 ${index + 1} 風險指標`"
                                                :placeholder="riskIndicatorPlaceholder" />
                                        </div>
                                        <div class="ruleCell ruleCell--actions" role="cell">
                                            <button type="button" class="btn ghost" @click="removeDocumentRuleRow(index)"
                                                :disabled="documentSettingState.loading || documentSettingState.saving">
                                                刪除
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                <label class="settingsLabel" for="documentPrompt">AI 提示範本</label>
                                <textarea id="documentPrompt" v-model="documentSettingState.promptTemplate"
                                    class="aiReviewInput" rows="6"
                                    placeholder="輸入要送給 Dify 的文件檢查提示" :disabled="documentSettingState.loading"></textarea>
                            </div>
                        </div>
                    </div>
                </template>
                <template v-else-if="isReportToolActive">
                    <div class="panelHeader">報告檢視</div>
                    <template v-if="hasReadyReports || viewerHasContent">
                        <div class="reportViewerContent"
                            :class="{ 'reportViewerContent--loading': isActiveReportProcessing }"
                            ref="reportViewerContentRef" :aria-busy="isActiveReportProcessing ? 'true' : 'false'">
                            <div v-if="isActiveReportProcessing"
                                class="reportViewerProcessingOverlay reportViewerLoading" role="status"
                                aria-live="polite">
                                <span class="reportViewerSpinner" aria-hidden="true"></span>
                                <p class="reportViewerProcessingText">正在透過 Dify 執行 AI審查，請稍候…</p>
                            </div>
                            <template v-if="activeReport">
                                <div class="reportViewerHeader">
                                    <h3 class="reportTitle">{{ activeReport.project.name }} / {{ activeReport.path }}
                                    </h3>
                                    <p class="reportViewerTimestamp">更新於 {{ activeReport.state.updatedAtDisplay || '-'
                                        }}</p>
                                </div>
                                <div v-if="activeReport.state.status === 'error'" class="reportErrorPanel">
                                    <p class="reportErrorText">生成失敗：{{ activeReport.state.error || '未知原因' }}</p>
                                    <p class="reportErrorHint">請檢查檔案權限、Dify 設定或稍後再試。</p>
                                </div>
                                <template v-else>
                                    <div v-if="hasStructuredReport" class="reportStructured">
                                        <div v-if="hasStructuredReportToggle" class="reportStructuredToggle"
                                            role="group" aria-label="報告來源">
                                            <div class="reportStructuredToggleButtons">
                                                <button type="button" class="reportStructuredToggleButton"
                                                    :class="{ active: structuredReportViewMode === 'combined' }"
                                                    :disabled="!canShowStructuredSummary"
                                                    @click="setStructuredReportViewMode('combined')">
                                                    總報告
                                                </button>
                                                <button type="button" class="reportStructuredToggleButton"
                                                    :class="{ active: structuredReportViewMode === 'static' }"
                                                    :disabled="!canShowStructuredStatic"
                                                    @click="setStructuredReportViewMode('static')">
                                                    靜態分析器
                                                </button>
                                                <button type="button" class="reportStructuredToggleButton"
                                                    :class="{ active: structuredReportViewMode === 'dml' }"
                                                    :disabled="!canShowStructuredDml"
                                                    @click="setStructuredReportViewMode('dml')">
                                                    AI審查
                                                </button>
                                            </div>
                                            <button v-if="shouldShowStructuredExportButton" type="button"
                                                class="reportExportButton reportStructuredToggleExport"
                                                :disabled="structuredReportExportConfig.busy"
                                                :aria-busy="structuredReportExportConfig.busy ? 'true' : 'false'"
                                                @click="exportCurrentStructuredReportJson">
                                                <span v-if="structuredReportExportConfig.busy">匯出中…</span>
                                                <span v-else>{{ structuredReportExportLabel }}</span>
                                            </button>
                                        </div>
                                        <section
                                            v-if="structuredReportViewMode === 'combined' && canShowStructuredSummary"
                                            class="reportSummaryGrid">
                                            <div class="reportSummaryCard reportSummaryCard--total">
                                                <span class="reportSummaryLabel">問題</span>
                                                <span class="reportSummaryValue">{{ activeReportTotalIssuesDisplay
                                                    }}</span>
                                            </div>
                                            <div v-if="activeReportSummaryText"
                                                class="reportSummaryCard reportSummaryCard--span">
                                                <span class="reportSummaryLabel">摘要</span>
                                                <p class="reportSummaryText">{{ activeReportSummaryText }}</p>
                                            </div>
                                            <div v-else-if="shouldShowNoIssueSummary"
                                                class="reportSummaryCard reportSummaryCard--span">
                                                <span class="reportSummaryLabel">摘要</span>
                                                <p class="reportSummaryText">未檢測到問題。</p>
                                            </div>
                                            <div v-if="ruleBreakdownItems.length" class="reportSummaryCard">
                                                <span class="reportSummaryLabel">規則分佈</span>
                                                <ul class="reportSummaryList">
                                                    <li v-for="item in ruleBreakdownItems"
                                                        :key="`${item.label}-${item.count}`">
                                                        <span class="reportSummaryItemLabel">{{ item.label }}</span>
                                                        <span class="reportSummaryItemValue">{{ item.count }}</span>
                                                    </li>
                                                </ul>
                                            </div>
                                            <div v-if="severityBreakdownItems.length" class="reportSummaryCard">
                                                <span class="reportSummaryLabel">嚴重度</span>
                                                <ul class="reportSummaryList">
                                                    <li v-for="item in severityBreakdownItems"
                                                        :key="`${item.label}-${item.count}`">
                                                        <span class="reportSummaryItemLabel">{{ item.label }}</span>
                                                        <span class="reportSummaryItemValue">{{ item.count }}</span>
                                                    </li>
                                                </ul>
                                            </div>
                                        </section>

                                        <section v-if="structuredReportViewMode === 'static' && hasStaticDetailContent"
                                            class="reportStaticSection">
                                            <div class="reportStaticHeader">
                                                <h4>靜態分析器</h4>
                                                <span v-if="staticEngineName" class="reportStaticEngine">
                                                    引擎：{{ staticEngineName }}
                                                </span>
                                                <span v-else-if="staticSourceName" class="reportStaticEngine">
                                                    來源：{{ staticSourceName }}
                                                </span>
                                            </div>
                                            <div v-if="staticSummaryDetailsItems.length" class="reportStaticBlock">
                                                <h5>摘要資訊</h5>
                                                <ul class="reportStaticList">
                                                    <li v-for="item in staticSummaryDetailsItems"
                                                        :key="`static-summary-${item.label}-${item.value}`">
                                                        <span class="reportStaticItemLabel">{{ item.label }}</span>
                                                        <span class="reportStaticItemValue">{{ item.value }}</span>
                                                    </li>
                                                </ul>
                                            </div>
                                            <div v-if="staticMetadataDetailsItems.length" class="reportStaticBlock">
                                                <h5>中繼資料</h5>
                                                <ul class="reportStaticList">
                                                    <li v-for="item in staticMetadataDetailsItems"
                                                        :key="`static-metadata-${item.label}-${item.value}`">
                                                        <span class="reportStaticItemLabel">{{ item.label }}</span>
                                                        <span class="reportStaticItemValue">{{ item.value }}</span>
                                                    </li>
                                                </ul>
                                            </div>
                                        </section>

                                        <section v-if="structuredReportViewMode === 'dml' && dmlReportDetails"
                                            class="reportDmlSection">
                                            <details class="reportDmlDetails" :open="isDmlReportExpanded"
                                                @toggle="handleToggleDmlSection">
                                                <summary class="reportDmlSummaryToggle">
                                                    <div class="reportDmlHeader">
                                                        <h4>區塊拆分</h4>
                                                        <span v-if="dmlReportDetails.status" class="reportDmlStatus">
                                                            {{ dmlReportDetails.status }}
                                                        </span>
                                                        <span v-if="dmlReportDetails.generatedAt"
                                                            class="reportDmlTimestamp">
                                                            產生於 {{ dmlReportDetails.generatedAt }}
                                                        </span>
                                                    </div>
                                                </summary>
                                                <div class="reportDmlContent">
                                                    <p v-if="dmlReportDetails.error" class="reportDmlError">
                                                        {{ dmlReportDetails.error }}
                                                    </p>
                                                    <div v-if="hasDmlSegments" class="reportDmlSegments">
                                                        <details v-for="segment in dmlSegments" :key="segment.key"
                                                            class="reportDmlSegment">
                                                            <summary>
                                                                第 {{ segment.index }} 段
                                                                <span v-if="segment.startLine">
                                                                    （第 {{ segment.startLine }} 行起
                                                                    <span v-if="segment.endLine">，至第 {{ segment.endLine
                                                                        }} 行止</span>
                                                                    ）
                                                                </span>
                                                            </summary>
                                                            <pre v-if="segment.text || segment.sql"
                                                                class="reportDmlSql codeScroll themed-scrollbar"
                                                                v-text="segment.text || segment.sql"></pre>
                                                            <pre v-if="segment.analysis"
                                                                class="reportDmlAnalysis codeScroll themed-scrollbar"
                                                                v-text="segment.analysis"></pre>
                                                        </details>
                                                    </div>
                                                    <p v-else class="reportDmlEmpty">尚未取得 AI審查拆分結果。</p>
                                                    <pre v-if="dmlReportDetails.reportText"
                                                        class="reportDmlSummary codeScroll themed-scrollbar"
                                                        v-text="dmlReportDetails.reportText"></pre>
                                                </div>
                                            </details>
                                        </section>
                                        <section v-if="structuredReportJsonPreview" class="reportJsonPreviewSection">
                                            <details class="reportJsonPreviewDetails">
                                                <summary class="reportJsonPreviewSummary">
                                                    {{ structuredReportJsonHeading }}
                                                </summary>
                                                <pre class="reportJsonPreview codeScroll themed-scrollbar"
                                                    v-text="structuredReportJsonPreview"></pre>
                                            </details>
                                        </section>
                                        <section v-if="shouldShowReportIssuesSection" class="reportIssuesSection">
                                            <div class="reportIssuesHeader">
                                                <div class="reportIssuesHeaderInfo">
                                                    <h4>問題清單</h4>
                                                    <span class="reportIssuesTotal">
                                                        <template v-if="activeReportIssueCount !== null">
                                                            共 {{ activeReportIssueCount }} 項
                                                        </template>
                                                        <template v-else>—</template>
                                                    </span>
                                                </div>
                                            </div>
                                            <div class="reportIssuesContent" ref="reportIssuesContentRef">
                                                <template v-if="activeReportDetails">
                                                    <div v-if="activeReport.state.sourceLoading"
                                                        class="reportIssuesNotice">
                                                        正在載入原始碼…
                                                    </div>
                                                    <div v-else-if="activeReport.state.sourceError"
                                                        class="reportIssuesNotice reportIssuesNotice--error">
                                                        無法載入檔案內容：{{ activeReport.state.sourceError }}
                                                    </div>
                                                    <template v-else>
                                                        <div v-if="shouldShowAiUnavailableNotice"
                                                            class="reportIssuesNotice reportIssuesNotice--warning">
                                                            {{ reportAiUnavailableNotice }}
                                                        </div>
                                                        <div v-if="hasReportIssueLines"
                                                            class="reportRow reportIssuesRow">
                                                            <div class="reportRowContent codeScroll themed-scrollbar">
                                                                <div class="codeEditor">
                                                                    <div v-for="line in reportIssueLines"
                                                                        :key="line.key" class="codeLine"
                                                                        :data-line="line.number != null ? line.number : undefined"
                                                                        :class="{
                                                                            'codeLine--issue': line.type === 'code' && line.hasIssue,
                                                                            'codeLine--meta': line.type !== 'code',
                                                                            'codeLine--issuesMeta': line.type === 'issues',
                                                                            'codeLine--fixMeta': line.type === 'fix'
                                                                        }">
                                                                        <span class="codeLineNo" :class="{
                                                                            'codeLineNo--issue': line.type === 'code' && line.hasIssue,
                                                                            'codeLineNo--meta': line.type !== 'code',
                                                                            'codeLineNo--issues': line.type === 'issues',
                                                                            'codeLineNo--fix': line.type === 'fix'
                                                                        }" :data-line="line.number != null ? line.displayNumber : ''"
                                                                            :aria-label="line.type !== 'code' ? line.iconLabel : null"
                                                                            :aria-hidden="line.type === 'code'">
                                                                            <svg v-if="line.type === 'issues'"
                                                                                class="codeLineNoIcon codeLineNoIcon--warning"
                                                                                viewBox="0 0 20 20" focusable="false"
                                                                                aria-hidden="true">
                                                                                <path
                                                                                    d="M10.447 2.105a1 1 0 00-1.894 0l-7 14A1 1 0 002.447 18h15.106a1 1 0 00.894-1.447l-7-14zM10 6a1 1 0 01.993.883L11 7v4a1 1 0 01-1.993.117L9 11V7a1 1 0 011-1zm0 8a1 1 0 110 2 1 1 0 010-2z" />
                                                                            </svg>
                                                                            <svg v-else-if="line.type === 'fix'"
                                                                                class="codeLineNoIcon codeLineNoIcon--fix"
                                                                                viewBox="0 0 20 20" focusable="false"
                                                                                aria-hidden="true">
                                                                                <path
                                                                                    d="M17.898 2.102a1 1 0 00-1.517.127l-2.156 2.873-1.21-.403a1 1 0 00-1.043.24l-4.95 4.95a1 1 0 000 1.414l1.775 1.775-5.189 5.189a1 1 0 001.414 1.414l5.189-5.189 1.775 1.775a1 1 0 001.414 0l4.95-4.95a1 1 0 00.24-1.043l-.403-1.21 2.873-2.156a1 1 0 00.127-1.517l-.489-.489z" />
                                                                            </svg>
                                                                        </span>
                                                                        <span class="codeLineContent" :class="{
                                                                            'codeLineContent--issueHighlight': line.type === 'code' && line.hasIssue,
                                                                            'codeLineContent--issues': line.type === 'issues',
                                                                            'codeLineContent--fix': line.type === 'fix'
                                                                        }" v-html="line.html"></span>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <p v-else class="reportIssuesEmpty">尚未能載入完整的代碼內容。</p>
                                                    </template>
                                                </template>
                                                <p v-else class="reportIssuesEmpty">尚未能載入完整的代碼內容。</p>
                                            </div>
                                        </section>
                                        <section v-else class="reportIssuesSection reportIssuesSection--empty">
                                            <p class="reportIssuesEmpty">未檢測到任何問題。</p>
                                        </section>

                                    </div>
                                    <pre v-else
                                        class="reportBody codeScroll themed-scrollbar">{{ activeReport.state.report }}</pre>
                                    <details v-if="shouldShowDmlChunkDetails" class="reportChunks">
                                        <summary>AI 審查段落（{{ dmlChunkDetails.length }}）</summary>
                                        <ol class="reportChunkList reportChunkList--issues">
                                            <li v-for="chunk in dmlChunkDetails"
                                                :key="`chunk-${chunk.index}-${chunk.total}`">
                                                <h4 class="reportChunkTitle">第 {{ chunk.index }} 段</h4>
                                                <template v-if="chunk.issues.length">
                                                    <ul class="reportChunkIssues">
                                                        <li v-for="(issue, issueIndex) in chunk.issues"
                                                            :key="`chunk-${chunk.index}-issue-${issueIndex}`"
                                                            class="reportChunkIssue">
                                                            <p class="reportChunkIssueMessage">{{ issue.message }}</p>
                                                            <p v-if="issue.rule" class="reportChunkIssueMeta">規則：{{
                                                                issue.rule }}</p>
                                                            <p v-if="issue.severity" class="reportChunkIssueMeta">
                                                                嚴重度：{{ issue.severity }}
                                                            </p>
                                                            <p v-if="describeIssueLineRange(issue)"
                                                                class="reportChunkIssueMeta">
                                                                行數：第 {{ describeIssueLineRange(issue) }} 行
                                                            </p>
                                                            <p v-if="issue.context" class="reportChunkIssueContext">
                                                                {{ issue.context }}
                                                            </p>
                                                        </li>
                                                    </ul>
                                                </template>
                                                <p v-else class="reportChunkEmpty">未檢測到任何問題。</p>
                                            </li>
                                        </ol>
                                    </details>
                                </template>
                            </template>
                            <template v-else>
                                <div class="reportViewerPlaceholder">請從左側選擇檔案報告。</div>
                            </template>
                        </div>
                    </template>
                    <p v-else class="reportViewerPlaceholder">尚未生成任何報告，請先於左側檔案中啟動生成。</p>
                </template>
                <template v-else-if="isPreviewToolActive">
                    <ProjectPreviewPanel :previews="projectPreviewEntries" :loading="isProjectPreviewLoading"
                        :show-summary="true" @select-issue="handlePreviewIssueSelect" />
                </template>
                <template v-else-if="previewing.kind && previewing.kind !== 'error'">
                    <div class="pvHeader">
                        <div class="pvName">{{ previewing.name }}</div>
                        <div class="pvMeta">{{ previewing.mime || '-' }} | {{ (previewing.size / 1024).toFixed(1) }} KB
                        </div>
                    </div>

                    <template v-if="previewing.kind === 'text'">
                        <div class="pvBox codeBox">
                            <div class="codeScroll themed-scrollbar"
                                :class="{ 'codeScroll--wrapped': !showCodeLineNumbers }" ref="codeScrollRef"
                                @pointerdown="handleCodeScrollPointerDown">
                                <div class="codeEditor">
                                    <div v-for="line in previewLineItems" :key="line.number" class="codeLine"
                                        :data-line="line.number">
                                        <span class="codeLineNo" :data-line="line.number" aria-hidden="true"></span>
                                        <span class="codeLineContent" v-html="renderLineContent(line)"></span>
                                    </div>
                                </div>
                            </div>
                        </div>

                    </template>

                    <div v-else-if="previewing.kind === 'image'" class="pvBox imgBox">
                        <img :src="previewing.url" :alt="previewing.name" />
                    </div>

                    <div v-else-if="previewing.kind === 'pdf'" class="pvBox pdfBox">
                        <iframe :src="previewing.url" title="PDF Preview"
                            style="width:100%;height:100%;border:none;"></iframe>
                    </div>

                    <div v-else class="pvBox">
                        <a class="btn" :href="previewing.url" download>Download file</a>
                        <a class="btn outline" :href="previewing.url" target="_blank">Open in new window</a>
                    </div>
                </template>

                <template v-else-if="previewing.kind === 'error'">
                    <div class="pvError">
                        Cannot preview: {{ previewing.error }}
                    </div>
                </template>

                <template v-else>
                    <div class="pvPlaceholder">請選擇檔案以在此預覽。</div>
                </template>
            </section>
        </div>

        <Teleport to="body">
            <ChatAiWindow :visible="isChatWindowOpen && !isSettingsViewActive" :floating-style="chatWindowStyle"
                :context-items="contextItems" :messages="messages" :loading="isProcessing" :disabled="isChatLocked"
                :connection="connection" @add-active="handleAddActiveContext" @add-selection="handleAddSelectionContext"
                @clear-context="clearContext" @remove-context="removeContext" @send-message="handleSendMessage"
                @close="closeChatWindow" @drag-start="startChatDrag" @resize-start="startChatResize" />
        </Teleport>

        <div v-if="showUploadModal" class="modalBackdrop" @click.self="showUploadModal = false">
            <div class="modalCard">
                <h3>Import Project Folder</h3>
                <p>Drag a folder here or use the buttons below to import a project. External directories and OPFS are
                    supported.
                </p>

                <div class="dropZone" @drop="handleDrop" @dragover="handleDragOver">Drop a folder here to import</div>

                <div class="modalBtns">
                    <button class="btn" v-if="supportsFS" @click="pickFolderAndImport">Select folder</button>
                    <label class="btn outline" v-else>Fallback import<input type="file" webkitdirectory directory
                            multiple style="display:none" @change="handleFolderInput"></label>
                    <button class="btn ghost" @click="showUploadModal = false">Cancel</button>
                </div>
                <p class="hint" v-if="!supportsFS">Your browser does not support showDirectoryPicker. Use the fallback
                    input
                    instead.</p>
            </div>
        </div>
    </div>
</template>
<style>
/* 讓 100% 有依據 */
html,
body,
#app {
    height: 100%;
    margin: 0;
    font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #e5e7eb;
}

.page {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background-color: #1e1e1e;
    overflow: hidden;
}

/* 頂欄 */
.topBar {
    box-sizing: border-box;
    height: 60px;
    padding: 0 16px;
    background: linear-gradient(90deg, #2c2c2c, #252526);
    border-bottom: 1px solid #3d3d3d;
    display: flex;
    align-items: center;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
}

.topBar_left {
    display: flex;
    align-items: center;
    gap: 12px;
}

.topBar_title {
    margin: 0;
    padding: 0;
    font-size: 0;
    line-height: 1;
}

.topBar_logo {
    display: block;
    height: 36px;
    width: auto;
    object-fit: contain;
}

.topBar_spacer {
    flex: 1 1 auto;
}

.topBar_right {
    display: flex;
    align-items: center;
    gap: 12px;
}

.topBar_iconBtn {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    border: 1px solid #3d3d3d;
    background: #2b2b2b;
    color: #cbd5f5;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.2s ease, transform 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.topBar_iconBtn svg {
    width: 20px;
    height: 20px;
}

.topBar_iconBtn:hover:not(:disabled) {
    background: #343434;
    border-color: #4b5563;
    color: #e0f2fe;
    transform: translateY(-1px);
}

.topBar_iconBtn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.topBar_iconBtn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.3), rgba(14, 165, 233, 0.3));
    border-color: rgba(14, 165, 233, 0.6);
    color: #e0f2fe;
}

.topBar_addProject {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    border-radius: 6px;
    background-color: #007acc;
    transition: all 0.25s ease;
}

.topBar_addProject p {
    margin: 0;
    color: white;
    font-weight: 600;
    font-size: 15px;
}

.topBar_addProject svg {
    height: 20px;
    fill: white;
    transition: transform 0.25s ease, fill 0.25s ease;
}

.topBar_addProject:hover {
    background-color: #0288d1;
    transform: translateY(-2px) scale(1.03);
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.topBar_addProject:active {
    transform: scale(0.96);
}


.mainContent {
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    align-items: stretch;
    flex: 1 1 auto;
    min-height: 0;
    background-color: #1e1e1e;
    padding: 0;
    width: 100%;
    box-sizing: border-box;
    column-gap: 0;
    row-gap: 0;
    height: calc(100vh - 60px);
    max-height: calc(100vh - 60px);
    overflow: hidden;
}

.workSpace {
    flex: 1 1 480px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
    min-width: 0;
    background: #191919;
    border: 1px solid #323232;
    border-radius: 0;
    padding: 16px;
    box-sizing: border-box;
    height: 100%;
    max-height: 100%;
    overflow-y: auto;
}

.workSpace--reports {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
}

.workSpace--settings {
    background: #f5f7fb;
    border-color: #d7deea;
}

.settingsPanel {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.settingsHeader {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 12px;
    align-items: center;
}

.settingsIntro {
    margin: 6px 0 0;
    color: #52616b;
    font-size: 13px;
}

.settingsLanguagePicker {
    display: flex;
    align-items: center;
    gap: 8px;
}

.settingsLabel {
    color: #1f2937;
    font-size: 13px;
    font-weight: 600;
}

.settingsLanguagePicker select {
    background: #f8fafc;
    color: #1f2937;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    padding: 8px 10px;
    min-width: 120px;
}

.settingsClose {
    justify-self: end;
}

.settingsContent {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.settingsCard {
    background: #ffffff;
    border: 1px solid #d7deea;
    border-radius: 12px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 8px 16px rgba(15, 23, 42, 0.06);
}

.settingsActions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
}

.settingsStatus {
    margin-right: auto;
    color: #52616b;
    font-size: 13px;
}

.settingsStatus.success {
    color: #15803d;
}

.ruleGrid {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.ruleRow {
    display: grid;
    grid-template-columns: 1.1fr 2fr 0.9fr 1.2fr 0.8fr;
    gap: 10px;
    align-items: center;
    padding-bottom: 6px;
    border-bottom: 1px solid #e2e8f0;
}

.ruleRow:last-of-type {
    border-bottom: none;
}

.ruleRow--header {
    font-weight: 600;
    color: #1f2937;
    border-bottom-color: #cbd5e1;
}

.ruleCell {
    display: flex;
    align-items: center;
}

.ruleCell--actions {
    justify-content: flex-end;
}

.ruleInput,
.aiReviewInput,
.settingsLanguagePicker select,
.ruleCell input[type="text"],
.settingsCard textarea {
    font: inherit;
}

.ruleInput,
.aiReviewInput {
    width: 100%;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid #cbd5e1;
    background: #f8fafc;
    color: #0f172a;
    box-sizing: border-box;
}

.aiReviewPlaceholderPanel {
    margin: 6px 0 12px;
    padding: 12px;
    border-radius: 12px;
    border: 1px solid #d7deea;
    background: #f9fbff;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.documentChecks {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 12px 0;
}

.documentChecksTitle {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
}

.documentChecksHint {
    margin: 0 0 4px;
    color: var(--panel-muted);
    font-size: 12px;
}

.documentCheckRow {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px;
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    background: var(--panel-surface);
}

.documentCheckFields {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.aiReviewPlaceholderHeader {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

.aiReviewPlaceholderTitle {
    margin: 0;
    color: #0f172a;
    font-weight: 700;
}

.aiReviewPlaceholderStatusText {
    margin: 0;
    color: #52616b;
    font-size: 12px;
}

.aiReviewPlaceholderGroup {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.aiReviewPlaceholderGroupLabel {
    margin: 0;
    font-weight: 600;
    color: #1f2937;
    font-size: 13px;
}

.aiReviewPlaceholderList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.aiReviewPlaceholderItem {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.aiReviewPlaceholderButton {
    border: 1px dashed #cbd5e1;
    background: #ffffff;
    color: #0f172a;
    border-radius: 8px;
    padding: 6px 10px;
    cursor: pointer;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 13px;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
    box-shadow: 0 1px 2px rgba(17, 24, 39, 0.08);
}

.aiReviewPlaceholderButton:hover:not(:disabled) {
    background: #eef2fb;
    border-color: #93c5fd;
    color: #0f172a;
}

.aiReviewPlaceholderButton.used,
.aiReviewPlaceholderButton:disabled {
    border-color: #e2e8f0;
    color: #94a3b8;
    background: #f8fafc;
    cursor: not-allowed;
}

.aiReviewPlaceholderDescription {
    color: #52616b;
    font-size: 12px;
}

.aiReviewPlaceholderHint {
    color: #b45309;
    font-size: 12px;
}

.aiReviewInput {
    min-height: 160px;
    resize: vertical;
}

.toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #1f2937;
}

.mainContent--settings {
    column-gap: 0px;
}

.toolColumn {
    flex: 0 0 64px;
    width: 64px;
    background: #252526;
    border-right: 1px solid #323232;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 16px 10px;
    box-sizing: border-box;
    max-height: 100%;
    overflow-y: auto;
    scrollbar-width: none;
}

.toolColumn::-webkit-scrollbar {
    display: none;
}

.toolColumn_btn {
    width: 44px;
    height: 44px;
    border: 1px solid #3d3d3d;
    background: #262626;
    color: #cbd5f5;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
    padding: 0;
}

.toolColumn_btn svg {
    width: 33px;
    height: 33px;
}

.toolColumn_btn--chat {
    margin-top: auto;
}

.toolColumn_btn--setting {
    margin-top: 4px;
}

.toolColumn_btn:hover {
    background: #2f2f2f;
    border-color: #4b5563;
    color: #e0f2fe;
    transform: translateY(-1px);
}

.toolColumn_btn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(14, 165, 233, 0.25));
    border-color: rgba(14, 165, 233, 0.6);
    color: #e0f2fe;
}

.toolColumn_btn:focus-visible {
    outline: 2px solid #60a5fa;
    outline-offset: 2px;
}

.mainContent>* {
    min-height: 0;
    min-width: 0;
}

@media (max-width: 900px) {
    .mainContent {
        flex-direction: column;
    }

    .toolColumn {
        flex-direction: row;
        width: 100%;
        flex: 0 0 auto;
        border-right: none;
        border-bottom: 1px solid #323232;
        justify-content: flex-start;
    }

    .toolColumn_btn {
        transform: none;
    }

    .toolColumn_btn--chat {
        margin-top: 0;
        margin-left: auto;
    }

    .settingsHeader {
        grid-template-columns: 1fr;
        align-items: flex-start;
    }

    .settingsClose {
        justify-self: start;
    }

    .ruleRow {
        grid-template-columns: 1fr;
    }

    .ruleCell--actions {
        justify-content: flex-start;
    }

    .workSpace {
        width: 100%;
        flex: 1 1 auto;
    }
}

.panelHeader {
    font-weight: 700;
    color: #cbd5e1;
    font-size: 14px;
}

.reportViewerContent {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    background: #191919;
    border: 1px solid #323232;
    border-radius: 0;
    padding: 16px;
    box-sizing: border-box;
    min-width: 0;
    position: relative;
    overflow-y: auto;
    overflow-x: hidden;
}

.reportViewerContent--loading> :not(.reportViewerProcessingOverlay) {
    filter: blur(1px);
    pointer-events: none;
}

.reportViewerProcessingOverlay {
    position: absolute;
    inset: 0;
    background: rgba(15, 23, 42, 0.78);
    backdrop-filter: blur(2px);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 32px 16px;
    z-index: 10;
    pointer-events: all;
}

.reportViewerProcessingOverlay .reportViewerSpinner {
    width: 48px;
    height: 48px;
}

.reportViewerProcessingText {
    margin: 0;
    font-size: 14px;
    color: #cbd5f5;
}

.reportViewerLoading {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 40px 16px;
    text-align: center;
    color: #e2e8f0;
}

.reportViewerSpinner {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 3px solid rgba(148, 163, 184, 0.35);
    border-top-color: #60a5fa;
    animation: reportViewerSpin 1s linear infinite;
}

.reportViewerLoadingText {
    margin: 0;
    font-size: 14px;
    color: #cbd5f5;
}

@keyframes reportViewerSpin {
    0% {
        transform: rotate(0deg);
    }

    100% {
        transform: rotate(360deg);
    }
}

.reportViewerHeader {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.reportTitle {
    margin: 0;
    font-size: 18px;
    color: #f9fafb;
}

.reportViewerTimestamp {
    margin: 0;
    font-size: 12px;
    color: #a5b4fc;
}

.reportBody {
    flex: 1 1 auto;
    margin: 0;
    padding: 16px;
    border-radius: 6px;
    background: #1b1b1b;
    border: 1px solid #2f2f2f;
    color: #d1d5db;
    font-family: Consolas, "Courier New", monospace;
    font-size: 13px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
}

.reportStructured {
    display: flex;
    flex-direction: column;
    gap: 20px;
    flex: 1 1 auto;
    min-height: 0;
}

.reportStructured>* {
    align-self: stretch;
}

.reportStructuredPrimary {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-height: 0;
}

.reportStructuredSecondary {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-height: 0;
}

.reportStructuredToggle {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    justify-content: space-between;
}

.reportStructuredToggleButtons {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 8px;
}

.reportStructuredToggleButton {
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 4px;
    background: rgba(148, 163, 184, 0.14);
    color: #e2e8f0;
    font-size: 12px;
    padding: 4px 10px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.reportStructuredToggleButton.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.28), rgba(14, 165, 233, 0.28));
    border-color: rgba(59, 130, 246, 0.5);
    color: #f8fafc;
}

.reportStructuredToggleButton:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.reportStructuredToggleExport {
    margin-left: auto;
}

.reportJsonPreviewSection {
    margin-top: 12px;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    flex: 0 0 auto;
    min-height: auto;
}

.reportJsonPreviewDetails {
    border: 1px solid #334155;
    border-radius: 6px;
    background: rgba(15, 23, 42, 0.65);
    overflow: hidden;
    max-width: 100%;
}

.reportJsonPreviewSummary {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 10px 12px;
    font-size: 13px;
    font-weight: 600;
    color: #bfdbfe;
    list-style: none;
    cursor: pointer;
}

.reportJsonPreviewSummary::-webkit-details-marker {
    display: none;
}

.reportJsonPreviewDetails[open] .reportJsonPreviewSummary {
    border-bottom: 1px solid rgba(59, 130, 246, 0.35);
}

.reportJsonPreviewDetails:not([open]) .reportJsonPreviewSummary::after,
.reportJsonPreviewDetails[open] .reportJsonPreviewSummary::after {
    content: "";
    width: 8px;
    height: 8px;
    border: 1px solid currentColor;
    border-left: 0;
    border-top: 0;
    transform: rotate(45deg);
    margin-left: auto;
    transition: transform 0.2s ease;
}

.reportJsonPreviewDetails[open] .reportJsonPreviewSummary::after {
    transform: rotate(225deg);
}

.reportJsonPreview {
    margin: 0;
    padding: 12px;
    border-top: 1px solid rgba(59, 130, 246, 0.35);
    background: rgba(15, 23, 42, 0.45);
    color: #e2e8f0;
    font-size: 12px;
    max-width: 100%;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
}

.reportExportButton {
    border: 1px solid #3d3d3d;
    background: #1f2937;
    color: #cbd5f5;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.2;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease, transform 0.2s ease;
}

.reportExportButton:hover:not(:disabled) {
    background: #374151;
    border-color: #60a5fa;
    color: #e0f2fe;
    transform: translateY(-1px);
}

.reportExportButton:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.reportExportButton:focus-visible {
    outline: 2px solid #60a5fa;
    outline-offset: 2px;
}

.reportSummaryGrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    width: 100%;
    flex: 0 0 auto;
    min-height: auto;
}

.reportSummaryCard {
    border: 1px solid #2f2f2f;
    background: #1f1f1f;
    border-radius: 6px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    word-break: break-word;
}

.reportSummaryCard--total {
    background: #1f1f1f;
    border-color: #2f2f2f;
}

.reportSummaryCard--span {
    grid-column: 1 / -1;
}

@media (max-width: 720px) {
    .reportSummaryCard--span {
        grid-column: span 1;
    }
}

.reportSummaryLabel {
    font-size: 12px;
    font-weight: 600;
    color: #cbd5f5;
    letter-spacing: 0.04em;
    text-transform: uppercase;
}

.reportSummaryValue {
    font-size: 28px;
    font-weight: 700;
    color: #f8fafc;
    line-height: 1;
}

.reportSummaryText {
    margin: 0;
    font-size: 13px;
    color: #e2e8f0;
    line-height: 1.5;
}

.reportSummaryList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: #e2e8f0;
}

.reportSummaryItemLabel {
    font-weight: 600;
    margin-right: 6px;
}

.reportSummaryItemValue {
    color: #cbd5f5;
}

.reportStaticSection {
    margin-top: 24px;
    padding: 16px;
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 8px;
    background: rgba(30, 41, 59, 0.32);
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reportStaticHeader {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
}

.reportStaticHeader h4 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: #f8fafc;
}

.reportStaticEngine {
    font-size: 12px;
    color: #94a3b8;
}

.reportStaticBlock {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.reportStaticBlock h5 {
    margin: 0;
    font-size: 13px;
    color: #cbd5f5;
    text-transform: none;
    letter-spacing: 0.02em;
}

.reportStaticList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: #e2e8f0;
}

.reportStaticItemLabel {
    font-weight: 600;
    margin-right: 6px;
    color: #cbd5f5;
}

.reportStaticItemValue {
    color: #cbd5f5;
}


.reportDmlSection {
    margin-top: 24px;
}

.reportDmlDetails {
    border: 1px solid #334155;
    border-radius: 6px;
    background: rgba(15, 23, 42, 0.65);
    color: #e2e8f0;
    overflow: hidden;
}

.reportDmlSummaryToggle {
    display: flex;
    align-items: center;
    cursor: pointer;
    gap: 6px;
    list-style: none;
    margin: 0;
    padding: 10px 12px;
    box-sizing: border-box;
    transition: background 0.2s ease, color 0.2s ease;
    color: #bfdbfe;
    font-size: 13px;
    font-weight: 600;
    border-radius: 6px;
    background: transparent;
}

.reportDmlSummaryToggle::-webkit-details-marker {
    display: none;
}

.reportDmlSummaryToggle::after {
    content: "";
    width: 8px;
    height: 8px;
    border: 1px solid currentColor;
    border-left: 0;
    border-top: 0;
    transform: rotate(45deg);
    margin-left: auto;
    transition: transform 0.2s ease;
}

.reportDmlDetails[open] .reportDmlSummaryToggle::after {
    transform: rotate(225deg);
}

.reportDmlDetails:not([open]) .reportDmlSummaryToggle:hover {
    color: #e2e8f0;
}

.reportDmlDetails[open] .reportDmlSummaryToggle:hover {
    background: rgba(148, 163, 184, 0.18);
}

.reportDmlDetails[open] .reportDmlSummaryToggle {
    border-bottom: 1px solid rgba(59, 130, 246, 0.35);
    border-radius: 6px 6px 0 0;
}

.reportDmlContent {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
}

.reportDmlHeader {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
}

.reportDmlHeader h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: inherit;
}

.reportDmlStatus {
    font-size: 12px;
    font-weight: 600;
    color: #22d3ee;
    text-transform: uppercase;
}

.reportDmlTimestamp {
    font-size: 12px;
    color: #94a3b8;
}

.reportDmlError {
    margin: 0;
    color: #f87171;
    font-size: 13px;
}

.reportDmlSegments {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.reportDmlSegment {
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 6px;
    background: rgba(15, 23, 42, 0.35);
}

.reportDmlSegment summary {
    cursor: pointer;
    padding: 8px 12px;
    font-weight: 600;
    color: #e2e8f0;
}

.reportDmlSegment pre {
    margin: 0;
    padding: 12px;
    font-size: 13px;
}

.reportDmlSql {
    background: rgba(15, 23, 42, 0.55);
    color: #e0f2fe;
}

.reportDmlAnalysis {
    background: rgba(8, 47, 73, 0.55);
    color: #fef9c3;
}

.reportDmlSummary {
    margin: 0;
    font-size: 13px;
    background: rgba(15, 23, 42, 0.65);
    color: #cbd5f5;
    border-radius: 6px;
    padding: 12px;
}

.reportDmlEmpty {
    margin: 0;
    font-size: 13px;
    color: #94a3b8;
}


.reportIssuesSection {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 1 1 auto;
    min-height: 0;
    align-self: stretch;
}

.reportIssuesSection--empty {
    padding-top: 12px;
    flex: 0 0 auto;
}


.reportIssuesHeader {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

.reportIssuesHeaderInfo {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
}

.reportIssuesContent {
    flex: 0 0 auto;
    min-height: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    border: 1px solid rgba(148, 163, 184, 0.28);
    border-radius: 8px;
    padding: 12px 12px 0;
    background: rgba(15, 23, 42, 0.02);
    overflow: auto;
}

.reportIssuesHeader h4 {
    margin: 0;
    font-size: 16px;
    color: #0b1120;
}

.reportIssuesTotal {
    font-size: 12px;
    color: #94a3b8;
}

.reportIssuesNotice {
    padding: 10px 14px;
    border-radius: 6px;
    background: rgba(148, 163, 184, 0.12);
    color: #e2e8f0;
    font-size: 13px;
}

.reportIssuesNotice--error {
    background: rgba(248, 113, 113, 0.12);
    color: #fda4af;
}

.reportIssuesNotice--warning {
    background: rgba(250, 204, 21, 0.12);
    color: #facc15;
}

.reportRow {
    flex: 0 0 auto;
    min-height: auto;
    border-radius: 6px;
    background: #1b1b1b;
    display: flex;
    flex-direction: column;
    overflow: visible;
}

.reportRowActions {
    display: flex;
    justify-content: flex-end;
    padding: 12px 16px 0;
    gap: 8px;
}

.reportRowActionButton {
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 4px;
    background: rgba(148, 163, 184, 0.14);
    color: #e2e8f0;
    font-size: 12px;
    padding: 4px 12px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.reportRowActionButton:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.2);
    border-color: rgba(59, 130, 246, 0.5);
    color: #f8fafc;
}

.reportRowActionButton:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.reportRowContent {
    flex: 1 1 auto;
    margin: 0;
    padding: 16px;
    font-family: Consolas, "Courier New", monospace;
    font-size: 13px;
    line-height: 1.45;
    color: #e2e8f0;
    background: transparent;
    white-space: pre-wrap;
    word-break: break-word;
    min-height: 0;
}

.reportRowContent.codeScroll {
    overflow: visible;
    max-height: none;
}

.reportRowNotice {
    margin: 0;
    padding: 0 16px 12px;
    font-size: 12px;
    color: #94a3b8;
}

.reportIssuesRow .reportRowContent {
    padding: 0;
}

.reportIssuesRow .reportRowContent.codeScroll {
    display: flex;
    flex-direction: column;
    overflow: auto;
    max-height: none;
}

.reportIssuesRow .codeEditor {
    padding: 4px 0 0;
}

.reportIssuesRow .codeLine {
    border-left: 3px solid transparent;
    padding: 2px 0;
}

.reportIssuesRow .codeLine--issue {
    background: rgba(248, 113, 113, 0.12);
    border-left-color: rgba(248, 113, 113, 0.65);
    padding-top: 0;
    padding-bottom: 0;
}

.codeLineNo--issue {
    color: #b91c1c;
}

.codeLineContent--issueHighlight {
    color: #7f1d1d;
    background: rgba(248, 113, 113, 0.18);
}

.reportIssuesRow .codeLine--meta {
    background: rgba(226, 232, 240, 0.75);
    border-left-color: rgba(148, 163, 184, 0.6);
}

.reportIssuesRow .codeLine--issuesMeta {
    background: rgba(251, 146, 60, 0.24);
    border-left-color: rgba(251, 146, 60, 0.6);
}

.reportIssuesRow .codeLine--fixMeta {
    background: rgba(56, 189, 248, 0.2);
    border-left-color: rgba(56, 189, 248, 0.55);
}

.codeLineNo--meta {
    color: #1f2937;
    display: flex;
    align-items: center;
    justify-content: center;
    padding-right: 0;
}

.codeLineNo--meta::before {
    content: "";
}

.codeLineNo--issues {
    color: #c2410c;
}

.codeLineNo--fix {
    color: #0284c7;
}

.codeLineNoIcon {
    width: 16px;
    height: 16px;
    fill: currentColor;
    display: block;
}

.codeLineNoIcon--warning {
    color: inherit;
}

.codeLineContent--issues,
.codeLineContent--fix {
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
}

.codeLineContent--issues {
    color: #9a3412;
}

.codeLineContent--fix {
    color: #0369a1;
}

.reportIssueInlineRow {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: flex-start;
    margin: 0 0 6px;
    color: #1e3a8a;
}

.reportIssueInlineRow:last-child {
    margin-bottom: 0;
}

.reportIssueInlineRow--empty {
    color: #475569;
    font-style: italic;
}

.reportIssueInlineRecommendationList {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    padding-left: 0;
    margin: 0 0 8px;
    list-style: none;
}

.reportIssueInlineRecommendation {
    background: #e0f2fe;
    border-radius: 8px;
    padding: 8px 10px;
}

.reportIssueInlineList {
    padding-left: 18px;
    margin: 4px 0 0;
    color: inherit;
}

.reportIssueInlineList li {
    margin: 2px 0;
}

.reportIssueInlineTupleList {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    padding-left: 0;
    margin: 4px 0 0;
    list-style: none;
}

.reportIssueInlineTuple {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.6);
    color: #0f172a;
    border: 1px solid rgba(148, 163, 184, 0.35);
}

.reportIssueInlineTupleItem {
    font-size: 12px;
    line-height: 1.5;
    word-break: break-word;
    text-align: left;
}

.reportIssueInlineTupleItem--severity {
    font-weight: 700;
    color: #9a3412;
}

.reportIssueInlineTupleItem--rule {
    font-weight: 600;
    color: #9a3412;
}

.reportIssueInlineTupleItem--message {
    color: #0b1120;
    flex: 1 1 auto;
    min-width: 0;
}

.reportIssueInlineCode {
    width: 100%;
    background: #eff6ff;
    border: 1px solid #93c5fd;
    border-radius: 8px;
    padding: 10px 12px;
    font-family: var(--code-font, "JetBrains Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
    color: #1d4ed8;
    background-clip: padding-box;
}

.reportIssueInlineCode code {
    font-family: inherit;
}

.reportIssueInlineBadges {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #cbd5f5;
}

.reportIssueInlineIndex {
    color: #1e3a8a;
}

.reportIssueInlineRule {
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(59, 130, 246, 0.15);
    color: #1d4ed8;
    font-weight: 600;
}

.reportIssueInlineSeverity {
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 600;
    border: 1px solid transparent;
    color: #0f172a;
}

.reportIssueInlineSeverity--high,
.reportIssueInlineSeverity--error {
    background: rgba(248, 113, 113, 0.22);
    color: #991b1b;
    border-color: rgba(248, 113, 113, 0.45);
}

.reportIssueInlineSeverity--mid,
.reportIssueInlineSeverity--warn {
    background: rgba(234, 179, 8, 0.24);
    color: #92400e;
    border-color: rgba(234, 179, 8, 0.45);
}

.reportIssueInlineSeverity--low,
.reportIssueInlineSeverity--info {
    background: rgba(59, 130, 246, 0.2);
    color: #1d4ed8;
    border-color: rgba(59, 130, 246, 0.45);
}

.reportIssueInlineSeverity--muted {
    background: rgba(148, 163, 184, 0.24);
    color: #1f2937;
    border-color: rgba(148, 163, 184, 0.45);
}

.reportIssueInlineLine {
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(154, 52, 18, 0.14);
    color: #9a3412;
    font-weight: 600;
}

.reportIssueInlineMessage {
    flex: 1 1 220px;
    min-width: 200px;
    font-weight: 600;
    color: #0b1120;
}

.reportIssueInlineMeta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 12px;
    color: #334155;
}

.reportIssueInlineObject {
    font-weight: 600;
}

.reportIssueInlineColumn {
    color: #1f2937;
}

.reportIssuesEmpty {
    margin: 0;
    font-size: 13px;
    color: #94a3b8;
}

.reportRaw {
    border: 1px solid #2f2f2f;
    border-radius: 6px;
    background: #111827;
    padding: 10px 14px;
}

.reportRaw>summary {
    cursor: pointer;
    font-weight: 600;
    font-size: 13px;
    color: #cbd5f5;
}

.reportRaw>summary::marker {
    color: #94a3b8;
}

.reportErrorPanel {
    margin: 0;
    padding: 16px;
    border-radius: 6px;
    border: 1px solid rgba(248, 113, 113, 0.3);
    background: rgba(248, 113, 113, 0.08);
    color: #fda4af;
}

.reportErrorText {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
}

.reportErrorHint {
    margin: 8px 0 0;
    font-size: 12px;
    color: #fecaca;
}

.reportChunks {
    margin-top: 16px;
    border-radius: 6px;
    border: 1px solid #2f2f2f;
    background: #111827;
    padding: 12px 16px;
    color: #e2e8f0;
}

.reportChunks>summary {
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 8px;
}

.reportChunkList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reportChunkList--issues {
    gap: 16px;
}

.reportChunkTitle {
    margin: 0 0 6px;
    font-size: 12px;
    color: #94a3b8;
}

.reportChunkIssues {
    margin: 0;
    padding-left: 20px;
    list-style: disc;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.reportChunkIssue {
    margin: 0;
}

.reportChunkIssueMessage {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: #f8fafc;
}

.reportChunkIssueMeta {
    margin: 4px 0 0;
    font-size: 12px;
    color: #94a3b8;
}

.reportChunkIssueContext {
    margin: 6px 0 0;
    font-size: 12px;
    color: #cbd5f5;
    white-space: pre-wrap;
    word-break: break-word;
}

.reportChunkEmpty {
    margin: 6px 0 0;
    font-size: 12px;
    color: #94a3b8;
}

.reportChunkBody {
    margin: 0;
    padding: 12px;
    border-radius: 4px;
    border: 1px solid #2f2f2f;
    background: #1b1b1b;
    color: #d1d5db;
    font-family: Consolas, "Courier New", monospace;
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
}

.reportViewerPlaceholder {
    margin: 0;
    color: #94a3b8;
    font-size: 13px;
}

.pvHeader {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 12px;
    line-height: 1.2;
}

.pvName {
    font-size: 16px;
    font-weight: 600;
    color: #f3f4f6;
    word-break: break-all;
}

.pvMeta {
    font-size: 12px;
    color: #94a3b8;
}

.pvBox {
    flex: 1 1 auto;
    background: #1b1b1b;
    border-radius: 6px;
    border: 1px solid #2f2f2f;
    padding: 12px;
    display: flex;
    overflow: auto;
}

.pvBox.codeBox {
    padding: 12px;
    overflow: auto;
}

.pvBox.codeBox.reportIssuesBox,
.pvBox.codeBox.reportIssuesBox .codeScroll {
    overflow: auto;
}

.codeScroll {
    flex: 1 1 auto;
    font-family: Consolas, "Courier New", monospace;
    font-size: 13px;
    line-height: 1.45;
    color: #1f2937;
    background: #f8fafc;
    cursor: text;
    overflow: auto;
    max-height: 100%;
}

.reportBody.codeScroll,
.reportChunkBody.codeScroll {
    -webkit-user-select: text;
    -moz-user-select: text;
    -ms-user-select: text;
    user-select: text;
}

.codeEditor {
    display: block;
    width: 100%;
    min-width: 0;
    outline: none;
    caret-color: transparent;
}

.codeEditor:focus {
    outline: none;
}

.codeLine {
    display: flex;
    align-items: flex-start;
    width: 100%;
}

.codeLineNo {
    position: relative;
    flex: 0 0 auto;
    width: 5ch;
    min-width: 5ch;
    padding: 0 12px 0 0;
    text-align: right;
    color: #4b5563;
    font-variant-numeric: tabular-nums;
    user-select: none;
}

.codeLineNo::before {
    content: attr(data-line);
    display: block;
}

.codeLineContent {
    flex: 1 1 auto;
    display: block;
    width: 100%;
    padding: 0 12px;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
    min-width: 0;
    -webkit-user-select: text;
    -moz-user-select: text;
    -ms-user-select: text;
    user-select: text;
}

.codeSelectionHighlight {
    background: rgba(59, 130, 246, 0.25);
    color: #1f2937;
    border-radius: 2px;
}

.reportBody::selection,
.reportBody *::selection,
.reportChunkBody::selection,
.reportChunkBody *::selection,
.codeScroll::selection,
.codeScroll *::selection,
.codeLineContent::selection,
.codeLineContent *::selection {
    background: rgba(59, 130, 246, 0.45);
    color: #f8fafc;
}

.reportBody::-moz-selection,
.reportBody *::-moz-selection,
.reportChunkBody::-moz-selection,
.reportChunkBody *::-moz-selection,
.codeScroll::-moz-selection,
.codeScroll *::-moz-selection,
.codeLineContent::-moz-selection,
.codeLineContent *::-moz-selection {
    background: rgba(59, 130, 246, 0.45);
    color: #f8fafc;
}


.modalBackdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, .5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
}

.modalCard {
    width: 520px;
    max-width: 90vw;
    background: #252526;
    color: #e5e7eb;
    border: 1px solid #3d3d3d;
    border-radius: 10px;
    padding: 18px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, .6);
}

.modalCard h3 {
    margin: 0 0 6px;
}

.modalCard p {
    margin: 6px 0 12px;
    opacity: .9;
}

.dropZone {
    border: 2px dashed #3d3d3d;
    border-radius: 10px;
    height: 160px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 12px;
    user-select: none;
}

.dropZone:hover {
    background: #2a2a2a;
}

.modalBtns {
    display: flex;
    gap: 10px;
}

.btn {
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid #3d3d3d;
    background: #007acc;
    color: #fff;
    cursor: pointer;
}

.btn:hover {
    filter: brightness(1.1);
}

.btn.ghost {
    background: transparent;
    color: #e5e7eb;
}

.btn.outline {
    background: transparent;
    color: #e5e7eb;
    border-color: #4b5563;
}

/* Light theme overrides */
.page--light {
    background-color: #f8fafc;
    color: #1f2937;
    --panel-surface: #ffffff;
    --panel-surface-alt: #f8fafc;
    --panel-border: #e2e8f0;
    --panel-border-strong: #cbd5f5;
    --panel-divider: rgba(148, 163, 184, 0.35);
    --panel-heading: #0f172a;
    --panel-muted: #64748b;
    --panel-accent: #2563eb;
    --panel-accent-soft: rgba(37, 99, 235, 0.12);
    --tree-row-hover: rgba(148, 163, 184, 0.18);
    --tree-row-active: rgba(59, 130, 246, 0.18);
    --tree-text: #1f2937;
    --tree-icon: #475569;
    --tree-connector: rgba(148, 163, 184, 0.4);
    --tree-badge-text: #1f2937;
    --tree-badge-idle: rgba(148, 163, 184, 0.24);
    --tree-badge-processing: rgba(234, 179, 8, 0.35);
    --tree-badge-ready: rgba(34, 197, 94, 0.28);
    --tree-badge-error: rgba(239, 68, 68, 0.32);
    --scrollbar-track: #e2e8f0;
    --scrollbar-thumb: #cbd5f5;
    --scrollbar-thumb-hover: #93c5fd;
}

.page--light .topBar {
    background: linear-gradient(90deg, #ffffff, #f1f5f9);
    border-bottom: 1px solid #cbd5f5;
    box-shadow: 0 2px 6px rgba(148, 163, 184, 0.35);
    color: #0f172a;
}

.page--light .topBar_iconBtn {
    background: #ffffff;
    border-color: #cbd5f5;
    color: #1f2937;
}

.page--light .topBar_iconBtn:hover:not(:disabled) {
    background: #e2e8f0;
    border-color: #93c5fd;
    color: #1d4ed8;
}

.page--light .topBar_iconBtn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.18), rgba(14, 165, 233, 0.18));
    color: #1d4ed8;
}

.page--light .topBar_addProject {
    background-color: #2563eb;
    box-shadow: 0 4px 12px rgba(148, 163, 184, 0.35);
}

.page--light .topBar_addProject:hover {
    background-color: #1d4ed8;
}

.page--light .mainContent {
    background-color: #f8fafc;
}

.page--light .workSpace {
    background: #ffffff;
    border-color: #e2e8f0;
}

.page--light .toolColumn {
    background: #e2e8f0;
    border-right: 1px solid #cbd5f5;
}

.page--light .toolColumn_btn {
    background: #ffffff;
    border-color: #cbd5f5;
    color: #1f2937;
}

.page--light .toolColumn_btn:hover {
    background: #e2e8f0;
    border-color: #93c5fd;
    color: #1d4ed8;
}

.page--light .toolColumn_btn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.18), rgba(14, 165, 233, 0.18));
    color: #1d4ed8;
}

.page--light .panelHeader {
    color: #475569;
}

.page--light .reportViewerContent {
    background: #ffffff;
    border-color: #e2e8f0;
    color: #1f2937;
}

.page--light .reportViewerProcessingOverlay {
    background: rgba(148, 163, 184, 0.35);
}

.page--light .reportViewerProcessingText {
    color: #1f2937;
}

.page--light .reportViewerPlaceholder {
    color: #64748b;
}

.page--light .reportTitle {
    color: #0f172a;
}

.page--light .reportViewerTimestamp {
    color: #64748b;
}

.page--light .reportBody {
    background: #ffffff;
    border-color: #e2e8f0;
    color: #1f2937;
}

.page--light .reportStructuredToggleButton {
    background: #e2e8f0;
    border-color: #cbd5f5;
    color: #1f2937;
}

.page--light .reportStructuredToggleButton.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(14, 165, 233, 0.2));
    color: #1d4ed8;
}

.page--light .reportJsonPreviewDetails {
    background: #f8fafc;
    border-color: #cbd5f5;
}

.page--light .reportJsonPreviewSummary {
    color: #1d4ed8;
}

.page--light .reportJsonPreview {
    background: #ffffff;
    border-top-color: rgba(59, 130, 246, 0.2);
    color: #1f2937;
}

.page--light .reportExportButton {
    background: #2563eb;
    border-color: #2563eb;
    color: #ffffff;
}

.page--light .reportExportButton:hover:not(:disabled) {
    background: #1d4ed8;
    border-color: #1d4ed8;
    color: #ffffff;
}

.page--light .reportExportButton:disabled {
    background: #e2e8f0;
    border-color: #cbd5f5;
    color: #94a3b8;
}

.page--light .reportSummaryCard {
    background: #f1f5f9;
    border-color: #e2e8f0;
    color: #1f2937;
}

.page--light .reportSummaryLabel {
    color: #475569;
}

.page--light .reportSummaryList {
    color: #1f2937;
}

.page--light .reportSummaryItemLabel {
    color: #0f172a;
}

.page--light .reportSummaryText {
    color: #1f2937;
}

.page--light .reportSummaryValue {
    color: #0f172a;
}

.page--light .reportSummaryItemValue {
    color: #1d4ed8;
}

.page--light .reportStaticSection,
.page--light .reportDmlDetails {
    background: #f8fafc;
    border-color: #e2e8f0;
    color: #1f2937;
}

.page--light .reportStaticHeader h4 {
    color: #0f172a;
}

.page--light .reportDmlHeader h4 {
    color: inherit;
}

.page--light .reportStaticEngine,
.page--light .reportDmlTimestamp,
.page--light .reportDmlEmpty {
    color: #64748b;
}

.page--light .reportStaticBlock h5 {
    color: #1f2937;
}

.page--light .reportStaticItemLabel {
    color: #0f172a;
}

.page--light .reportStaticItemValue {
    color: #1d4ed8;
}

.page--light .reportDmlStatus {
    color: #1d4ed8;
}

.page--light .reportDmlSummaryToggle {
    color: #1d4ed8;
}

.page--light .reportDmlDetails:not([open]) .reportDmlSummaryToggle:hover {
    color: #1f2937;
}

.page--light .reportDmlDetails[open] .reportDmlSummaryToggle:hover {
    background: rgba(148, 163, 184, 0.32);
}

.page--light .reportDmlSegment {
    background: #f1f5f9;
    border-color: #e2e8f0;
}

.page--light .reportDmlSegment summary {
    color: #1f2937;
}

.page--light .reportDmlSegment pre {
    background: #ffffff;
    color: #1f2937;
}

.page--light .reportDmlSql {
    background: rgba(59, 130, 246, 0.12);
    color: #1d4ed8;
}

.page--light .reportDmlAnalysis {
    background: rgba(14, 165, 233, 0.12);
    color: #0f172a;
}

.page--light .reportDmlSummary {
    background: #f1f5f9;
    color: #1f2937;
}

.page--light .reportErrorPanel {
    background: rgba(248, 113, 113, 0.12);
    border-color: rgba(248, 113, 113, 0.35);
    color: #b91c1c;
}

.page--light .reportErrorHint {
    color: #b91c1c;
}

.page--light .reportChunks {
    background: #f8fafc;
    border-color: #e2e8f0;
    color: #1f2937;
}

.page--light .reportChunkTitle,
.page--light .reportChunkIssueMeta,
.page--light .reportChunkEmpty {
    color: #64748b;
}

.page--light .reportChunkIssueMessage {
    color: #0f172a;
}

.page--light .reportChunkIssueContext {
    color: #1d4ed8;
}

.page--light .reportChunkBody {
    background: #ffffff;
    border-color: #e2e8f0;
    color: #1f2937;
}

.page--light .pvName {
    color: #0f172a;
}

.page--light .pvMeta {
    color: #64748b;
}

.page--light .pvBox {
    background: #ffffff;
    border-color: #e2e8f0;
    color: #1f2937;
}

.page--light .codeScroll {
    background: #f8fafc;
    color: #1f2937;
}

.page--light .codeLineNo {
    color: #94a3b8;
}

.page--light .codeSelectionHighlight {
    background: rgba(59, 130, 246, 0.18);
    color: #1d4ed8;
}

.page--light .modalBackdrop {
    background: rgba(148, 163, 184, 0.35);
}

.page--light .modalCard {
    background: #ffffff;
    color: #1f2937;
    border-color: #e2e8f0;
    box-shadow: 0 16px 32px rgba(148, 163, 184, 0.4);
}

.page--light .dropZone {
    border-color: #cbd5f5;
    background: #f8fafc;
    color: #64748b;
}

.page--light .dropZone:hover {
    background: #e2e8f0;
}

.page--light .btn {
    background: #2563eb;
    border-color: #2563eb;
    color: #ffffff;
}

.page--light .btn.ghost {
    background: transparent;
    color: #1d4ed8;
}

.page--light .btn.outline {
    background: transparent;
    border-color: #93c5fd;
    color: #1d4ed8;
}
</style>
