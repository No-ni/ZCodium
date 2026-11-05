# Developer docs Vite adapters

stdioTrafficApiPlugin提供既有只读tail API；featureBoundaryGraphPlugin提供既有本地YAML虚拟模块。vite.config.ts仅消费这两个公开工厂。

数据根优先级与services paths一致，仅读取当前fork .zcodium；不开启抓包、采样或上传，不持有用户业务状态。图谱源仍归原feature planner与legacy normalize owner；移动文件必须保留源路径、HMR及构建语义。
