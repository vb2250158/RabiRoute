import assert from "node:assert/strict";
import test from "node:test";
import { registerSourcePluginTranslations } from "./plugin-translation-test-host";
import { setLocale, translateText } from "../src/i18n/index";

const dispose = await registerSourcePluginTranslations();
test.after(dispose);
test("automatic port hints and unpublished listener states translate without changing their numeric contract", () => {
  try {
    setLocale("en");
    assert.equal(translateText("等待监听就绪"), "Waiting for the listener");
    assert.equal(translateText("0 表示自动分配，监听就绪后显示实际地址。"), "0 assigns a port automatically. The actual address appears when the listener is ready.");
    assert.equal(translateText("WS 端口必须是 0-65535 的整数；0 表示自动分配"), "WS port must be an integer from 0 to 65535; 0 assigns automatically");
    assert.equal(translateText("本机回调地址"), "Local callback URL");
    assert.equal(translateText("NapCat WebSocket 监听尚未就绪；就绪后会显示当前连接地址。"), "The NapCat WebSocket listener is not ready. Its current address appears when ready.");
    setLocale("ja");
    assert.equal(translateText("等待监听就绪"), "リスナーの準備を待っています");
    assert.match(translateText("0 表示自动分配，监听就绪后显示实际地址。"), /0.*自動割り当て/);
  } finally { setLocale("zh-CN"); }
});
