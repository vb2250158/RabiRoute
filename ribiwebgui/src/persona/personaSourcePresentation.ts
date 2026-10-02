import type { MetaPayload } from "../types";
import type { PersonaSourceDevice } from "./remotePersonaReference";
import { rabiPcVersionLabel } from "../rabiLinkHomeClient";

/** Labels are rebuildable views; values remain the saved local/remote reference keys. */
export function personaSourceOptions(
  meta: Pick<MetaPayload, "rabiName" | "computerName" | "version">,
  devices: PersonaSourceDevice[],
  selectedDeviceId: string,
  translate: (text: string) => string = text => text
) {
  const name = meta.rabiName?.trim() || meta.computerName?.trim() || "";
  const local = {
    title: name ? `${translate("本机")} · ${name}` : translate("本机"),
    subtitle: `${rabiPcVersionLabel(meta.version, translate)} · ${translate("使用本机人格")}`,
    value: "",
    props: { disabled: false }
  };
  const options = devices.map(device => {
    const status = !device.online ? "离线" : !device.supported ? "在线 · 需要更新" : !device.trusted ? "在线 · 将自动连接" : "在线";
    return {
      title: device.name,
      subtitle: `${rabiPcVersionLabel(device.rabiPcVersion, translate)} · ${translate(status)}`,
      value: device.deviceId,
      props: { disabled: !device.online && device.deviceId !== selectedDeviceId }
    };
  });
  if (selectedDeviceId && !options.some(option => option.value === selectedDeviceId)) {
    options.push({
      title: selectedDeviceId,
      subtitle: `${rabiPcVersionLabel(null, translate)} · ${translate("已保存的远端 PC · 状态待核对")}`,
      value: selectedDeviceId,
      props: { disabled: false }
    });
  }
  return [local, ...options];
}
