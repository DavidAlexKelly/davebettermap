/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
// eslint-disable-next-line import/no-extraneous-dependencies
import { Streams } from "@osdk/foundry.streams";
import { Datasets } from "@osdk/foundry";
import client from "../auth/client";

const LOG_PREFIX = "[StreamService]";

/**
 * Geo-column detection keywords — shared with datasetService logic.
 */
const GEO_COLUMN_NAME_HINTS = [
  "geo",
  "geolocation",
  "geopoint",
  "geo_point",
  "geo_data",
  "location",
  "coordinates",
  "coord",
  "latlng",
  "latlong",
  "position",
  "point",
];

const GEOMETRY_COLUMN_NAME_HINTS = [
  "geometry",
  "geom",
  "geo_shape",
  "geoshape",
  "shape",
  "polygon",
  "boundary",
  "multipolygon",
  "linestring",
  "multilinestring",
  "geojson",
  "wkt",
];

/** A single geo-point extracted from a stream record. */
export interface StreamGeoPoint {
  latitude: number;
  longitude: number;
  /** Unique entity ID (e.g. plane callsign, vehicle id). Null if no ID detected. */
  entityId: string | null;
  /** Heading / bearing in degrees (0 = north, clockwise). Null if not detected. */
  heading: number | null;
  /** Speed in metres per second. Null if not detected. */
  velocityMs: number | null;
  properties: Record<string, unknown>;
  /** Accumulated position history for trail rendering. Newest last. */
  trail?: Array<{ lat: number; lng: number; ts: number }>;
}

/** A geometry entry extracted from a stream record. */
export interface StreamGeoGeometry {
  geometry: GeoJSON.Geometry;
  /** Unique entity ID. Null if no ID detected. */
  entityId: string | null;
  properties: Record<string, unknown>;
}

/** Aggregated geo data from a stream. */
export interface StreamGeoData {
  streamRid: string;
  streamName: string;
  /** Which field we detected geo data in. */
  geoColumnName: string | null;
  /** All field names in the stream schema. */
  allFieldNames: string[];
  /** Point entries. */
  points: StreamGeoPoint[];
  /** Geometry entries. */
  geometries: StreamGeoGeometry[];
}

/** Per-partition offset tracking for incremental reads. */
export interface StreamOffsets {
  [partitionId: string]: string;
}

/**
 * How geo data is extracted from each record.
 *
 * - `"column"`: A dedicated geo column exists (e.g. "location", "geo_point").
 *   The value of that column is parsed for coordinates.
 * - `"valueJson"`: The stream uses a timestamp+value pattern. The "value"
 *   column contains a JSON blob that embeds lat/lng fields
 *   (e.g. `{ latitude, longitude, ... }`).
 * - `"valueJsonGeometry"`: Same as above but the JSON blob contains GeoJSON
 *   geometry rather than simple lat/lng.
 */
type GeoExtractionMode = "column" | "valueJson" | "valueJsonGeometry";

/**
 * Metadata about a stream we've connected to.
 */
export interface StreamInfo {
  datasetRid: string;
  branchName: string;
  streamName: string;
  viewRid: string;
  partitionsCount: number;
  fieldNames: string[];
  geoColumnName: string | null;
  /** Whether the geo column holds geometries rather than points. */
  isGeometryColumn: boolean;
  /** How we extract geo data from each record. */
  geoExtractionMode: GeoExtractionMode;
  /** The name of the "value" column when in valueJson mode. */
  valueColumnName: string | null;
}

/**
 * Fetch the current end offsets for a stream so we can skip all existing
 * records and only process records that arrive after this point.
 */
