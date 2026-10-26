# 更正后的证据（2026-10-26）

第一版 PR0b 评论把“DataChannel 重复交付”归因给了 str0m。后续核对 PR0a 的
`sendMessageBinary` 语义后确认：`node-datachannel` 在缓冲满时**先入队、再返回 false**。
第一版 `peer.mjs` 在 false 时没有 `shift`，下一轮会把同一条 Noise 密文再次入队，
因此制造了相邻重复记录。错误在 Node 对端，不在 str0m。

本目录的证据使用修正后的 `node/peer.mjs`：

- false 后无条件消费该记录，不重试；
- 按 `bufferedAmount()` 的高水位（256 KiB）发送；`onBufferedAmountLow`（64 KiB）唤醒；
- 保留 50 ms 兜底轮询，仅用于漏回调，不是逐条节流；
- 不启用任何密文去重。

`summary.csv` 是汇总；每次运行的 `*.app.log` 是 iOS 证据，`*.node.log` 是
Node/libdatachannel 侧证据。地址已替换为 RFC 5737 / RFC 3849 示例。

旧证据（第一版错误归因那次）已从当前树删除；它在 git 历史中仍可查。
