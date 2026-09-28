import { useCallback, useRef } from "react";
import type { MediaSetStyleConfig } from "../components/SettingsPanel";

/**
 * The shape of the full map saved state, serialised as JSON into the
 * Workshop `savedState` string variable.
 */
export interface MapSavedState {
  /** Map viewport */
  viewport: {
    lng: number;
    lat: number;
    zoom: number;
    pitch: number;
    bearing: number;
  };
  /** Whether 3-D buildings mode is on */
  is3D: boolean;
  /** Active base map style id */
  baseMapStyle: string;
  /** Whether entity trails are shown */
  showTrails: boolean;
  /** Per-dataset marker emoji overrides */
  markerStyles: Record<string, string>;
  /** Per-dataset title property selection */
  titleProperties: Record<string, string>;
  /** Per-dataset visible property sets (serialised as arrays) */
  visibleProperties: Record<string, string[]>;
  /** Media set layer style configs */
  mediaSetStyles: Record<string, MediaSetStyleConfig>;
  /** Multi-pin mode on/off */
  multiPinMode: boolean;
  /** Pin colour hex */
  pinColor: string;
}

export const DEFAULT_SAVED_STATE: MapSavedState = {
  viewport: { lng: 0, lat: 0, zoom: 1, pitch: 0, bearing: 0 },
  is3D: false,
  baseMapStyle: "streets",
  showTrails: true,
  markerStyles: {},
  titleProperties: {},
  visibleProperties: {},
  mediaSetStyles: {},
  multiPinMode: false,
  pinColor: "#e74c3c",
};

/**
 * Safely parse a JSON string into a MapSavedState.
 * Returns null if the string is empty or cannot be parsed.
 */
export function parseSavedState(raw: string): MapSavedState | null {
  if (!raw || raw.trim() === "") {return null;}
  try {
    const parsed = JSON.parse(raw) as Partial<MapSavedState>;
    // Merge with defaults so any missing keys from older snapshots are
    // filled in gracefully.
    return { ...DEFAULT_SAVED_STATE, ...parsed };
  } catch {
    return null;
  }
}

/**
 * Serialise a MapSavedState to JSON.
 */
export function serialiseSavedState(state: MapSavedState): string {
  return JSON.stringify(state);
}

/**
 * Hook that returns a stable `persistState` callback.
 *
 * Call `persistState(patch)` whenever anything changes — it deep-merges
 * the patch into the current in-memory state and writes back to the
 * Workshop variable via `setSavedState`.
 *
 * The caller is responsible for providing the current values for the
 * full state so the hook can build the snapshot. Because this is
 * called from event handlers we accept a getter function rather than
 * a direct value to avoid stale closure issues.
 */
export function useSavedStateWriter(
  getSavedState: () => MapSavedState,
  setSavedState: (json: string) => void,
) {
  const getSavedStateRef = useRef(getSavedState);
  getSavedStateRef.current = getSavedState;

  const setSavedStateRef = useRef(setSavedState);
  setSavedStateRef.current = setSavedState;

  const persistState = useCallback((patch: Partial<MapSavedState>) => {
    const current = getSavedStateRef.current();
    const next: MapSavedState = { ...current, ...patch };
    setSavedStateRef.current(serialiseSavedState(next));
  }, []);

  return persistState;
}
