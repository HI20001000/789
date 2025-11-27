import base64
import io
import json
import sys
import zipfile
import xml.etree.ElementTree as ET


WORD_NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
SHEET_NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def _safe_load_json(text: str):
    try:
        return json.loads(text)
    except Exception:
        return {}


def detect_kind(name: str, mime: str):
    lower_name = (name or "").lower()
    if lower_name.endswith(".docx") or lower_name.endswith(".doc") or "wordprocessingml" in (mime or "").lower():
        return "word"
    if lower_name.endswith(".xlsx") or lower_name.endswith(".xls") or "spreadsheetml" in (mime or "").lower():
        return "excel"
    return ""


def extract_word_text(buff: bytes):
    with zipfile.ZipFile(io.BytesIO(buff)) as archive:
        try:
            document = archive.read("word/document.xml")
        except KeyError:
            return ""
        root = ET.fromstring(document)
        texts = [node.text or "" for node in root.findall(".//w:t", WORD_NS)]
        return "\n".join([t for t in texts if t.strip()])


def _load_shared_strings(archive: zipfile.ZipFile):
    try:
        data = archive.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ET.fromstring(data)
    values = []
    for t in root.findall(".//s:t", SHEET_NS):
        values.append(t.text or "")
    return values


def _cell_value(cell, shared_strings):
    cell_type = cell.attrib.get("t")
    if cell_type == "s":
        value = cell.find("s:v", SHEET_NS)
        if value is not None and value.text is not None:
            try:
                index = int(value.text)
                if 0 <= index < len(shared_strings):
                    return shared_strings[index]
            except Exception:
                return ""
        return ""

    inline = cell.find("s:is", SHEET_NS)
    if inline is not None:
        texts = [t.text or "" for t in inline.findall(".//s:t", SHEET_NS)]
        if texts:
            return "".join(texts)

    value = cell.find("s:v", SHEET_NS)
    return value.text if value is not None else ""


def _decode_entities(text: str) -> str:
    return (
        (text or "")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
    )


def _strip_xml_tags(xml_text: str) -> str:
    return (
        _decode_entities(xml_text or "")
        .replace("\r", " ")
        .replace("\n", " ")
        .replace("\t", " ")
        .replace("<", " <")
        .replace(">", "> ")
        .split()
    )


def extract_excel_text(buff: bytes):
    with zipfile.ZipFile(io.BytesIO(buff)) as archive:
        shared_strings = _load_shared_strings(archive)
        rows = []
        for name in archive.namelist():
            if not name.startswith("xl/worksheets/") or not name.endswith(".xml"):
                continue
            content = archive.read(name)
            root = ET.fromstring(content)
            for row in root.findall(".//s:row", SHEET_NS):
                cells = [
                    (_cell_value(cell, shared_strings) or "").strip()
                    for cell in row.findall("s:c", SHEET_NS)
                ]
                joined = " ".join([c for c in cells if c])
                if joined:
                    rows.append(joined)
        return "\n".join(rows)


def extract_fallback_xml_text(buff: bytes):
    rows = []
    with zipfile.ZipFile(io.BytesIO(buff)) as archive:
        for name in archive.namelist():
            if not name.lower().endswith(".xml"):
                continue
            try:
                xml_bytes = archive.read(name)
            except KeyError:
                continue
            flattened = " ".join(_strip_xml_tags(xml_bytes.decode(errors="ignore")))
            if flattened.strip():
                rows.append(flattened.strip())
    return "\n".join(rows)


def _normalise_base64_payload(text: str) -> str:
    if not text:
        return ""
    trimmed = text.strip()
    if not trimmed.startswith("data:"):
        return trimmed
    comma = trimmed.find(",")
    return trimmed if comma == -1 else trimmed[comma + 1 :]


def main():
    payload = _safe_load_json(sys.stdin.read())
    base64_data = payload.get("base64") or payload.get("data") or ""
    name = payload.get("name") or ""
    mime = payload.get("mime") or ""

    normalised_base64 = _normalise_base64_payload(base64_data)

    if not normalised_base64:
        json.dump({"text": ""}, sys.stdout)
        return

    kind = detect_kind(name, mime)
    if not kind:
        json.dump({"text": ""}, sys.stdout)
        return

    try:
        raw_bytes = base64.b64decode(normalised_base64)
    except Exception:
        json.dump({"text": ""}, sys.stdout)
        return

    try:
        if kind == "word":
            text = extract_word_text(raw_bytes)
        else:
            text = extract_excel_text(raw_bytes)
    except Exception:
        text = ""

    if not text.strip():
        try:
            text = extract_fallback_xml_text(raw_bytes)
        except Exception:
            text = ""

    json.dump({"text": text or ""}, sys.stdout)


if __name__ == "__main__":
    main()
