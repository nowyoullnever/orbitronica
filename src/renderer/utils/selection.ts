import type { MultiSelection, Orbit, Planet, Selection } from "../state/types";
import { ellipsePoint } from "./geometry.ts";

export const emptySelection: Selection = { orbitId: null, planetId: null, barId: null };
export const emptyMultiSelection: MultiSelection = { orbitIds: [], planetIds: [] };

export const selectSingleState = (selection: Selection) => ({
  selection,
  multiSelection: emptyMultiSelection
});

export const selectMultipleState = (orbitIds: string[], planetIds: string[]) => ({
  selection: emptySelection,
  multiSelection: { orbitIds, planetIds }
});

export const clearSelectionState = () => ({
  selection: emptySelection,
  multiSelection: emptyMultiSelection
});

type MarqueeBounds = { sx: number; sy: number; x: number; y: number };

export function collectMarqueeSelection(orbits: Orbit[], planets: Planet[], bounds: MarqueeBounds): MultiSelection {
  const x0 = Math.min(bounds.sx, bounds.x), x1 = Math.max(bounds.sx, bounds.x);
  const y0 = Math.min(bounds.sy, bounds.y), y1 = Math.max(bounds.sy, bounds.y);
  if (x0 === x1 || y0 === y1) return emptyMultiSelection;
  const orbitIds: string[] = [];
  const planetIds: string[] = [];
  const orbitsById = new Map(orbits.map((orbit) => [orbit.id, orbit]));
  for (const orbit of orbits) {
    if (orbit.x - orbit.radiusX >= x0 && orbit.x + orbit.radiusX <= x1 &&
      orbit.y - orbit.radiusY >= y0 && orbit.y + orbit.radiusY <= y1) orbitIds.push(orbit.id);
  }
  for (const planet of planets) {
    const orbit = orbitsById.get(planet.orbitId);
    if (!orbit) continue;
    const center = ellipsePoint(orbit, planet.angle);
    if (center.x >= x0 && center.x <= x1 && center.y >= y0 && center.y <= y1) planetIds.push(planet.id);
  }
  return { orbitIds, planetIds };
}
