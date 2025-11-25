# -*- coding: utf-8 -*-
"""SQL rule engine used for static analysis when reviewing .sql files."""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Dict, List, Set, Tuple

CJK_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]")
BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
IDENTIFIER_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")

TABLE_RE = re.compile(
    r'\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[\]\w\.\$#@]+)',
    flags=re.IGNORECASE,
)
VIEW_RE = re.compile(
    r'\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([`"\[\]\w\.\$#@]+)',
    flags=re.IGNORECASE,
)
PROC_RE = re.compile(
    r'\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+([`"\[\]\w\.\$#@]+)',
    flags=re.IGNORECASE,
)
FUNC_RE = re.compile(
    r'\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([`"\[\]\w\.\$#@]+)',
    flags=re.IGNORECASE,
)


# ---------- position helpers ----------
def _idx_to_linecol(sql: str, idx: int) -> Tuple[int, int]:
    """0-based idx -> (1-based line, 1-based column)."""
    line = sql.count("\n", 0, idx) + 1
    last_nl = sql.rfind("\n", 0, idx)
    col = idx - (last_nl + 1) + 1
    return line, col


def _line_snippet(sql: str, idx: int, max_len: int = 240) -> str:
    """Extract the full line containing idx (trim to max_len)."""
    start = sql.rfind("\n", 0, idx) + 1
    end = sql.find("\n", idx)
    if end == -1:
        end = len(sql)
    snippet = sql[start:end].rstrip("\r")
    if len(snippet) > max_len:
        snippet = snippet[:max_len] + "..."
    return snippet


# ---------- masking comments & strings (keeps positions) ----------
def _mask_span_with_spaces(text: str, start: int, end: int) -> str:
    return text[:start] + "".join("\n" if ch == "\n" else " " for ch in text[start:end]) + text[end:]


def _mask_block_comments(sql: str) -> str:
    """Replace /* ... */ comment bodies with spaces while keeping length consistent."""
    masked = sql
    for match in BLOCK_COMMENT_RE.finditer(sql):
        masked = _mask_span_with_spaces(masked, match.start(), match.end())
    return masked


def _mask_comments_and_strings(sql: str) -> str:
    """Replace comment/string contents with spaces but keep newlines & length."""
    masked = _mask_block_comments(sql)

    for match in re.finditer(r"--.*?$", masked, flags=re.MULTILINE):
        masked = _mask_span_with_spaces(masked, match.start(), match.end())

    for match in re.finditer(r"'(?:''|[^'])*'", masked, flags=re.DOTALL):
        masked = _mask_span_with_spaces(masked, match.start(), match.end())

    for match in re.finditer(r'"(?:""|[^"])*"', masked, flags=re.DOTALL):
        masked = _mask_span_with_spaces(masked, match.start(), match.end())

    return masked


# ---------- token helpers ----------
def _last_identifier(name_token: str) -> str:
    token = name_token.strip()
    if "." in token:
        token = token.split(".")[-1]
    if token.startswith("[") and token.endswith("]"):
        token = token[1:-1]
    token = token.strip('`"')
    return token


def _find_next_create(masked_sql: str, start_idx: int) -> int:
    match = re.search(r"\bCREATE\b", masked_sql[start_idx + 1 :], flags=re.IGNORECASE)
    if match is None:
        return len(masked_sql)
    return start_idx + 1 + match.start()


def _extract_statement(sql: str, masked_sql: str, start_idx: int) -> str:
    end_idx = _find_next_create(masked_sql, start_idx)
    return sql[start_idx:end_idx]


def _find_matching_paren(masked_sql: str, start_idx: int) -> int:
    depth = 0
    for idx in range(start_idx, len(masked_sql)):
        ch = masked_sql[idx]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return idx
    return -1


