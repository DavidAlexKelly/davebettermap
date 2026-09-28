/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Datasets } from "@osdk/foundry";
import client from "../auth/client";

const LOG_PREFIX = "[DatasetService]";

/**
 * Geo-column detection keywords.
 * A column name containing any of these substrings (case-insensitive)
 * is considered a likely candidate for geographic data.
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

/**
 * Geometry-column detection keywords.
 * A column name containing any of these substrings (case-insensitive)
 * is considered a likely candidate for boundary / polygon / geometry data.
 */
const GEOMETRY_COLUMN_NAME_HINTS = [
  "geometry",
  "geom",
  "geo_shape",
  "geoshape",
  "shape",
  "polygon",
  "boundary",
  "boundaries",
  "border",
  "multipolygon",
  "linestring",
  "multilinestring",
  "geo",
  "geojson",
  "wkt",
];

/** A single parsed geo-point extracted from a dataset row. */
export interface GeoPointEntry {
  latitude: number;
  longitude: number;
  /** Altitude / elevation in metres. Null if not detected. */
  altitude: number | null;
  /** All remaining column values for popup display. */
  properties: Record<string, unknown>;
}

/** Supported GeoJSON geometry types for boundaries / shapes. */
export type GeoGeometryType =
  | "Polygon"
  | "MultiPolygon"
  | "LineString"
  | "MultiLineString"
  | "GeometryCollection";

/** A single parsed geometry entry extracted from a dataset row. */
export interface GeoGeometryEntry {
  /** The parsed GeoJSON geometry object. */
  geometry: GeoJSON.Geometry;
  /** All remaining column values for popup display. */
  properties: Record<string, unknown>;
}
/**
 * Fetch the dataset as CSV, auto-detect (or use the provided) geo column,
 * and extract geo-point data from each row.
 *
 * Strategy:
 *  1. Try to get the schema via the v2 getSchema endpoint (beta).
 *     If it 404s / errors, fall back to reading a small CSV sample
 *     and deriving column names from the header row.
 *  2. Identify the geo column (manual override or auto-detect).
 *  3. Read the full table as CSV and parse geo data.
 */
