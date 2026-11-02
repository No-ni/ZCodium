# workflow-analysis-helpers

只消费原 TaintState/Evaluator 持有的值图、map/set 和当前发射参数；不保存第二份不动点状态，不增加 IO，公开方法与发射顺序沿原 owner。

范围仅为列出的现有帮助函数与类型；跨模块消费从原公开入口或此类型合同读取。状态不搬迁，运行参数仍由原调用方提供。
