/* eslint-disable no-console */
import { useState, useEffect, useRef, useCallback } from "react";
import {
  discoverStream,
  fetchStreamRecords,
  getCurrentEndOffsets,
  backfillStreamHistory,
  type StreamInfo,
  type StreamOffsets,
  type StreamGeoPoint,
  type StreamGeoGeometry,
} from "../utils/streamService";

const LOG_PREFIX = "[useStreamGeoData]";

/** Default polling interval in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Maximum number of trail positions to keep per entity. */
const MAX_TRAIL_LENGTH = 200;

/** Accumulated geo data for a single stream. */
export interface StreamLayerData {
  streamRid: string;
  streamName: string;
  geoColumnName: string | null;
  allFieldNames: string[];
  /** All point features accumulated so far. */
  points: StreamGeoPoint[];
  /** All geometry features accumulated so far. */
  geometries: StreamGeoGeometry[];
  /** Whether the geo column holds boundary/geometry data. */
  isGeometryColumn: boolean;
}

/** Return type of the hook. */
export interface UseStreamGeoDataResult {
  /** rid → accumulated layer data. */
  streamLayers: Record<string, StreamLayerData>;
  /** rid → stream metadata (null if not yet discovered). */
  streamInfos: Record<string, StreamInfo | null>;
  /** Whether initial discovery is still in progress. */
  discovering: boolean;
}

/**
 * Hook that discovers and polls Foundry streams for geo data.
 *
 * On discovery, reads recent historical records to seed entity trails
 * so that entities appear with full path history on first load.
 *
 * - `streamRids`: array of streaming-dataset RIDs to connect to.
 * - `enabled`: master on/off switch (e.g. disable when map hasn't loaded).
 * - `pollIntervalMs`: how often to fetch new records (default 5 s).
 */
