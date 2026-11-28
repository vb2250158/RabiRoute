const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function compatibleUsage(usage) {
  const inputTokens = count(usage?.prompt_tokens);
  const outputTokens = count(usage?.completion_tokens);
  const reportedCache = count(usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens);
  const cachedTokens = inputTokens === undefined || reportedCache <= inputTokens ? reportedCache : undefined;
  const uncachedTokens = count(usage?.prompt_cache_miss_tokens)
    ?? (inputTokens !== undefined && cachedTokens !== undefined ? inputTokens - cachedTokens : undefined);
  return { inputTokens, outputTokens, cachedTokens, uncachedTokens,
    measuredCacheInput: cachedTokens !== undefined ? inputTokens : undefined };
}

export function workBuddyUsage(receipt, model) {
  const turn = receipt?._meta?.['codebuddy.ai/turnUsage'];
  const scoped = turn?.version === 1 && turn.scope === 'turn' && turn.kind === 'snapshot' ? turn : undefined;
  const stages = Array.isArray(scoped?.stages) ? scoped.stages : [];
  // The formatted CLI call starts one non-persistent session. Ignore aggregate
  // metrics if the provider shows that the turn used another model or tool.
  if (stages.some(stage => stage?.source !== 'model' || stage.model !== model)) return {};
  const usage = scoped?.total?.usage ?? receipt?.usage;
  const uncached = count(usage?.input_tokens);
  const cachedTokens = count(usage?.cache_read_input_tokens);
  const cacheCreation = count(usage?.cache_creation_input_tokens);
  const uncachedTokens = uncached !== undefined && cacheCreation !== undefined ? count(uncached + cacheCreation) : uncached;
  const measuredCacheInput = cachedTokens !== undefined && uncachedTokens !== undefined ? count(cachedTokens + uncachedTokens) : undefined;
  const credits = scoped?.total?.creditStatus === 'known' && typeof scoped.total.credits === 'number'
    && Number.isFinite(scoped.total.credits) && scoped.total.credits >= 0 ? scoped.total.credits : undefined;
  return { inputTokens: measuredCacheInput ?? uncached, outputTokens: count(usage?.output_tokens),
    cachedTokens, uncachedTokens, measuredCacheInput, credits };
}
