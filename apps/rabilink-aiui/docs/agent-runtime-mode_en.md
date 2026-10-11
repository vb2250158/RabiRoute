English | [简体中文](agent-runtime-mode.md)

# AIUI inference ownership

The glasses page always executes conversation through Rokid's native `LanguageModel`. Credentials, personas and PC connectivity do not change the executor. A persona supplies Skills and instructions without restricting API permissions. The PC owns the mailbox and receipts; the phone forwards wake requests only.

`mode=transcription` and `mode=configuration` select states of the same page. The legacy remote observer, speech-upload queue and remote-reply playback queue are retired. Existing local records are neither read nor deleted. New delivery uses [deviceAgent](device-agent_en.md), with no second model or silent executor switch.
