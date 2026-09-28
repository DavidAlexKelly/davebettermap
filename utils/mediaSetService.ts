/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { MediaSets } from "@osdk/foundry";
import client from "../auth/client";

// The @osdk/foundry package re-exports MediaSets as a namespace containing
// a nested MediaSets object with the actual API functions.
const MediaSetApi = MediaSets.MediaSets;

const LOG_PREFIX = "[MediaSetService]";

/** A GeoJSON FeatureCollection or Geometry loaded from a media set item. */
export interface MediaSetGeoJsonResult {
  /** The media set RID this data came from. */
  mediaSetRid: string;
  /** The media item RID (if resolved). */
  mediaItemRid: string;
  /** The media item path / filename. */
  mediaItemPath: string;
  /** The parsed GeoJSON data as a FeatureCollection. */
  featureCollection: GeoJSON.FeatureCollection;
}

/**
 * Determine whether a filename looks like a GeoJSON file.
 */
function isGeoJsonFilename(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".geojson") || lower.endsWith(".json");
}

/**
 * Try to normalise arbitrary GeoJSON into a FeatureCollection.
 * Accepts: FeatureCollection, Feature, or bare Geometry objects.
 */
function toFeatureCollection(parsed: any): GeoJSON.FeatureCollection | null {
  if (!parsed || typeof parsed !== "object") {return null;}

  if (parsed.type === "FeatureCollection" && Array.isArray(parsed.features)) {
    return parsed as GeoJSON.FeatureCollection;
  }

  if (parsed.type === "Feature" && parsed.geometry) {
    return {
      type: "FeatureCollection",
      features: [parsed as GeoJSON.Feature],
    };
  }

  // Bare geometry
  const GEOM_TYPES = [
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
  ];
  if (GEOM_TYPES.includes(parsed.type)) {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: parsed as GeoJSON.Geometry,
          properties: {},
        },
      ],
    };
  }

  return null;
}

/**
 * Fetch a single media item by its RID from a media set, parse it as GeoJSON.
 */
async function fetchMediaItemAsGeoJson(
  mediaSetRid: string,
  mediaItemRid: string,
  mediaItemPath: string
): Promise<MediaSetGeoJsonResult | null> {
  try {
    console.log(
      `${LOG_PREFIX} Reading media item: ${mediaItemPath} (${mediaItemRid})`
    );
    const response = await MediaSetApi.read(client, mediaSetRid, mediaItemRid, {
      preview: true,
    });

    const text = await response.text();
    const parsed = JSON.parse(text);
    const fc = toFeatureCollection(parsed);

    if (!fc) {
      console.warn(
        `${LOG_PREFIX} Media item ${mediaItemPath} is valid JSON but not recognisable GeoJSON.`
      );
      return null;
    }

    console.log(
      `${LOG_PREFIX} Loaded ${fc.features.length} features from ${mediaItemPath}`
    );

    return {
      mediaSetRid,
      mediaItemRid,
      mediaItemPath,
      featureCollection: fc,
    };
  } catch (err) {
    console.error(
      `${LOG_PREFIX} Failed to read/parse media item ${mediaItemPath}:`,
      err
    );
    return null;
  }
}

/**
 * Given a media set RID and a media item path (filename), resolve the item
 * RID via `getRidByPath` and then fetch + parse it.
 */
export async function fetchMediaItemByPath(
  mediaSetRid: string,
  mediaItemPath: string
): Promise<MediaSetGeoJsonResult | null> {
  console.log(
    `${LOG_PREFIX} Resolving item path "${mediaItemPath}" in media set ${mediaSetRid}`
  );

  try {
    const ridResponse = await MediaSetApi.getRidByPath(client, mediaSetRid, {
      mediaItemPath,
      preview: true,
    });

    const mediaItemRid = ridResponse.mediaItemRid;
    if (!mediaItemRid) {
      console.warn(
        `${LOG_PREFIX} No media item RID returned for path "${mediaItemPath}"`
      );
      return null;
    }

    return fetchMediaItemAsGeoJson(mediaSetRid, mediaItemRid, mediaItemPath);
  } catch (err) {
    console.error(
      `${LOG_PREFIX} Failed to resolve media item path "${mediaItemPath}":`,
      err
    );
    return null;
  }
}

