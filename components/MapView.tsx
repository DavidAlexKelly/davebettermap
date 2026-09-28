/* eslint-disable import/default */
/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useCallback, useEffect, useRef } from "react";
import { isAsyncValue_Loaded, isAsyncValue_Reloading } from "@osdk/workshop-iframe-custom-widget";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { MAP_CONFIG_DEFINITION } from "../config";
import type { StreamLayerData } from "../hooks/useStreamGeoData";
import {
  GeoGeometryEntry,
  GeoPointEntry,
  fetchDatasetGeoData,
  fetchDatasetGeometryData,
} from "../utils/datasetService";
import { loadGeoJsonFromMediaSets } from "../utils/mediaSetService";
import {
  type EntityMap,
  type InterpolatingEntity,
  applyHeadingRotation,
  startInterpolationLoop,
} from "../utils/streamInterpolation";
import {
  ALL_DATASETS_KEY,
  BASE_MAP_OPTIONS,
  CATEGORY_PALETTE,
  DEFAULT_MEDIA_SET_STYLE,
} from "./SettingsPanel";
import type { MediaSetStyleConfig } from "./SettingsPanel";

const DEFAULT_LNG = 0;
const DEFAULT_LAT = 0;
const DEFAULT_ZOOM = 1;
const BUILDING_LAYER_ID = "3d-buildings";

const GEOMETRY_FILL_COLORS = [
  "#215db0",
  "#2ecc71",
  "#e74c3c",
  "#f39c12",
  "#9b59b6",
  "#1abc9c",
  "#e67e22",
  "#3498db",
];

const EMOJI_BASE_SIZE_PX = 22;
const EMOJI_MIN_SIZE_PX = 10;
const EMOJI_MIN_ZOOM = 8;

function emojiSizeForZoom(zoom: number): number {
  if (zoom >= EMOJI_MIN_ZOOM) {
    return EMOJI_BASE_SIZE_PX;
  }
  const t = zoom / EMOJI_MIN_ZOOM;
  return EMOJI_MIN_SIZE_PX + t * (EMOJI_BASE_SIZE_PX - EMOJI_MIN_SIZE_PX);
}

function createEmojiMarkerElement(emoji: string, zoom?: number): HTMLDivElement {
  const size = emojiSizeForZoom(zoom ?? EMOJI_MIN_ZOOM);
  const root = document.createElement("div");
  root.style.cssText =
    "line-height:1;cursor:pointer;user-select:none;display:flex;align-items:center;justify-content:center;";
  const inner = document.createElement("div");
  inner.style.cssText = `font-size:${size}px;line-height:1;transition:transform 0.3s ease-out;`;
  inner.textContent = emoji;
  root.appendChild(inner);
  return root;
}

function geometrySourceId(rid: string): string {
  return `geometry-source-${rid}`;
}
function geometryFillLayerId(rid: string): string {
  return `geometry-fill-${rid}`;
}
function geometryLineLayerId(rid: string): string {
  return `geometry-line-${rid}`;
}

/** Trail layer IDs */
const TRAIL_SOURCE_ID = "stream-trails-source";
const TRAIL_LAYER_ID = "stream-trails-line";

interface MapViewProps {
  workshopContext: import("@osdk/workshop-iframe-custom-widget").IWorkshopContext<
    typeof MAP_CONFIG_DEFINITION
  >;
  is3D: boolean;
  markerMode: boolean;
  multiPinMode: boolean;
  pinColor: string;
  markerStyles: Record<string, string>;
  baseMapStyle: string;
  visibleProperties: Record<string, Set<string>>;
  titleProperties: Record<string, string>;
  mediaSetStyles: Record<string, MediaSetStyleConfig>;
  streamLayers?: Record<string, StreamLayerData>;
  /** Whether to render entity position trails. */
  showTrails?: boolean;
  /** Whether to show the Mapbox zoom/compass navigation control. */
  showZoomControls?: boolean;
  /** Initial viewport to restore from saved state on first mount. */
  initialViewport?: {
    lng: number;
    lat: number;
    zoom: number;
    pitch: number;
    bearing: number;
  };
  /** Called whenever the map viewport changes (moveend). */
  onViewportChange?: (viewport: {
    lng: number;
    lat: number;
    zoom: number;
    pitch: number;
    bearing: number;
  }) => void;
  onDatasetColumnsDiscovered: (rid: string, columns: string[]) => void;
  onTitlePropertyAutoDetected: (rid: string, column: string) => void;
  onMediaSetPropertyValuesDiscovered?: (key: string, values: string[]) => void;
  onMarkerModeChanged?: (active: boolean) => void;
  onMapLoaded?: () => void;
  onRegisterClearPins: (fn: () => void) => void;
  onRegisterToggle3D: (fn: () => void) => void;
  onRegisterToggleMarkerMode: (fn: () => void) => void;
  /** Called when the user clicks a dataset point marker. */
  onDatasetPointSelected?: (rid: string, properties: Record<string, unknown>) => void;
  /** Called when the user clicks a boundary (dataset geometry or media set layer). */
  onBoundarySelected?: (key: string, properties: Record<string, unknown>) => void;
  /** Called when the user clicks a live stream entity marker or geometry. */
  onStreamEntitySelected?: (rid: string, properties: Record<string, unknown>) => void;
}

