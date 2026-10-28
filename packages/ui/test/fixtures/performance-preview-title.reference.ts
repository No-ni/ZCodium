import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as shared from "@zcode/shared";
import * as fileReferences from "@/lib/assistantFileReferences.js";
import * as paths from "@/lib/path.js";
import type { buildAssistantPreviewCardsFromReferences } from "@/lib/assistantPreviewCards.js";

// 固化修复前的完整 builder 与首见标题查询；只复用本次不改动的路径、URL 和卡片 helper。
const legacyTitleLookup = String.raw`
function getWebsiteTitleFromMarkdownLink(content: string, url: string): string | null {
  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const label = match[1] ? cleanMarkdownLinkTitle(match[1]) : null;
    const href = match[2] ? normalizeTrailingUrlText(normalizeMarkdownHref(match[2])) : "";
    if (label && href === url && !/^https?:\/\//i.test(label)) return label;
  }
  return null;
}
`;
const legacyBuilder = String.raw`
export function buildAssistantPreviewCardsFromReferences(
  content: string,
  workspacePath: string,
  references: readonly AssistantFileReference[],
  options: AssistantPreviewCardOptions = {},
): AssistantPreviewCard[] {
  if (!content.trim()) return [];

  const changedFilePaths = options.changedFilePaths ?? [];
  let changedFilePathIndex: ChangedFilePathIndex | undefined;
  const findChangedPath = (reference: AssistantFileReference): string | null =>
    findMatchingChangedFilePath(
      reference,
      (changedFilePathIndex ??= buildChangedFilePathIndex(changedFilePaths, workspacePath)),
    );
  const positionedCards: PositionedCard[] = [];
  let hasLocalHttpPreview = false;

  for (const match of content.matchAll(LOCALHOST_URL_RE)) {
    const url = normalizeTrailingUrlText(match[0] ?? "");
    if (!isValidAssistantPreviewWebsiteUrl(url)) continue;
    if (options.suppressWebRemoteCards) continue;
    const filePath = resolveLocalhostHtmlChangedPath(url, workspacePath, findChangedPath, {
      homePath: options.homePath,
    });
    hasLocalHttpPreview = true;
    positionedCards.push({
      position: match.index ?? 0,
      card: {
        id: "website:" + url,
        type: "website",
        title:
          filePath !== null
            ? getPathLeaf(filePath)
            : (getWebsiteTitleFromMarkdownLink(content, url) ?? getWebsiteFallbackTitle(url)),
        subtitleId: "chat.previewCards.website",
        url,
        ...(filePath ? { filePath } : {}),
      },
    });
  }

  const fileReferences: AssistantFileReference[] = [];
  for (const reference of references) {
    if (options.suppressWebRemoteCards && reference.kind === "html") continue;
    if (reference.kind === "html" && hasLocalHttpPreview) continue;
    let resolvedReference = reference;
    if (reference.kind === "markdown" || reference.kind === "html") {
      const changedPath = findChangedPath(reference);
      if (!changedPath) continue;
      resolvedReference = { ...reference, path: changedPath };
    }
    fileReferences.push(resolvedReference);
  }

  const previewCandidates = buildConversationPreviewArtifactCandidatesFromReferences({
    references: fileReferences,
    productTurnId: "",
    workspacePath,
    fileChanges: changedFilePaths.map((path) => ({ path, state: "active" as const })),
    enforceWorkspaceBoundary: false,
  });
  const referencesByPath = new Map(
    fileReferences.map((reference) => [normalizePathForCompare(reference.path), reference]),
  );
  for (const candidate of previewCandidates) {
    const reference = referencesByPath.get(normalizePathForCompare(candidate.sourceRef));
    if (!reference) continue;
    positionedCards.push({
      position: reference.start,
      card: buildFileCard({ ...reference, path: candidate.sourceRef }),
    });
  }

  positionedCards.sort((left, right) => right.position - left.position);
  const seen = new Set<string>();
  const cards: AssistantPreviewCard[] = [];
  for (const candidate of positionedCards) {
    const key = getCardSeenKey(candidate.card);
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push(candidate.card);
    if (cards.length === ASSISTANT_PREVIEW_CARD_CANDIDATE_LIMIT) break;
  }
  return cards;
}
`;

export async function loadLegacyPreviewBuilder(): Promise<
  typeof buildAssistantPreviewCardsFromReferences
> {
  const source = await readFile(
    new URL("../../src/lib/assistantPreviewCards.ts", import.meta.url),
    "utf8",
  );
  const file = ts.createSourceFile(
    "assistantPreviewCards.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const replacements = new Map([
    ["buildAssistantPreviewCardsFromReferences", legacyBuilder],
    ["getWebsiteTitleFromMarkdownLink", legacyTitleLookup],
  ]);
  let restored = source;
  const found = new Set<string>();
  for (const statement of [...file.statements].reverse()) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
    const name = statement.name.text;
    const replacement = replacements.get(name);
    if (!replacement) continue;
    found.add(name);
    restored =
      restored.slice(0, statement.getStart(file)) + replacement + restored.slice(statement.end);
  }
  if (!found.has("buildAssistantPreviewCardsFromReferences"))
    throw new Error("Missing preview builder");
  if (!found.has("getWebsiteTitleFromMarkdownLink")) restored += legacyTitleLookup;
  const compiled = ts.transpileModule(restored, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dependencies: Record<string, unknown> = {
    "@zcode/shared": shared,
    "@/lib/assistantFileReferences.js": fileReferences,
    "@/lib/path.js": paths,
  };
  const exports: Partial<typeof import("@/lib/assistantPreviewCards.js")> = {};
  new Function("require", "exports", compiled)((id: string) => {
    if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected reference import: ${id}`);
    return dependencies[id];
  }, exports);
  if (!exports.buildAssistantPreviewCardsFromReferences)
    throw new Error("Missing restored builder");
  return exports.buildAssistantPreviewCardsFromReferences;
}
