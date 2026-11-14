export const rabiAgentToolPolicy = Object.freeze({
  classify(decision) {
    if (decision.name === 'close_app' && Object.keys(decision.arguments).length) {
      throw Object.assign(new Error('TURN_TOOL_INVALID'), { code: 'TURN_TOOL_INVALID' });
    }
    const mutation = decision.name === 'rabi_api_call'
      && ((decision.arguments.mode === 'websocket' && decision.arguments.messages?.length > 0)
        || !['GET', 'HEAD', 'OPTIONS'].includes(String(decision.arguments.method || '').toUpperCase()));
    return { mutation };
  },
  inspectOutcome(result, decision) {
    const terminal = decision.name === 'close_app'
      && result?.local === true && result.terminal === true && result.requested === true;
    const known = terminal || result?.duplicate === true && result.state === 'completed'
      || typeof result?.result?.structuredContent?.ok === 'boolean' || result?.result?.isError === true;
    return {
      uncertain: Boolean(!known || result?.uncertain || result?.cancelled
        || result?.result?.structuredContent?.uncertain || result?.duplicate && result.state !== 'completed'),
      failed: Boolean(result?.result?.isError || result?.result?.structuredContent?.ok === false),
      terminal
    };
  }
});