def _split_columns(sql: str, masked_sql: str, start_idx: int, end_idx: int) -> List[Tuple[str, int]]:
    segments: List[Tuple[str, int]] = []
    depth = 0
    segment_start = start_idx
    for idx in range(start_idx, end_idx):
        ch = masked_sql[idx]
        if ch == "(":
            depth += 1
        elif ch == ")":
            if depth > 0:
                depth -= 1
        elif ch == "," and depth == 0:
            segment = sql[segment_start:idx]
            segments.append((segment, segment_start))
            segment_start = idx + 1
    if segment_start < end_idx:
        segments.append((sql[segment_start:end_idx], segment_start))
    return segments


def _find_statement_terminator(masked_sql: str, start_idx: int) -> int:
    for idx in range(start_idx, len(masked_sql)):
        if masked_sql[idx] == ";":
            return idx + 1
    return len(masked_sql)


def _iter_dml_segments(statement: str) -> List[Tuple[int, int]]:
    masked = _mask_comments_and_strings(statement)
    segments: List[Tuple[int, int]] = []
    for match in re.finditer(r"\b(INSERT|UPDATE|DELETE)\b", masked, flags=re.IGNORECASE):
        start = match.start()
        end = _find_statement_terminator(masked, start)
        segments.append((start, end))
    return segments


def _has_adjacent_comment(statement: str, start_idx: int, end_idx: int) -> bool:
    segment = statement[start_idx:end_idx]
    if re.search(r"--|/\*", segment):
        return True

    prefix = statement[:start_idx]
    stripped_prefix = prefix.rstrip()
    if stripped_prefix:
        last_line_start = stripped_prefix.rfind("\n") + 1
        last_line = stripped_prefix[last_line_start:]
        if "--" in last_line:
            return True
        if re.search(r"/\*.*\*/\s*$", stripped_prefix, flags=re.DOTALL):
            return True

    suffix = statement[end_idx:]
    if re.match(r"\s*(--|/\*)", suffix):
        return True

    return False


def _enforce_identifier_format(
    issues: List[Dict],
    name: str,
    sql: str,
    idx: int,
    obj_desc: str,
) -> None:
    clean = name.strip()
    if not clean:
        return

    if not IDENTIFIER_RE.fullmatch(clean):
        _add_issue(
            issues,
            "RULE_01_IDENTIFIER_FORMAT",
            f"{obj_desc} {clean} 不符合命名规范（需使用大写英文、数字、下划线且以字母开头）。",
            sql,
            idx,
            evidence=clean,
            obj_name=clean,
        )

    parts = [segment for segment in clean.split("_") if segment]
    if len(parts) > 3:
        _add_issue(
            issues,
            "RULE_03_IDENTIFIER_WORD_LIMIT",
            f"{obj_desc} {clean} 超过 3 个单词（以下划线分隔）。",
            sql,
            idx,
            evidence=clean,
            obj_name=clean,
        )


def _add_issue(
    issues: List[Dict],
    rule_id: str,
    message: str,
    sql: str,
    pos_idx: int,
    evidence: str = "",
    severity: str = "ERROR",
    obj_name: str = "",
    recommendation: str = "",
) -> None:
    line, col = _idx_to_linecol(sql, pos_idx)
    snippet = _line_snippet(sql, pos_idx)
    resolved_evidence = evidence or snippet

    # Ensure issues affecting the same line are aggregated so arrays remain aligned
    existing = None
    for entry in issues:
        if entry.get("line") == line:
            existing = entry
            break

    if existing is None:
        existing = {
            "rule_id": rule_id,
            "rule_ids": [rule_id],
            "severity": severity,
            "severity_levels": [severity],
            "message": message,
            "issues": [message],
            "object": obj_name,
            "line": line,
            "column": [col],
            "snippet": snippet,
            "evidence": resolved_evidence,
            "evidence_list": [resolved_evidence],
            "recommendation": [recommendation or ""],
            "fixed_code": "",
        }
        issues.append(existing)
        return

    existing.setdefault("rule_ids", []).append(rule_id)
    existing.setdefault("severity_levels", []).append(severity)
    columns = existing.setdefault("column", [])
    columns.append(col)
    entries = existing.setdefault("issues", [])
    entries.append(message)
    existing.setdefault("recommendation", []).append(recommendation or "")
    evidence_list = existing.setdefault("evidence_list", [])
    evidence_list.append(resolved_evidence)

    # Keep single-value fallbacks in sync for legacy consumers
    existing["rule_id"] = existing["rule_ids"][0]
    existing["severity"] = existing["severity_levels"][0]
    existing["message"] = existing["issues"][0]
    existing["evidence"] = existing["evidence_list"][0]


