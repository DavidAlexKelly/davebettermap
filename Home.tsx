import React, { useCallback, useEffect, useRef, useState } from "react";
import { Datasets } from "@osdk/foundry";
import {
  isAsyncValue_Loaded,
  isAsyncValue_Reloading,
  useWorkshopContext,
  visitLoadingState,
} from "@osdk/workshop-iframe-custom-widget";
import css from "./Home.module.css";
import { client } from "./auth/client";
import MapView from "./components/MapView";
import SettingsPanel from "./components/SettingsPanel";
import type { MediaSetStyleConfig, StreamSettingsInfo } from "./components/SettingsPanel";
import { MAP_CONFIG_DEFINITION } from "./config";
import { useLocalStorageState } from "./hooks/useLocalStorageState";
import {
  DEFAULT_SAVED_STATE,
  type MapSavedState,
  parseSavedState,
  useSavedStateWriter,
} from "./hooks/useSavedState";
import { useStreamGeoData } from "./hooks/useStreamGeoData";

/** Serialization helpers for Record<string, Set<string>>. */
const setRecordSerializer = {
  serialize: (val: Record<string, Set<string>>): string =>
    JSON.stringify(Object.fromEntries(Object.entries(val).map(([k, v]) => [k, [...v]]))),
  deserialize: (raw: string): Record<string, Set<string>> => {
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, new Set(v)]));
  },
};

/** Parse a boolean-list Workshop field value, defaulting missing indices to true. */
function parseToggleUI(raw: boolean[] | null | undefined): {
  showZoomControls: boolean;
  show3DToggle: boolean;
  showPinButton: boolean;
  showSettingsButton: boolean;
  showLiveFeaturesUI: boolean;
} {
  const arr = raw ?? [];
  return {
    showZoomControls: arr[0] ?? true,
    show3DToggle: arr[1] ?? true,
    showPinButton: arr[2] ?? true,
    showSettingsButton: arr[3] ?? true,
    showLiveFeaturesUI: arr[4] ?? true,
  };
}

function Home(): React.ReactElement {
  const workshopContext = useWorkshopContext(MAP_CONFIG_DEFINITION);
  return visitLoadingState(workshopContext, {
    loading: () => <div>Loading Workshop context…</div>,
    succeeded: (ctx) => <HomeMap workshopContext={ctx} />,
    reloading: () => <div>Reloading…</div>,
    failed: () => <div>Failed to load Workshop context. Running standalone.</div>,
  });
}

interface HomeMapProps {
  workshopContext: import("@osdk/workshop-iframe-custom-widget").IWorkshopContext<
    typeof MAP_CONFIG_DEFINITION
  >;
}

