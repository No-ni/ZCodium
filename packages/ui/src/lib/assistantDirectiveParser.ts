interface ParsedAssistantDirective {
  end: number;
  name: string;
  parameters: Readonly<Record<string, string>> | null;
  raw: string;
  start: number;
}

export type AssistantTextRange = readonly [start: number, end: number];

interface AssistantDirectiveSyntaxOptions {
  allowSmartQuotes?: boolean;
  allowSingleColon?: boolean;
  allowTripleColon?: boolean;
}

interface AssistantDirectivePrefixOptions {
  minimumSingleColonPrefixLength?: number;
  singleColonDirectiveNames?: readonly string[];
  tripleColonDirectiveNames?: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createDirectiveStartPattern(
  directiveName: string,
  options: AssistantDirectiveSyntaxOptions = {},
): RegExp {
  // 模型偶尔把文件引用的双冒号输出成单/三冒号；不能全局放宽，否则
  // code-comment 等协议也会被意外兼容。opt-in 时同时拒绝从连续冒号中间起匹配。
  const minimumColonCount = options.allowSingleColon ? 1 : 2;
  const maximumColonCount = options.allowTripleColon ? 3 : 2;
  const prefix = `(?<!:):{${minimumColonCount},${maximumColonCount}}`;
  return new RegExp(`${prefix}${escapeRegExp(directiveName)}\\s*\\{`, "g");
}

interface DirectiveQuoteState {
  close: string;
  open: string;
}

function getDirectiveQuoteState(
  character: string | undefined,
  options: AssistantDirectiveSyntaxOptions,
): DirectiveQuoteState | null {
  if (character === '"' || character === "'") {
    return { open: character, close: character };
  }
  // 中文模型输出可能使用成对智能引号；未识别时会退化为未加引号值，
  // 使空格截断路径或把引号字符带入后续文件解析。仅由 citation opt-in，保持其它 directive 严格。
  if (!options.allowSmartQuotes) return null;
  if (character === "“") return { open: character, close: "”" };
  if (character === "‘") return { open: character, close: "’" };
  return null;
}

function findDirectiveClosingBrace(
  content: string,
  openBraceIndex: number,
  options: AssistantDirectiveSyntaxOptions,
): number {
  let quote: DirectiveQuoteState | null = null;
  let escaped = false;

  for (let index = openBraceIndex + 1; index < content.length; index += 1) {
    const character = content[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote.close) {
        quote = null;
      }
      continue;
    }

    const quoteState = getDirectiveQuoteState(character, options);
    if (quoteState) {
      quote = quoteState;
    } else if (character === "}") {
      return index;
    }
  }

  return -1;
}

function parseQuotedValue(
  source: string,
  start: number,
  quote: DirectiveQuoteState,
): { nextIndex: number; value: string } | null {
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === quote.close) return { nextIndex: index + 1, value };
    if (character !== "\\" || index + 1 >= source.length) {
      value += character;
      continue;
    }

    const escapedCharacter = source[index + 1]!;
    if (
      escapedCharacter === quote.open ||
      escapedCharacter === quote.close ||
      escapedCharacter === "\\"
    ) {
      value += escapedCharacter;
    } else {
      // Directive 不是 JSON；未知转义必须保留反斜杠，避免把 Windows 路径改坏。
      value += `\\${escapedCharacter}`;
    }
    index += 1;
  }

  return null;
}

function parseDirectiveParameters(
  source: string,
  options: AssistantDirectiveSyntaxOptions,
): Record<string, string> | null {
  const parameters: Record<string, string> = {};
  let index = 0;

  while (index < source.length) {
    while (index < source.length && /[\s,]/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) return parameters;

    const nameMatch = /^[a-zA-Z_][a-zA-Z\d_-]*/.exec(source.slice(index));
    if (!nameMatch) return null;
    const name = nameMatch[0];
    index += name.length;

    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== "=") return null;
    index += 1;
    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) return null;

    let value: string;
    const quote = getDirectiveQuoteState(source[index], options);
    if (quote) {
      const parsedValue = parseQuotedValue(source, index, quote);
      if (!parsedValue) return null;
      value = parsedValue.value;
      index = parsedValue.nextIndex;
    } else {
      const valueStart = index;
      while (index < source.length && !/[\s,]/.test(source[index] ?? "")) index += 1;
      value = source.slice(valueStart, index);
      if (!value) return null;
    }

    if (index < source.length && !/[\s,]/.test(source[index] ?? "")) return null;
    parameters[name] = value;
  }

  return parameters;
}