/**
 * Given a media set RID, try to discover all GeoJSON items inside it.
 *
 * Strategy: The Platform SDK doesn't expose a "list items" endpoint, so we
 * use the `info` call on known item RIDs. Since we can't enumerate items
 * directly, callers should provide specific media item paths or RIDs.
 *
 * This function accepts an array of media item identifiers. Each identifier
 * can be:
 *   - A media item RID (starts with "ri.mio.main.media-item.")
 *   - A filename / path within the media set (e.g. "boundaries.geojson")
 *
 * If the identifiers array is empty, we cannot enumerate the media set
 * automatically (the SDK has no list endpoint). In that case we return an
 * empty array and log a warning.
 */
export async function fetchMediaSetGeoJson(
  mediaSetRid: string,
  mediaItemIdentifiers: string[]
): Promise<MediaSetGeoJsonResult[]> {
  console.log(
    `${LOG_PREFIX} Fetching GeoJSON from media set ${mediaSetRid} with ${mediaItemIdentifiers.length} identifier(s)`
  );

  if (mediaItemIdentifiers.length === 0) {
    console.warn(
      `${LOG_PREFIX} No media item identifiers provided for media set ${mediaSetRid}. ` +
        `The Media Sets SDK does not provide a list-items endpoint, so individual ` +
        `media item paths or RIDs must be specified.`
    );
    return [];
  }

  const results: MediaSetGeoJsonResult[] = [];

  await Promise.all(
    mediaItemIdentifiers.map(async (identifier) => {
      const trimmed = identifier.trim();
      if (!trimmed) {return;}

      let result: MediaSetGeoJsonResult | null = null;

      if (trimmed.startsWith("ri.mio.main.media-item.")) {
        // It's a media item RID — fetch directly
        // We don't have the path, so use the RID as the path label
        result = await fetchMediaItemAsGeoJson(mediaSetRid, trimmed, trimmed);
      } else {
        // Treat it as a file path/name — resolve the RID first
        if (!isGeoJsonFilename(trimmed)) {
          console.log(
            `${LOG_PREFIX} Skipping "${trimmed}" — doesn't look like a GeoJSON file`
          );
          return;
        }
        result = await fetchMediaItemByPath(mediaSetRid, trimmed);
      }

      if (result) {
        results.push(result);
      }
    })
  );

  return results;
}

/**
 * High-level entry point: process an array of "media set input" strings.
 *
 * Every entry **must** use the `mediaSetRid::mediaItemIdentifier` format,
 * where the identifier is either:
 *   - A filename / path (e.g. `boundaries.geojson`)
 *   - A media item RID (e.g. `ri.mio.main.media-item.xxxx`)
 *
 * The Foundry Media Sets API requires both a media set RID and a media item
 * RID / path to read content — there is no way to fetch by media item RID
 * alone. Entries that don't contain `::` are ignored with a warning.
 *
 * Returns all successfully loaded GeoJSON results.
 */
export async function loadGeoJsonFromMediaSets(
  inputs: string[]
): Promise<MediaSetGeoJsonResult[]> {
  const results: MediaSetGeoJsonResult[] = [];

  // Group items by media set RID
  const grouped = new Map<string, string[]>();

  for (const input of inputs) {
    const trimmed = input.trim();
    if (!trimmed) {continue;}

    if (!trimmed.includes("::")) {
      console.warn(
        `${LOG_PREFIX} Skipping "${trimmed}" — expected format is "mediaSetRid::mediaItemPath" ` +
          `or "mediaSetRid::mediaItemRid". The Foundry Media Sets API requires both ` +
          `a media set RID and a media item identifier.`
      );
      continue;
    }

    const [setRid, ...rest] = trimmed.split("::");
    const itemIdentifier = rest.join("::").trim();
    if (!setRid || !itemIdentifier) {
      console.warn(
        `${LOG_PREFIX} Skipping "${trimmed}" — both sides of "::" must be non-empty.`
      );
      continue;
    }

    const existing = grouped.get(setRid) ?? [];
    existing.push(itemIdentifier);
    grouped.set(setRid, existing);
  }

  await Promise.all(
    Array.from(grouped.entries()).map(async ([mediaSetRid, items]) => {
      const setResults = await fetchMediaSetGeoJson(mediaSetRid, items);
      results.push(...setResults);
    })
  );

  return results;
}
