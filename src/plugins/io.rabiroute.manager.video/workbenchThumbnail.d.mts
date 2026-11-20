import type { Point, WorkbenchCanvas } from "./web/pages/workbenchEditor";

export type CanvasThumbnail = {
  viewBox: string;
  nodes: { id: string; x: number; y: number; width: number; height: number; enabled: boolean }[];
  wires: string[];
};

export function wirePath(from: Point, to: Point): string;
export function wireBend(from: Point, to: Point): number;
export function canvasGraphThumbnail(canvas: WorkbenchCanvas): CanvasThumbnail | undefined;