export function extractAssistantDirectives(
  content: string,
  directiveName: string,
  options: AssistantDirectiveSyntaxOptions = {},
): ParsedAssistantDirective[] {
  if (!content.trim() || !directiveName.trim()) return [];

  const startPattern = createDirectiveStartPattern(directiveName, options);
  const directives: ParsedAssistantDirective[] = [];
  let consumedUntil = 0;
  for (const match of content.matchAll(startPattern)) {
    const start = match.index ?? 0;
    if (start < consumedUntil) continue;
    const openBraceIndex = start + (match[0]?.lastIndexOf("{") ?? -1);
    if (openBraceIndex < start) continue;

    const closingBraceIndex = findDirectiveClosingBrace(content, openBraceIndex, options);
    if (closingBraceIndex < 0) continue;
    const end = closingBraceIndex + 1;
    consumedUntil = end;
    directives.push({
      start,
      end,
      name: directiveName,
      raw: content.slice(start, end),
      parameters: parseDirectiveParameters(
        content.slice(openBraceIndex + 1, closingBraceIndex),
        options,
      ),
    });
  }

  return directives;
}

function mergeRanges(ranges: AssistantTextRange[]): AssistantTextRange[] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

export function findMarkdownCodeRanges(content: string): AssistantTextRange[] {
  const ranges: Array<[number, number]> = [];
  const fencedRanges: Array<[number, number]> = [];
  let fence: { character: "`" | "~"; length: number; start: number } | null = null;
  let lineStart = 0;
  // CommonMark 支持 LF/CRLF/CR；单次顺序扫描保留原始下标，避免把 CR 后的代码引用当正文。
  const lines = /\r\n|\r|\n/gu;

  while (lineStart < content.length) {
    const newline = lines.exec(content);
    const lineEnd = newline ? lines.lastIndex : content.length;
    const line = content.slice(lineStart, newline?.index ?? content.length);
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    const marker = match?.[1];
    if (marker) {
      if (!fence) {
        if (marker[0] === "`" && match?.[2]?.includes("`")) {
          lineStart = lineEnd;
          continue;
        }
        fence = {
          character: marker[0] as "`" | "~",
          length: marker.length,
          start: lineStart,
        };
      } else if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        /^[ \t]*$/u.test(match?.[2] ?? "")
      ) {
        // CommonMark 关闭围栏只能带空白；把 ```后缀 当作关闭会让代码里的引用示例被改写。
        fencedRanges.push([fence.start, lineEnd]);
        fence = null;
      }
    }
    lineStart = lineEnd;
  }
  if (fence) fencedRanges.push([fence.start, content.length]);
  ranges.push(...fencedRanges);

  for (const match of content.matchAll(/<(code|pre)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi)) {
    const start = match.index ?? 0;
    ranges.push([start, start + (match[0]?.length ?? 0)]);
  }

  // 围栏已按起点排序且不重叠；闭合候选可能跨过多个围栏，二分查询避免每次全表扫描。
  const isFenced = (index: number) => {
    let low = 0;
    let high = fencedRanges.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const [start, end] = fencedRanges[middle]!;
      if (index < start) high = middle - 1;
      else if (index >= end) low = middle + 1;
      else return true;
    }
    return false;
  };
  let fenceIndex = 0;
  for (let index = content.indexOf("`"); index !== -1; index = content.indexOf("`", index + 1)) {
    // 行内扫描只向前推进，已知围栏整段跳过；跨围栏的旧行内匹配也要推进游标。
    while (fenceIndex < fencedRanges.length && index >= fencedRanges[fenceIndex]![1]) {
      fenceIndex += 1;
    }
    const fencedRange = fencedRanges[fenceIndex];
    if (fencedRange && index >= fencedRange[0]) {
      index = fencedRange[1] - 1;
      continue;
    }
    let markerLength = 1;
    while (content[index + markerLength] === "`") markerLength += 1;
    const marker = "`".repeat(markerLength);
    const closingIndex = content.indexOf(marker, index + markerLength);
    if (closingIndex < 0 || isFenced(closingIndex)) {
      index += markerLength - 1;
      continue;
    }
    ranges.push([index, closingIndex + markerLength]);
    index = closingIndex + markerLength - 1;
  }

  return mergeRanges(ranges);
}

