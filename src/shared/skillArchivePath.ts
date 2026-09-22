/** Portable archive path component, shared by HTTP validation and checked file enumeration. */
export function isPortableSkillArchiveSegment(segment: string): boolean {
  return Boolean(segment) && segment !== "." && segment !== ".."
    && !/[\x00-\x1f\x7f/\\:<>"|?*]/.test(segment)
    && !/[. ]$/.test(segment)
    && !/^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i.test(segment)
    && Buffer.byteLength(segment) <= 255;
}