export async function getCurrentEndOffsets(
  datasetRid: string,
  branchName: string
): Promise<StreamOffsets> {
  try {
    const endOffsets = (await Streams.getEndOffsets(
      client,
      datasetRid,
      branchName,
      { preview: true }
    )) as unknown as Record<string, string>;
    console.log(
      `${LOG_PREFIX} Snapshotted end offsets for ${datasetRid}:`,
      endOffsets
    );
    return endOffsets;
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} Failed to snapshot end offsets for ${datasetRid}, will start from 0:`,
      err
    );
    return {};
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Discover a stream for a given dataset RID, returning metadata about it.
 * Tries branch "master" first, then falls back to other common branch names.
 *
 * Detection strategy:
 * 1. Look for a dedicated geo column by name (same as datasets).
 * 2. If not found, check if the stream uses a "timestamp + value" pattern
 *    (exactly 2 fields, one being timestamp-ish and the other a value blob).
 *    If so, sample a record and probe the JSON inside the value field.
 */
export async function discoverStream(
  datasetRid: string
): Promise<StreamInfo | null> {
  const branches = ["master", "main"];

  for (const branchName of branches) {
    try {
      const stream = await Streams.get(client, datasetRid, branchName);

      // Get dataset name
      let streamName = datasetRid;
      try {
        const dataset = await Datasets.Datasets.get(client, datasetRid);
        streamName = dataset.name ?? datasetRid;
      } catch {
        // Use RID as fallback
      }

      const fieldNames = (stream.schema?.fields ?? [])
        .map((f: any) => f.name)
        .filter(Boolean) as string[];

      // ── Strategy 1: dedicated geo column by name ──
      const { geoColumn, isGeometry } = detectGeoColumn(fieldNames);

      if (geoColumn) {
        console.log(
          `${LOG_PREFIX} Discovered stream for ${datasetRid} on branch "${branchName}": ` +
            `${fieldNames.length} fields, geo column = "${geoColumn}" (column mode)`
        );
        return {
          datasetRid,
          branchName,
          streamName,
          viewRid: stream.viewRid as string,
          partitionsCount: stream.partitionsCount,
          fieldNames,
          geoColumnName: geoColumn,
          isGeometryColumn: isGeometry,
          geoExtractionMode: "column",
          valueColumnName: null,
        };
      }

      // ── Strategy 2: timestamp + value pattern ──
      const tvResult = detectTimestampValuePattern(fieldNames);
      if (tvResult) {
        console.log(
          `${LOG_PREFIX} Stream ${datasetRid} looks like timestamp+value pattern` +
            ` (value column = "${tvResult.valueColumn}"). Probing a sample record…`
        );

        const probeResult = await probeValueColumnForGeo(
          datasetRid,
          branchName,
          stream.partitionsCount,
          tvResult.valueColumn
        );

        if (probeResult) {
          console.log(
            `${LOG_PREFIX} Discovered geo in value column "${tvResult.valueColumn}" ` +
              `(mode = ${probeResult.mode}) for ${datasetRid}`
          );
          return {
            datasetRid,
            branchName,
            streamName,
            viewRid: stream.viewRid as string,
            partitionsCount: stream.partitionsCount,
            fieldNames,
            geoColumnName: tvResult.valueColumn,
            isGeometryColumn: probeResult.mode === "valueJsonGeometry",
            geoExtractionMode: probeResult.mode,
            valueColumnName: tvResult.valueColumn,
          };
        }

        console.log(
          `${LOG_PREFIX} Probed value column "${tvResult.valueColumn}" but found no geo data.`
        );
      }

      // ── No geo data found ──
      console.log(
        `${LOG_PREFIX} Discovered stream for ${datasetRid} on branch "${branchName}": ` +
          `${fieldNames.length} fields, no geo column detected`
      );
      return {
        datasetRid,
        branchName,
        streamName,
        viewRid: stream.viewRid as string,
        partitionsCount: stream.partitionsCount,
        fieldNames,
        geoColumnName: null,
        isGeometryColumn: false,
        geoExtractionMode: "column",
        valueColumnName: null,
      };
    } catch (err: any) {
      console.log(
        `${LOG_PREFIX} No stream on branch "${branchName}" for ${datasetRid}: ${err?.message ?? err}`
      );
    }
  }

  console.warn(`${LOG_PREFIX} No stream found for dataset ${datasetRid}`);
  return null;
}

/**
 * Fetch the latest records from a stream, starting from the given offsets.
 * Returns the parsed geo data and the updated offsets for the next poll.
 */
export async function fetchStreamRecords(
  info: StreamInfo,
  currentOffsets: StreamOffsets,
  limit: number = 500
): Promise<{
  data: StreamGeoData;
  newOffsets: StreamOffsets;
}> {
  const newOffsets: StreamOffsets = { ...currentOffsets };
  const allRecords: Record<string, any>[] = [];

  let endOffsets: Record<string, string>;
  try {
    endOffsets = (await Streams.getEndOffsets(
      client,
      info.datasetRid,
      info.branchName,
      { preview: true }
    )) as Record<string, string>;
  } catch (err) {
    console.error(
      `${LOG_PREFIX} Failed to get end offsets for ${info.datasetRid}:`,
      err
    );
    return {
      data: {
        streamRid: info.datasetRid,
        streamName: info.streamName,
        geoColumnName: info.geoColumnName,
        allFieldNames: info.fieldNames,
        points: [],
        geometries: [],
      },
      newOffsets,
    };
  }

  await Promise.all(
    Object.entries(endOffsets).map(async ([partitionId, endOffset]) => {
      const startOffset = currentOffsets[partitionId] ?? "0";
      if (BigInt(startOffset) >= BigInt(endOffset)) {return;}

      try {
        const records = await Streams.getRecords(
          client,
          info.datasetRid,
          info.branchName,
          {
            partitionId: partitionId as any,
            startOffset,
            limit,
            preview: true,
          }
        );

        if (Array.isArray(records) && records.length > 0) {
          for (const rec of records) {
            allRecords.push(rec.value);
            const nextOffset = String(BigInt(rec.offset) + 1n);
            if (
              !newOffsets[partitionId] ||
              BigInt(nextOffset) > BigInt(newOffsets[partitionId])
            ) {
              newOffsets[partitionId] = nextOffset;
            }
          }
        }
      } catch (err) {
        console.error(
          `${LOG_PREFIX} Failed to read partition ${partitionId} for ${info.datasetRid}:`,
          err
        );
      }
    })
  );

  const points: StreamGeoPoint[] = [];
  const geometries: StreamGeoGeometry[] = [];

  if (info.geoColumnName) {
    if (
      info.geoExtractionMode === "valueJson" ||
      info.geoExtractionMode === "valueJsonGeometry"
    ) {
      parseValueJsonRecords(allRecords, info, points, geometries);
    } else {
      parseColumnModeRecords(allRecords, info, points, geometries);
    }
  }

  return {
    data: {
      streamRid: info.datasetRid,
      streamName: info.streamName,
      geoColumnName: info.geoColumnName,
      allFieldNames: info.fieldNames,
      points,
      geometries,
    },
    newOffsets,
  };
}

/**
 * Read recent historical records from a stream to seed entity trails.
 *
 * For each partition, reads backwards from the current end offset by up to
 * `maxRecordsPerPartition` records. Parses them for geo data so the caller
 * can build trail histories.
 *
 * Returns points in roughly chronological order (oldest first).
 */
export async function backfillStreamHistory(
  info: StreamInfo,
  maxRecordsPerPartition: number = 200
): Promise<{
  points: StreamGeoPoint[];
  geometries: StreamGeoGeometry[];
}> {
  const points: StreamGeoPoint[] = [];
  const geometries: StreamGeoGeometry[] = [];

  if (!info.geoColumnName) {return { points, geometries };}

  let endOffsets: Record<string, string>;
  try {
    endOffsets = (await Streams.getEndOffsets(
      client,
      info.datasetRid,
      info.branchName,
      { preview: true }
    )) as Record<string, string>;
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} Failed to get end offsets for backfill of ${info.datasetRid}:`,
      err
    );
    return { points, geometries };
  }

  const allRecords: Record<string, any>[] = [];

  await Promise.all(
    Object.entries(endOffsets).map(async ([partitionId, endOffset]) => {
      const endBig = BigInt(endOffset);
      if (endBig <= 0n) {return;}

      const startBig =
        endBig > BigInt(maxRecordsPerPartition)
          ? endBig - BigInt(maxRecordsPerPartition)
          : 0n;

      try {
        const records = await Streams.getRecords(
          client,
          info.datasetRid,
          info.branchName,
          {
            partitionId: partitionId as any,
            startOffset: String(startBig),
            limit: maxRecordsPerPartition,
            preview: true,
          }
        );

        if (Array.isArray(records)) {
          for (const rec of records) {
            allRecords.push(rec.value);
          }
        }
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} Backfill read failed for partition ${partitionId}:`,
          err
        );
      }
    })
  );

  console.log(
    `${LOG_PREFIX} Backfill read ${allRecords.length} historical records for ${info.datasetRid}`
  );

  if (info.geoColumnName) {
    if (
      info.geoExtractionMode === "valueJson" ||
      info.geoExtractionMode === "valueJsonGeometry"
    ) {
      parseValueJsonRecords(allRecords, info, points, geometries);
    } else {
      parseColumnModeRecords(allRecords, info, points, geometries);
    }
  }

  return { points, geometries };
}

// ─── Record parsing by mode ─────────────────────────────────────────

/** Parse records when a dedicated geo column exists in the schema. */
function parseColumnModeRecords(
  records: Record<string, any>[],
  info: StreamInfo,
  points: StreamGeoPoint[],
  geometries: StreamGeoGeometry[]
): void {
  const geoColLower = info.geoColumnName!.toLowerCase();

  for (const record of records) {
    const matchingKey = Object.keys(record).find(
      (k) => k.toLowerCase() === geoColLower
    );
    if (!matchingKey) {continue;}

    const rawValue = record[matchingKey];

    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (k.toLowerCase() !== geoColLower) {
        properties[k] = v;
      }
    }

    if (info.isGeometryColumn) {
      const geom = extractGeometry(rawValue);
      if (geom) {
        geometries.push({
          geometry: geom,
          entityId: detectEntityId(properties),
          properties,
        });
      }
    } else {
      const point = extractGeoPoint(rawValue);
      if (point) {
        points.push({
          ...point,
          entityId: detectEntityId(properties),
          heading: detectHeading(properties),
          velocityMs: detectVelocity(properties),
          properties,
        });
      }
    }
  }
}

/**
 * Parse records in "value JSON" mode.
 *
 * The value column contains a JSON blob. We parse it, then look inside
 * for lat/lng or geometry fields. All non-geo fields from the parsed JSON
 * become popup properties (plus any top-level fields like timestamp).
 */
function parseValueJsonRecords(
  records: Record<string, any>[],
  info: StreamInfo,
  points: StreamGeoPoint[],
  geometries: StreamGeoGeometry[]
): void {
  const valueColLower = (
    info.valueColumnName ?? info.geoColumnName!
  ).toLowerCase();

  for (const record of records) {
    const valueKey = Object.keys(record).find(
      (k) => k.toLowerCase() === valueColLower
    );
    if (!valueKey) {continue;}

    const rawValue = record[valueKey];

    let parsed: any = rawValue;
    if (typeof rawValue === "string") {
      try {
        parsed = JSON.parse(rawValue.trim());
      } catch {
        continue;
      }
    }

    if (typeof parsed !== "object" || parsed === null) {
      console.warn(
        `${LOG_PREFIX} Value column parsed to non-object:`,
        typeof parsed,
        parsed
      );
      continue;
    }

    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (k.toLowerCase() !== valueColLower) {
        properties[k] = v;
      }
    }

    if (info.geoExtractionMode === "valueJsonGeometry") {
      const geomResult = extractGeometryFromJsonBlob(parsed);
      if (geomResult) {
        for (const [k, v] of Object.entries(parsed)) {
          if (k !== geomResult.fieldName && !isPlainGeoField(k)) {
            properties[k] = v;
          }
        }
        const entityId = detectEntityId(properties) ?? detectEntityId(parsed);
        geometries.push({
          geometry: geomResult.geometry,
          entityId,
          properties,
        });
      }
    } else {
      const pointResult = extractGeoPointFromJsonBlob(parsed);
      if (pointResult) {
        const geoFieldsUsed = new Set(
          pointResult.fieldsUsed.map((f) => f.toLowerCase())
        );
        for (const [k, v] of Object.entries(parsed)) {
          if (!geoFieldsUsed.has(k.toLowerCase())) {
            properties[k] = v;
          }
        }

        const entityId = detectEntityId(properties);
        const heading = detectHeading(properties);
        const velocityMs = detectVelocity(properties);

        points.push({
          latitude: pointResult.latitude,
          longitude: pointResult.longitude,
          entityId,
          heading,
          velocityMs,
          properties,
        });
      }
    }
  }
}

// ─── Timestamp+Value pattern detection ───────────────────────────────

const TIMESTAMP_HINTS = [
  "timestamp",
  "time",
  "datetime",
  "date",
  "created_at",
  "updated_at",
  "event_time",
  "event_timestamp",
  "ts",
  "created",
  "modified",
];

const VALUE_HINTS = [
  "value",
  "body",
  "payload",
  "data",
  "message",
  "content",
  "json",
  "record",
  "event",
  "raw",
];

function detectTimestampValuePattern(
  fieldNames: string[]
): { timestampColumn: string; valueColumn: string } | null {
  if (fieldNames.length < 2 || fieldNames.length > 3) {return null;}

  const lower = fieldNames.map((f) => f.toLowerCase());

  let tsIdx = -1;
  for (let i = 0; i < lower.length; i++) {
    if (TIMESTAMP_HINTS.some((h) => lower[i].includes(h))) {
      tsIdx = i;
      break;
    }
  }

  let valIdx = -1;
  for (let i = 0; i < lower.length; i++) {
    if (i === tsIdx) {continue;}
    if (VALUE_HINTS.some((h) => lower[i].includes(h))) {
      valIdx = i;
      break;
    }
  }

  if (tsIdx >= 0 && valIdx >= 0) {
    return {
      timestampColumn: fieldNames[tsIdx],
      valueColumn: fieldNames[valIdx],
    };
  }

  if (fieldNames.length === 2 && tsIdx >= 0) {
    const otherIdx = tsIdx === 0 ? 1 : 0;
    return {
      timestampColumn: fieldNames[tsIdx],
      valueColumn: fieldNames[otherIdx],
    };
  }

  return null;
}

async function probeValueColumnForGeo(
  datasetRid: string,
  branchName: string,
  partitionsCount: number,
  valueColumn: string
): Promise<{ mode: GeoExtractionMode } | null> {
  try {
    const records = await Streams.getRecords(client, datasetRid, branchName, {
      partitionId: "0" as any,
      startOffset: "0",
      limit: 5,
      preview: true,
    });

    if (!Array.isArray(records) || records.length === 0) {
      if (partitionsCount > 1) {
        for (let p = 1; p < Math.min(partitionsCount, 4); p++) {
          try {
            const recs = await Streams.getRecords(
              client,
              datasetRid,
              branchName,
              {
                partitionId: String(p) as any,
                startOffset: "0",
                limit: 5,
                preview: true,
              }
            );
            if (Array.isArray(recs) && recs.length > 0) {
              return probeRecordsForGeo(recs, valueColumn);
            }
          } catch {
            // skip
          }
        }
      }
      return null;
    }

    return probeRecordsForGeo(records, valueColumn);
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to probe value column:`, err);
    return null;
  }
}

