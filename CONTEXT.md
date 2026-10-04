# Durato

以 coding 为核心的 agent 产品：自托管宿主负责可恢复的执行，桌面、Web、移动端作为客户端提供一致的界面。

## Language

### 部署

**宿主（Host）**:
一台具体的机器，运行 Harness、独占 Durable 存储，并以本机的 shell 和代码仓库作为执行环境。
_Avoid_: 服务器、后端、server

**客户端（Client）**:
只通过宿主协议观察和操作宿主的界面端，不持有执行状态。桌面端即使和宿主在同一台机器上也算客户端。
_Avoid_: 前端、宿主界面、viewer

### 扩展与呈现

**内置扩展（Built-in Extension）**:
由 Durato 自己实现、按插件边界组织的功能单元。核心只通过扩展注册表认识它。
_Avoid_: 内置功能、模块、插件（未公开协议前）

**展示类型（Presentation Type）**:
Durato 定义、带运行时 schema 的结构化数据类型，符合时各客户端用设计系统统一渲染。
_Avoid_: 组件、widget、UI 插件

**兜底渲染（Fallback Rendering）**:
对不符合任何展示类型的结构化数据，用通用的 JSON 树或键值列表展示。
_Avoid_: 原始输出、debug 视图
