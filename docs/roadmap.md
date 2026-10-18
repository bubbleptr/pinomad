# 路线图

只放方向和顺序。具体条目、规格和状态都在 GitHub Issues，按 milestone 分组（用法见 `docs/agents/issue-tracker.md`）；PR 用 `Closes #N` 关闭条目，这份文件只在阶段或顺序变化时改。

## 现在

1. **[iOS 原生替换（ADR-0024）](https://github.com/bubbleptr/pinomad/milestone/1)**：推送接入 → 替换验收、TestFlight 替换 Expo 版 → 用满一周后删除 `apps/mobile`。账号和它并行，不挡替换。推送也补上 M5"知道它跑完了或在等你"的最后一块。
2. **[M3 在哪都能连](https://github.com/bubbleptr/pinomad/milestone/3)**：各客户端切到 `app.pinomad.si` 后摘掉旧域名。

## 以后

- [Backlog](https://github.com/bubbleptr/pinomad/issues?q=is%3Aopen+is%3Aissue+no%3Amilestone+-label%3Alater+-label%3Atech-debt)：没排进阶段的具体小项
- [`later`](https://github.com/bubbleptr/pinomad/issues?q=is%3Aopen+is%3Aissue+label%3Alater)：等有明确需求再做的想法，相关的合在一个伞形 issue 里
- [`tech-debt`](https://github.com/bubbleptr/pinomad/issues?q=is%3Aopen+is%3Aissue+label%3Atech-debt)

## 已完成的阶段

M1 并行任务的审阅与对齐 · M2 coding 能力补齐 · M2.5 搬入 Pace 的界面 · M4 客户端完善（桌面端、设置） · [M5 手机推进 side project](https://github.com/bubbleptr/pinomad/milestone/2)（推送随 iOS 原生替换交付）。细节在对应的 ADR 和 PR 里。

## 不在计划内

- Windows 宿主（ADR-0009）
- Serverless / 云端宿主（ADR-0003）
- 兼容 Pi CLI 的扩展、配置和会话格式（ADR-0001）
- 声明式视图树，等标准展示类型确实不够用时再考虑（ADR-0005）
