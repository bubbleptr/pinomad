# Inbox 消息量评测

ADR-0052 §5：用一组录好的事件，让真实模型跑 Inbox 任务，看每项任务的结局是不是期望的那种：通知用户（`notify`）、安静结束、停下来提问。用来调默认规则（`apps/host/src/inbox-memory.ts` 的 `ENDING_A_RUN`）。要调用真实模型，所以不进 CI。

## 跑法

在仓库根目录：

```sh
ANTHROPIC_API_KEY=… node apps/host/eval/inbox-notify.ts --model anthropic/claude-haiku-5-5 --budget 5
```

- `--model`：`provider/model`，默认 `anthropic/claude-haiku-5-5`。
- 凭据：模型的 API key 走环境变量（pi 认的那些，如 `ANTHROPIC_API_KEY`）；或者 `--auth <auth.json>`，把一份 PiNomad / pi 的 `auth.json` 复制进临时数据目录。注意 OAuth 凭据在副本里刷新时可能轮换 refresh token，让原文件里的失效，所以优先用 API key。
- `--budget`：美元上限，默认 5；花到上限后剩下的用例记为 `skipped`。
- `--only <名字片段>`：只跑名字含这段的用例。
- `--pass-score`：过线分数，默认 0.75；没过线时退出码为 1。

每个用例一个临时 Git 项目和一个临时数据目录，跑完都删掉，不碰 `~/.pinomad`。

## 用例

`apps/host/eval/inbox-notify-cases.json`：每条有名字、期望结局（`notify` / `quiet` / `ask`）、要预先放进项目的文件和事件。加用例时让期望结局一目了然：例行的、不需要用户知道的是 `quiet`；坏了、或者用户说过要知道的是 `notify`；只有用户能定的取舍是 `ask`。

## 结果

每个用例打一行 `PASS` / `FAIL` 和花费，最后输出 JSON（分数、总花费、逐条结果）。运行失败（凭据错、提供方报错）记为 `error`，不会被当成安静结束。
