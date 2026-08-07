export function knowledgePageShouldWork(
  visibilityState: DocumentVisibilityState | undefined,
  mounted: boolean
): boolean {
  return mounted && visibilityState !== "hidden";
}
