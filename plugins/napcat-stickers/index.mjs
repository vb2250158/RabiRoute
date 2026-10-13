// Old NapCat releases expose favorite URLs but omit their native descriptions.
// Reuse OneBot's existing authentication and the account's native collection owner.
let registration;
export const plugin_init = async ctx => {
  const actionName = 'fetch_custom_face_detail';
  if (ctx.actions.get(actionName)) return;
  const service = ctx.core.context.session.getMsgService();
  if (typeof service.fetchFavEmojiList !== 'function') throw new Error('QQ favorite metadata is unavailable');
  const execute = async (payload = {}, echo) => {
    const count = payload.count ?? 48;
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      return { status: 'failed', retcode: 1400, message: 'count must be 1-1000', data: null, echo };
    }
    try {
      const value = await service.fetchFavEmojiList('', count, true, true);
      if (value.result !== 0 || !Array.isArray(value.emojiInfoList)) throw new Error('favorite read failed');
      const data = value.emojiInfoList.slice(0, count).map(item => ({
        md5: item.md5, desc: item.desc ?? '', url: item.url
      }));
      return { status: 'ok', retcode: 0, data, echo };
    } catch { return { status: 'failed', retcode: 200, message: 'QQ favorite metadata read failed', data: null, echo }; }
  };
  const action = {
    actionName, useStream: false, actionSummary: '读取 QQ 收藏表情 ID 和名字', actionTags: ['QQ'],
    handle: async (payload, _adapter, _config, _request, echo) => execute(payload, echo),
    websocketHandle: async (payload, echo) => execute(payload, echo),
    check: async () => ({ valid: true })
  };
  // NapCat exposes a shared lookup object, not a mutable Map. All existing
  // HTTP/WS adapters retain this object and therefore use the same lookup.
  const originalGet = ctx.actions.get;
  const lookup = function (name) {
    return name === actionName ? action : originalGet.call(this, name);
  };
  ctx.actions.get = lookup;
  registration = { actions: ctx.actions, originalGet, lookup };
};
export const plugin_cleanup = async () => {
  if (registration && registration.actions.get === registration.lookup) registration.actions.get = registration.originalGet;
  registration = undefined;
};