function probeRecordsForGeo(
  records: Array<{ value: Record<string, any> }>,
  valueColumn: string
): { mode: GeoExtractionMode } | null {
  const valueColLower = valueColumn.toLowerCase();

  for (const rec of records) {
    const row = rec.value;
    const valueKey = Object.keys(row).find(
      (k) => k.toLowerCase() === valueColLower
    );
    if (!valueKey) {continue;}

    let parsed: any = row[valueKey];
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed.trim());
      } catch {
        continue;
      }
    }

    if (typeof parsed !== "object" || parsed === null) {continue;}

    const geom = extractGeometryFromJsonBlob(parsed);
    if (geom) {return { mode: "valueJsonGeometry" };}

    const point = extractGeoPointFromJsonBlob(parsed);
    if (point) {return { mode: "valueJson" };}
  }

  return null;
}

// ─── Geo extraction from JSON blobs ──────────────────────────────────

function extractGeoPointFromJsonBlob(
  obj: Record<string, any>
): { latitude: number; longitude: number; fieldsUsed: string[] } | null {
  if (obj.latitude != null && obj.longitude != null) {
    const lat = Number(obj.latitude);
    const lng = Number(obj.longitude);
    if (isValidCoord(lat, lng)) {
      return {
        latitude: lat,
        longitude: lng,
        fieldsUsed: ["latitude", "longitude"],
      };
    }
  }

  if (obj.lat != null && (obj.lng != null || obj.lon != null)) {
    const lat = Number(obj.lat);
    const lng = Number(obj.lng ?? obj.lon);
    if (isValidCoord(lat, lng)) {
      const lngField = obj.lng != null ? "lng" : "lon";
      return { latitude: lat, longitude: lng, fieldsUsed: ["lat", lngField] };
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      if (
        value.type === "Point" &&
        Array.isArray(value.coordinates) &&
        value.coordinates.length >= 2
      ) {
        const lng = Number(value.coordinates[0]);
        const lat = Number(value.coordinates[1]);
        if (isValidCoord(lat, lng)) {
          return { latitude: lat, longitude: lng, fieldsUsed: [key] };
        }
      }
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested = extractGeoPointFromJsonBlob(value);
      if (nested) {
        return { ...nested, fieldsUsed: [key] };
      }
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      const lower = key.toLowerCase();
      if (GEO_COLUMN_NAME_HINTS.some((h) => lower.includes(h))) {
        const point = extractGeoPoint(value);
        if (point) {
          return { ...point, fieldsUsed: [key] };
        }
      }
    }
  }

  return null;
}