# ---------- rule checks ----------
def _check_cjk(sql: str, issues: List[Dict]) -> None:
    """Rule 1: object names must avoid non-ASCII characters."""
    masked = _mask_comments_and_strings(sql)
    match = CJK_RE.search(masked)
    if match:
        ch = match.group(0)
        _add_issue(
            issues,
            "RULE_01_CJK_NAME",
            "检测到中文/非 ASCII 字符（疑似用于对象/列命名），应使用英文单词/短语/缩写。",
            sql,
            match.start(),
            evidence=f"...{ch}...",
        )


def _check_naming_prefixes(sql: str, issues: List[Dict]) -> None:
    """Rule 4 & Rule 14: enforce object prefixes and block TMP_TMP_TMP tables."""
    masked = _mask_comments_and_strings(sql)

    for match in TABLE_RE.finditer(masked):
        raw = match.group(1)
        name = _last_identifier(raw)
        _enforce_identifier_format(issues, name, sql, match.start(1), "表名")
        if not name.upper().startswith("T_"):
            _add_issue(
                issues,
                "RULE_04_PREFIX_TABLE",
                f"表名需以 T_ 开头：发现 {name}",
                sql,
                match.start(),
                evidence=match.group(0),
                obj_name=name,
            )
        if name.upper().startswith("TMP_TMP_TMP"):
            _add_issue(
                issues,
                "RULE_14_TMP_TRIPLE",
                f"中间表命名不得使用 TMP_TMP_TMP 前缀：发现 {name}",
                sql,
                match.start(),
                evidence=match.group(0),
                obj_name=name,
            )

    for match in VIEW_RE.finditer(masked):
        name = _last_identifier(match.group(1))
        _enforce_identifier_format(issues, name, sql, match.start(1), "视图名")
        if not name.upper().startswith("V_"):
            _add_issue(
                issues,
                "RULE_04_PREFIX_VIEW",
                f"视图名需以 V_ 开头：发现 {name}",
                sql,
                match.start(),
                evidence=match.group(0),
                obj_name=name,
            )

    for match in PROC_RE.finditer(masked):
        name = _last_identifier(match.group(1))
        _enforce_identifier_format(issues, name, sql, match.start(1), "存储过程名")
        if not name.upper().startswith("P_"):
            _add_issue(
                issues,
                "RULE_04_PREFIX_PROC",
                f"存储过程名需以 P_ 开头：发现 {name}",
                sql,
                match.start(),
                evidence=match.group(0),
                obj_name=name,
            )

    for match in FUNC_RE.finditer(masked):
        name = _last_identifier(match.group(1))
        _enforce_identifier_format(issues, name, sql, match.start(1), "函数名")
        if not name.upper().startswith("F_"):
            _add_issue(
                issues,
                "RULE_04_PREFIX_FUNC",
                f"函数名需以 F_ 开头：发现 {name}",
                sql,
                match.start(),
                evidence=match.group(0),
                obj_name=name,
            )


