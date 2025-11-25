/**
 * AI review prompt template & rules cache helpers.
 */

const templateCache = new Map();
const rulesCache = new Map();

function normaliseLanguage(language) {
    const value = typeof language === "string" ? language.trim() : "";
    if (!value) return "SQL";
    const upper = value.toUpperCase();
    return upper === "JAVA" ? "Java" : "SQL";
}

function cacheKey(language) {
    return normaliseLanguage(language);
}

export async function getAiReviewTemplate(pool, language) {
    const key = cacheKey(language);
    if (templateCache.has(key)) {
        return templateCache.get(key);
    }

    const [rows] = await pool.query(
        `SELECT code_block
         FROM setting_ai_review
         WHERE language = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [key]
    );
    const template = typeof rows?.[0]?.code_block === "string" ? rows[0].code_block : "";
    templateCache.set(key, template);
    return template;
}

export async function getAiReviewRulesText(pool, language) {
    const key = cacheKey(language);
    if (rulesCache.has(key)) {
        return rulesCache.get(key);
    }

    const [rows] = await pool.query(
        `SELECT rule_id, description, risk_indicator
         FROM setting_rules
         WHERE language = ? AND enabled = 1
         ORDER BY id ASC`,
        [key]
    );

    const lines = Array.isArray(rows)
        ? rows
              .map((row) => ({
                  ruleId: typeof row.rule_id === "string" ? row.rule_id.trim() : "",
                  description: typeof row.description === "string" ? row.description.trim() : "",
                  riskIndicator: typeof row.risk_indicator === "string" ? row.risk_indicator.trim() : ""
              }))
              .filter((rule) => rule.ruleId && (rule.description || rule.riskIndicator))
              .map((rule) => {
                  const risk = rule.riskIndicator ? `（風險指標：${rule.riskIndicator}）` : "";
                  const description = rule.description || "";
                  return `- [${rule.ruleId}] ${description}${risk}`.trim();
              })
        : [];

    const rulesText = lines.join("\n");
    rulesCache.set(key, rulesText);
    return rulesText;
}

export function clearAiReviewCaches() {
    templateCache.clear();
    rulesCache.clear();
}
