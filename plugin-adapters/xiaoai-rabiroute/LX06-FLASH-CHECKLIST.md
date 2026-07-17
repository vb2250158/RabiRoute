<!-- docs-language-switch -->
<div align="center">
English | <a href="./LX06-FLASH-CHECKLIST_zh.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# LX06 flashing research checklist

> Status: high-risk historical research. RabiRoute does not ship firmware, a flashing tool, or a supported speaker image. Revalidate every command against the current [Open-XiaoAI upstream](https://github.com/idootop/open-xiaoai), exact LX06 hardware, and firmware before use.

Target investigated by the original notes: Xiaomi XiaoAI Speaker Pro, model `xiaomi.wifispeaker.lx06`.

## Safety gate

Flashing may void the warranty, erase data, or brick the device. Stop unless the owner has accepted that risk and a verified recovery path exists.

Never publish serial numbers, MAC addresses, QR codes, Wi-Fi credentials, SSH passwords, Xiaomi account credentials, firmware obtained under restricted terms, or local device addresses.

## Repository preparation

The current repository-owned files are:

```text
plugin-adapters/xiaoai-rabiroute/index.mjs
plugin-adapters/xiaoai-rabiroute/smoke-send.mjs
plugin-adapters/xiaoai-rabiroute/xiaoai-local.config.example.json
examples/data/route/xiaoai/adapterConfig.json
docs/xiaoai-integration/xiaoai-roleMessageConfig-snippet.json
```

They prepare the PC bridge only. They do not make an LX06 flash safe or supported.

## Pre-flash acceptance

Before writing any partition, record and verify:

1. Exact model, board revision, and current firmware.
2. A current upstream instruction set that explicitly supports that combination.
3. A data-capable cable, recognized USB device, and correct driver.
4. The checksum and provenance of the patched image.
5. A tested recovery method and the original boot partition.
6. A local backup of non-secret configuration needed for recovery.

Do not infer support from another XiaoAI model or from an old LX06 guide.

## Historical command outline

The previous investigation used an Amlogic tool to identify the device, set `boot_part` to `boot0`, and write a patched image to `system0`. These commands are intentionally not presented as a copy-paste procedure because the repository no longer contains the upstream version they came from.

Only after current upstream verification should an operator translate that outline into exact commands. Capture the tool version, firmware hash, identify output, and recovery command in a private work log before execution.

## Post-flash integration boundary

If a supported image boots and SSH access works, install the speaker client according to the current upstream instructions. Keep its server address and credentials in ignored local configuration.

The PC side still requires:

- An Open-XiaoAI-compatible process, commonly on port `4399`.
- This bridge on `127.0.0.1:8798`.
- An enabled RabiRoute XiaoAI Route on the configured Webhook port.
- Explicit speaker-side handling for `intercept` and reply playback.

An SSH reverse tunnel is an optional network workaround, not part of the flashing proof.

## Recovery

Do not begin without a verified way to return to the original boot partition or restore the original system image. The old notes referenced `boot1` as the original partition, but that must be confirmed on the actual device before changing anything.

## Acceptance evidence

A complete environment acceptance needs separate proof for:

- Device boots and remains recoverable.
- Speaker client reconnects after reboot.
- Non-matching speech leaves native XiaoAI untouched.
- Matching speech produces `intercept` and actually aborts native handling.
- RabiRoute logs and routes the transcript.
- Desktop IPC delivers the prompt to the loaded task.
- A real reply reaches speaker playback.

The current repository proves only the PC bridge and Route-side pieces, not the full list.
