export function captionSettings(config) {
  return { enabled: config.captionsEnabled, locked: config.captionLocked, skin: config.captionSkin,
    fontSize: config.captionFontSize, opacity: config.captionOpacity, position: config.captionPosition,
    bounds: config.captionHasBounds ? { x: config.captionX, y: config.captionY, width: config.captionWidth, height: config.captionHeight } : null }
}
