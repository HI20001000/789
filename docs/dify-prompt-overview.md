# Dify Prompt Generation Overview

This document summarizes how prompts are currently assembled before being sent to Dify so the same logic can be reused when talking directly to a large language model.

## Configuration and token sizing
- Environment variables in `server/lib/difyClient.js` drive API routing and prompt sizing: `DIFY_API_BASE_URL`, `DIFY_CHAT_ENDPOINT`, `DIFY_RESPONSE_MODE`, `DIFY_TOKEN_LIMIT`, `DIFY_APPROX_CHARS_PER_TOKEN`, `DIFY_SAFETY_MARGIN`, and `DIFY_USER_ID`.
- `tokenLimit`, `approxCharsPerToken`, and `safetyMargin` are combined to compute `maxSegmentChars`, which bounds the size of each prompt segment when content is partitioned for the model.【F:server/lib/difyClient.js†L5-L80】

## Segment preparation
- Arbitrary content is split into segments using `partitionContent`, which slices text into blocks no larger than `maxSegmentChars`, preferring to cut at newlines when possible.【F:server/lib/difyClient.js†L32-L86】
- SQL static-analysis issues use `buildStaticIssuePromptData` to package each issue as a synthetic segment with metadata such as rule IDs, severity, evidence snippet, and serialized issue JSON for later prompt construction.【F:server/lib/sqlAnalyzer.js†L393-L522】
- Java files may receive language-specific segmentation via `buildJavaSegments` before the Dify request (see `server/index.js`); otherwise, general files rely on `partitionContent`.【F:server/index.js†L1297-L1334】

## Prompt assembly
- `requestDifyReport` is the main entry point. For every segment it builds a prompt with `buildPrompt`, injects metadata (project name, file path, chunk index/total, selection details), and posts the prompt as the `query` field to the Dify chat endpoint.【F:server/lib/difyClient.js†L658-L765】
- When the segment represents a static-analysis issue (`kind: "static_issue"`), `buildPrompt` switches to a JSON-output instruction set. It asks the model (in Traditional Chinese) to fill `recommendation` and `fixed_code` fields and includes the relevant code snippet and serialized issue payload as fenced blocks.【F:server/lib/difyClient.js†L684-L724】
- For non-static segments, the prompt is a prose code-review request (Traditional Chinese, Markdown-friendly) followed by the raw code block. Additional labels are appended when the location refers to a Java method (method name, class name, signature).【F:server/lib/difyClient.js†L699-L717】

## Request payload and metadata
- Each Dify request includes `inputs` that mirror the segment’s positional metadata (chunk index/total, start/end lines and columns, selection info, code location label) plus file attachments when provided.【F:server/lib/difyClient.js†L710-L756】
- Conversation IDs are reused across chunks to maintain context; if the API signals a “maximum context length” error, the conversation ID is cleared and the request is retried with a fresh thread.【F:server/lib/difyClient.js†L742-L756】

## Response handling
- Responses are parsed with `parseDifyAnswer`, which attempts to extract JSON from the answer text (including fenced code blocks) and keeps both raw text and parsed structures.【F:server/lib/difyClient.js†L88-L173】
- For multi-chunk responses, `aggregateDifyChunkResults` consolidates issue lists, severity counts, rule IDs, and summary messages, embedding chunk indexes into each issue for traceability.【F:server/lib/difyClient.js†L175-L250】
- SQL static issues are enriched by sending the serialized issue JSON plus the code snippet; the first chunk’s parsed JSON (or extracted JSON fallback) is merged back into the issue to populate `recommendation` and `fixed_code`.【F:server/lib/sqlAnalyzer.js†L480-L540】

## Where to adapt for direct LLM calls
- The prompt text comes entirely from `buildPrompt`; reusing that function (or its static/general branches) will preserve current wording and metadata formatting.
- Segment sizing/partitioning and issue packaging live in `partitionContent` and `buildStaticIssuePromptData`—carry these forward to maintain chunking behavior and issue-specific prompts.
- The structured `inputs` payload mirrors `segmentMeta` plus optional selection info. Replicating these fields can keep downstream logging/analytics consistent even without Dify.
- Conversation management is currently Dify-specific; when calling the model directly, decide whether to chain segments sequentially or send them independently and aggregate with logic similar to `aggregateDifyChunkResults`.
