const FENCE_PATTERN = /^```([A-Za-z0-9_-]+)?\s*$/;
const ORDERED_PATTERN = /^\s*(\d+)\.?\s+(.*)$/;
const UNORDERED_PATTERN = /^\s*[-+*]\s+(.*)$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const HR_PATTERN = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function renderInline(text) {
    if (!text) return "";

    const placeholders = [];
    let processed = String(text);

    processed = processed.replace(/`([^`]+)`/g, (_, code) => {
        const id = `__INLINE_CODE_${placeholders.length}__`;
        placeholders.push({ id, html: `<code>${escapeHtml(code)}</code>` });
        return id;
    });

    const escaped = escapeHtml(processed)
        .replace(/!\[([^\]]*)\]\((https?:\/\/[\S]+?)\)/g, (_m, alt, href) => {
            const safeHref = escapeHtml(href);
            const safeAlt = escapeHtml(alt || "");
            return `<img src="${safeHref}" alt="${safeAlt}" loading="lazy" />`;
        })
        .replace(/\[([^\]]+)\]\((https?:\/\/[\S]+?)\)/g, (_m, label, href) => {
            const safeHref = escapeHtml(href);
            return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        })
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^_]+)__/g, "<strong>$1</strong>")
        .replace(/\*(?!\s)([^*]+?)\*/g, "<em>$1</em>")
        .replace(/_([^_]+)_/g, "<em>$1</em>")
        .replace(/~~([^~]+)~~/g, "<del>$1</del>")
        .replace(/\n/g, "<br />");

    let finalText = escaped;
    for (const { id, html } of placeholders) {
        finalText = finalText.replaceAll(escapeHtml(id), html).replaceAll(id, html);
    }

    return finalText;
}

function flushParagraph(buffer, html) {
    if (!buffer.length) return;
    const text = buffer.join("\n").trim();
    if (text) {
        html.push(`<p>${renderInline(text)}</p>`);
    }
    buffer.length = 0;
}

function flushList(state, html) {
    if (!state.type || !state.items.length) {
        state.type = null;
        state.items = [];
        return;
    }
    const tag = state.type === "ol" ? "ol" : "ul";
    const items = state.items
        .map((item) => `<li>${renderInline(item)}</li>`)
        .join("");
    html.push(`<${tag}>${items}</${tag}>`);
    state.type = null;
    state.items = [];
}

function flushCode(state, html) {
    if (!state.active) return;
    const codeText = state.lines.join("\n");
    const escaped = escapeHtml(codeText);
    const langAttr = state.lang ? ` data-lang="${escapeHtml(state.lang)}"` : "";
    html.push(`<pre class="chatMd__code"><code${langAttr}>${escaped}</code></pre>`);
    state.active = false;
    state.lang = "";
    state.lines = [];
}

export function renderMarkdown(input) {
    if (input === null || input === undefined) return "";
    const text = String(input).replace(/\r\n/g, "\n");
    const lines = text.split("\n");
    const html = [];

    const paragraph = [];
    const listState = { type: null, items: [] };
    const codeState = { active: false, lang: "", lines: [] };

    for (const rawLine of lines) {
        const line = rawLine;

        if (codeState.active) {
            if (FENCE_PATTERN.test(line.trim())) {
                flushCode(codeState, html);
            } else {
                codeState.lines.push(line);
            }
            continue;
        }

        if (FENCE_PATTERN.test(line.trim())) {
            flushParagraph(paragraph, html);
            flushList(listState, html);
            const fenceMatch = line.trim().match(/^```([A-Za-z0-9_-]+)?/);
            codeState.active = true;
            codeState.lang = fenceMatch?.[1] || "";
            codeState.lines = [];
            continue;
        }

        if (!line.trim()) {
            flushParagraph(paragraph, html);
            flushList(listState, html);
            continue;
        }

        const headingMatch = line.match(HEADING_PATTERN);
        if (headingMatch) {
            flushParagraph(paragraph, html);
            flushList(listState, html);
            const level = Math.min(6, headingMatch[1].length);
            html.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
            continue;
        }

        if (HR_PATTERN.test(line)) {
            flushParagraph(paragraph, html);
            flushList(listState, html);
            html.push("<hr />");
            continue;
        }

        const orderedMatch = line.match(ORDERED_PATTERN);
        if (orderedMatch) {
            flushParagraph(paragraph, html);
            if (listState.type && listState.type !== "ol") {
                flushList(listState, html);
            }
            listState.type = "ol";
            listState.items.push(orderedMatch[2]);
            continue;
        }

        const unorderedMatch = line.match(UNORDERED_PATTERN);
        if (unorderedMatch) {
            flushParagraph(paragraph, html);
            if (listState.type && listState.type !== "ul") {
                flushList(listState, html);
            }
            listState.type = "ul";
            listState.items.push(unorderedMatch[1]);
            continue;
        }

        if (line.trim().startsWith(">")) {
            flushParagraph(paragraph, html);
            flushList(listState, html);
            const content = line.replace(/^>\s?/, "");
            html.push(`<blockquote>${renderInline(content)}</blockquote>`);
            continue;
        }

        paragraph.push(line);
    }

    flushCode(codeState, html);
    flushParagraph(paragraph, html);
    flushList(listState, html);

    if (!html.length) {
        return `<p>${renderInline(text)}</p>`;
    }

    return html.join("");
}

export default renderMarkdown;