function extractGeometryFromJsonBlob(
  obj: Record<string, any>
): { geometry: GeoJSON.Geometry; fieldName: string } | null {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "object" && value !== null) {
      const geom = extractGeometry(value);
      if (geom && geom.type !== "Point") {
        return { geometry: geom, fieldName: key };
      }
    }
    if (typeof value === "string") {
      const geom = extractGeometry(value);
      if (geom && geom.type !== "Point") {
        return { geometry: geom, fieldName: key };
      }
    }
  }
  return null;
}

// ─── Entity ID detection ─────────────────────────────────────────────

const ENTITY_ID_HINTS = [
  "id",
  "callsign",
  "call_sign",
  "vehicle_id",
  "aircraft_id",
  "flight_id",
  "ship_id",
  "vessel_id",
  "device_id",
  "tracker_id",
  "unit_id",
  "asset_id",
  "object_id",
  "entity_id",
  "uid",
  "uuid",
  "key",
  "name",
  "identifier",
  "registration",
  "tail_number",
  "mmsi",
  "imei",
  "imo",
  "icao",
  "icao24",
];

function detectEntityId(properties: Record<string, unknown>): string | null {
  for (const hint of ENTITY_ID_HINTS) {
    for (const [key, value] of Object.entries(properties)) {
      if (key.toLowerCase() === hint && value != null && value !== "") {
        return String(value);
      }
    }
  }
  for (const hint of ENTITY_ID_HINTS) {
    for (const [key, value] of Object.entries(properties)) {
      if (key.toLowerCase().includes(hint) && value != null && value !== "") {
        return String(value);
      }
    }
  }
  return null;
}

