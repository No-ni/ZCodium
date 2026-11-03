# provider-endpoint-routing

只解析用户自选 Provider 的现有路由端口；无官方鉴权、账号或自动端点回退。

实现范围固定在本模块列出的当前源码，不接管其他模块的数据。跨模块调用沿原公开入口；module.ts 的 requires 来自实际 imports。新增或修改行为前按对应产品 spec 更新验收；本次职责登记不改变执行顺序或默认开关。

Bootstrap 的跨包类型声明通过 `@zcode/adapters/provider-endpoint-routing` 与 `@zcode/adapters/provider-endpoint-routing-options` 两个精确公开入口引用 adapters 编译后的声明，不直接导入 adapters/src。两个入口只公开现有工厂与选项类型，不扩张为整个 model namespace；Bootstrap 自身入口仍引用本包源码。验收使用真实 Bootstrap NodeNext/rootDir 编译，声明文件不得把另一个包的源码纳入本包输出。

运行时仍复用 `@zcode/adapters/model` 的现有直连工厂，保留用户 URL 与取消语义，没有配置、凭据或官方网络回退。