def _check_table_definitions(sql: str, issues: List[Dict]) -> None:
    masked = _mask_comments_and_strings(sql)

    for match in TABLE_RE.finditer(masked):
        table_name = _last_identifier(match.group(1))
        statement = _extract_statement(sql, masked, match.start())
        statement_upper = statement.upper()
        if "COMMENT" not in statement_upper:
            evidence_line = statement.strip().splitlines()[0] if statement.strip() else table_name
            _add_issue(
                issues,
                "RULE_05_TABLE_COMMENT",
                f"表 {table_name} 缺少注释（COMMENT）。",
                sql,
                match.start(),
                evidence=evidence_line,
                obj_name=table_name,
            )

        name_end = match.end()
        paren_start = masked.find("(", name_end)
        if paren_start == -1:
            continue
        paren_end = _find_matching_paren(masked, paren_start)
        if paren_end == -1:
            continue

        has_dt_date = False
        column_segments = _split_columns(sql, masked, paren_start + 1, paren_end)
        for segment, seg_start in column_segments:
            raw_segment = segment.strip()
            if not raw_segment:
                continue
            keyword = raw_segment.split(None, 1)[0].upper()
            if keyword in {"CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "KEY"}:
                continue

            leading = len(segment) - len(segment.lstrip())
            trimmed = segment.lstrip()
            name_match = re.match(r'[`"\[\]\w#@\$]+', trimmed)
            if not name_match:
                continue
            raw_name = name_match.group(0)
            column_name = _last_identifier(raw_name)
            name_idx = seg_start + leading + name_match.start()
            _enforce_identifier_format(issues, column_name, sql, name_idx, f"表 {table_name} 的字段")

            if column_name.upper() == "DT_DATE":
                has_dt_date = True

            if "COMMENT" not in raw_segment.upper():
                _add_issue(
                    issues,
                    "RULE_05_COLUMN_COMMENT",
                    f"表 {table_name} 字段 {column_name} 缺少注释。",
                    sql,
                    name_idx,
                    evidence=raw_segment.strip(),
                    obj_name=f"{table_name}.{column_name}",
                )

        if table_name.upper().endswith("_HIS") and not has_dt_date:
            _add_issue(
                issues,
                "RULE_15_HISTORY_DT_DATE",
                f"历史表 {table_name} 需包含字段 DT_DATE。",
                sql,
                match.start(1),
                evidence=table_name,
                obj_name=table_name,
            )


def _check_delete_full_table(sql: str, issues: List[Dict]) -> None:
    """Rule 16: DELETE without WHERE must be replaced by TRUNCATE."""
    masked = _mask_block_comments(sql)

    delete_re = re.finditer(
        r'\bDELETE\s+FROM\s+([`"\[\]\w\.\$#@]+)([^;]*)',
        masked,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for match in delete_re:
        tail = match.group(2) or ""
        if re.search(r"\bWHERE\b", tail, flags=re.IGNORECASE) is None:
            table_name = _last_identifier(match.group(1))
            _add_issue(
                issues,
                "RULE_16_DELETE_NO_WHERE",
                f"检测到对表 {table_name} 的全表删除（DELETE 无 WHERE）。请使用 TRUNCATE。",
                sql,
                match.start(),
                evidence=match.group(0),
                obj_name=table_name,
            )


def _check_uppercase(sql: str, issues: List[Dict]) -> None:
    masked = _mask_comments_and_strings(sql)
    match = re.search(r"[a-z]", masked)
    if match:
        _add_issue(
            issues,
            "RULE_06_UPPERCASE",
            "脚本需使用大写字母，检测到小写字符。",
            sql,
            match.start(),
            evidence=_line_snippet(sql, match.start()),
            severity="WARNING",
        )


def _max_function_call_depth(masked_sql: str) -> int:
    positions: Set[int] = set()
    for match in re.finditer(r"\b[A-Z_][A-Z0-9_]*\s*\(", masked_sql, flags=re.IGNORECASE):
        positions.add(match.end() - 1)

    stack: List[bool] = []
    current_depth = 0
    max_depth = 0

    for idx, ch in enumerate(masked_sql):
        if ch == "(":
            is_func = idx in positions
            stack.append(is_func)
            if is_func:
                current_depth += 1
                if current_depth > max_depth:
                    max_depth = current_depth
        elif ch == ")":
            if stack:
                is_func = stack.pop()
                if is_func and current_depth > 0:
                    current_depth -= 1
    return max_depth


def _check_view_nesting(sql: str, issues: List[Dict]) -> None:
    masked = _mask_comments_and_strings(sql)
    for match in VIEW_RE.finditer(masked):
        view_name = _last_identifier(match.group(1))
        statement = _extract_statement(sql, masked, match.start())
        upper_stmt = statement.upper()
        body_start = upper_stmt.find(" AS ")
        body = statement[body_start + 4 :] if body_start != -1 else statement
        body_masked = _mask_comments_and_strings(body)
        select_count = len(re.findall(r"\bSELECT\b", body_masked, flags=re.IGNORECASE))
        if select_count > 3:
            _add_issue(
                issues,
                "RULE_10_VIEW_NESTING",
                f"视图 {view_name} 的嵌套层级疑似超过 3 层（检测到 {select_count} 个 SELECT）。",
                sql,
                match.start(1),
                evidence=view_name,
                obj_name=view_name,
            )


def _check_function_rules(sql: str, issues: List[Dict]) -> None:
    masked = _mask_comments_and_strings(sql)
    for match in FUNC_RE.finditer(masked):
        func_name = _last_identifier(match.group(1))
        stmt_start = match.start()
        statement = _extract_statement(sql, masked, stmt_start)
        masked_statement = _mask_comments_and_strings(statement)
        depth = _max_function_call_depth(masked_statement)
        if depth > 3:
            _add_issue(
                issues,
                "RULE_11_FUNCTION_NESTING",
                f"函数 {func_name} 嵌套调用深度 {depth} 超出 3 层限制。",
                sql,
                stmt_start,
                evidence=func_name,
                obj_name=func_name,
            )
        elif depth > 2:
            _add_issue(
                issues,
                "RULE_11_FUNCTION_NESTING_WARN",
                f"函数 {func_name} 嵌套调用深度 {depth}，建议不超过 2 层。",
                sql,
                stmt_start,
                evidence=func_name,
                severity="WARNING",
                obj_name=func_name,
            )

        line_count = statement.count("\n") + 1
        if line_count > 200:
            _add_issue(
                issues,
                "RULE_12_FUNCTION_LENGTH",
                f"函数 {func_name} 行数为 {line_count}，超过 200 行。",
                sql,
                stmt_start,
                evidence=func_name,
                obj_name=func_name,
            )


def _check_procedure_rules(sql: str, issues: List[Dict]) -> None:
    masked = _mask_comments_and_strings(sql)
    for match in PROC_RE.finditer(masked):
        proc_name = _last_identifier(match.group(1))
        stmt_start = match.start()
        statement = _extract_statement(sql, masked, stmt_start)

        for eq_match in re.finditer(r"(?<![\s<>=!])=(?!=)", statement):
            _add_issue(
                issues,
                "RULE_14_EQUAL_SPACING_LEFT",
                "存储过程内等号两侧需留空格。",
                sql,
                stmt_start + eq_match.start(),
                evidence=_line_snippet(sql, stmt_start + eq_match.start()),
                obj_name=proc_name,
                severity="WARNING",
            )

        for eq_match in re.finditer(r"=(?!=)(?![\s=])", statement):
            _add_issue(
                issues,
                "RULE_14_EQUAL_SPACING_RIGHT",
                "存储过程内等号两侧需留空格。",
                sql,
                stmt_start + eq_match.start(),
                evidence=_line_snippet(sql, stmt_start + eq_match.start()),
                obj_name=proc_name,
                severity="WARNING",
            )

        if re.search(r"\bTRUNCATE\b", statement, flags=re.IGNORECASE):
            _add_issue(
                issues,
                "RULE_20_PROCEDURE_TRUNCATE",
                f"存储过程 {proc_name} 中禁止使用 TRUNCATE。",
                sql,
                stmt_start,
                evidence=proc_name,
                obj_name=proc_name,
            )


def _check_procedure_comments(sql: str, issues: List[Dict]) -> None:
    masked = _mask_comments_and_strings(sql)
    for pattern, label, rule_id in (
        (PROC_RE, "存储过程", "RULE_05_PROC_COMMENT"),
        (FUNC_RE, "函数", "RULE_05_FUNC_COMMENT"),
    ):
        for match in pattern.finditer(masked):
            obj_name = _last_identifier(match.group(1))
            stmt_start = match.start()
            statement = _extract_statement(sql, masked, stmt_start)
            for seg_start, seg_end in _iter_dml_segments(statement):
                if not _has_adjacent_comment(statement, seg_start, seg_end):
                    snippet = statement[seg_start:seg_end].strip()
                    _add_issue(
                        issues,
                        rule_id,
                        f"{label} {obj_name} 包含 DML 语句但缺少注释。",
                        sql,
                        stmt_start + seg_start,
                        evidence=snippet,
                        obj_name=obj_name,
                    )


def _check_no_trigger(sql: str, issues: List[Dict]) -> None:
    masked = _mask_comments_and_strings(sql)
    for match in re.finditer(r"\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\b", masked, flags=re.IGNORECASE):
        _add_issue(
            issues,
            "RULE_13_NO_TRIGGER",
            "不允许创建触发器。",
            sql,
            match.start(),
            evidence=_line_snippet(sql, match.start()),
        )


# ---------- main ----------
def main(sql_query: str) -> Dict[str, str]:
    if not isinstance(sql_query, str):
        result = json.dumps({"summary": "输入不是字符串。", "issues": []}, ensure_ascii=False)
        return {"result": result}

    issues: List[Dict] = []
    sql = sql_query

    _check_cjk(sql, issues)
    _check_naming_prefixes(sql, issues)
    _check_table_definitions(sql, issues)
    _check_delete_full_table(sql, issues)
    _check_uppercase(sql, issues)
    _check_view_nesting(sql, issues)
    _check_function_rules(sql, issues)
    _check_procedure_rules(sql, issues)
    _check_procedure_comments(sql, issues)
    _check_no_trigger(sql, issues)

    file_extension = ".sql"

    if not issues:
        payload = {
            "summary": {
                "message": "代码正常",
                "file_extension": file_extension,
                "total_issues": 0,
            },
            "issues": [],
        }
    else:
        by_rule: Dict[str, int] = {}
        total_count = 0
        for issue in issues:
            rule_ids = issue.get("rule_ids")
            if isinstance(rule_ids, list) and rule_ids:
                for rule in rule_ids:
                    if not isinstance(rule, str):
                        continue
                    key = rule.strip()
                    if not key:
                        continue
                    by_rule[key] = by_rule.get(key, 0) + 1
            else:
                rule = issue.get("rule_id")
                if isinstance(rule, str) and rule.strip():
                    key = rule.strip()
                    by_rule[key] = by_rule.get(key, 0) + 1

            entries = issue.get("issues")
            if isinstance(entries, list) and entries:
                total_count += len(entries)
            else:
                total_count += 1

        payload = {
            "summary": {
                "total_issues": total_count,
                "by_rule": by_rule,
                "file_extension": file_extension,
            },
            "issues": issues,
        }

    summary_block = payload.get("summary")
    if isinstance(summary_block, dict):
        summary_block.setdefault("analysis_source", "static_analyzer")

    payload["analysis_source"] = "static_analyzer"
    payload["metadata"] = {
        "analysis_source": "static_analyzer",
        "engine": "sql_rule_engine",
    }

    result = json.dumps(payload, ensure_ascii=False, indent=2)
    return {"result": result}


def _read_sql_from_stdin_or_file() -> str:
    data = sys.stdin.read()
    if data:
        return data

    if len(sys.argv) > 1:
        sql_file = sys.argv[1]
        if os.path.exists(sql_file):
            with open(sql_file, "r", encoding="utf-8") as handle:
                return handle.read()
        raise FileNotFoundError(f"文件 {sql_file} 不存在")

    return ""


def _emit_json(payload: Dict) -> None:
    data = json.dumps(payload, ensure_ascii=False)
    encoded = data.encode("utf-8", errors="surrogateescape")
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        sql_content = _read_sql_from_stdin_or_file()
        report = main(sql_content)
    except Exception as exc:  # pragma: no cover
        _emit_json({"error": str(exc)})
        sys.exit(1)

    _emit_json(report)