export function overlapsAssistantTextRanges(
  start: number,
  end: number,
  ranges: readonly AssistantTextRange[],
): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

export function findUnclosedAssistantDirectiveStart(
  content: string,
  directiveName: string,
  protectedRanges: readonly AssistantTextRange[] = [],
  options: AssistantDirectiveSyntaxOptions & {
    isParameterPrefix?: (source: string) => boolean;
  } = {},
): number | null {
  const startPattern = createDirectiveStartPattern(directiveName, options);
  let unclosedStart: number | null = null;
  for (const match of content.matchAll(startPattern)) {
    const start = match.index ?? 0;
    const openBraceIndex = start + (match[0]?.lastIndexOf("{") ?? -1);
    if (
      openBraceIndex < start ||
      overlapsAssistantTextRanges(start, openBraceIndex + 1, protectedRanges)
    ) {
      continue;
    }
    if (findDirectiveClosingBrace(content, openBraceIndex, options) < 0) {
      // 只有仍然符合“参数前缀”的半截 directive 才隐藏。闭合引号后又出现
      // 普通正文时，参数解析会失败，于是保留原文，避免缺失 `}` 把后文吞掉。
      const parameterPrefix = content.slice(openBraceIndex + 1);
      let quote: DirectiveQuoteState | null = null;
      let escaped = false;
      for (const character of parameterPrefix) {
        if (quote !== null) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === quote.close) quote = null;
        } else {
          quote = getDirectiveQuoteState(character, options);
        }
      }
      const isParameterPrefix =
        options.isParameterPrefix?.(parameterPrefix) === true ||
        parseDirectiveParameters(parameterPrefix, options) !== null ||
        quote !== null ||
        /(?:^|[\s,])[a-zA-Z_][a-zA-Z\d_-]*\s*(?:=\s*)?$/.test(parameterPrefix);
      if (isParameterPrefix) unclosedStart = start;
    }
  }
  return unclosedStart;
}

const DIRECTIVE_WHITESPACE_PATTERN = /\s/;

/**
 * 流式尾部可能刚开始输出特化 directive 时，先把仍然匹配协议名称前缀的内容暂存。
 * 只检查文末连续尾部，且跳过 Markdown 代码范围；一旦前缀分叉，返回 null 让正文照常显示。
 */