// ─── Heading & velocity detection ────────────────────────────────────

const HEADING_HINTS = [
  "heading",
  "bearing",
  "direction",
  "track",
  "course",
  "track_angle",
  "heading_deg",
  "bearing_deg",
  "cog",
  "true_heading",
  "true_track",
];

const VELOCITY_HINTS = [
  "velocity",
  "speed",
  "velocity_ms",
  "speed_ms",
  "ground_speed",
  "groundspeed",
  "velocity_kts",
  "speed_kts",
  "velocity_kmh",
  "speed_kmh",
  "velocity_mph",
  "speed_mph",
  "sog",
  "tas",
  "ias",
  "gs",
];

const KNOTS_HINTS = ["kts", "knots", "velocity_kts", "speed_kts"];
const KMH_HINTS = ["kmh", "km_h", "kph", "velocity_kmh", "speed_kmh"];
const MPH_HINTS = ["mph", "velocity_mph", "speed_mph"];

function detectHeading(properties: Record<string, unknown>): number | null {
  for (const hint of HEADING_HINTS) {
    for (const [key, value] of Object.entries(properties)) {
      if (key.toLowerCase() === hint && value != null) {
        const n = Number(value);
        if (!isNaN(n) && isFinite(n)) {return ((n % 360) + 360) % 360;}
      }
    }
  }
  for (const hint of HEADING_HINTS) {
    for (const [key, value] of Object.entries(properties)) {
      if (key.toLowerCase().includes(hint) && value != null) {
        const n = Number(value);
        if (!isNaN(n) && isFinite(n)) {return ((n % 360) + 360) % 360;}
      }
    }
  }
  return null;
}

