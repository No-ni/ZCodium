# E2E report

node adapter提供现有显式报告读取和viewer URL；viewer拥有加载状态并只展示summary/trend事实，shared是纯类型。Chart tooltip使用解析的纵轴值，与曲线和采样一致。

报告缺失/趋势加载失败沿原错误面显示；不将未知采样归为真实0，不引入采样、上传、业务状态或官方网络资源。公开index兼容既有node入口。
