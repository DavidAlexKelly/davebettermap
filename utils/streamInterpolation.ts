/**
 * Stream marker interpolation engine.
 *
 * Between stream poll cycles (every ~5 seconds) markers with known heading
 * and velocity are smoothly animated along their projected path using
 * requestAnimationFrame. When a new poll arrives the marker snaps to the
 * real position and a new interpolation begins from there.
 *
 * Coordinate maths uses a simple equirectangular projection — accurate
 * enough for the small distances covered in a 5-second window.
 *
 * IMPORTANT: Rotation is applied to an **inner** wrapper element, NOT the
 * marker's root element. Mapbox controls the root element's `transform`
 * property for map positioning — overwriting it breaks placement.
 */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
/** Earth radius in metres. */
const R = 6_371_000;

/** Maximum seconds of interpolation before we stop projecting. */
const MAX_INTERP_SECONDS = 10;

/** State we track per entity for interpolation. */
export interface InterpolatingEntity {
  /** The mapbox marker to move. */
  marker: {
    setLngLat(lngLat: [number, number]): unknown;
    setPopup(popup: unknown): unknown;
    getElement(): HTMLElement;
    remove(): void;
    setAltitude?(altitude: number): unknown;
  };
  /** Latitude at last known position (start of interpolation). */
  startLat: number;
  /** Longitude at last known position. */
  startLng: number;
  /** Heading in degrees (0 = N, clockwise). Null = no interpolation. */
  heading: number | null;
  /** Speed in m/s. Null or 0 = no interpolation. */
  velocityMs: number | null;
  /** Performance.now() timestamp when the current interpolation started. */
  startTime: number;
  /** Altitude in metres. Null if not known. */
  altitude: number | null;
  /** Whether the map is in 3D mode (if true, setAltitude is called). */
  is3D: boolean;
  /**
   * Optional: inner wrapper element to rotate for heading indication.
   * This must be a CHILD of the marker element, not the marker element itself.
   */
  rotateElement: HTMLDivElement | null;
}

export type EntityMap = Map<string, InterpolatingEntity>;

/**
 * Project a lat/lng forward by `distanceMetres` along `bearingDeg`.
 * Uses equirectangular approximation — fine for <50 km.
 */
function projectForward(
  lat: number,
  lng: number,
  bearingDeg: number,
  distanceMetres: number
): { lat: number; lng: number } {
  const brng = bearingDeg * DEG2RAD;
  const dLat = (distanceMetres * Math.cos(brng)) / R;
  const dLng =
    (distanceMetres * Math.sin(brng)) / (R * Math.cos(lat * DEG2RAD));
  return {
    lat: lat + dLat * RAD2DEG,
    lng: lng + dLng * RAD2DEG,
  };
}

/**
 * Start (or continue) the interpolation animation loop.
 *
 * Call this once — it will keep running via requestAnimationFrame as long
 * as `entities` has entries. The ref is read on every frame so you can
 * mutate the map externally (add/remove entities) without restarting.
 *
 * Returns a cleanup function that cancels the loop.
 */
export function startInterpolationLoop(
  entitiesRef: React.MutableRefObject<Record<string, EntityMap>>
): () => void {
  let rafId = 0;
  let running = true;

  function tick() {
    if (!running) {return;}

    const now = performance.now();
    const allMaps = entitiesRef.current;

    for (const entityMap of Object.values(allMaps)) {
      for (const entity of entityMap.values()) {
        if (
          entity.heading == null ||
          entity.velocityMs == null ||
          entity.velocityMs <= 0
        ) {
          continue;
        }

        const elapsed = (now - entity.startTime) / 1000; // seconds

        // Cap interpolation so markers don't fly off if polls stall
        if (elapsed > MAX_INTERP_SECONDS) {continue;}

        const distance = entity.velocityMs * elapsed;

        const projected = projectForward(
          entity.startLat,
          entity.startLng,
          entity.heading,
          distance
        );

        entity.marker.setLngLat([projected.lng, projected.lat]);
      }
    }

    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);

  return () => {
    running = false;
    cancelAnimationFrame(rafId);
  };
}

/**
 * Apply heading rotation to an entity's inner rotate element.
 * Safe to call even if rotateElement is null (no-op).
 */
export function applyHeadingRotation(
  entity: InterpolatingEntity,
  heading: number | null
): void {
  if (entity.rotateElement && heading != null) {
    entity.rotateElement.style.transform = `rotate(${heading}deg)`;
  }
}
