# PiNomad

English · [中文](README.zh-CN.md) · [pinomad.si](https://pinomad.si)

A self-hosted coding agent built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable). The agent runs on your own machine; the Mac app, the web client, and the iPhone app all attach to the same runs.

![One run streaming live to the Mac app, an iPhone, and the web client](docs/assets/demo.jpg)

<sub>One run, three clients: Mac app (left), iPhone via iPhone Mirroring (center), web (right). The host is a Linux box on the same tailnet.</sub>

- **Your machine does the work.** The host runs on a Mac mini, a Linux box, or a VPS, and the agent uses that machine's shell and repositories.
- **Runs survive crashes and restarts.** Pi Durable checkpoints every model call and tool call, so a restarted host picks up where it stopped.
- **Clients are just windows.** Start a task at your desk, then check on it or steer it from your phone. Devices pair with a one-time QR code and talk to the host over an end-to-end encrypted channel: directly on your LAN or tailnet, or through a relay that only sees ciphertext.

> **Status:** early and moving fast. Pi Durable is itself experimental, and the host and its clients must speak the same protocol major version.

## Quick start

The host needs Node 25+ on macOS or Linux.

```sh
npm i -g pinomad
pinomad host        # data and credentials live in ~/.pinomad
pinomad link        # in another terminal: prints a browser link to the web client
```

Sign in to a model provider under Settings → Providers: a subscription you already pay for (Claude, ChatGPT, Copilot, …), an API key, or your own OpenAI- or Anthropic-compatible endpoint. To click around without one, `pinomad host --faux "hi"` runs a scripted fake model.

## Documentation

User docs live on **[pinomad.si/docs](https://pinomad.si/docs/)**: [getting started](https://pinomad.si/docs/) (connecting your other devices, keeping the host running, clients) and [what the agent can do](https://pinomad.si/docs/features/). Usage, remote access, and the service reference are in Chinese for now: [中文文档](https://pinomad.si/zh/docs/).

For contributors (in Chinese):

| Doc | Covers |
|---|---|
| [Website](docs/website.md) | The pinomad.si site and the hosted app.pinomad.si instance |
| [Architecture overview](docs/architecture.md) | How the parts and languages fit together, with send/receive diagrams |
| [Architecture decisions](docs/adr/README.md) | Why things are the way they are |
| [Roadmap](docs/roadmap.md) | Direction and order; items live in GitHub Issues |
| [Glossary](GLOSSARY.md) | Domain terms |

## Contributing

Running from source, verification, and the release process are in [CONTRIBUTING.md](CONTRIBUTING.md) (Chinese).

## License

[Apache-2.0](LICENSE). PiNomad includes code adapted from [Pi](https://github.com/earendil-works/pi) (MIT) and other projects; their notices are in [`docs/licenses/`](docs/licenses/).
