const JAVA_FILE_REGEX = /\.java$/i;
const PUBLIC_CLASS_REGEX = /public\s+(?:class|interface|enum)\s+([A-Za-z_$][\w$]*)[^\{]*\{/g;
const CLASS_REGEX = /(class|interface|enum)\s+([A-Za-z_$][\w$]*)[^\{]*\{/g;

export function isJavaPath(path) {
    if (typeof path !== "string") {
        return false;
    }
    return JAVA_FILE_REGEX.test(path);
}

function stripPackageAndImports(source) {
    return source.replace(/^[\t ]*(?:package|import)\s+[^;]+;\s*/gm, "");
}

function stripBlockComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function stripLineComments(source) {
    return source.replace(/(?<![:\\])\/\/[^\n\r]*/g, "");
}

export function sanitiseJavaSource(source) {
    if (typeof source !== "string" || !source.trim()) {
        return typeof source === "string" ? source.trim() : "";
    }
    let result = source;
    result = stripPackageAndImports(result);
    result = stripBlockComments(result);
    result = stripLineComments(result);
    return result.replace(/\r\n/g, "\n").trim();
}

function maskNonCodeRegions(source) {
    if (typeof source !== "string" || !source.length) {
        return "";
    }
    const chars = Array.from(source);
    let masked = "";
    let index = 0;
    let inBlockComment = false;
    let inLineComment = false;
    let inString = false;
    let inChar = false;
    let escapeNext = false;

    while (index < chars.length) {
        const current = chars[index];
        const next = chars[index + 1];

        if (inLineComment) {
            if (current === "\n") {
                inLineComment = false;
                masked += current;
            } else {
                masked += current === "\r" ? "\r" : " ";
            }
            index += 1;
            continue;
        }

        if (inBlockComment) {
            if (current === "*" && next === "/") {
                masked += "  ";
                index += 2;
                inBlockComment = false;
                continue;
            }
            masked += current === "\n" || current === "\r" ? current : " ";
            index += 1;
            continue;
        }

        if (inString || inChar) {
            masked += current === "\n" || current === "\r" ? current : " ";
            if (!escapeNext && ((inString && current === '"') || (inChar && current === "'"))) {
                inString = false;
                inChar = false;
            }
            escapeNext = !escapeNext && current === "\\";
            index += 1;
            continue;
        }

        if (current === "/" && next === "/") {
            masked += "  ";
            index += 2;
            inLineComment = true;
            continue;
        }

        if (current === "/" && next === "*") {
            masked += "  ";
            index += 2;
            inBlockComment = true;
            continue;
        }

        if (current === '"') {
            masked += current;
            inString = true;
            index += 1;
            escapeNext = false;
            continue;
        }

        if (current === "'") {
            masked += current;
            inChar = true;
            index += 1;
            escapeNext = false;
            continue;
        }

        masked += current;
        index += 1;
    }

    return masked;
}

function findMatchingBrace(source, openIndex) {
    if (typeof source !== "string" || !source.length) {
        return -1;
    }
    let depth = 0;
    for (let index = openIndex; index < source.length; index += 1) {
        const char = source[index];
        if (char === "{") {
            depth += 1;
        } else if (char === "}") {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function buildLineIndex(source) {
    const starts = [0];
    if (typeof source !== "string" || !source.length) {
        return starts;
    }
    for (let index = 0; index < source.length; index += 1) {
        if (source[index] === "\n") {
            starts.push(index + 1);
        }
    }
    return starts;
}

function lineNumberForIndex(lineStarts, index) {
    if (!Array.isArray(lineStarts) || !lineStarts.length) {
        return 1;
    }
    if (typeof index !== "number" || Number.isNaN(index) || index < 0) {
        return 1;
    }
    let low = 0;
    let high = lineStarts.length - 1;
    let line = 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const startIndex = lineStarts[mid];
        if (startIndex <= index) {
            line = mid + 1;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return line;
}

function cleanSignature(signature) {
    if (typeof signature !== "string") {
        return "";
    }
    return signature
        .replace(/\s+/g, " ")
        .replace(/\s*\(/g, "(")
        .trim();
}

function extractClasses(source, maskedSource, regex) {
    if (typeof source !== "string" || !source.trim()) {
        return [];
    }
    const classes = [];
    let match;
    while ((match = regex.exec(source))) {
        const braceIndex = maskedSource.indexOf("{", match.index);
        if (braceIndex === -1) {
            continue;
        }
        const closingIndex = findMatchingBrace(maskedSource, braceIndex);
        if (closingIndex === -1) {
            continue;
        }
        const className = match[2] || match[1];
        classes.push({
            className,
            bodyStart: braceIndex + 1,
            bodyEnd: closingIndex
        });
        regex.lastIndex = closingIndex + 1;
    }
    return classes;
}

function extractPublicClasses(source, maskedSource) {
    const publicClasses = extractClasses(source, maskedSource, PUBLIC_CLASS_REGEX);
    if (publicClasses.length) {
        return publicClasses;
    }
    return extractClasses(source, maskedSource, CLASS_REGEX);
}

function extractMethodsFromClass(source, maskedSource, classInfo) {
    const methods = [];
    if (!classInfo || typeof classInfo.bodyStart !== "number" || typeof classInfo.bodyEnd !== "number") {
        return methods;
    }
    const classBody = source.slice(classInfo.bodyStart, classInfo.bodyEnd);
    const maskedClassBody = maskedSource.slice(classInfo.bodyStart, classInfo.bodyEnd);
    const methodRegex = /(^|[\r\n])\s*(?:@[A-Za-z_$][\w$.]*(?:\([^)]*\))?\s*)*(?:(?:public|protected|private|static|final|native|synchronized|abstract|transient|volatile|strictfp)\s+)*[A-Za-z_$][\w$<>\[\],\s]*\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws [^{]+)?\{/gm;
    const controlKeywords = new Set(["if", "for", "while", "switch", "catch", "try", "do", "else", "case", "default"]);
    let match;
    while ((match = methodRegex.exec(maskedClassBody))) {
        const signatureStart = match.index + (match[1] ? match[1].length : 0);
        const braceIndex = maskedClassBody.indexOf("{", match.index + (match[1] ? match[1].length : 0));
        if (braceIndex === -1) {
            continue;
        }
        const absoluteSignatureStart = classInfo.bodyStart + signatureStart;
        const absoluteBraceIndex = classInfo.bodyStart + braceIndex;
        const absoluteEndIndex = findMatchingBrace(maskedSource, absoluteBraceIndex);
        if (absoluteEndIndex === -1) {
            continue;
        }
        const methodName = match[2] || "";
        if (controlKeywords.has(methodName)) {
            continue;
        }
        const block = source.slice(absoluteSignatureStart, absoluteEndIndex + 1).trim();
        if (!block) {
            continue;
        }
        methods.push({
            signature: cleanSignature(source.slice(absoluteSignatureStart, absoluteBraceIndex)),
            methodName,
            block,
            startIndex: absoluteSignatureStart,
            endIndex: absoluteEndIndex
        });
        methodRegex.lastIndex = braceIndex + 1;
    }
    return methods;
}

export function extractJavaMethodSegments(source) {
    if (typeof source !== "string" || !source.trim()) {
        return [];
    }
    const maskedSource = maskNonCodeRegions(source);
    const classes = extractPublicClasses(source, maskedSource);
    if (!classes.length) {
        return [];
    }
    const lineIndex = buildLineIndex(source);
    const segments = [];
    classes.forEach((classInfo) => {
        const classMethods = extractMethodsFromClass(source, maskedSource, classInfo);
        classMethods.forEach((method) => {
            const startLine = lineNumberForIndex(lineIndex, method.startIndex);
            const endLine = lineNumberForIndex(lineIndex, method.endIndex);
            const rawText = method.block;
            segments.push({
                text: rawText,
                rawText,
                className: classInfo.className,
                methodName: method.methodName,
                methodSignature: method.signature,
                label: `${classInfo.className || "UnknownClass"}::${method.methodName || method.signature || "(anonymous)"}`,
                kind: "java_method",
                codeLocationLabel: startLine
                    ? endLine && endLine !== startLine
                        ? `程式碼位置：第 ${startLine}-${endLine} 行`
                        : `程式碼位置：第 ${startLine} 行`
                    : "",
                startLine,
                endLine
            });
        });
    });
    return segments;
}

export function buildJavaSegments(source) {
    const segments = extractJavaMethodSegments(source);
    return segments.map((segment, index) => ({
        ...segment,
        index: index + 1,
        total: segments.length
    }));
}

export default {
    isJavaPath,
    extractJavaMethodSegments,
    buildJavaSegments,
    sanitiseJavaSource
};