export async function fetchDatasetGeoData(
  datasetRid: string,
  manualGeoColumn?: string
): Promise<{
  geoColumnName: string | null;
  entries: GeoPointEntry[];
  allColumnNames: string[];
}> {
  console.log(`${LOG_PREFIX} Starting fetch for dataset: ${datasetRid}`);
  if (manualGeoColumn) {
    console.log(
      `${LOG_PREFIX} Manual geo column requested: "${manualGeoColumn}"`
    );
  }

  // ── Step 1: Discover column names ──────────────────────────────────
  let allColumnNames: string[] = [];
  let schemaFields: Array<{ name?: string; type: string }> = [];

  // Try schema endpoint first (beta – may 404)
  try {
    console.log(`${LOG_PREFIX} Attempting getSchema (beta)…`);
    const schemaResponse = await Datasets.Datasets.getSchema(
      client,
      datasetRid,
      {}
    );
    schemaFields = (schemaResponse.schema?.fieldSchemaList ?? []) as Array<{
      name?: string;
      type: string;
    }>;
    allColumnNames = schemaFields
      .map((f) => f.name)
      .filter((n): n is string => n != null);
    console.log(`${LOG_PREFIX} Schema fetched OK. Columns:`, allColumnNames);
  } catch (schemaErr) {
    console.warn(
      `${LOG_PREFIX} getSchema failed (this is expected if the beta API is unavailable). Falling back to CSV header detection.`,
      schemaErr
    );

    // Fallback: read just 1 row of CSV to learn the column names
    try {
      console.log(`${LOG_PREFIX} Reading 1-row CSV sample to detect columns…`);
      const sampleResp = await Datasets.Datasets.readTable(client, datasetRid, {
        format: "CSV",
        columns: [],
        rowLimit: 1,
      });
      const sampleText = await sampleResp.text();
      const firstLine = sampleText.split("\n")[0] ?? "";
      allColumnNames = splitCSVLine(firstLine);
      console.log(`${LOG_PREFIX} Columns from CSV header:`, allColumnNames);
    } catch (csvErr) {
      console.error(
        `${LOG_PREFIX} CSV sample also failed. Cannot read dataset.`,
        csvErr
      );
      throw csvErr;
    }
  }

  if (allColumnNames.length === 0) {
    console.warn(`${LOG_PREFIX} No columns found in dataset.`);
    return { geoColumnName: null, entries: [], allColumnNames };
  }

  // ── Step 2: Determine the geo column ───────────────────────────────
  let geoColumnName: string | null = null;

  if (manualGeoColumn && manualGeoColumn.trim() !== "") {
    // User specified a column — verify it exists (case-insensitive)
    const match = allColumnNames.find(
      (c) => c.toLowerCase() === manualGeoColumn.toLowerCase()
    );
    if (match) {
      geoColumnName = match;
      console.log(
        `${LOG_PREFIX} Manual column "${manualGeoColumn}" matched → "${geoColumnName}"`
      );
    } else {
      console.warn(
        `${LOG_PREFIX} Manual column "${manualGeoColumn}" NOT found among columns:`,
        allColumnNames
      );
      return { geoColumnName: null, entries: [], allColumnNames };
    }
  } else {
    // Auto-detect: prefer STRUCT/STRING columns with geo-ish names (if we have schema info)
    if (schemaFields.length > 0) {
      for (const field of schemaFields) {
        const name = field.name?.toLowerCase() ?? "";
        const isStructOrString =
          field.type === "STRUCT" || field.type === "STRING";
        if (
          isStructOrString &&
          GEO_COLUMN_NAME_HINTS.some((h) => name.includes(h))
        ) {
          geoColumnName = field.name!;
          break;
        }
      }
    }

    // Fallback: match column names only (no type info, or schema pass didn't match)
    if (!geoColumnName) {
      for (const col of allColumnNames) {
        if (GEO_COLUMN_NAME_HINTS.some((h) => col.toLowerCase().includes(h))) {
          geoColumnName = col;
          break;
        }
      }
    }

    if (geoColumnName) {
      console.log(`${LOG_PREFIX} Auto-detected geo column: "${geoColumnName}"`);
    } else {
      console.warn(
        `${LOG_PREFIX} No geo column detected among:`,
        allColumnNames
      );
    }
  }

  if (!geoColumnName) {
    return { geoColumnName: null, entries: [], allColumnNames };
  }

  // ── Step 3: Read full table as CSV ─────────────────────────────────
  console.log(`${LOG_PREFIX} Reading table CSV (up to 10 000 rows)…`);
  const response = await Datasets.Datasets.readTable(client, datasetRid, {
    format: "CSV",
    columns: allColumnNames,
    rowLimit: 10000,
  });

  const csvText = await response.text();
  const rows = parseCSV(csvText);
  console.log(`${LOG_PREFIX} Parsed ${rows.length} rows from CSV.`);

  if (rows.length > 0) {
    console.log(`${LOG_PREFIX} Sample row[0]:`, rows[0]);
  }

  // ── Step 4: Extract geo data ───────────────────────────────────────
  const entries: GeoPointEntry[] = [];
  const geoColLower = geoColumnName.toLowerCase();
  let parseFailures = 0;

  for (const row of rows) {
    const matchingKey = Object.keys(row).find(
      (k) => k.toLowerCase() === geoColLower
    );
    if (!matchingKey) {continue;}

    const rawValue = row[matchingKey];
    const point = extractGeoPoint(rawValue);
    if (!point) {
      parseFailures++;
      if (parseFailures <= 3) {
        console.warn(
          `${LOG_PREFIX} Could not parse geo from column "${matchingKey}":`,
          JSON.stringify(rawValue).slice(0, 200)
        );
      }
      continue;
    }

    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k.toLowerCase() !== geoColLower) {
        properties[k] = v;
      }
    }
    const altitude = detectAltitude(properties);
    entries.push({ ...point, altitude, properties });
  }

  console.log(
    `${LOG_PREFIX} Extracted ${entries.length} geo entries (${parseFailures} rows failed to parse).`
  );

  return { geoColumnName, entries, allColumnNames };
}

// ─── Geometry (boundary) fetch ───────────────────────────────────────

/**
 * Fetch the dataset as CSV, auto-detect (or use the provided) geometry column,
 * and extract boundary / geometry data from each row.
 *
 * Supports: Polygon, MultiPolygon, LineString, MultiLineString, GeometryCollection
 * Formats:  GeoJSON string, WKT string
 */
