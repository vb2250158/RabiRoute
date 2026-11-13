/** Content identities only. Executable paths are resolved by the original package owners. */
export function desktopQtPackageRef(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || !value.id.trim() || typeof value.version !== 'string' || !value.version.trim() || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) throw new Error('An imported Qt resource package id, version and exact revision are required.');
  return Object.freeze({ id: value.id, version: value.version, revision: value.revision });
}
export function desktopResourceReference(value, previous = {}) {
  if (typeof value === 'string') value = { digest: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A desktop release digest or resource reference is required.');
  const digest = Object.hasOwn(value, 'digest') ? value.digest : previous.digest ?? null;
  if (digest !== null && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) throw new Error('The native desktop release digest is invalid.');
  return Object.freeze({ digest, qtPackageRef: desktopQtPackageRef(Object.hasOwn(value, 'qtPackageRef') ? value.qtPackageRef : previous.qtPackageRef) });
}
export function sameDesktopResourceReference(a, b) {
  return (a.digest ?? null) === (b.digest ?? null) && a.qtPackageRef?.id === b.qtPackageRef?.id && a.qtPackageRef?.version === b.qtPackageRef?.version && a.qtPackageRef?.revision === b.qtPackageRef?.revision;
}
