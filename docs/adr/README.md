# ADR 索引

ADR 只记录同时满足三条的决策：难以回退、没有上下文会让人意外、确实有过取舍。分期计划和待办放在 [路线图](../roadmap.md)，用法放在仓库根目录的 README，术语放在 `CONTEXT.md`。

已接受的 ADR 不改写决策；被后来的 ADR 取代或补全时，在原文标注并在这里记录。

## 产品定位

| ADR | 一句话 |
| --- | --- |
| [0001](0001-own-the-ui-contract.md) | PiNomad 拥有自己的 UI 契约，不兼容 Pi CLI 的扩展、配置和会话格式 |
| [0003](0003-self-hosted-host-remote-clients.md) | 以 coding 为核心：自托管宿主执行，桌面 / Web / 移动端都只是客户端 |
| [0004](0004-built-in-first-plugin-protocol-later.md) | 先内置后开放：内置功能按扩展边界写，满足三个条件才公开插件协议 |

## 运行时与呈现

| ADR | 一句话 |
| --- | --- |
| [0002](0002-pi-durable-as-runtime.md) | 以 Pi Durable 的 Harness 为内核，Durable 存储是唯一事实来源 |
| [0005](0005-structured-presentation-types.md) | 插件状态通过带运行时 schema 的展示类型呈现，不符合时兜底渲染 |

## 宿主能力与工作组织

| ADR | 一句话 |
| --- | --- |
| [0006](0006-host-tools-and-context-sources.md) | 宿主默认提供编码工具、默认不审批，上下文只从项目和 `~/.agents` 读取 |
| [0007](0007-projects-and-conversations.md) | 工作组织是"项目 → 对话"，不用 channel；归档代替删除 |
| [0010](0010-worktree-execution-checkout.md) | Git 项目的对话默认在数据目录下的独立 worktree 里工作，fork 得到新 worktree |
| [0011](0011-ask-user-question-replaces-approval.md) | 不做审批闸门；agent 用阻塞式的结构化提问和用户对齐，取代 `pinomad.approval` |

## 远程与运维

| ADR | 一句话 |
| --- | --- |
| [0008](0008-remote-access-pairing-and-secure-channel.md) | 远程访问：协议层 Noise 端到端加密、扫码配对、中继分期 |
| [0009](0009-host-lifecycle.md) | 宿主作为用户级系统服务常驻，源码检出升级，等空闲重启 |

## 遗留项的去向

| 原 ADR 中的遗留项 | 现状 |
| --- | --- |
| 0003：远程访问怎么认证、加密 | 已由 0008 决定 |
| 0003：宿主生命周期 | 已由 0009 决定 |
| 0003：会话、项目、执行检出和 Durable 对话怎么对应 | 已由 0007 决定 |
| 0007：worktree 执行检出、fork 时检出怎么处理 | 已由 0010 决定 |
| 0006：做远程访问前先定认证和审批策略 | 认证已由 0008 决定；审批闸门由 0011 决定不做 |
| 0005：`pinomad.approval` | 由 0011 换成 `pinomad.question` |
| 其余"以后再做" | 统一收在[路线图](../roadmap.md) |