export async function fetchDatasetGeometryData(
  datasetRid: string,
  manualGeometryColumn?: string
): Promise<{
  geometryColumnName: string | null;
  entries: GeoGeometryEntry[];
  allColumnNames: string[];
}> {
  console.log(
    `${LOG_PREFIX} Starting geometry fetch for dataset: ${datasetRid}`
  );

  // ── Step 1: Discover column names ──────────────────────────────────
  let allColumnNames: string[] = [];
  let schemaFields: Array<{ name?: string; type: string }> = [];

  try {
    const schemaResponse = await Datasets.Datasets.getSchema(
      client,
      datasetRid,
      {}
    );
    schemaFields = (schemaResponse.schema?.fieldSchemaList ?? []) as Array<{
      name?: string;
      type: string;
    }>;
    allColumnNames = schemaFields
      .map((f) => f.name)
      .filter((n): n is string => n != null);
  } catch {
    try {
      const sampleResp = await Datasets.Datasets.readTable(client, datasetRid, {
        format: "CSV",
        columns: [],
        rowLimit: 1,
      });
      const sampleText = await sampleResp.text();
      allColumnNames = splitCSVLine(sampleText.split("\n")[0] ?? "");
    } catch (csvErr) {
      console.error(`${LOG_PREFIX} Cannot read dataset for geometry.`, csvErr);
      throw csvErr;
    }
  }

  if (allColumnNames.length === 0) {
    return { geometryColumnName: null, entries: [], allColumnNames };
  }

  // ── Step 2: Determine the geometry column ──────────────────────────
  let geometryColumnName: string | null = null;

  if (manualGeometryColumn && manualGeometryColumn.trim() !== "") {
    const match = allColumnNames.find(
      (c) => c.toLowerCase() === manualGeometryColumn.toLowerCase()
    );
    if (match) {
      geometryColumnName = match;
    } else {
      console.warn(
        `${LOG_PREFIX} Manual geometry column "${manualGeometryColumn}" not found.`
      );
      return { geometryColumnName: null, entries: [], allColumnNames };
    }
  } else {
    // Auto-detect: prefer columns whose names match geometry hints
    // but exclude columns that look like point-only columns
    const POINT_ONLY_HINTS = ["geopoint", "geo_point", "latlng", "latlong"];

    if (schemaFields.length > 0) {
      for (const field of schemaFields) {
        const name = field.name?.toLowerCase() ?? "";
        const isStructOrString =
          field.type === "STRUCT" || field.type === "STRING";
        const isPointOnly = POINT_ONLY_HINTS.some((h) => name.includes(h));
        if (
          isStructOrString &&
          !isPointOnly &&
          GEOMETRY_COLUMN_NAME_HINTS.some((h) => name.includes(h))
        ) {
          geometryColumnName = field.name!;
          break;
        }
      }
    }

    if (!geometryColumnName) {
      for (const col of allColumnNames) {
        const lower = col.toLowerCase();
        const isPointOnly = POINT_ONLY_HINTS.some((h) => lower.includes(h));
        if (
          !isPointOnly &&
          GEOMETRY_COLUMN_NAME_HINTS.some((h) => lower.includes(h))
        ) {
          geometryColumnName = col;
          break;
        }
      }
    }

    if (geometryColumnName) {
      console.log(
        `${LOG_PREFIX} Auto-detected geometry column: "${geometryColumnName}"`
      );
    }
  }

  if (!geometryColumnName) {
    return { geometryColumnName: null, entries: [], allColumnNames };
  }

  // ── Step 3: Read full table as CSV ─────────────────────────────────
  console.log(
    `${LOG_PREFIX} Reading table CSV for geometry (up to 10 000 rows)…`
  );
  const response = await Datasets.Datasets.readTable(client, datasetRid, {
    format: "CSV",
    columns: allColumnNames,
    rowLimit: 10000,
  });

  const csvText = await response.text();
  const rows = parseCSV(csvText);
  console.log(`${LOG_PREFIX} Parsed ${rows.length} rows for geometry.`);

  // ── Step 4: Extract geometry data ──────────────────────────────────
  const entries: GeoGeometryEntry[] = [];
  const geomColLower = geometryColumnName.toLowerCase();
  let parseFailures = 0;

  for (const row of rows) {
    const matchingKey = Object.keys(row).find(
      (k) => k.toLowerCase() === geomColLower
    );
    if (!matchingKey) {continue;}

    const rawValue = row[matchingKey];
    const geometry = extractGeometry(rawValue);
    if (!geometry) {
      parseFailures++;
      if (parseFailures <= 3) {
        console.warn(
          `${LOG_PREFIX} Could not parse geometry from "${matchingKey}":`,
          JSON.stringify(rawValue).slice(0, 200)
        );
      }
      continue;
    }

    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k.toLowerCase() !== geomColLower) {
        properties[k] = v;
      }
    }
    entries.push({ geometry, properties });
  }

  console.log(
    `${LOG_PREFIX} Extracted ${entries.length} geometry entries (${parseFailures} rows failed to parse).`
  );

  return { geometryColumnName, entries, allColumnNames };
}