export function useStreamGeoData(
  streamRids: string[],
  enabled: boolean,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS
): UseStreamGeoDataResult {
  const [streamLayers, setStreamLayers] = useState<
    Record<string, StreamLayerData>
  >({});
  const [streamInfos, setStreamInfos] = useState<
    Record<string, StreamInfo | null>
  >({});
  const [discovering, setDiscovering] = useState(false);

  const offsetsRef = useRef<Record<string, StreamOffsets>>({});
  const streamInfosRef = useRef<Record<string, StreamInfo | null>>({});
  const enabledRef = useRef(enabled);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    streamInfosRef.current = streamInfos;
  }, [streamInfos]);

  // ── Discover streams + backfill history ────────────────────────────
  useEffect(() => {
    if (!enabled || streamRids.length === 0) {
      setStreamLayers({});
      setStreamInfos({});
      offsetsRef.current = {};
      return;
    }

    const validRids = streamRids.filter((r) =>
      r.startsWith("ri.foundry.main.dataset.")
    );
    if (validRids.length === 0) {return;}

    let cancelled = false;
    setDiscovering(true);

    (async () => {
      // ── Step 1: Discover stream schemas ──
      const results: Record<string, StreamInfo | null> = {};
      await Promise.all(
        validRids.map(async (rid) => {
          if (streamInfosRef.current[rid] !== undefined) {
            results[rid] = streamInfosRef.current[rid];
            return;
          }
          try {
            results[rid] = await discoverStream(rid);
          } catch (err) {
            console.error(`${LOG_PREFIX} Discovery failed for ${rid}:`, err);
            results[rid] = null;
          }
        })
      );

      if (cancelled) {return;}

      setStreamInfos(results);
      streamInfosRef.current = results;

      // ── Step 2: Backfill history + snapshot offsets ──
      await Promise.all(
        Object.entries(results).map(async ([rid, info]) => {
          if (!info || offsetsRef.current[rid]) {return;}

          // Backfill: read recent historical records to seed trails
          try {
            const history = await backfillStreamHistory(info, 500);

            if (history.points.length > 0 || history.geometries.length > 0) {
              console.log(
                `${LOG_PREFIX} Backfilled ${history.points.length} points + ` +
                  `${history.geometries.length} geometries for ${rid}`
              );

              const seededPoints = buildTrailsFromHistory(history.points);

              if (!cancelled) {
                setStreamLayers((prev) => ({
                  ...prev,
                  [rid]: {
                    streamRid: rid,
                    streamName: info.streamName,
                    geoColumnName: info.geoColumnName,
                    allFieldNames: info.fieldNames,
                    isGeometryColumn: info.isGeometryColumn,
                    points: seededPoints,
                    geometries: history.geometries,
                  },
                }));
              }
            }
          } catch (err) {
            console.warn(
              `${LOG_PREFIX} Backfill failed for ${rid} (non-fatal):`,
              err
            );
          }

          // Snapshot end offsets so live polling starts from NOW
          offsetsRef.current[rid] = await getCurrentEndOffsets(
            info.datasetRid,
            info.branchName
          );
        })
      );

      // Clean up removed RIDs
      for (const rid of Object.keys(offsetsRef.current)) {
        if (!validRids.includes(rid)) {
          delete offsetsRef.current[rid];
        }
      }

      if (!cancelled) {setDiscovering(false);}
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(streamRids), enabled]);

  // ── Poll for new records ──────────────────────────────────────────
  const poll = useCallback(async () => {
    if (!enabledRef.current) {return;}

    const infos = streamInfosRef.current;
    const ridsToFetch = Object.keys(infos).filter(
      (rid) => infos[rid]?.geoColumnName
    );
    if (ridsToFetch.length === 0) {return;}

    await Promise.all(
      ridsToFetch.map(async (rid) => {
        const info = infos[rid];
        if (!info) {return;}

        try {
          const { data, newOffsets } = await fetchStreamRecords(
            info,
            offsetsRef.current[rid] ?? {}
          );
          offsetsRef.current[rid] = newOffsets;

          if (data.points.length === 0 && data.geometries.length === 0) {
            return;
          }

          setStreamLayers((prev) => {
            const existing = prev[rid];

            const mergedPoints = deduplicateByEntity(
              existing?.points ?? [],
              data.points
            );

            const mergedGeometries = deduplicateGeometriesByEntity(
              existing?.geometries ?? [],
              data.geometries
            );

            return {
              ...prev,
              [rid]: {
                streamRid: rid,
                streamName: info.streamName,
                geoColumnName: info.geoColumnName,
                allFieldNames: info.fieldNames,
                isGeometryColumn: info.isGeometryColumn,
                points: mergedPoints,
                geometries: mergedGeometries,
              },
            };
          });
        } catch (err) {
          console.error(`${LOG_PREFIX} Poll failed for ${rid}:`, err);
        }
      })
    );
  }, []);

  useEffect(() => {
    if (!enabled || discovering) {return;}
    poll();
    const id = setInterval(poll, pollIntervalMs);
    return () => clearInterval(id);
  }, [enabled, discovering, pollIntervalMs, poll]);

  return { streamLayers, streamInfos, discovering };
}

// ─── Trail building from historical records ──────────────────────────

/** Minimum distance (metres) between trail points to avoid cluttering. */
const MIN_TRAIL_DISTANCE_M = 50;

/** Rough metres-per-degree at the equator. */
const DEG_TO_M = 111_320;

/** Quick equirectangular distance in metres. */
function quickDistanceM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = (lat2 - lat1) * DEG_TO_M;
  const dLng =
    (lng2 - lng1) * DEG_TO_M * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/**
 * Given an array of historical points (in roughly chronological order),
 * group them by entityId and build trail arrays.
 *
 * Returns one entry per entity — the latest position as the "current"
 * point, with a `.trail` containing all historical positions.
 *
 * Points without an entityId are returned as-is (no trail possible).
 */
function buildTrailsFromHistory(points: StreamGeoPoint[]): StreamGeoPoint[] {
  const byEntity = new Map<
    string,
    {
      positions: Array<{ lat: number; lng: number; ts: number }>;
      latestPoint: StreamGeoPoint;
    }
  >();
  const noId: StreamGeoPoint[] = [];

  const now = Date.now();
  const totalPoints = points.length;

  for (let i = 0; i < totalPoints; i++) {
    const point = points[i];

    if (point.entityId == null) {
      noId.push(point);
      continue;
    }

    // Approximate timestamp: spread historical points evenly so the
    // trail gradient looks reasonable even without real timestamps
    const estimatedTs = now - (totalPoints - i) * 5000;

    const existing = byEntity.get(point.entityId);

    if (existing) {
      const lastPos = existing.positions[existing.positions.length - 1];
      const dist = quickDistanceM(
        lastPos.lat,
        lastPos.lng,
        point.latitude,
        point.longitude
      );

      if (dist >= MIN_TRAIL_DISTANCE_M) {
        existing.positions.push({
          lat: point.latitude,
          lng: point.longitude,
          ts: estimatedTs,
        });
      }

      existing.latestPoint = point;
    } else {
      byEntity.set(point.entityId, {
        positions: [
          { lat: point.latitude, lng: point.longitude, ts: estimatedTs },
        ],
        latestPoint: point,
      });
    }
  }

  const result: StreamGeoPoint[] = [];

  for (const { positions, latestPoint } of byEntity.values()) {
    const trail =
      positions.length > MAX_TRAIL_LENGTH
        ? positions.slice(positions.length - MAX_TRAIL_LENGTH)
        : positions;

    result.push({ ...latestPoint, trail });
  }

  result.push(...noId);
  return result;
}

// ─── Entity deduplication helpers ────────────────────────────────────

/**
 * Merge old + new point arrays, keeping only the latest entry per entityId.
 * For entities that have moved, accumulate a position trail.
 */
function deduplicateByEntity(
  existing: StreamGeoPoint[],
  incoming: StreamGeoPoint[]
): StreamGeoPoint[] {
  const anyIncomingHasId = incoming.some((p) => p.entityId != null);
  if (!anyIncomingHasId) {
    return [...existing, ...incoming];
  }

  const byEntity = new Map<string, StreamGeoPoint>();
  const noId: StreamGeoPoint[] = [];

  for (const point of existing) {
    if (point.entityId != null) {
      byEntity.set(point.entityId, point);
    } else {
      noId.push(point);
    }
  }

  const now = Date.now();

  for (const point of incoming) {
    if (point.entityId != null) {
      const prev = byEntity.get(point.entityId);

      let trail: Array<{ lat: number; lng: number; ts: number }>;

      if (prev) {
        trail = prev.trail
          ? [...prev.trail]
          : [{ lat: prev.latitude, lng: prev.longitude, ts: now - 5000 }];

        const lastTrailPt = trail[trail.length - 1];
        const dist = quickDistanceM(
          lastTrailPt.lat,
          lastTrailPt.lng,
          point.latitude,
          point.longitude
        );

        if (dist >= MIN_TRAIL_DISTANCE_M) {
          trail.push({ lat: point.latitude, lng: point.longitude, ts: now });
        }

        if (trail.length > MAX_TRAIL_LENGTH) {
          trail = trail.slice(trail.length - MAX_TRAIL_LENGTH);
        }
      } else {
        trail = [{ lat: point.latitude, lng: point.longitude, ts: now }];
      }

      byEntity.set(point.entityId, { ...point, trail });
    } else {
      noId.push(point);
    }
  }

  return [...byEntity.values(), ...noId];
}

/**
 * Same as above but for geometry entries.
 */
function deduplicateGeometriesByEntity(
  existing: StreamGeoGeometry[],
  incoming: StreamGeoGeometry[]
): StreamGeoGeometry[] {
  const anyIncomingHasId = incoming.some((g) => g.entityId != null);
  if (!anyIncomingHasId) {
    return [...existing, ...incoming];
  }

  const byEntity = new Map<string, StreamGeoGeometry>();
  const noId: StreamGeoGeometry[] = [];

  for (const geom of existing) {
    if (geom.entityId != null) {
      byEntity.set(geom.entityId, geom);
    } else {
      noId.push(geom);
    }
  }

  for (const geom of incoming) {
    if (geom.entityId != null) {
      byEntity.set(geom.entityId, geom);
    } else {
      noId.push(geom);
    }
  }

  return [...byEntity.values(), ...noId];
}
