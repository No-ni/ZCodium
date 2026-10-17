import type {
  FileBinaryPreview,
  FileEntry,
  FileMediaPreview,
  FileStat,
  WorkspaceFileEntry,
  FileTextSlice,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface WorkspaceFileSearchParams {
  rootPath: string;
  workspaceIdentity?: string;
  query: string;
  /** 命令中心保留多词 AND、原索引顺序；缺省继续使用模糊匹配。 */
  matchMode?: "fuzzy" | "terms";
  limit?: number;
  /** 无命中补扫：绕过尚未过期的文件索引。 */
  refresh?: boolean;
  /**
   * 忽略规则根（`.zcodiumignore` 的所在目录）。缺省 = `rootPath`，行为与今天逐位一致。
   * 对话会话（未指定项目的会话）必须传**对话根**：会话 cwd 是对话根下的独立目录，
   * 规则仍只有一份、落在对话根上，会话目录里不生成 `.zcodiumignore`。
   * 见 docs/specs/conversation-session-workspace.md 规则 10。
   */
  ignoreRulesRoot?: string;
}

export interface IFileService {
  /** Host 匹配并返回有界候选，避免 Renderer 下载完整文件索引。 */
  searchWorkspaceFiles(params: WorkspaceFileSearchParams): Promise<WorkspaceFileEntry[]>;
  readdir(params: { path: string; includeHidden?: boolean }): Promise<FileEntry[]>;
  stat(params: { path: string }): Promise<FileStat>;
  checkFilesExist(params: { paths: string[] }): Promise<Array<{ path: string; exists: boolean }>>;
  resolvePath(params: { path: string }): Promise<string>;
  ensureConversationWorkspace(): Promise<{
    path: string;
    created: boolean;
    workspacePurpose: "conversation";
  }>;
  createDefaultWorkspace(): Promise<{ path: string }>;
  createScratchWorkspace(params: { name: string }): Promise<{ path: string }>;
  readTextFile(params: { path: string; offset?: number; length?: number }): Promise<FileTextSlice>;
  readMediaPreview(params: { path: string; maxBytes?: number }): Promise<FileMediaPreview>;
  /**
   * 按偏移读取文件的一段原始字节，供大二进制文件（如 PDF）按需分段加载。
   * 返回值必须保持顶层 Uint8Array：RPC 序列化只对顶层二进制走原始字节通道，
   * 嵌套在对象字段里会退化成 JSON+base64。EOF 时返回短数组。
   */
  readFileRange(params: { path: string; offset: number; length: number }): Promise<Uint8Array>;
  readBinaryPreview(params: { path: string; maxBytes?: number }): Promise<FileBinaryPreview>;
  /**
   * workspace 文件索引的列式打包长度（字符数）。与 listWorkspaceFilesRange 配对，
   * 调用方按长度分块拉取（见 fetchWorkspaceFileEntriesPacked）。
   * 返回 number：RPC Int 快速路径。
   * `ignoreRulesRoot` 与 searchWorkspaceFiles 同义；两次调用必须传同一个规则根，
   * 否则索引会因签名不同而重扫。
   */
  listWorkspaceFilesLength(params: { rootPath: string; ignoreRulesRoot?: string }): Promise<number>;
  /**
   * 分块返回列式打包字符串（workspaceFileEntriesCodec 格式，[offset, offset+length)）。
   * 必须是裸 string 顶层返回：RPC String 快速路径（长度前缀+原始字节）；Object 会
   * JSON 转义大字符串（实测 6-9s 主线程长任务）。单块不超过 ~4MB：大消息在
   * renderer 接收端的分帧重组是秒级长任务（实测 4.6-6.3s），分块 + 块间让出后
   * 主线程每次只处理一小块（~50ms），输入永不冻结。
   * Host 侧有 60s TTL + .zcodiumignore 指纹签名的整包缓存，分块只是切片。
   */
  listWorkspaceFilesRange(params: {
    rootPath: string;
    offset: number;
    length: number;
    ignoreRulesRoot?: string;
  }): Promise<string>;
  /**
   * workspace 搜索忽略规则（.zcodiumignore）的读写，供设置页编辑使用。
   * `ignoreRulesRoot` 必须与搜索用的规则根一致，否则设置页会编辑出第二个规则文件
   * （对话会话因此绝不能把规则写进会话目录）。
   * source: "file" 已存在文件内容；"template" 尚未创建时的初始内容预览（保存时才落盘）。
   */
  readWorkspaceFileSearchIgnore(params: {
    rootPath: string;
    ignoreRulesRoot?: string;
  }): Promise<{ content: string; source: "file" | "template" }>;
  /**
   * 设置页分区操作（返回新内容填充编辑框，保存才落盘）：
   * "sync-gitignore" 只重写 gitignore 同步区（保留默认段与自定义区）；
   * "reset-defaults" 只重置默认排除段（保留 gitignore 区与自定义区）。
   */
  applyWorkspaceFileSearchIgnoreTransform(params: {
    rootPath: string;
    transform: "sync-gitignore" | "reset-defaults";
    ignoreRulesRoot?: string;
  }): Promise<{ content: string }>;
  writeWorkspaceFileSearchIgnore(params: {
    rootPath: string;
    content: string;
    ignoreRulesRoot?: string;
  }): Promise<void>;
}

export const IFileService = createServiceDescriptor<IFileService>(ServiceChannels.File);