function MapView({
  workshopContext,
  is3D,
  markerMode,
  multiPinMode,
  pinColor,
  markerStyles,
  baseMapStyle,
  visibleProperties,
  titleProperties,
  mediaSetStyles,
  streamLayers,
  showTrails = true,
  showZoomControls = true,
  initialViewport,
  onViewportChange,
  onDatasetColumnsDiscovered,
  onTitlePropertyAutoDetected,
  onMediaSetPropertyValuesDiscovered,
  onMarkerModeChanged,
  onMapLoaded,
  onRegisterClearPins,
  onRegisterToggle3D,
  onRegisterToggleMarkerMode,
  onDatasetPointSelected,
  onBoundarySelected,
  onStreamEntitySelected,
}: MapViewProps): React.ReactElement {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const pinMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const mapLoadedRef = useRef(false);
  const [mapLoaded, setMapLoaded] = React.useState(false);
  const [missingToken, setMissingToken] = React.useState(false);

  const markerModeRef = useRef(markerMode);
  const multiPinModeRef = useRef(multiPinMode);
  const pinColorRef = useRef(pinColor);
  const is3DRef = useRef(is3D);
  const markerStylesRef = useRef(markerStyles);
  const visiblePropertiesRef = useRef(visibleProperties);
  const titlePropertiesRef = useRef(titleProperties);
  const onMarkerModeChangedRef = useRef(onMarkerModeChanged);
  const mediaSetStylesRef = useRef(mediaSetStyles);
  const showTrailsRef = useRef(showTrails);

  useEffect(() => {
    markerModeRef.current = markerMode;
  }, [markerMode]);
  useEffect(() => {
    onMarkerModeChangedRef.current = onMarkerModeChanged;
  }, [onMarkerModeChanged]);
  useEffect(() => {
    multiPinModeRef.current = multiPinMode;
  }, [multiPinMode]);
  useEffect(() => {
    pinColorRef.current = pinColor;
  }, [pinColor]);
  useEffect(() => {
    is3DRef.current = is3D;
  }, [is3D]);
  useEffect(() => {
    markerStylesRef.current = markerStyles;
  }, [markerStyles]);
  useEffect(() => {
    visiblePropertiesRef.current = visibleProperties;
  }, [visibleProperties]);
  useEffect(() => {
    titlePropertiesRef.current = titleProperties;
  }, [titleProperties]);
  useEffect(() => {
    mediaSetStylesRef.current = mediaSetStyles;
  }, [mediaSetStyles]);
  useEffect(() => {
    showTrailsRef.current = showTrails;
  }, [showTrails]);

  const onMapLoadedRef = useRef(onMapLoaded);
  useEffect(() => {
    onMapLoadedRef.current = onMapLoaded;
  }, [onMapLoaded]);

  const onViewportChangeRef = useRef(onViewportChange);
  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  const onDatasetPointSelectedRef = useRef(onDatasetPointSelected);
  useEffect(() => {
    onDatasetPointSelectedRef.current = onDatasetPointSelected;
  }, [onDatasetPointSelected]);

  const onBoundarySelectedRef = useRef(onBoundarySelected);
  useEffect(() => {
    onBoundarySelectedRef.current = onBoundarySelected;
  }, [onBoundarySelected]);

  const onStreamEntitySelectedRef = useRef(onStreamEntitySelected);
  useEffect(() => {
    onStreamEntitySelectedRef.current = onStreamEntitySelected;
  }, [onStreamEntitySelected]);

  const userPinsRef = useRef<mapboxgl.Marker[]>([]);

  const datasetCacheRef = useRef<
    Record<
      string,
      {
        entries: GeoPointEntry[];
        markers: mapboxgl.Marker[];
      }
    >
  >({});

  const geometryCacheRef = useRef<
    Record<
      string,
      {
        entries: GeoGeometryEntry[];
      }
    >
  >({});

  const geometryColorIndexRef = useRef(0);
  const geometryRidColorRef = useRef<Record<string, string>>({});

  const mediaSetCacheRef = useRef<
    Record<
      string,
      {
        featureCollection: GeoJSON.FeatureCollection;
      }
    >
  >({});

  const lastDatasetRidsRef = useRef<string>("");
  const lastGeoColumnsInputRef = useRef<string>("");
  const lastMediaSetInputsRef = useRef<string>("");

  const initialDatasetFitDoneRef = useRef(false);
  const initialMediaSetFitDoneRef = useRef(false);

  const workshopContextRef = useRef(workshopContext);
  useEffect(() => {
    workshopContextRef.current = workshopContext;
  }, [workshopContext]);

  // Track whether trail source/layer has been created
  const trailLayerCreatedRef = useRef(false);

  // ── Helper: read the current lat/lng arrays from the Workshop context ─
  const getCurrentPinArrays = (): { lats: number[]; lngs: number[] } => {
    const latFv = workshopContextRef.current.pinLatitude.fieldValue;
    const lngFv = workshopContextRef.current.pinLongitude.fieldValue;
    const extract = (fv: typeof latFv): number[] => {
      if (isAsyncValue_Loaded(fv)) {
        return fv.value ?? [];
      }
      if (isAsyncValue_Reloading(fv)) {
        return fv.value ?? [];
      }
      return [];
    };
    return { lats: [...extract(latFv)], lngs: [...extract(lngFv)] };
  };

  // ── Place a user pin ─────────────────────────────────────────────────
  const placePinRef = useRef((lngLat: mapboxgl.LngLat) => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const isMulti = multiPinModeRef.current;
    if (!isMulti && pinMarkerRef.current) {
      pinMarkerRef.current.remove();
    }

    const marker = new mapboxgl.Marker({
      color: pinColorRef.current,
      draggable: true,
    })
      .setLngLat(lngLat)
      .addTo(map);
    pinMarkerRef.current = marker;

    let { lats, lngs } = getCurrentPinArrays();
    if (isMulti) {
      userPinsRef.current.push(marker);
      lats.push(lngLat.lat);
      lngs.push(lngLat.lng);
    } else {
      markerModeRef.current = false;
      if (map.getCanvas()) {
        map.getCanvas().style.cursor = "";
      }
      lats = [lngLat.lat];
      lngs = [lngLat.lng];
      onMarkerModeChangedRef.current?.(false);
    }

    workshopContextRef.current.pinLatitude.setLoadedValue(lats);
    workshopContextRef.current.pinLongitude.setLoadedValue(lngs);

    const pinIndex = lats.length - 1;
    marker.on("dragend", () => {
      const pos = marker.getLngLat();
      const current = getCurrentPinArrays();
      if (pinIndex < current.lats.length) {
        current.lats[pinIndex] = pos.lat;
        current.lngs[pinIndex] = pos.lng;
      }
      workshopContextRef.current.pinLatitude.setLoadedValue(current.lats);
      workshopContextRef.current.pinLongitude.setLoadedValue(current.lngs);
    });
  });

  // ── Fit the map to show all dataset markers + geometry bounds ────────
  const fitMapToAllMarkers = useCallback(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const bounds = new mapboxgl.LngLatBounds();
    let hasData = false;

    for (const cached of Object.values(datasetCacheRef.current)) {
      for (const entry of cached.entries) {
        bounds.extend([entry.longitude, entry.latitude]);
        hasData = true;
      }
    }

    for (const cached of Object.values(geometryCacheRef.current)) {
      for (const entry of cached.entries) {
        extendBoundsWithGeometry(bounds, entry.geometry);
        hasData = true;
      }
    }

    for (const cached of Object.values(mediaSetCacheRef.current)) {
      for (const feature of cached.featureCollection.features) {
        extendBoundsWithGeometry(bounds, feature.geometry);
        hasData = true;
      }
    }

    if (!hasData) {
      return;
    }
    map.fitBounds(bounds, { padding: 50, maxZoom: 15, duration: 1000 });
  }, []);

  // ── Build popup HTML for an entry ─────────────────────────────────
  const buildPopupHtml = useCallback(
    (rid: string, entry: { properties: Record<string, unknown> }): string => {
      const visSet = visiblePropertiesRef.current[rid];
      const titleCol = titlePropertiesRef.current[rid] ?? "";

      const allProps = Object.entries(entry.properties);
      const filtered =
        visSet && visSet.size > 0 ? allProps.filter(([k]) => visSet.has(k)) : allProps;

      let titleValue: string | null = null;
      const bodyProps: [string, unknown][] = [];
      for (const [k, v] of filtered) {
        if (titleCol && k === titleCol) {
          const s = v != null ? String(v).trim() : "";
          if (s) {
            titleValue = s;
          }
        } else {
          bodyProps.push([k, v]);
        }
      }

      const parts: string[] = [];
      if (titleValue) {
        parts.push(
          `<div style="font-weight:700;font-size:14px;color:#1c2127;margin-bottom:6px;border-bottom:1px solid #e1e4e8;padding-bottom:4px;">${titleValue}</div>`,
        );
      }

      if (bodyProps.length > 0) {
        const rows = bodyProps
          .map(
            ([k, v]) =>
              `<tr><td style="color:#5f6b7c;font-size:11px;padding:1px 8px 1px 0;vertical-align:top;white-space:nowrap;">${k}</td>` +
              `<td style="color:#1c2127;font-size:11px;padding:1px 0;vertical-align:top;">${v ?? ""}</td></tr>`,
          )
          .join("");
        parts.push(`<table style="border-collapse:collapse;">${rows}</table>`);
      }

      return parts.length > 0
        ? `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:2px 0;">${parts.join("")}</div>`
        : "";
    },
    [],
  );

  // ── Track all emoji marker DOM elements so we can resize on zoom ────
  const emojiElementsRef = useRef<Set<HTMLDivElement>>(new Set());

  const updateEmojiSizes = useCallback((zoom: number) => {
    const size = emojiSizeForZoom(zoom);
    for (const el of emojiElementsRef.current) {
      el.style.fontSize = `${size}px`;
    }
  }, []);

  const updateEmojiSizesRef = useRef(updateEmojiSizes);
  useEffect(() => {
    updateEmojiSizesRef.current = updateEmojiSizes;
  }, [updateEmojiSizes]);

  // ── Render markers for a single dataset ─────────────────────────────
  const renderMarkersForRid = useCallback(
    (rid: string, entries: GeoPointEntry[], emoji: string) => {
      const map = mapRef.current;
      if (!map) {
        return;
      }

      const existing = datasetCacheRef.current[rid];
      if (existing) {
        for (const m of existing.markers) {
          const inner = m.getElement()?.firstElementChild as HTMLDivElement | null;
          if (inner) {
            emojiElementsRef.current.delete(inner);
          }
          m.remove();
        }
      }

      const markers: mapboxgl.Marker[] = [];
      const currentZoom = map.getZoom();

      for (const entry of entries) {
        const propsHtml = buildPopupHtml(rid, entry);
        const popup = new mapboxgl.Popup({
          offset: 25,
          maxWidth: "280px",
        }).setHTML(propsHtml);

        let marker: mapboxgl.Marker;
        if (emoji) {
          const root = createEmojiMarkerElement(emoji, currentZoom);
          const inner = root.firstElementChild as HTMLDivElement;
          emojiElementsRef.current.add(inner);
          marker = new mapboxgl.Marker({ element: root })
            .setLngLat([entry.longitude, entry.latitude])
            .setPopup(popup)
            .addTo(map);
        } else {
          marker = new mapboxgl.Marker({ color: "#2ecc71" })
            .setLngLat([entry.longitude, entry.latitude])
            .setPopup(popup)
            .addTo(map);
        }

        // Fire onDatasetPointSelected when the user clicks a dataset point marker
        marker.getElement().addEventListener("click", () => {
          onDatasetPointSelectedRef.current?.(rid, entry.properties as Record<string, unknown>);
        });

        markers.push(marker);
      }

      datasetCacheRef.current[rid] = { entries, markers };
    },
    [buildPopupHtml],
  );

  // ── Render geometry layers for a single dataset ─────────────────────
  const renderGeometryForRid = useCallback(
    (rid: string, entries: GeoGeometryEntry[]) => {
      const map = mapRef.current;
      if (!map) {
        return;
      }

      const sourceId = geometrySourceId(rid);
      const fillLayerId = geometryFillLayerId(rid);
      const lineLayerId = geometryLineLayerId(rid);

      if (map.getLayer(fillLayerId)) {
        map.removeLayer(fillLayerId);
      }
      if (map.getLayer(lineLayerId)) {
        map.removeLayer(lineLayerId);
      }
      if (map.getSource(sourceId)) {
        map.removeSource(sourceId);
      }

      if (entries.length === 0) {
        return;
      }

      if (!geometryRidColorRef.current[rid]) {
        geometryRidColorRef.current[rid] =
          GEOMETRY_FILL_COLORS[geometryColorIndexRef.current % GEOMETRY_FILL_COLORS.length];
        geometryColorIndexRef.current++;
      }
      const color = geometryRidColorRef.current[rid];

      const features: GeoJSON.Feature[] = entries.map((entry, idx) => ({
        type: "Feature",
        id: idx,
        geometry: entry.geometry,
        properties: entry.properties as Record<string, any>,
      }));

      const featureCollection: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features,
      };

      map.addSource(sourceId, { type: "geojson", data: featureCollection });

      const hasPolygons = entries.some(
        (e) => e.geometry.type === "Polygon" || e.geometry.type === "MultiPolygon",
      );
      const hasLines = entries.some(
        (e) => e.geometry.type === "LineString" || e.geometry.type === "MultiLineString",
      );

      if (hasPolygons) {
        map.addLayer({
          id: fillLayerId,
          type: "fill",
          source: sourceId,
          filter: [
            "any",
            ["==", ["geometry-type"], "Polygon"],
            ["==", ["geometry-type"], "MultiPolygon"],
          ],
          paint: { "fill-color": color, "fill-opacity": 0.2 },
        });
      }

      if (hasPolygons || hasLines) {
        const lineFilter: any[] = ["any"];
        if (hasPolygons) {
          lineFilter.push(["==", ["geometry-type"], "Polygon"]);
          lineFilter.push(["==", ["geometry-type"], "MultiPolygon"]);
        }
        if (hasLines) {
          lineFilter.push(["==", ["geometry-type"], "LineString"]);
          lineFilter.push(["==", ["geometry-type"], "MultiLineString"]);
        }
        map.addLayer({
          id: lineLayerId,
          type: "line",
          source: sourceId,
          filter: lineFilter,
          paint: { "line-color": color, "line-width": 2, "line-opacity": 0.8 },
        });
      }

      const clickLayerIds = [fillLayerId, lineLayerId].filter((id) => map.getLayer(id));
      for (const layerId of clickLayerIds) {
        map.on("click", layerId, (e) => {
          if (!e.features || e.features.length === 0) {
            return;
          }
          const feature = e.features[0];
          const entry = entries.find((_ent, idx) => idx === feature.id) ?? entries[0];
          if (!entry) {
            return;
          }
          const html = buildPopupHtml(rid, entry);
          if (html) {
            new mapboxgl.Popup({ maxWidth: "280px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);
          }
          // Fire onBoundarySelected when the user clicks a dataset geometry boundary
          onBoundarySelectedRef.current?.(rid, entry.properties as Record<string, unknown>);
        });
        map.on("mouseenter", layerId, () => {
          if (!markerModeRef.current) {
            map.getCanvas().style.cursor = "pointer";
          }
        });
        map.on("mouseleave", layerId, () => {
          if (!markerModeRef.current) {
            map.getCanvas().style.cursor = "";
          }
        });
      }

      geometryCacheRef.current[rid] = { entries };
    },
    [buildPopupHtml],
  );

  // ── Build Mapbox paint colour expression for a media set layer ──
  const buildMediaSetColorExpr = useCallback(
    (key: string, featureCollection: GeoJSON.FeatureCollection): string | any[] => {
      const style = mediaSetStylesRef.current[key] ?? DEFAULT_MEDIA_SET_STYLE;
      if (style.mode === "solid" || !style.colorByProperty) {
        return style.solidColor;
      }

      const prop = style.colorByProperty;
      const valueSet = new Set<string>();
      for (const f of featureCollection.features) {
        const v = f.properties?.[prop];
        if (v != null) {
          valueSet.add(String(v));
        }
      }
      const uniqueValues = Array.from(valueSet).sort();
      if (uniqueValues.length === 0) {
        return style.solidColor;
      }

      const matchExpr: any[] = ["match", ["get", prop]];
      uniqueValues.forEach((val, idx) => {
        const color = style.valueColors[val] ?? CATEGORY_PALETTE[idx % CATEGORY_PALETTE.length];
        matchExpr.push(val, color);
      });
      matchExpr.push("#888888");
      return matchExpr;
    },
    [],
  );

  // ── Render a media-set GeoJSON FeatureCollection ─────────────────
  const renderMediaSetGeoJson = useCallback(
    (key: string, featureCollection: GeoJSON.FeatureCollection) => {
      const map = mapRef.current;
      if (!map) {
        return;
      }

      const sourceId = geometrySourceId(key);
      const fillLayerId = geometryFillLayerId(key);
      const lineLayerId = geometryLineLayerId(key);

      if (map.getLayer(fillLayerId)) {
        map.removeLayer(fillLayerId);
      }
      if (map.getLayer(lineLayerId)) {
        map.removeLayer(lineLayerId);
      }
      if (map.getSource(sourceId)) {
        map.removeSource(sourceId);
      }

      if (featureCollection.features.length === 0) {
        return;
      }

      const style = mediaSetStylesRef.current[key] ?? DEFAULT_MEDIA_SET_STYLE;
      const colorExpr = buildMediaSetColorExpr(key, featureCollection);

      map.addSource(sourceId, { type: "geojson", data: featureCollection });

      const hasPolygons = featureCollection.features.some(
        (f) => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon",
      );
      const hasLines = featureCollection.features.some(
        (f) => f.geometry.type === "LineString" || f.geometry.type === "MultiLineString",
      );

      if (hasPolygons) {
        map.addLayer({
          id: fillLayerId,
          type: "fill",
          source: sourceId,
          filter: [
            "any",
            ["==", ["geometry-type"], "Polygon"],
            ["==", ["geometry-type"], "MultiPolygon"],
          ],
          paint: {
            "fill-color": colorExpr as any,
            "fill-opacity": style.fillOpacity,
          },
        });
      }

      if (hasPolygons || hasLines) {
        const lineFilter: any[] = ["any"];
        if (hasPolygons) {
          lineFilter.push(["==", ["geometry-type"], "Polygon"]);
          lineFilter.push(["==", ["geometry-type"], "MultiPolygon"]);
        }
        if (hasLines) {
          lineFilter.push(["==", ["geometry-type"], "LineString"]);
          lineFilter.push(["==", ["geometry-type"], "MultiLineString"]);
        }
        map.addLayer({
          id: lineLayerId,
          type: "line",
          source: sourceId,
          filter: lineFilter,
          paint: {
            "line-color": colorExpr as any,
            "line-width": 2,
            "line-opacity": style.lineOpacity,
          },
        });
      }

      const clickLayerIds = [fillLayerId, lineLayerId].filter((id) => map.getLayer(id));
      for (const layerId of clickLayerIds) {
        map.on("click", layerId, (e) => {
          if (!e.features || e.features.length === 0) {
            return;
          }
          const feature = e.features[0];
          const props = feature.properties ?? {};
          const html = buildPopupHtml(key, { properties: props });
          if (html) {
            new mapboxgl.Popup({ maxWidth: "280px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);
          }
          // Fire onBoundarySelected when the user clicks a media set boundary
          onBoundarySelectedRef.current?.(key, props as Record<string, unknown>);
        });
        map.on("mouseenter", layerId, () => {
          if (!markerModeRef.current) {
            map.getCanvas().style.cursor = "pointer";
          }
        });
        map.on("mouseleave", layerId, () => {
          if (!markerModeRef.current) {
            map.getCanvas().style.cursor = "";
          }
        });
      }

      mediaSetCacheRef.current[key] = { featureCollection };
    },
    [buildPopupHtml, buildMediaSetColorExpr],
  );

  // ── Re-render dataset markers when styles change ──
  const markerStylesJsonRef = useRef(JSON.stringify(markerStyles));
  useEffect(() => {
    const newJson = JSON.stringify(markerStyles);
    const visChanged = visibleProperties !== visiblePropertiesRef.current;
    const titleChanged = titleProperties !== titlePropertiesRef.current;
    const stylesChanged = newJson !== markerStylesJsonRef.current;
    if (!stylesChanged && !visChanged && !titleChanged) {
      return;
    }
    markerStylesJsonRef.current = newJson;

    const globalEmoji = markerStyles[ALL_DATASETS_KEY] ?? "";
    for (const [rid, cached] of Object.entries(datasetCacheRef.current)) {
      const emoji = markerStyles[rid] || globalEmoji;
      renderMarkersForRid(rid, cached.entries, emoji);
    }
  }, [markerStyles, visibleProperties, titleProperties, renderMarkersForRid]);

  // ── Re-render geometry when popup settings change ──
  useEffect(() => {
    for (const [rid, cached] of Object.entries(geometryCacheRef.current)) {
      renderGeometryForRid(rid, cached.entries);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleProperties, titleProperties]);

  // ── Re-render media set layers when styles change ──
  useEffect(() => {
    for (const [key, cached] of Object.entries(mediaSetCacheRef.current)) {
      renderMediaSetGeoJson(key, cached.featureCollection);
      const style = mediaSetStyles[key];
      if (style?.colorByProperty && cached.featureCollection.features.length > 0) {
        const valSet = new Set<string>();
        for (const f of cached.featureCollection.features) {
          const v = f.properties?.[style.colorByProperty];
          if (v != null) {
            valSet.add(String(v));
          }
        }
        onMediaSetPropertyValuesDiscovered?.(key, Array.from(valSet).sort());
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaSetStyles]);

  // ── Toggle 3D ────────────────────────────────────────────────────────
  const toggle3D = useCallback(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const next = !is3DRef.current;
    if (next) {
      map.easeTo({ pitch: 60, bearing: -17.6 });
      if (map.getLayer(BUILDING_LAYER_ID)) {
        map.setLayoutProperty(BUILDING_LAYER_ID, "visibility", "visible");
      }
    } else {
      map.easeTo({ pitch: 0, bearing: 0 });
      if (map.getLayer(BUILDING_LAYER_ID)) {
        map.setLayoutProperty(BUILDING_LAYER_ID, "visibility", "none");
      }
    }
  }, []);

  // ── Toggle marker mode ───────────────────────────────────────────────
  const toggleMarkerMode = useCallback(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const next = !markerModeRef.current;
    markerModeRef.current = next;
    map.getCanvas().style.cursor = next ? "crosshair" : "";
  }, []);

  // ── Clear all user pins ──────────────────────────────────────────────
  const clearAllPins = useCallback(() => {
    for (const m of userPinsRef.current) {
      m.remove();
    }
    userPinsRef.current = [];
    if (pinMarkerRef.current) {
      pinMarkerRef.current.remove();
      pinMarkerRef.current = null;
    }
    workshopContextRef.current.pinLatitude.setLoadedValue([]);
    workshopContextRef.current.pinLongitude.setLoadedValue([]);
  }, []);

  useEffect(() => {
    onRegisterClearPins(clearAllPins);
    onRegisterToggle3D(toggle3D);
    onRegisterToggleMarkerMode(toggleMarkerMode);
  }, [
    clearAllPins,
    toggle3D,
    toggleMarkerMode,
    onRegisterClearPins,
    onRegisterToggle3D,
    onRegisterToggleMarkerMode,
  ]);

  // ── Initialise Mapbox ────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) {
      return;
    }

    const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string;
    if (!token || token.includes("%")) {
      setMissingToken(true);
      return;
    }

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [initialViewport?.lng ?? DEFAULT_LNG, initialViewport?.lat ?? DEFAULT_LAT],
      zoom: initialViewport?.zoom ?? DEFAULT_ZOOM,
      pitch: initialViewport?.pitch ?? 0,
      bearing: initialViewport?.bearing ?? 0,
    });

    mapRef.current = map;

    if (showZoomControls) {
      map.addControl(new mapboxgl.NavigationControl(), "top-right");
    }

    map.on("click", (e) => {
      if (markerModeRef.current) {
        placePinRef.current(e.lngLat);
      }
    });

    map.on("zoom", () => {
      updateEmojiSizesRef.current(map.getZoom());
    });

    // Persist viewport whenever the user finishes panning/zooming/rotating
    map.on("moveend", () => {
      const center = map.getCenter();
      onViewportChangeRef.current?.({
        lng: center.lng,
        lat: center.lat,
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
      });
    });

    map.on("load", () => {
      mapLoadedRef.current = true;
      setMapLoaded(true);
      onMapLoadedRef.current?.();

      const layers = map.getStyle().layers;
      let labelLayerId: string | undefined;
      for (const layer of layers ?? []) {
        if (layer.type === "symbol" && (layer.layout as any)?.["text-field"]) {
          labelLayerId = layer.id;
          break;
        }
      }

      map.addLayer(
        {
          id: BUILDING_LAYER_ID,
          source: "composite",
          "source-layer": "building",
          filter: ["==", "extrude", "true"],
          type: "fill-extrusion",
          minzoom: 12,
          paint: {
            "fill-extrusion-color": "#aaa",
            "fill-extrusion-height": [
              "interpolate",
              ["linear"],
              ["zoom"],
              12,
              0,
              12.05,
              ["get", "height"],
            ],
            "fill-extrusion-base": [
              "interpolate",
              ["linear"],
              ["zoom"],
              12,
              0,
              12.05,
              ["get", "min_height"],
            ],
            "fill-extrusion-opacity": 0.6,
          },
        },
        labelLayerId,
      );
      // Restore 3D building visibility from saved state
      map.setLayoutProperty(BUILDING_LAYER_ID, "visibility", is3DRef.current ? "visible" : "none");
    });

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      mapLoadedRef.current = false;
      setMapLoaded(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Switch base map style ──────────────────────────────────────────
  const baseMapStyleRef = useRef(baseMapStyle);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) {
      return;
    }
    if (baseMapStyle === baseMapStyleRef.current) {
      return;
    }
    baseMapStyleRef.current = baseMapStyle;

    const option = BASE_MAP_OPTIONS.find((o) => o.id === baseMapStyle);
    if (!option) {
      return;
    }

    map.setStyle(option.url);

    map.once("style.load", () => {
      const layers = map.getStyle().layers;
      let labelLayerId: string | undefined;
      for (const layer of layers ?? []) {
        if (layer.type === "symbol" && (layer.layout as any)?.["text-field"]) {
          labelLayerId = layer.id;
          break;
        }
      }

      map.addLayer(
        {
          id: BUILDING_LAYER_ID,
          source: "composite",
          "source-layer": "building",
          filter: ["==", "extrude", "true"],
          type: "fill-extrusion",
          minzoom: 12,
          paint: {
            "fill-extrusion-color": "#aaa",
            "fill-extrusion-height": [
              "interpolate",
              ["linear"],
              ["zoom"],
              12,
              0,
              12.05,
              ["get", "height"],
            ],
            "fill-extrusion-base": [
              "interpolate",
              ["linear"],
              ["zoom"],
              12,
              0,
              12.05,
              ["get", "min_height"],
            ],
            "fill-extrusion-opacity": 0.6,
          },
        },
        labelLayerId,
      );
      map.setLayoutProperty(BUILDING_LAYER_ID, "visibility", is3DRef.current ? "visible" : "none");

      for (const [rid, cached] of Object.entries(geometryCacheRef.current)) {
        renderGeometryForRid(rid, cached.entries);
      }
      for (const [key, cached] of Object.entries(mediaSetCacheRef.current)) {
        renderMediaSetGeoJson(key, cached.featureCollection);
      }

      // Trail source was destroyed by setStyle — mark for recreation
      trailLayerCreatedRef.current = false;
    });
  }, [baseMapStyle, renderGeometryForRid, renderMediaSetGeoJson]);

  // ── Dataset fetch effect ─────────────────────────────────────────────
  const SENTINEL_VALUES = ["No geo column found, Please Manually Enter", "geo column not found"];

  const datasetRidsFieldValue = workshopContext.datasetRids.fieldValue;
  const geoColumnsFieldValue = workshopContext.geoColumns.fieldValue;

  const extractStringListValue = (fv: typeof datasetRidsFieldValue): string[] => {
    if (isAsyncValue_Loaded(fv)) {
      return fv.value ?? [];
    }
    if (isAsyncValue_Reloading(fv)) {
      return fv.value ?? [];
    }
    return [];
  };

  const datasetRidsValue = extractStringListValue(datasetRidsFieldValue);
  const geoColumnsValue = extractStringListValue(geoColumnsFieldValue);

  useEffect(() => {
    if (!mapLoaded || datasetRidsValue.length === 0) {
      return;
    }

    const validRids = datasetRidsValue.filter((rid) => rid.startsWith("ri.foundry.main.dataset."));
    if (validRids.length === 0) {
      return;
    }

    const ridsKey = JSON.stringify(validRids);
    const effectiveGeos = validRids.map((_, i) => {
      const col = geoColumnsValue[i] ?? "";
      return SENTINEL_VALUES.includes(col) ? "" : col;
    });
    const geosKey = JSON.stringify(effectiveGeos);

    if (ridsKey === lastDatasetRidsRef.current && geosKey === lastGeoColumnsInputRef.current) {
      return;
    }
    lastDatasetRidsRef.current = ridsKey;
    lastGeoColumnsInputRef.current = geosKey;

    for (const cachedRid of Object.keys(datasetCacheRef.current)) {
      if (!validRids.includes(cachedRid)) {
        for (const m of datasetCacheRef.current[cachedRid].markers) {
          m.remove();
        }
        delete datasetCacheRef.current[cachedRid];
      }
    }

    const map = mapRef.current;
    for (const cachedRid of Object.keys(geometryCacheRef.current)) {
      if (!validRids.includes(cachedRid) && map) {
        const fillId = geometryFillLayerId(cachedRid);
        const lineId = geometryLineLayerId(cachedRid);
        const srcId = geometrySourceId(cachedRid);
        if (map.getLayer(fillId)) {
          map.removeLayer(fillId);
        }
        if (map.getLayer(lineId)) {
          map.removeLayer(lineId);
        }
        if (map.getSource(srcId)) {
          map.removeSource(srcId);
        }
        delete geometryCacheRef.current[cachedRid];
      }
    }

    (async () => {
      const resultGeoColumns: string[] = [];

      await Promise.all(
        validRids.map(async (rid, i) => {
          const userGeoInput = effectiveGeos[i];
          const isUserInput = userGeoInput !== "";

          try {
            const result = await fetchDatasetGeoData(rid, isUserInput ? userGeoInput : undefined);

            if (result.geoColumnName && result.entries.length > 0) {
              resultGeoColumns[i] = result.geoColumnName;
              const propNames = result.allColumnNames.filter(
                (c) => c.toLowerCase() !== result.geoColumnName!.toLowerCase(),
              );
              onDatasetColumnsDiscovered(rid, propNames);

              const TITLE_HINTS = ["name", "title", "label", "display_name", "displayname"];
              const autoTitle = propNames.find((col) => {
                const lower = col.toLowerCase();
                return TITLE_HINTS.some((h) => lower.includes(h));
              });
              if (autoTitle) {
                onTitlePropertyAutoDetected(rid, autoTitle);
              }

              renderMarkersForRid(
                rid,
                result.entries,
                markerStylesRef.current[rid] || (markerStylesRef.current[ALL_DATASETS_KEY] ?? ""),
              );
            } else {
              const geomResult = await fetchDatasetGeometryData(
                rid,
                isUserInput ? userGeoInput : undefined,
              );

              if (geomResult.geometryColumnName && geomResult.entries.length > 0) {
                resultGeoColumns[i] = geomResult.geometryColumnName;
                const propNames = geomResult.allColumnNames.filter(
                  (c) => c.toLowerCase() !== geomResult.geometryColumnName!.toLowerCase(),
                );
                onDatasetColumnsDiscovered(rid, propNames);

                const TITLE_HINTS = ["name", "title", "label", "display_name", "displayname"];
                const autoTitle = propNames.find((col) => {
                  const lower = col.toLowerCase();
                  return TITLE_HINTS.some((h) => lower.includes(h));
                });
                if (autoTitle) {
                  onTitlePropertyAutoDetected(rid, autoTitle);
                }

                renderGeometryForRid(rid, geomResult.entries);
              } else if (result.geoColumnName) {
                resultGeoColumns[i] = result.geoColumnName;
              } else if (isUserInput) {
                resultGeoColumns[i] = "geo column not found";
              } else {
                resultGeoColumns[i] = "No geo column found, Please Manually Enter";
              }
            }
          } catch (err) {
            console.error(`[Dataset Widget] Failed to fetch RID ${rid}:`, err);
            resultGeoColumns[i] = "geo column not found";
          }
        }),
      );

      workshopContext.geoColumns.setLoadedValue(resultGeoColumns);

      if (!initialDatasetFitDoneRef.current) {
        initialDatasetFitDoneRef.current = true;
        // Only auto-fit if no saved viewport was provided
        if (!initialViewport) {
          fitMapToAllMarkers();
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mapLoaded,
    datasetRidsValue,
    geoColumnsValue,
    workshopContext,
    renderMarkersForRid,
    renderGeometryForRid,
    fitMapToAllMarkers,
  ]);

  // ── Media Set GeoJSON fetch effect ──────────────────────────────────
  const mediaSetInputsFieldValue = workshopContext.mediaSetInputs.fieldValue;
  const mediaSetInputsValue = extractStringListValue(mediaSetInputsFieldValue);

  useEffect(() => {
    if (!mapLoaded || mediaSetInputsValue.length === 0) {
      return;
    }

    const inputsKey = JSON.stringify(mediaSetInputsValue);
    if (inputsKey === lastMediaSetInputsRef.current) {
      return;
    }
    lastMediaSetInputsRef.current = inputsKey;

    const map = mapRef.current;
    if (map) {
      for (const cachedKey of Object.keys(mediaSetCacheRef.current)) {
        const fillId = geometryFillLayerId(cachedKey);
        const lineId = geometryLineLayerId(cachedKey);
        const srcId = geometrySourceId(cachedKey);
        if (map.getLayer(fillId)) {
          map.removeLayer(fillId);
        }
        if (map.getLayer(lineId)) {
          map.removeLayer(lineId);
        }
        if (map.getSource(srcId)) {
          map.removeSource(srcId);
        }
        delete mediaSetCacheRef.current[cachedKey];
      }
    }

    (async () => {
      try {
        const results = await loadGeoJsonFromMediaSets(mediaSetInputsValue);
        for (const result of results) {
          const key = `mediaset-${result.mediaSetRid}-${result.mediaItemRid}`;
          renderMediaSetGeoJson(key, result.featureCollection);

          if (result.featureCollection.features.length > 0) {
            const sampleProps = result.featureCollection.features[0].properties ?? {};
            const propNames = Object.keys(sampleProps);
            onDatasetColumnsDiscovered(key, propNames);

            const TITLE_HINTS = ["name", "title", "label", "display_name", "displayname"];
            const autoTitle = propNames.find((col) => {
              const lower = col.toLowerCase();
              return TITLE_HINTS.some((h) => lower.includes(h));
            });
            if (autoTitle) {
              onTitlePropertyAutoDetected(key, autoTitle);
            }

            const currentStyle = mediaSetStylesRef.current[key];
            if (currentStyle?.colorByProperty) {
              const valSet = new Set<string>();
              for (const f of result.featureCollection.features) {
                const v = f.properties?.[currentStyle.colorByProperty];
                if (v != null) {
                  valSet.add(String(v));
                }
              }
              onMediaSetPropertyValuesDiscovered?.(key, Array.from(valSet).sort());
            }
          }
        }

        if (!initialMediaSetFitDoneRef.current) {
          initialMediaSetFitDoneRef.current = true;
          if (!initialViewport) {
            fitMapToAllMarkers();
          }
        }
      } catch (err) {
        console.error("[MediaSet Widget] Failed to load media set GeoJSON:", err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded, mediaSetInputsValue, renderMediaSetGeoJson, fitMapToAllMarkers]);

  // ── Live Stream data rendering effect ─────────────────────────────────
  const streamMarkerByEntityRef = useRef<Record<string, EntityMap>>({});
  const streamAnonymousMarkersRef = useRef<Record<string, mapboxgl.Marker[]>>({});

  useEffect(() => {
    const stop = startInterpolationLoop(streamMarkerByEntityRef);
    return stop;
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !streamLayers) {
      return;
    }

    const streamRids = Object.keys(streamLayers);
    if (streamRids.length === 0) {
      return;
    }

    const STREAM_POINT_COLOR = "#ff6b35";
    const currentZoom = map.getZoom();

    for (const [rid, layer] of Object.entries(streamLayers)) {
      // ── Render point markers (incremental + interpolation) ──
      if (layer.points.length > 0) {
        if (!streamMarkerByEntityRef.current[rid]) {
          streamMarkerByEntityRef.current[rid] = new Map();
        }
        const entityMap = streamMarkerByEntityRef.current[rid];

        const globalEmoji = markerStylesRef.current[ALL_DATASETS_KEY] ?? "";
        const ridEmoji = markerStylesRef.current[rid] || globalEmoji;

        const activeEntityIds = new Set<string>();
        const anonymousPoints: typeof layer.points = [];
        const now = performance.now();

        for (const point of layer.points) {
          if (point.entityId == null) {
            anonymousPoints.push(point);
            continue;
          }

          activeEntityIds.add(point.entityId);
          const existing = entityMap.get(point.entityId);

          if (existing) {
            existing.marker.setLngLat([point.longitude, point.latitude]);
            existing.startLat = point.latitude;
            existing.startLng = point.longitude;
            existing.heading = point.heading;
            existing.velocityMs = point.velocityMs;
            existing.startTime = now;

            applyHeadingRotation(existing, point.heading);

            const propsHtml = buildPopupHtml(rid, point);
            existing.marker.setPopup(
              new mapboxgl.Popup({ offset: 25, maxWidth: "280px" }).setHTML(propsHtml),
            );
          } else {
            const propsHtml = buildPopupHtml(rid, point);
            const popup = new mapboxgl.Popup({
              offset: 25,
              maxWidth: "280px",
            }).setHTML(propsHtml);

            let marker: mapboxgl.Marker;
            let rotateElement: HTMLDivElement | null = null;

            if (ridEmoji) {
              const root = createEmojiMarkerElement(ridEmoji, currentZoom);
              const inner = root.firstElementChild as HTMLDivElement;
              emojiElementsRef.current.add(inner);
              if (point.heading != null) {
                inner.style.transform = `rotate(${point.heading}deg)`;
              }
              rotateElement = inner;
              marker = new mapboxgl.Marker({ element: root })
                .setLngLat([point.longitude, point.latitude])
                .setPopup(popup)
                .addTo(map);
            } else {
              marker = new mapboxgl.Marker({ color: STREAM_POINT_COLOR })
                .setLngLat([point.longitude, point.latitude])
                .setPopup(popup)
                .addTo(map);
            }

            // Fire onStreamEntitySelected when the user clicks a stream entity marker
            marker.getElement().addEventListener("click", () => {
              onStreamEntitySelectedRef.current?.(rid, point.properties as Record<string, unknown>);
            });

            const interpEntity: InterpolatingEntity = {
              marker,
              startLat: point.latitude,
              startLng: point.longitude,
              heading: point.heading,
              velocityMs: point.velocityMs,
              startTime: now,
              rotateElement,
              altitude:
                (point.properties?.altitude as number | null) ??
                (point.properties?.baro_altitude as number | null) ??
                (point.properties?.geo_altitude as number | null) ??
                null,
              is3D: is3DRef.current,
            };
            entityMap.set(point.entityId, interpEntity);
          }
        }

        for (const [entityId, entry] of entityMap) {
          if (!activeEntityIds.has(entityId)) {
            const inner = entry.marker.getElement()?.firstElementChild as HTMLDivElement | null;
            if (inner) {
              emojiElementsRef.current.delete(inner);
            }
            entry.marker.remove();
            entityMap.delete(entityId);
          }
        }

        const oldAnon = streamAnonymousMarkersRef.current[rid] ?? [];
        for (const m of oldAnon) {
          const inner = m.getElement()?.firstElementChild as HTMLDivElement | null;
          if (inner) {
            emojiElementsRef.current.delete(inner);
          }
          m.remove();
        }

        const newAnon: mapboxgl.Marker[] = [];
        for (const point of anonymousPoints) {
          const propsHtml = buildPopupHtml(rid, point);
          const popup = new mapboxgl.Popup({
            offset: 25,
            maxWidth: "280px",
          }).setHTML(propsHtml);

          let marker: mapboxgl.Marker;
          if (ridEmoji) {
            const root = createEmojiMarkerElement(ridEmoji, currentZoom);
            const inner = root.firstElementChild as HTMLDivElement;
            emojiElementsRef.current.add(inner);
            marker = new mapboxgl.Marker({ element: root })
              .setLngLat([point.longitude, point.latitude])
              .setPopup(popup)
              .addTo(map);
          } else {
            marker = new mapboxgl.Marker({ color: STREAM_POINT_COLOR })
              .setLngLat([point.longitude, point.latitude])
              .setPopup(popup)
              .addTo(map);
          }

          // Fire onStreamEntitySelected when the user clicks an anonymous stream marker
          marker.getElement().addEventListener("click", () => {
            onStreamEntitySelectedRef.current?.(rid, point.properties as Record<string, unknown>);
          });

          newAnon.push(marker);
        }
        streamAnonymousMarkersRef.current[rid] = newAnon;
      }

      // ── Render geometry layers (update GeoJSON source in-place) ──
      if (layer.geometries.length > 0) {
        const streamSourceId = `stream-source-${rid}`;
        const streamFillId = `stream-fill-${rid}`;
        const streamLineId = `stream-line-${rid}`;

        const STREAM_POINT_COLOR_GEOM = "#ff6b35";

        const features: GeoJSON.Feature[] = layer.geometries.map((g, idx) => ({
          type: "Feature" as const,
          id: idx,
          geometry: g.geometry,
          properties: g.properties as Record<string, any>,
        }));

        const fc: GeoJSON.FeatureCollection = {
          type: "FeatureCollection",
          features,
        };

        const existingSource = map.getSource(streamSourceId) as mapboxgl.GeoJSONSource | undefined;

        if (existingSource) {
          existingSource.setData(fc);
        } else {
          map.addSource(streamSourceId, { type: "geojson", data: fc });

          const hasPolygons = features.some(
            (f) => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon",
          );
          const hasLines = features.some(
            (f) => f.geometry.type === "LineString" || f.geometry.type === "MultiLineString",
          );

          if (hasPolygons) {
            map.addLayer({
              id: streamFillId,
              type: "fill",
              source: streamSourceId,
              filter: [
                "any",
                ["==", ["geometry-type"], "Polygon"],
                ["==", ["geometry-type"], "MultiPolygon"],
              ],
              paint: {
                "fill-color": STREAM_POINT_COLOR_GEOM,
                "fill-opacity": 0.25,
              },
            });
          }

          if (hasPolygons || hasLines) {
            const lineFilter: any[] = ["any"];
            if (hasPolygons) {
              lineFilter.push(
                ["==", ["geometry-type"], "Polygon"],
                ["==", ["geometry-type"], "MultiPolygon"],
              );
            }
            if (hasLines) {
              lineFilter.push(
                ["==", ["geometry-type"], "LineString"],
                ["==", ["geometry-type"], "MultiLineString"],
              );
            }
            map.addLayer({
              id: streamLineId,
              type: "line",
              source: streamSourceId,
              filter: lineFilter,
              paint: {
                "line-color": STREAM_POINT_COLOR_GEOM,
                "line-width": 2,
                "line-opacity": 0.8,
              },
            });
          }

          for (const layerId of [streamFillId, streamLineId].filter((id) => map.getLayer(id))) {
            map.on("click", layerId, (e) => {
              if (!e.features || e.features.length === 0) {
                return;
              }
              const feature = e.features[0];
              const props = feature.properties ?? {};
              const html = buildPopupHtml(rid, { properties: props });
              if (html) {
                new mapboxgl.Popup({ maxWidth: "280px" })
                  .setLngLat(e.lngLat)
                  .setHTML(html)
                  .addTo(map);
              }
              // Fire onStreamEntitySelected when the user clicks a stream geometry
              onStreamEntitySelectedRef.current?.(rid, props as Record<string, unknown>);
            });
            map.on("mouseenter", layerId, () => {
              if (!markerModeRef.current) {
                map.getCanvas().style.cursor = "pointer";
              }
            });
            map.on("mouseleave", layerId, () => {
              if (!markerModeRef.current) {
                map.getCanvas().style.cursor = "";
              }
            });
          }
        }
      }
    }

    // Clean up stream RIDs that no longer exist
    for (const cachedRid of Object.keys(streamMarkerByEntityRef.current)) {
      if (!streamLayers[cachedRid]) {
        const entityMap = streamMarkerByEntityRef.current[cachedRid];
        for (const entry of entityMap.values()) {
          entry.marker.remove();
        }
        delete streamMarkerByEntityRef.current[cachedRid];
      }
    }
    for (const cachedRid of Object.keys(streamAnonymousMarkersRef.current)) {
      if (!streamLayers[cachedRid]) {
        for (const m of streamAnonymousMarkersRef.current[cachedRid]) {
          m.remove();
        }
        delete streamAnonymousMarkersRef.current[cachedRid];
      }
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded, streamLayers]);

  // ── Render stream entity trails as LineString layers ──────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !streamLayers) {
      return;
    }

    if (!showTrails) {
      if (map.getLayer(TRAIL_LAYER_ID)) {
        map.setLayoutProperty(TRAIL_LAYER_ID, "visibility", "none");
      }
      return;
    }

    if (map.getLayer(TRAIL_LAYER_ID)) {
      map.setLayoutProperty(TRAIL_LAYER_ID, "visibility", "visible");
    }

    const features: GeoJSON.Feature[] = [];

    for (const [, layer] of Object.entries(streamLayers)) {
      for (const point of layer.points) {
        if (!point.trail || point.trail.length < 2) {
          continue;
        }

        const coordinates: [number, number][] = point.trail.map((t) => [t.lng, t.lat]);

        features.push({
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates,
          },
          properties: {
            entityId: point.entityId ?? "unknown",
            trailLength: point.trail.length,
          },
        });
      }
    }

    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features,
    };

    const existingSource = map.getSource(TRAIL_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;

    if (existingSource && trailLayerCreatedRef.current) {
      existingSource.setData(fc);
    } else {
      if (map.getLayer(TRAIL_LAYER_ID)) {
        map.removeLayer(TRAIL_LAYER_ID);
      }
      if (map.getSource(TRAIL_SOURCE_ID)) {
        map.removeSource(TRAIL_SOURCE_ID);
      }

      map.addSource(TRAIL_SOURCE_ID, {
        type: "geojson",
        data: fc,
        lineMetrics: true,
      });

      map.addLayer({
        id: TRAIL_LAYER_ID,
        type: "line",
        source: TRAIL_SOURCE_ID,
        paint: {
          "line-color": "#ff6b35",
          "line-width": 2.5,
          "line-opacity": 0.8,
          "line-gradient": [
            "interpolate",
            ["linear"],
            ["line-progress"],
            0,
            "rgba(255, 107, 53, 0.05)",
            0.5,
            "rgba(255, 107, 53, 0.3)",
            1,
            "rgba(255, 107, 53, 0.8)",
          ],
        },
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
      });

      trailLayerCreatedRef.current = true;
    }
  }, [mapLoaded, streamLayers, showTrails]);

  if (missingToken) {
    return (
      <div style={{
        width: "100%", height: "100%", display: "flex", alignItems: "center",
        justifyContent: "center", background: "#0a0a0a", color: "#e0e0e0",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}>
        <div style={{ maxWidth: 480, textAlign: "center", padding: 32 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🗺️</div>
          <h2 style={{ margin: "0 0 12px", fontSize: 20, fontWeight: 600 }}>
            Mapbox Access Token Required
          </h2>
          <p style={{ margin: "0 0 20px", fontSize: 14, color: "#999", lineHeight: 1.6 }}>
            This application requires a Mapbox access token to render maps.
            Please set it in your environment configuration.
          </p>
          <div style={{
            background: "#1a1a1a", border: "1px solid #333", borderRadius: 8,
            padding: 16, textAlign: "left", fontSize: 13,
          }}>
            <p style={{ margin: "0 0 8px", fontWeight: 600, color: "#60a5fa" }}>
              How to configure:
            </p>
            <ol style={{ margin: 0, paddingLeft: 20, color: "#ccc", lineHeight: 1.8 }}>
              <li>Get a token from <strong>mapbox.com/account/access-tokens</strong></li>
              <li>Open <code style={{ background: "#252525", padding: "2px 6px", borderRadius: 3 }}>.env.production</code> in your code workspace</li>
              <li>Set <code style={{ background: "#252525", padding: "2px 6px", borderRadius: 3 }}>VITE_MAPBOX_ACCESS_TOKEN=pk.your_token_here</code></li>
              <li>Rebuild and redeploy the application</li>
            </ol>
          </div>
        </div>
      </div>
    );
  }

  return <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />;
}

// ─── Utility: extend LngLatBounds with a GeoJSON geometry ────────────
function extendBoundsWithGeometry(bounds: mapboxgl.LngLatBounds, geometry: GeoJSON.Geometry): void {
  switch (geometry.type) {
    case "Point":
      bounds.extend(geometry.coordinates as [number, number]);
      break;
    case "LineString":
    case "MultiPoint":
      for (const coord of geometry.coordinates) {
        bounds.extend(coord as [number, number]);
      }
      break;
    case "Polygon":
    case "MultiLineString":
      for (const ring of geometry.coordinates) {
        for (const coord of ring) {
          bounds.extend(coord as [number, number]);
        }
      }
      break;
    case "MultiPolygon":
      for (const polygon of geometry.coordinates) {
        for (const ring of polygon) {
          for (const coord of ring) {
            bounds.extend(coord as [number, number]);
          }
        }
      }
      break;
    case "GeometryCollection":
      for (const geom of geometry.geometries) {
        extendBoundsWithGeometry(bounds, geom);
      }
      break;
  }
}

export default MapView;