function detectVelocity(properties: Record<string, unknown>): number | null {
  for (const hint of VELOCITY_HINTS) {
    for (const [key, value] of Object.entries(properties)) {
      if (key.toLowerCase() === hint && value != null) {
        const n = Number(value);
        if (!isNaN(n) && isFinite(n) && n >= 0) {return normaliseSpeed(n, key);}
      }
    }
  }
  for (const hint of VELOCITY_HINTS) {
    for (const [key, value] of Object.entries(properties)) {
      if (key.toLowerCase().includes(hint) && value != null) {
        const n = Number(value);
        if (!isNaN(n) && isFinite(n) && n >= 0) {return normaliseSpeed(n, key);}
      }
    }
  }
  return null;
}

function normaliseSpeed(value: number, fieldName: string): number {
  const lower = fieldName.toLowerCase();
  if (KNOTS_HINTS.some((h) => lower.includes(h))) {return value * 0.514444;}
  if (KMH_HINTS.some((h) => lower.includes(h))) {return value / 3.6;}
  if (MPH_HINTS.some((h) => lower.includes(h))) {return value * 0.44704;}
  return value;
}

function isPlainGeoField(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "latitude" ||
    lower === "longitude" ||
    lower === "lat" ||
    lower === "lng" ||
    lower === "lon"
  );
}

