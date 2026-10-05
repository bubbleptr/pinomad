# PiNomad

以 coding 为核心的 agent 产品：自托管宿主负责可恢复的执行，桌面、Web、移动端作为客户端提供一致的界面。

## Language

### 部署

**宿主（Host）**:
一台具体的机器，运行 Harness、独占 Durable 存储，并以本机的 shell 和代码仓库作为执行环境。
_Avoid_: 服务器、后端、server

**客户端（Client）**:
只通过宿主协议观察和操作宿主的界面端，不持有执行状态。桌面端即使和宿主在同一台机器上也算客户端。
_Avoid_: 前端、宿主界面、viewer

### 工作组织

**项目（Project）**:
用户在宿主上手动登记的一个本地目录，是对话归属和执行的根。不要求是 Git 仓库；不从历史对话或文件系统扫描自动产生；移除项目不删除目录和历史对话。
_Avoid_: 工作区、workspace、仓库、会话

**对话（Conversation）**:
一个任务的完整交互单元：消息、工具调用和运行状态，可恢复、可 fork、可归档，归属某个项目或 Chat。从对话中 fork 出的对话和子代理的对话挂在发起它的对话下面，以 thread 的形式呈现，不单独出现在顶层列表。
_Avoid_: 会话、Session、thread（作为独立概念）、channel

**Chat**:
不属于任何项目的对话。每条 Chat 有宿主为它准备的独立临时目录，不进入项目登记表。
_Avoid_: 临时项目、默认项目、无项目项目

**执行检出（Execution Checkout）**:
对话中的 agent 实际读写文件的那一份代码所在的目录：项目目录本身，或在 Git 项目中由 PiNomad 为该对话管理的 worktree；Chat 的执行检出是它的临时目录。它是并发对话之间隔离文件的边界。工作目录（cwd）可以是执行检出里的子目录；一个 worktree 对应一个分支，但执行检出关心的是文件在哪改，不是分支历史。
_Avoid_: 工作目录、cwd、分支、工作副本

### 扩展与呈现

**内置扩展（Built-in Extension）**:
由 PiNomad 自己实现、按插件边界组织的功能单元。核心只通过扩展注册表认识它。
_Avoid_: 内置功能、模块、插件（未公开协议前）

**展示类型（Presentation Type）**:
PiNomad 定义、带运行时 schema 的结构化数据类型，符合时各客户端用设计系统统一渲染。
_Avoid_: 组件、widget、UI 插件

**兜底渲染（Fallback Rendering）**:
对不符合任何展示类型的结构化数据，用通用的 JSON 树或键值列表展示。
_Avoid_: 原始输出、debug 视图