// ─── Geo parsing helpers ─────────────────────────────────────────────

/**
 * Try to extract latitude/longitude from a raw cell value.
 * Supports:
 *   - JSON object with { latitude, longitude }
 *   - JSON object with { lat, lng } / { lat, lon }
 *   - GeoJSON Point: { type: "Point", coordinates: [lng, lat] }
 *   - Plain geohash strings (base-32, 4-12 chars) – decoded to centre point
 */
function extractGeoPoint(
  raw: unknown
): { latitude: number; longitude: number } | null {
  if (raw == null || raw === "") {return null;}

  const str = typeof raw === "string" ? raw.trim() : null;

  // Attempt JSON parse first
  let parsed: any = raw;
  if (str) {
    try {
      parsed = JSON.parse(str);
    } catch {
      // Not JSON — check if it's a geohash string
      if (isGeohashString(str)) {
        return decodeGeohash(str);
      }
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null) {return null;}

  // GeoJSON Point
  if (
    parsed.type === "Point" &&
    Array.isArray(parsed.coordinates) &&
    parsed.coordinates.length >= 2
  ) {
    const lng = Number(parsed.coordinates[0]);
    const lat = Number(parsed.coordinates[1]);
    if (isValidCoord(lat, lng)) {return { latitude: lat, longitude: lng };}
  }

  // { latitude, longitude }
  if (parsed.latitude != null && parsed.longitude != null) {
    const lat = Number(parsed.latitude);
    const lng = Number(parsed.longitude);
    if (isValidCoord(lat, lng)) {return { latitude: lat, longitude: lng };}
  }

  // { lat, lng } or { lat, lon }
  if (parsed.lat != null && (parsed.lng != null || parsed.lon != null)) {
    const lat = Number(parsed.lat);
    const lng = Number(parsed.lng ?? parsed.lon);
    if (isValidCoord(lat, lng)) {return { latitude: lat, longitude: lng };}
  }

  return null;
}

// ─── Altitude / elevation detection ──────────────────────────────────

const ALTITUDE_HINTS_METRES = [
  "altitude",
  "altitude_m",
  "elevation",
  "elevation_m",
  "alt",
  "alt_m",
  "height",
  "height_m",
  "elev",
  "elev_m",
  "z",
  "asl",
];

const ALTITUDE_HINTS_FEET = [
  "altitude_ft",
  "elevation_ft",
  "alt_ft",
  "height_ft",
  "elev_ft",
  "flight_level",
];

const ALTITUDE_HINTS_KM = [
  "altitude_km",
  "elevation_km",
  "alt_km",
  "height_km",
];

/**
 * Detect altitude/elevation from a record's properties.
 * Normalises to metres. Returns null if not found.
 */
export function detectAltitude(
  properties: Record<string, unknown>
): number | null {
  // Exact match first — metres
  for (const hint of ALTITUDE_HINTS_METRES) {
    for (const [key, value] of Object.entries(properties)) {
      if (key.toLowerCase() === hint && value != null && value !== "") {
        const n = Number(value);
        if (!isNaN(n) && isFinite(n)) {return n;}
      }
    }
  }
  // Exact match — feet
  for (const hint of ALTITUDE_HINTS_FEET) {
    for (const [key, value] of Object.entries(properties)) {
      if (key.toLowerCase() === hint && value != null && value !== "") {
        const n = Number(value);
        if (!isNaN(n) && isFinite(n)) {return n * 0.3048;}
      }
    }
  }
  // Exact match — kilometres
  for (const hint of ALTITUDE_HINTS_KM) {
    for (const [key, value] of Object.entries(properties)) {
      if (key.toLowerCase() === hint && value != null && value !== "") {
        const n = Number(value);
        if (!isNaN(n) && isFinite(n)) {return n * 1000;}
      }
    }
  }

  // Contains match — metres (most common)
  for (const hint of ALTITUDE_HINTS_METRES) {
    for (const [key, value] of Object.entries(properties)) {
      if (key.toLowerCase().includes(hint) && value != null && value !== "") {
        const n = Number(value);
        if (!isNaN(n) && isFinite(n)) {
          // Check if field name also contains a unit hint
          const lower = key.toLowerCase();
          if (lower.includes("ft") || lower.includes("feet")) {return n * 0.3048;}
          if (lower.includes("km")) {return n * 1000;}
          return n; // default metres
        }
      }
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

// ─── Geometry parsing helpers ────────────────────────────────────────

/** Supported GeoJSON geometry type strings for boundary data. */
const SUPPORTED_GEOMETRY_TYPES = new Set([
  "Polygon",
  "MultiPolygon",
  "LineString",
  "MultiLineString",
  "GeometryCollection",
]);

/**
 * Try to extract a GeoJSON geometry from a raw cell value.
 * Supports:
 *   - GeoJSON Geometry objects (Polygon, MultiPolygon, LineString, etc.)
 *   - GeoJSON Feature objects (extracts .geometry)
 *   - WKT strings (POLYGON, MULTIPOLYGON, LINESTRING, MULTILINESTRING)
 */
function extractGeometry(raw: unknown): GeoJSON.Geometry | null {
  if (raw == null || raw === "") {return null;}

  const str = typeof raw === "string" ? raw.trim() : null;

  // Try WKT first (if it looks like WKT)
  if (str) {
    const upperStr = str.toUpperCase();
    if (
      upperStr.startsWith("POLYGON") ||
      upperStr.startsWith("MULTIPOLYGON") ||
      upperStr.startsWith("LINESTRING") ||
      upperStr.startsWith("MULTILINESTRING") ||
      upperStr.startsWith("GEOMETRYCOLLECTION")
    ) {
      const geom = parseWKT(str);
      if (geom) {return geom;}
    }
  }

  // Try JSON parse
  let parsed: any = raw;
  if (str) {
    try {
      parsed = JSON.parse(str);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null) {return null;}

  // GeoJSON Feature → extract geometry
  if (parsed.type === "Feature" && parsed.geometry) {
    parsed = parsed.geometry;
  }

  // Validate it's a supported geometry type
  if (parsed.type && SUPPORTED_GEOMETRY_TYPES.has(parsed.type)) {
    // Basic structural validation
    if (parsed.type === "GeometryCollection") {
      if (Array.isArray(parsed.geometries)) {return parsed as GeoJSON.Geometry;}
    } else if (Array.isArray(parsed.coordinates)) {
      return parsed as GeoJSON.Geometry;
    }
  }

  // Also accept GeoJSON Point (will be handled as a point marker in the geometry layer if needed)
  if (parsed.type === "Point" && Array.isArray(parsed.coordinates)) {
    return parsed as GeoJSON.Geometry;
  }

  return null;
}

// ─── WKT parsing helpers ─────────────────────────────────────────────

/**
 * Basic WKT parser supporting POLYGON, MULTIPOLYGON, LINESTRING, MULTILINESTRING.
 * Handles nested parentheses and coordinate lists.
 */
function parseWKT(wkt: string): GeoJSON.Geometry | null {
  const trimmed = wkt.trim();
  const upper = trimmed.toUpperCase();

  try {
    if (upper.startsWith("MULTIPOLYGON")) {
      const coordStr = trimmed.slice(trimmed.indexOf("("));
      const coordinates = parseWKTMultiPolygonCoords(coordStr);
      if (coordinates) {return { type: "MultiPolygon", coordinates };}
    } else if (upper.startsWith("POLYGON")) {
      const coordStr = trimmed.slice(trimmed.indexOf("("));
      const coordinates = parseWKTPolygonCoords(coordStr);
      if (coordinates) {return { type: "Polygon", coordinates };}
    } else if (upper.startsWith("MULTILINESTRING")) {
      const coordStr = trimmed.slice(trimmed.indexOf("("));
      const coordinates = parseWKTMultiLineStringCoords(coordStr);
      if (coordinates) {return { type: "MultiLineString", coordinates };}
    } else if (upper.startsWith("LINESTRING")) {
      const coordStr = trimmed.slice(trimmed.indexOf("("));
      const coordinates = parseWKTLineStringCoords(coordStr);
      if (coordinates) {return { type: "LineString", coordinates };}
    }
  } catch (e) {
    console.warn(`${LOG_PREFIX} WKT parse error:`, e);
  }

  return null;
}

/** Parse a WKT coordinate pair list like "lng lat, lng lat, ..." */
function parseWKTCoordList(str: string): number[][] {
  return str
    .split(",")
    .map((pair) => {
      const parts = pair.trim().split(/\s+/).map(Number);
      return parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])
        ? [parts[0], parts[1]]
        : null;
    })
    .filter((c): c is number[] => c !== null);
}

/** Parse POLYGON coords: ((lng lat, lng lat, ...), (hole...)) */
function parseWKTPolygonCoords(str: string): number[][][] | null {
  // Strip outer parens: ((...), (...))
  const inner = stripOuterParens(str);
  if (!inner) {return null;}

  const rings = splitRings(inner);
  const result: number[][][] = [];
  for (const ring of rings) {
    const coords = parseWKTCoordList(stripOuterParens(ring) ?? ring);
    if (coords.length > 0) {result.push(coords);}
  }
  return result.length > 0 ? result : null;
}

/** Parse MULTIPOLYGON coords: (((lng lat, ...)), ((lng lat, ...))) */
function parseWKTMultiPolygonCoords(str: string): number[][][][] | null {
  const inner = stripOuterParens(str);
  if (!inner) {return null;}

  const polygons = splitRings(inner);
  const result: number[][][][] = [];
  for (const poly of polygons) {
    const coords = parseWKTPolygonCoords(poly);
    if (coords) {result.push(coords);}
  }
  return result.length > 0 ? result : null;
}

/** Parse LINESTRING coords: (lng lat, lng lat, ...) */
function parseWKTLineStringCoords(str: string): number[][] | null {
  const inner = stripOuterParens(str);
  if (!inner) {return null;}
  const coords = parseWKTCoordList(inner);
  return coords.length > 0 ? coords : null;
}

/** Parse MULTILINESTRING coords: ((lng lat, ...), (lng lat, ...)) */
function parseWKTMultiLineStringCoords(str: string): number[][][] | null {
  const inner = stripOuterParens(str);
  if (!inner) {return null;}

  const lines = splitRings(inner);
  const result: number[][][] = [];
  for (const line of lines) {
    const coords = parseWKTCoordList(stripOuterParens(line) ?? line);
    if (coords.length > 0) {result.push(coords);}
  }
  return result.length > 0 ? result : null;
}

/** Strip the outermost pair of parentheses from a string. */
function stripOuterParens(str: string): string | null {
  const trimmed = str.trim();
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    return trimmed.slice(1, -1).trim();
  }
  return null;
}

/** Split top-level comma-separated groups respecting nested parentheses. */
function splitRings(str: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = "";

  for (const ch of str) {
    if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }

  if (current.trim()) {result.push(current.trim());}
  return result;
}

// ─── Geohash helpers ─────────────────────────────────────────────────

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

function isGeohashString(s: string): boolean {
  if (s.length < 4 || s.length > 12) {return false;}
  return /^[0-9bcdefghjkmnpqrstuvwxyz]+$/i.test(s);
}

function decodeGeohash(
  hash: string
): { latitude: number; longitude: number } | null {
  let isLon = true;
  let latMin = -90,
    latMax = 90;
  let lonMin = -180,
    lonMax = 180;

  for (const c of hash.toLowerCase()) {
    const idx = BASE32.indexOf(c);
    if (idx === -1) {return null;}
    for (let bit = 4; bit >= 0; bit--) {
      const mid = isLon ? (lonMin + lonMax) / 2 : (latMin + latMax) / 2;
      if ((idx >> bit) & 1) {
        if (isLon) {lonMin = mid;}
        else {latMin = mid;}
      } else {
        if (isLon) {lonMax = mid;}
        else {latMax = mid;}
      }
      isLon = !isLon;
    }
  }

  const lat = (latMin + latMax) / 2;
  const lng = (lonMin + lonMax) / 2;
  return isValidCoord(lat, lng) ? { latitude: lat, longitude: lng } : null;
}

// ─── CSV helpers ─────────────────────────────────────────────────────

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split("\n");
  if (lines.length < 2) {return [];}

  const headers = splitCSVLine(lines[0]);
  const results: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") {continue;}
    const values = splitCSVLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    results.push(row);
  }
  return results;
}

function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
  }

  result.push(current.trim());
  return result;
}