// ─── Internal helpers ────────────────────────────────────────────────

function detectGeoColumn(fieldNames: string[]): {
  geoColumn: string | null;
  isGeometry: boolean;
} {
  const POINT_ONLY_HINTS = ["geopoint", "geo_point", "latlng", "latlong"];

  for (const name of fieldNames) {
    const lower = name.toLowerCase();
    const isPointOnly = POINT_ONLY_HINTS.some((h) => lower.includes(h));
    if (
      !isPointOnly &&
      GEOMETRY_COLUMN_NAME_HINTS.some((h) => lower.includes(h))
    ) {
      return { geoColumn: name, isGeometry: true };
    }
  }

  for (const name of fieldNames) {
    if (GEO_COLUMN_NAME_HINTS.some((h) => name.toLowerCase().includes(h))) {
      return { geoColumn: name, isGeometry: false };
    }
  }

  return { geoColumn: null, isGeometry: false };
}

function extractGeoPoint(
  raw: unknown
): { latitude: number; longitude: number } | null {
  if (raw == null || raw === "") {return null;}

  let parsed: any = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null) {return null;}

  if (
    parsed.type === "Point" &&
    Array.isArray(parsed.coordinates) &&
    parsed.coordinates.length >= 2
  ) {
    const lng = Number(parsed.coordinates[0]);
    const lat = Number(parsed.coordinates[1]);
    if (isValidCoord(lat, lng)) {return { latitude: lat, longitude: lng };}
  }

  if (parsed.latitude != null && parsed.longitude != null) {
    const lat = Number(parsed.latitude);
    const lng = Number(parsed.longitude);
    if (isValidCoord(lat, lng)) {return { latitude: lat, longitude: lng };}
  }

  if (parsed.lat != null && (parsed.lng != null || parsed.lon != null)) {
    const lat = Number(parsed.lat);
    const lng = Number(parsed.lng ?? parsed.lon);
    if (isValidCoord(lat, lng)) {return { latitude: lat, longitude: lng };}
  }

  return null;
}

function extractGeometry(raw: unknown): GeoJSON.Geometry | null {
  if (raw == null || raw === "") {return null;}

  let parsed: any = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null) {return null;}

  if (parsed.type === "Feature" && parsed.geometry) {
    parsed = parsed.geometry;
  }

  const SUPPORTED = new Set([
    "Point",
    "Polygon",
    "MultiPolygon",
    "LineString",
    "MultiLineString",
    "GeometryCollection",
  ]);

  if (parsed.type && SUPPORTED.has(parsed.type)) {
    if (
      parsed.type === "GeometryCollection" &&
      Array.isArray(parsed.geometries)
    ) {
      return parsed as GeoJSON.Geometry;
    }
    if (Array.isArray(parsed.coordinates)) {
      return parsed as GeoJSON.Geometry;
    }
  }

  return null;
}

function isValidCoord(lat: number, lng: number): boolean {
  return (
    !isNaN(lat) &&
    !isNaN(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}
