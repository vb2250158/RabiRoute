import type { ComputerExecutionContext, ComputerSettings } from "./computer-control-contract.mjs";
import type { DesktopQtPackageRef, DesktopResourceReference } from "./desktop-resource-reference.mjs";
export type ComputerPresentationTheme = { theme: string; customThemes?: readonly unknown[]; customTheme?: unknown };
export class ComputerService {
  constructor(options?: { onChange?: () => void; onControlChange?: () => void; uploadHistoryRoot?: string; historyIo?: unknown;
    qtPresentation?: { command: string; args: string[] }; getPresentationTheme?: () => ComputerPresentationTheme | undefined;
    instanceId?: string | (() => string); getSettings?: () => unknown; getDefinition?:()=>import("./computer-control-contract.mjs").ComputerSettingsDefinition; receiptRoot?: string;
    restoreDesktopRelease?: () => Promise<{ revision: number; reference?: string; version?: string; qtPackageRef?: DesktopQtPackageRef }>;
    commitDesktopRelease?: (release: { version: string; digest?: string; qtPackageRef?: DesktopQtPackageRef | null }, expectedRevision: number) => Promise<{ revision: number }>;
    resolveDesktopRelease?: (reference: unknown, previous?: DesktopResourceReference, context?: { restoring?: boolean }) => Promise<{ version: string; digest?: string; qtPackageRef?: DesktopQtPackageRef | null; presentationIssue?: Readonly<{ code: string; message: string }>; nativeOptions?: { executable?: string; args?: string[]; qtPresentation?: { command: string; args: string[] } | null; presentationIssue?: Readonly<{ code: string; message: string }> } }>;
    nativeFactory?: (options: { children: Set<unknown>; timeout: (key: string, fallback: number) => number; release: { version: string; digest?: string; qtPackageRef?: DesktopQtPackageRef | null } }) => unknown;
    timeout?: (key: string, fallback: number) => number; maxUploadBytes?: number; maxConcurrentIo?: number;
    maxActiveUploads?: number; maxUploadRecords?: number });
  desktopReleaseStatus(): Promise<Readonly<{ revision: number; release: unknown; state: string }>>;
  prepareDesktopRelease(reference: unknown): Promise<unknown>;
  activateDesktopRelease(prepared: unknown, expectedRevision: number): Promise<unknown>;
  discardDesktopRelease(prepared: unknown): Promise<void>;
  readonly activeCount: number;
  readonly capabilities: string[];
  setPresentationTheme(snapshot?: ComputerPresentationTheme): Promise<void>;
  connectionClosed(): Promise<void>;
  endSource(connectionId: string): Promise<unknown>;
  endTask(taskId: string, sourceId: string): Promise<unknown>;
  execute(input: Record<string, unknown>, context?: ComputerExecutionContext): Promise<unknown>;
  reconcileSettings(context?: Partial<ComputerExecutionContext>): Promise<void>;
  stop(): Promise<void>;
}
