# 第三方来源与发布前许可核对

本文件是来源核对清单，不构成对第三方代码的许可授予。当前源码没有完整的项目 LICENSE；作者需选定自有代码许可证，并明确第三方例外后再作为正式开源版本发布。

| 范围 | 已有证据 | 待补材料 |
| --- | --- | --- |
| python/rebind_worker/registration_core/sentinel_assets/sdk_20260810913b.js | 内嵌压缩 Sentinel SDK，运行时校验哈希；文件含 UUID 项目引用 | SDK 来源版本、适用许可及再分发依据，内嵌依赖的版权和通知 |
| python/rebind_worker/registration_core/auth_flow.py | 源码注释引用 any-auto-register，部分位置标注 MIT | 对应上游版本、实际复制范围、原作者版权声明和 MIT 正文 |
| python/rebind_worker/registration_core/config.py | 注释声明从 CTF-reg/config.py 剥离 | 原项目归属、版本与适用许可 |
| 其他 registration_core/rebind_core 文件及 SDK bridge | 存在内嵌与本地修改代码 | 按文件确认来源、版权和修改记录 |

上述来源注释保留，未作为敏感信息删掉。为保持与服务功能对应，候选包保留这些文件；这不代表已确认可公开再分发。若发布前仍缺许可证据，应从正式发布包中剥离对应组件并调整加载/安装流程，而不是直接删除版权说明。

Node依赖由 package-lock.json 锁定；Python依赖由 python/rebind_worker/requirements.txt 声明。依赖安装目录及浏览器二进制不随包分发。依赖本身分别适用其许可证，安装后应保留其 LICENSE/NOTICE。
