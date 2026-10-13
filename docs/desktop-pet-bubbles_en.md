English | [简体中文](desktop-pet-bubbles.md)

# Desktop pet bubbles and speech

The context menu's size entry shows the current percentage. Open it to drag a slider from 10% to 200% in 1% increments. Changes save automatically and are restored when reopening the menu or restarting.

Enable “显示气泡” (Show bubbles) in the pet's context menu. Companion comments, task results and local persona speech share an ordinary dialogue bubble. When a RabiSpeech host FIFO job starts and its `voice` matches the pet's persona ID, the bubble shows its text and the pet uses the talking action. After playback, it stays for eight seconds by default. Ordinary notices do not replace active speech text.

The bubble shows text only. Long text scrolls, capped at 4,000 characters. It does not take focus. Click-through also applies to the bubble. Hiding the pet or disabling bubbles affects display; audio remains under the speech queue's controls.

Choose “气泡样式…” (Bubble style) from the context menu to preview and save the cat-paw or plain skin, system font, size (12–24 px), text color, width (220–480 px), opacity (50–100%) and lifetime (2–30 seconds). The plain skin also supports background and outline colors. The persona's pet panel exposes the same settings. Each persona saves its own style, restored after restart. Nine-slice rendering keeps the bottom-right paw fixed in size. An independent pointer tracks the visible pet artwork’s horizontal center while the frame clamps to screen edges. If there is insufficient room above, the bubble moves below the pet with an upward pointer. Text remains clear of the decoration.

Desktop subscribes to Manager `/api/speech/events` and reads `/api/speech/playback/status` to restore currently playing speech. Reconnection neither displays completed history nor replays audio. Qt renders only; RabiSpeech owns synthesis, playback, cache and queue state.

Manager owns the persona binding's `bubbleStyle`, updated through the existing `/api/desktop-pet/roles/{personaId}` endpoint. Desktop does not write settings files. The desktop runtime includes `rabiroute_tray/assets/bubble-cat-paw-body-v2.png`; the asset notes describe slice ratios and fixed destination sizes. Browser-local audio, remote playback and voices without a matching persona ID do not attach to the local pet.
