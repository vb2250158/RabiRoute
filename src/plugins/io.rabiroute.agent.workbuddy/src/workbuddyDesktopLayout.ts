export const legacyWorkbuddyDesktopLayout = Object.freeze({
  pageClass: "wb-home-page",
  editorContainerClass: "cr-input-container",
  sendButtonClass: "cr-send-button",
  newTaskTabClass: "conversation-list-tab-button",
  workspaceButtonClass: "cr-workspace-picker",
  workspaceMenuClass: "cr-workspace-picker-dropdown",
  workspaceOptionClass: "cr-workspace-picker-popover__item",
  workspacePickerComponent: "WorkspacePicker",
  inputScopeComponent: "InputBoxScope"
});

export type WorkbuddyDesktopLayout = Readonly<Record<keyof typeof legacyWorkbuddyDesktopLayout, string>>;

const keys = Object.keys(legacyWorkbuddyDesktopLayout) as Array<keyof WorkbuddyDesktopLayout>;
const identifier = /^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/;

/** Only bounded class and component identifiers may cross the local creation protocol. */
export function isWorkbuddyDesktopLayout(value: unknown): value is WorkbuddyDesktopLayout {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length) return false;
  const fields = value as Record<string, unknown>;
  return keys.every(key => Object.hasOwn(fields, key) && typeof fields[key] === "string" && identifier.test(fields[key]));
}

export function isLegacyWorkbuddyDesktopLayout(layout: WorkbuddyDesktopLayout): boolean {
  return keys.every(key => layout[key] === legacyWorkbuddyDesktopLayout[key]);
}
