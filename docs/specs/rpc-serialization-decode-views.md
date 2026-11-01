# RPC 反序列化 String/Object 零拷贝即时解码

## 问题与边界

`deserialize` 的 String 分支（`packages/rpc/src/serialization.ts`）与 Object 分支原先都走
`reader.read(len).toString()`：`BufferReader.read` 经 `VSBuffer.slice`（`Uint8Array.slice`）
把整段 payload 拷贝一份，随即交给 `TextDecoder`/`JSON.parse` 解码。RPC 每条消息的 body 反序列化
都会多付一次与 payload 等长的拷贝——沙箱实测（hook `Uint8Array.slice/set` 计字节）：首轮红以
UTF-8 fixture（"汉字😀"重复，wire payload 实际 1,497,960 字节）反序列化拷贝 1,497,973 字节，
与帧长成正比；文件读取、skill sync 归档、media preview、prompt attachment 等大载荷链路每次
传输都重复付出。修复后以普通 `Uint8Array` 帧、ASCII 恰 1MiB fixture 实测拷贝为 0（见实施证据）。

本次只收口「String/Object 负载的读取 + 即时解码」这一件事：

- `Buffer`/`VSBuffer` 分支与 `slice`/`read` 既有语义不动：不改这两个分支、不改这两个既有
  方法的实现与返回行为。若 `Buffer`/`VSBuffer` 分支改用零拷贝视图，小二进制结果会钉住整帧
  底层存储——沙箱实测（普通 `Uint8Array` 帧）1MiB 帧中 8 字节 binary，视图方案
  retain 1,048,603 字节、拷贝方案 retain 8 字节。
- `VSBuffer.wrap` 直接保留传入的 `Uint8Array` 实例；Node `Buffer` 是 `Uint8Array` 子类，
  其原生 `slice` 本就返回 view。本 spec 的拷贝承诺只覆盖本轮改动路径（String/Object 读取 +
  即时解码）与明确列出的既有语义不动项，**不扩大声称任何输入底层类型都由现实现保证 copy**；
  Node `Buffer` 帧在该维度上的差异不在本轮修复范围，保持范围不改。
- 不引入 decoder 缓存、不新增 wire 类型、不改协议/session/IPC、不做任何跨模块变更。
- 不新增产品规则；仅收紧本模块内部实现的所有权边界。
- 本文所有性能数字只统计 JS 层 `Uint8Array.prototype.slice/set` 的字节，不含
  `TextDecoder`/`JSON.parse` 的必要分配。

## 唯一 owner 与契约

- **`BufferReader.readString(bytes): string`**：BufferReader 拥有字符串负载的读取与即时解码。
  方法内按与 `read()` 完全一致的 slice 归一规则取零拷贝子视图
  （`underlying.subarray(this.pos, this.pos + bytes)`，随后 `this.pos += view.byteLength`），
  并在方法内部经 `VSBuffer.wrap(view).toString()`（`TextDecoder`）解码。视图不跨方法边界：
  返回值是 string，不持有底层存储；解码后视图不可达，不会让调用方保留整帧缓冲。
  游标归一规则与 `read()` 逐字节一致（subarray 与 slice 的 clamp 语义相同，仅不拷贝）：
  越界 bytes 截断到剩余长度、零长不推进游标；负 bytes 由 slice/subarray 相对末尾归一
  （end = pos + bytes 可为负并折回 length 末端，结果可能非空——如 "abcdefghij" 在 pos=2 处
  read(-5) 得 "cdefg"），readString 与 read() 在该路径上逐字节一致；
  `readByte` 越界不推进 `pos` 的既有容错不受影响，其后的 readString 不倒退游标。
- **私有 `IStringReader` 能力探测**：模块内定义、不导出。`deserialize` 对
  `readString` 能力做存在性探测（duck-typing，不依赖具体类型），有能力者走
  `readString` 零拷贝即时解码；普通 `IReader`（仅实现 `read`）回退既有
  `read(bytes).toString()`，行为与现状逐字节一致。外部 `IReader` 契约不变。