function HomeMap({ workshopContext }: HomeMapProps): React.ReactElement {
  // ── Read savedState from Workshop on first render ─────────────────
  const savedStateField = workshopContext.savedState.fieldValue;
  const savedStateRaw: string = (() => {
    if (isAsyncValue_Loaded(savedStateField)) {
      return savedStateField.value ?? "";
    }
    if (isAsyncValue_Reloading(savedStateField)) {
      return savedStateField.value ?? "";
    }
    return "";
  })();

  // Parse once on mount; ignore subsequent Workshop-driven changes so
  // the widget is always the source of truth after the first load.
  const initialStateRef = useRef<MapSavedState | null>(null);
  if (initialStateRef.current === null) {
    initialStateRef.current = parseSavedState(savedStateRaw) ?? DEFAULT_SAVED_STATE;
  }
  const initial = initialStateRef.current;

  // ── Read toggleUI from Workshop ────────────────────────────────────
  const toggleUIField = workshopContext.toggleUI.fieldValue;
  const toggleUIRaw: boolean[] | null = (() => {
    if (isAsyncValue_Loaded(toggleUIField)) {
      return toggleUIField.value ?? null;
    }
    if (isAsyncValue_Reloading(toggleUIField)) {
      return toggleUIField.value ?? null;
    }
    return null;
  })();
  const { showZoomControls, show3DToggle, showPinButton, showSettingsButton, showLiveFeaturesUI } =
    parseToggleUI(toggleUIRaw);

  // ── Transient UI state ────────────────────────────────────────────
  const [is3D, setIs3D] = useState(initial.is3D);
  const [markerMode, setMarkerMode] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Persisted settings (seeded from savedState, then kept in memory) ─
  const [multiPinMode, setMultiPinMode] = useLocalStorageState(
    "map:multiPinMode",
    initial.multiPinMode,
  );
  const [pinColor, setPinColor] = useLocalStorageState("map:pinColor", initial.pinColor);
  const [markerStyles, setMarkerStyles] = useLocalStorageState<Record<string, string>>(
    "map:markerStyles",
    initial.markerStyles,
  );
  const [baseMapStyle, setBaseMapStyle] = useLocalStorageState(
    "map:baseMapStyle",
    initial.baseMapStyle,
  );
  const [showTrails, setShowTrails] = useLocalStorageState("map:showTrails", initial.showTrails);

  const [datasetColumns, setDatasetColumns] = useState<Record<string, string[]>>({});

  const [visibleProperties, setVisibleProperties] = useLocalStorageState<
    Record<string, Set<string>>
  >(
    "map:visibleProperties",
    Object.fromEntries(Object.entries(initial.visibleProperties).map(([k, v]) => [k, new Set(v)])),
    setRecordSerializer,
  );

  const [titleProperties, setTitleProperties] = useLocalStorageState<Record<string, string>>(
    "map:titleProperties",
    initial.titleProperties,
  );

  const [datasetNames, setDatasetNames] = useState<Record<string, string>>({});

  const [mediaSetStyles, setMediaSetStyles] = useLocalStorageState<
    Record<string, MediaSetStyleConfig>
  >("map:mediaSetStyles", initial.mediaSetStyles);

  const [mediaSetPropertyValues, setMediaSetPropertyValues] = useState<Record<string, string[]>>(
    {},
  );

  const [mapReady, setMapReady] = useState(false);

  // Current map viewport — updated by MapView via onViewportChange
  const viewportRef = useRef(initial.viewport);

  const toggle3DRef = useRef<() => void>(() => {});
  const toggleMarkerModeRef = useRef<() => void>(() => {});
  const clearPinsRef = useRef<() => void>(() => {});

  // ── Saved-state writer ────────────────────────────────────────────
  const getSavedState = useCallback(
    (): MapSavedState => ({
      viewport: viewportRef.current,
      is3D,
      baseMapStyle,
      showTrails,
      markerStyles,
      titleProperties,
      visibleProperties: Object.fromEntries(
        Object.entries(visibleProperties).map(([k, v]) => [k, Array.from(v)]),
      ),
      mediaSetStyles,
      multiPinMode,
      pinColor,
    }),
    [
      is3D,
      baseMapStyle,
      showTrails,
      markerStyles,
      titleProperties,
      visibleProperties,
      mediaSetStyles,
      multiPinMode,
      pinColor,
    ],
  );

  const writeSavedState = useCallback(
    (json: string) => {
      workshopContext.savedState.setLoadedValue(json);
    },
    [workshopContext],
  );

  const persistState = useSavedStateWriter(getSavedState, writeSavedState);

  // Persist whenever any piece of settings state changes
  useEffect(() => {
    persistState({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    is3D,
    baseMapStyle,
    showTrails,
    markerStyles,
    titleProperties,
    visibleProperties,
    mediaSetStyles,
    multiPinMode,
    pinColor,
  ]);

  // Derive valid RIDs from workshop context
  const ridsField = workshopContext.datasetRids.fieldValue;
  const datasetRids: string[] = (() => {
    const raw = isAsyncValue_Loaded(ridsField)
      ? ridsField.value
      : isAsyncValue_Reloading(ridsField)
        ? ridsField.value
        : [];
    return (raw ?? []).filter((r: string) => r.startsWith("ri.foundry.main.dataset."));
  })();

  // Derive stream RIDs
  const streamRidsField = workshopContext.streamRids.fieldValue;
  const streamRids: string[] = (() => {
    const raw = isAsyncValue_Loaded(streamRidsField)
      ? streamRidsField.value
      : isAsyncValue_Reloading(streamRidsField)
        ? streamRidsField.value
        : [];
    return (raw ?? []).filter((r: string) => r.startsWith("ri.foundry.main.dataset."));
  })();

  // Stream live data hook
  const {
    streamLayers,
    streamInfos,
    discovering: streamsDiscovering,
  } = useStreamGeoData(streamRids, mapReady, 5_000);

  // Build stream settings infos for the SettingsPanel
  const streamSettingsInfos: StreamSettingsInfo[] = React.useMemo(() => {
    return Object.entries(streamInfos)
      .filter(([, info]) => info != null)
      .map(([rid, info]) => {
        const layer = streamLayers[rid];
        return {
          rid,
          name: info!.streamName,
          fieldNames: info!.fieldNames,
          geoExtractionMode: info!.geoExtractionMode,
          pointCount: layer?.points.length ?? 0,
          geometryCount: layer?.geometries.length ?? 0,
        };
      });
  }, [streamInfos, streamLayers]);

  // Fetch dataset names
  useEffect(() => {
    const unresolved = datasetRids.filter((rid) => !(rid in datasetNames));
    if (unresolved.length === 0) {
      return;
    }

    (async () => {
      const results = await Promise.allSettled(
        unresolved.map(async (rid) => {
          const dataset = await Datasets.Datasets.get(client, rid);
          return { rid, name: dataset.name ?? rid };
        }),
      );

      const updates: Record<string, string> = {};
      for (const result of results) {
        if (result.status === "fulfilled") {
          updates[result.value.rid] = result.value.name;
        } else {
          const rid = unresolved[results.indexOf(result)];
          updates[rid] = rid.split(".").pop() ?? rid;
        }
      }
      setDatasetNames((prev) => ({ ...prev, ...updates }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(datasetRids)]);

  const handleToggle3D = () => {
    toggle3DRef.current();
    setIs3D((p) => !p);
  };
  const handleToggleMarkerMode = () => {
    toggleMarkerModeRef.current();
    setMarkerMode((p) => !p);
  };
  const handleMarkerModeChanged = useCallback((active: boolean) => setMarkerMode(active), []);

  // Wrap setters so they also trigger a state persist
  const handleBaseMapStyleChange = useCallback(
    (style: string) => {
      setBaseMapStyle(style);
    },
    [setBaseMapStyle],
  );

  const handleShowTrailsToggle = useCallback(
    (v: boolean) => {
      setShowTrails(v);
    },
    [setShowTrails],
  );

  return (
    <div className={css.home}>
      {/* Stream status indicator */}
      {showLiveFeaturesUI && streamRids.length > 0 && (
        <div className={css.streamStatusBadge}>
          <span className={css.streamStatusDot} />
          {streamsDiscovering
            ? "Discovering streams…"
            : `${Object.values(streamLayers).reduce(
                (n, l) => n + l.points.length + l.geometries.length,
                0,
              )} live features`}
        </div>
      )}

      <div className={css.mapControlGroup}>
        {show3DToggle && (
          <button
            className={`${css.mapControlButton} ${is3D ? css.activeButton : ""}`}
            onClick={handleToggle3D}
            title={is3D ? "Switch to 2D" : "Switch to 3D"}
          >
            {is3D ? "2D" : "3D"}
          </button>
        )}
        {showPinButton && (
          <button
            className={`${css.mapControlButton} ${markerMode ? css.activeButton : ""}`}
            onClick={handleToggleMarkerMode}
            title="Place pin"
          >
            📍
          </button>
        )}
        {showSettingsButton && (
          <button
            className={css.mapControlButton}
            onClick={() => setSettingsOpen(true)}
            title="Settings"
          >
            ⚙️
          </button>
        )}
      </div>

      {settingsOpen && (
        <SettingsPanel
          multiPinMode={multiPinMode}
          onMultiPinToggle={setMultiPinMode}
          pinColor={pinColor}
          onPinColorChange={setPinColor}
          onClearPins={() => clearPinsRef.current()}
          markerStyles={markerStyles}
          onMarkerStyleChange={(rid, emoji) =>
            setMarkerStyles((prev) => ({ ...prev, [rid]: emoji }))
          }
          baseMapStyle={baseMapStyle}
          onBaseMapStyleChange={handleBaseMapStyleChange}
          showTrails={showTrails}
          onShowTrailsToggle={handleShowTrailsToggle}
          datasetRids={datasetRids}
          datasetNames={datasetNames}
          datasetColumns={datasetColumns}
          visibleProperties={visibleProperties}
          onVisiblePropertiesChange={(rid, props) =>
            setVisibleProperties((prev) => ({ ...prev, [rid]: props }))
          }
          titleProperties={titleProperties}
          onTitlePropertyChange={(rid, col) =>
            setTitleProperties((prev) => ({ ...prev, [rid]: col }))
          }
          mediaSetStyles={mediaSetStyles}
          onMediaSetStyleChange={(key, config) =>
            setMediaSetStyles((prev) => ({ ...prev, [key]: config }))
          }
          mediaSetPropertyValues={mediaSetPropertyValues}
          streamSettingsInfos={streamSettingsInfos}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <MapView
        workshopContext={workshopContext}
        is3D={is3D}
        markerMode={markerMode}
        multiPinMode={multiPinMode}
        pinColor={pinColor}
        markerStyles={markerStyles}
        baseMapStyle={baseMapStyle}
        visibleProperties={visibleProperties}
        titleProperties={titleProperties}
        mediaSetStyles={mediaSetStyles}
        streamLayers={streamLayers}
        showTrails={showTrails}
        showZoomControls={showZoomControls}
        initialViewport={initial.viewport}
        onViewportChange={(viewport) => {
          viewportRef.current = viewport;
          persistState({ viewport });
        }}
        onDatasetColumnsDiscovered={(rid, cols) => {
          setDatasetColumns((prev) => ({ ...prev, [rid]: cols }));
          setVisibleProperties((prev) => {
            if (prev[rid] != null) {
              return prev;
            }
            const TITLE_HINTS = ["name", "title", "label", "display_name", "displayname"];
            const titleCol = cols.find((c) => {
              const lower = c.toLowerCase();
              return TITLE_HINTS.some((h) => lower.includes(h));
            });
            const nonTitle = cols.filter((c) => c !== titleCol);
            const defaultVisible = new Set<string>(nonTitle.slice(0, 5));
            if (titleCol) {
              defaultVisible.add(titleCol);
            }
            return { ...prev, [rid]: defaultVisible };
          });
        }}
        onTitlePropertyAutoDetected={(rid, col) =>
          setTitleProperties((prev) => {
            if (prev[rid] != null) {
              return prev;
            }
            return { ...prev, [rid]: col };
          })
        }
        onMediaSetPropertyValuesDiscovered={(key, values) =>
          setMediaSetPropertyValues((prev) => ({ ...prev, [key]: values }))
        }
        onMarkerModeChanged={handleMarkerModeChanged}
        onMapLoaded={() => setMapReady(true)}
        onRegisterToggle3D={(fn) => {
          toggle3DRef.current = fn;
        }}
        onRegisterToggleMarkerMode={(fn) => {
          toggleMarkerModeRef.current = fn;
        }}
        onRegisterClearPins={(fn) => {
          clearPinsRef.current = fn;
        }}
        onDatasetPointSelected={(_rid, properties) => {
          const firstValue = String(Object.values(properties)[0] ?? "");
          workshopContext.selectedDatasetPoint.setLoadedValue(firstValue);
          workshopContext.onDatasetPointSelected.executeEvent();
        }}
        onBoundarySelected={(_key, properties) => {
          const firstValue = String(Object.values(properties)[0] ?? "");
          workshopContext.selectedBoundary.setLoadedValue(firstValue);
          workshopContext.onBoundarySelected.executeEvent();
        }}
        onStreamEntitySelected={(_rid, properties) => {
          const firstValue = String(Object.values(properties)[0] ?? "");
          workshopContext.selectedStreamEntity.setLoadedValue(firstValue);
          workshopContext.onStreamEntitySelected.executeEvent();
        }}
      />
    </div>
  );
}

export default Home;
