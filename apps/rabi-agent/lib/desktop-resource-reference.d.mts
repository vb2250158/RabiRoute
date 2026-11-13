export type DesktopQtPackageRef = Readonly<{ id: string; version: string; revision: string }>;
export type DesktopResourceReference = Readonly<{ digest?: string | null; qtPackageRef?: DesktopQtPackageRef | null }>;
export function desktopQtPackageRef(value: unknown): DesktopQtPackageRef | null;
export function desktopResourceReference(value: unknown, previous?: DesktopResourceReference): Readonly<{ digest: string | null; qtPackageRef: DesktopQtPackageRef | null }>;
export function sameDesktopResourceReference(a: DesktopResourceReference, b: DesktopResourceReference): boolean;