- **String/Object 消费 string**：两条分支的产物分别是 string 与 `JSON.parse` 结果
  （纯 JS 值；嵌套 `Uint8Array` 由 `decodeRpcJsonValue` 从 base64 字符串新建，
  与帧底层无关）。视图不可能经返回值逃逸：`TextDecoder.decode` 在解码时复制字节，
  JS string 不持有任何 buffer 引用。

## 验收边界

纯内存 `node:test`（不引入 Vitest、不使用真实 socket 或网络），直接导入真实 TS 导出。
十项场景：String/Object 1MiB 载荷反序列化拷贝预算（JS 层 slice/set 字节 ≤64，先红后绿；
帧统一为普通 `Uint8Array`；载荷 ASCII 恰 1MiB；计数块外 `deepEqual` 校验解码内容防假绿，
`t.diagnostic` 报告 payload/frame/copied 实测字节）、Buffer/VSBuffer 返回值变异隔离
（改返回值不动原消息）、readString 游标归一与 read() 一致（正常/零长/越界/负 bytes 四种边界）、
负 bytes 相对末端归一与 read() 一致（非 EOF 路径，独立序列 [2,-5,0,-1,4]）、
readByte 越界后 readString 不倒退游标（EOF 容错一致性）、非零 byteOffset 子视图解码正确、
UTF-8 多字节与多个连续值 roundtrip 等价、普通 IReader 回退路径行为不变、
IStringReader 被优先探测（readString 被调用且 read 不被调用）、
VSBuffer.slice / BufferReader.read 既有拷贝隔离不变。

入口 `scripts/ci/serialization-decode-view-regression.test.mjs` → `runSourceTests`，
子进程清除 `NODE_TEST_CONTEXT`，全部 IO 只写项目内
`.run-logs/project-only-validation/source-tests-*` 沙箱，不触网、不占端口、
不使用真实用户目录、系统 TEMP 或真实 `.zcodium`。

## 实施证据

- 红（修复前，`packages/rpc/test/serializationDecodeViews.test.ts`，沙箱
  `red-decode-Smv7lE`）：8 tests / 5 pass / 3 fail——拷贝预算（string 反序列化拷贝
  1,497,973 字节）、readString 游标归一（`readString is not a function`）、
  readString 优先探测（calls=0）。
- 绿（修复后，沙箱 `green-decode-KgrtJk`）：8 tests / 8 pass / 0 fail。
- 补强（父代理 review 要求，直接对修复后代码实测，沙箱 `green2-decode-LIFEja`）：
  10 tests / 10 pass / 0 fail。预算用例增加计数块外 `deepEqual` 内容校验与
  `t.diagnostic` 实测字节；新增负 bytes 相对末端归一、readByte 越界后 readString
  不倒退两个用例。实测数字（普通 `Uint8Array` 帧，ASCII 恰 1MiB fixture）：
  string wire payload 1,048,576 字节 / frame 1,048,603 字节 / JS slice/set copied 0 字节；
  object JSON payload 1,048,590 字节 / frame 1,048,617 字节 / copied 0 字节。
  首轮红的 1,497,973 字节来自 UTF-8 fixture（"汉字😀"重复，payload 1,497,960 字节），
  与本节 ASCII fixture 不是同一载荷，不作同口径比较；性能结论以普通 `Uint8Array` 帧
  slice/set=0 与首轮真实 red 记录为准，不混用两种 fixture 的比例。
- 既有回归继续绿：packages/rpc 5 文件 55 passed（`green-rpc` 沙箱）、
  packages/ui 的 performanceRound10RpcCopies / performanceRound7RpcQueues /
  performanceRound11TransportCodec 3 文件 17 passed（`green-rpc-ui` 沙箱）。
- 变更文件：`packages/rpc/src/serialization.ts`（+私有 `IStringReader` 接口、
  `isStringReader`/`readDecodedPayload` helper、`BufferReader.readString`、
  String/Object 两分支改调用；`slice`/`read`/`Buffer`/`VSBuffer` 路径零改动）、
  新增 `packages/rpc/test/serializationDecodeViews.test.ts`、
  新增 `scripts/ci/serialization-decode-view-regression.test.mjs`、本 spec。