export function findAssistantDirectivePrefixStart(
  content: string,
  directiveNames: readonly string[],
  protectedRanges: readonly AssistantTextRange[] = [],
  options: AssistantDirectivePrefixOptions = {},
): number | null {
  const singleColonNames = new Set(options.singleColonDirectiveNames ?? []);
  const tripleColonNames = new Set(options.tripleColonDirectiveNames ?? []);
  const minimumSingleColonPrefixLength = options.minimumSingleColonPrefixLength ?? 2;

  // 合法前缀的最长可能长度 = 三冒号 + 最长的 directive 名。旧实现从正文最后一个字符逐字符
  // 回扫全文，每遇到一个冒号就 slice 一次剩余全文、并对每个名字做若干次 startsWith：冒号数随
  // 正文长度线性增长，而单次 slice 覆盖的是剩余全文，因此**累计 slice 覆盖范围**对正文长度
  // 平方级增长（startsWith 次数只随冒号数线性增长；V8 的 slice 可能共享底层字符数据，墙钟
  // 耗时与内存并不保证同比例平方增长）。流式投影在正文每次更新时都会调它。这里把回扫收窄到
  // 「最后一个非空白字符往前 maxPrefixLength 个字符」。
  // 下界证明（p 为任一命中位置，lastNonWhitespace 为最后一个非空白字符的下标）：
  //   - suffix 是某个 ":"×k + name 的真前缀 → suffix.length <= maxPrefixLength，
  //     故 p >= content.length - maxPrefixLength >= lastNonWhitespace + 1 - maxPrefixLength；
  //   - suffix 以完整的 ":"×k + name 开头且其后全空白 → 名之后没有非空白字符，
  //     故 lastNonWhitespace <= p + (k + len(name)) - 1 <= p + maxPrefixLength - 1。
  // 公开参数不约束名字非空白，第二种形态只能取 <=；旧实现返回最靠右的命中位置，收窄窗口
  // 因此不改变返回值。完整推导见 docs/specs/performance-rescan-ui-directive-prefix-scan.md。
  const longestNameLength = directiveNames.reduce(
    (longest, directiveName) => (directiveName.length > longest ? directiveName.length : longest),
    0,
  );
  const maxPrefixLength = 3 + longestNameLength;
  // 最后一个非空白字符之后只可能是空白，不可能有冒号，回扫从它开始即可，无需再走一遍尾部空白。
  let lastNonWhitespace = -1;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (!DIRECTIVE_WHITESPACE_PATTERN.test(content[index] ?? "")) {
      lastNonWhitespace = index;
      break;
    }
  }

  for (
    let index = lastNonWhitespace;
    index >= Math.max(0, lastNonWhitespace + 1 - maxPrefixLength);
    index -= 1
  ) {
    if (content[index] !== ":") continue;
    if (content[index - 1] === ":") continue;
    if (overlapsAssistantTextRanges(index, index + 1, protectedRanges)) continue;

    const tailLength = content.length - index;
    const isPrefix = directiveNames.some((directiveName) =>
      matchesDirectivePrefixAt(content, index, tailLength, lastNonWhitespace, directiveName, {
        minimumSingleColonPrefixLength,
        singleColonNames,
        tripleColonNames,
      }),
    );
    if (isPrefix) return index;
  }
  return null;
}

/**
 * content 在 index 处的尾部是否命中某个 directive 名的前缀。与旧实现按名判定的三种形态
 * 逐条等价，只是不构造 content.slice(index) 这个中间子串：
 *   suffix.startsWith(X)          → content.startsWith(X, index)
 *   X.startsWith(suffix)          → 仅当 tailLength <= X.length 时 slice 后比较（长度已封顶）
 *   suffix 以 X 开头且名后只剩空白 → content.startsWith(X, index) 且
 *                                    lastNonWhitespace < index + X.length
 * 最后一条不假设名字本身非空白，对带尾空白的名字与全空白名字同样成立。
 */
function matchesDirectivePrefixAt(
  content: string,
  index: number,
  tailLength: number,
  lastNonWhitespace: number,
  directiveName: string,
  context: {
    minimumSingleColonPrefixLength: number;
    singleColonNames: ReadonlySet<string>;
    tripleColonNames: ReadonlySet<string>;
  },
): boolean {
  const canonicalName = `::${directiveName}`;
  const tripleColonName = `:::${directiveName}`;
  if (
    context.tripleColonNames.has(directiveName) &&
    content.startsWith(":::", index) &&
    (isNamePrefixAt(content, index, tailLength, tripleColonName) ||
      isCompleteNameAt(content, index, lastNonWhitespace, tripleColonName))
  ) {
    return true;
  }
  if (
    content.startsWith("::", index) &&
    (isNamePrefixAt(content, index, tailLength, canonicalName) ||
      isCompleteNameAt(content, index, lastNonWhitespace, canonicalName))
  ) {
    return true;
  }
  if (
    !context.singleColonNames.has(directiveName) ||
    tailLength < context.minimumSingleColonPrefixLength
  ) {
    return false;
  }
  const compatibilityName = `:${directiveName}`;
  return (
    isNamePrefixAt(content, index, tailLength, compatibilityName) ||
    isCompleteNameAt(content, index, lastNonWhitespace, compatibilityName)
  );
}

/** name 以 content.slice(index) 为前缀；suffix 比 name 长时判定恒为否。 */
function isNamePrefixAt(content: string, index: number, tailLength: number, name: string): boolean {
  if (tailLength > name.length) return false;
  return name.startsWith(content.slice(index));
}

/** content 在 index 处完整出现 name，且 name 之后只剩下空白字符。 */
function isCompleteNameAt(
  content: string,
  index: number,
  lastNonWhitespace: number,
  name: string,
): boolean {
  return content.startsWith(name, index) && lastNonWhitespace < index + name.length;
}
