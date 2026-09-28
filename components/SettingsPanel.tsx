/* eslint-disable react/no-unescaped-entities */
import React, { useState } from "react";
import EmojiPicker, { type EmojiClickData, EmojiStyle, Theme } from "emoji-picker-react";
import css from "./SettingsPanel.module.css";

type Tab = "settings" | "howto";

export interface BaseMapOption {
  id: string;
  label: string;
  url: string;
  stylePath: string;
}

export interface MediaSetStyleConfig {
  mode: "solid" | "property";
  solidColor: string;
  colorByProperty: string;
  fillOpacity: number;
  lineOpacity: number;
  valueColors: Record<string, string>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const DEFAULT_MEDIA_SET_STYLE: MediaSetStyleConfig = {
  mode: "solid",
  solidColor: "#215db0",
  colorByProperty: "",
  fillOpacity: 0.25,
  lineOpacity: 0.8,
  valueColors: {},
};

// eslint-disable-next-line react-refresh/only-export-components
export const CATEGORY_PALETTE = [
  "#215db0", "#2ecc71", "#e74c3c", "#f39c12", "#9b59b6",
  "#1abc9c", "#e67e22", "#3498db", "#d35400", "#8e44ad",
  "#16a085", "#c0392b", "#27ae60", "#2980b9", "#f1c40f",
  "#7f8c8d", "#e84393", "#00b894", "#6c5ce7", "#fd79a8",
];

// eslint-disable-next-line react-refresh/only-export-components
export const BASE_MAP_OPTIONS: BaseMapOption[] = [
  { id: "streets", label: "Default", url: "mapbox://styles/mapbox/streets-v12", stylePath: "mapbox/streets-v12" },
  { id: "standard", label: "Advanced 3D", url: "mapbox://styles/mapbox/standard", stylePath: "mapbox/streets-v12" },
  { id: "light", label: "Light", url: "mapbox://styles/mapbox/light-v11", stylePath: "mapbox/light-v11" },
  { id: "dark", label: "Dark", url: "mapbox://styles/mapbox/dark-v11", stylePath: "mapbox/dark-v11" },
  { id: "standard-satellite", label: "Satellite", url: "mapbox://styles/mapbox/standard-satellite", stylePath: "mapbox/satellite-streets-v12" },
  { id: "satellite", label: "Satellite (Pure)", url: "mapbox://styles/mapbox/satellite-v9", stylePath: "mapbox/satellite-v9" },
  { id: "outdoors", label: "Outdoors", url: "mapbox://styles/mapbox/outdoors-v12", stylePath: "mapbox/outdoors-v12" },
  { id: "navigation-day", label: "Nav Day", url: "mapbox://styles/mapbox/navigation-day-v1", stylePath: "mapbox/navigation-day-v1" },
  { id: "navigation-night", label: "Nav Night", url: "mapbox://styles/mapbox/navigation-night-v1", stylePath: "mapbox/navigation-night-v1" },
];

function baseMapPreviewUrl(stylePath: string): string {
  const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string;
  return `https://api.mapbox.com/styles/v1/${stylePath}/static/-0.12,51.5,10,0/120x80@2x?access_token=${token}`;
}

export interface StreamSettingsInfo {
  rid: string;
  name: string;
  fieldNames: string[];
  geoExtractionMode: string;
  pointCount: number;
  geometryCount: number;
}

interface SettingsPanelProps {
  multiPinMode: boolean;
  onMultiPinToggle: (enabled: boolean) => void;
  pinColor: string;
  onPinColorChange: (color: string) => void;
  onClearPins: () => void;
  markerStyles: Record<string, string>;
  onMarkerStyleChange: (rid: string, emoji: string) => void;
  baseMapStyle: string;
  onBaseMapStyleChange: (styleId: string) => void;
  showTrails: boolean;
  onShowTrailsToggle: (enabled: boolean) => void;
  datasetRids: string[];
  datasetNames: Record<string, string>;
  datasetColumns: Record<string, string[]>;
  visibleProperties: Record<string, Set<string>>;
  onVisiblePropertiesChange: (rid: string, props: Set<string>) => void;
  titleProperties: Record<string, string>;
  onTitlePropertyChange: (rid: string, column: string) => void;
  mediaSetStyles: Record<string, MediaSetStyleConfig>;
  onMediaSetStyleChange: (key: string, config: MediaSetStyleConfig) => void;
  mediaSetPropertyValues: Record<string, string[]>;
  streamSettingsInfos?: StreamSettingsInfo[];
  onClose: () => void;
}

/* ── Reusable collapsible section ── */
interface AccordionSectionProps {
  icon: string;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function AccordionSection({ icon, title, defaultOpen = false, children }: AccordionSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={css.accordionSection}>
      <button
        className={css.accordionHeader}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={css.accordionHeaderLeft}>
          <span className={css.accordionIcon}>{icon}</span>
          {title}
        </span>
        <span className={`${css.accordionChevron} ${open ? css.accordionChevronOpen : ""}`}>
          ▼
        </span>
      </button>
      {open && <div className={css.accordionBody}>{children}</div>}
    </div>
  );
}

export const ALL_DATASETS_KEY = "__all__";

function SettingsPanel({
  multiPinMode,
  onMultiPinToggle,
  pinColor,
  onPinColorChange,
  onClearPins,
  markerStyles,
  onMarkerStyleChange,
  baseMapStyle,
  onBaseMapStyleChange,
  showTrails,
  onShowTrailsToggle,
  datasetRids,
  datasetNames,
  datasetColumns,
  visibleProperties,
  onVisiblePropertiesChange,
  titleProperties,
  onTitlePropertyChange,
  mediaSetStyles,
  onMediaSetStyleChange,
  mediaSetPropertyValues,
  streamSettingsInfos = [],
  onClose,
}: SettingsPanelProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<Tab>("settings");
  const [selectedRid, setSelectedRid] = useState<string>(
    datasetRids.length > 0 ? datasetRids[0] : ALL_DATASETS_KEY
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  const mediaSetKeys = Object.keys(datasetColumns).filter((k) => k.startsWith("mediaset-"));
  const [selectedMediaSetKey, setSelectedMediaSetKey] = useState<string>(mediaSetKeys[0] ?? "");

  if (selectedMediaSetKey === "" && mediaSetKeys.length > 0) {
    setTimeout(() => setSelectedMediaSetKey(mediaSetKeys[0]), 0);
  }

  const isAll = selectedRid === ALL_DATASETS_KEY;
  const currentEmoji = markerStyles[selectedRid] ?? "";
  const effectiveEmoji = isAll
    ? currentEmoji
    : currentEmoji || (markerStyles[ALL_DATASETS_KEY] ?? "");

  const selectedColumns: string[] = isAll ? [] : (datasetColumns[selectedRid] ?? []);
  const selectedVisibleSet: Set<string> = isAll
    ? new Set<string>()
    : (visibleProperties[selectedRid] ?? new Set<string>());

  const isPropertyVisible = (col: string): boolean =>
    selectedVisibleSet.size === 0 || selectedVisibleSet.has(col);

  const handlePropertyToggle = (col: string) => {
    if (isAll) {return;}
    const current = visibleProperties[selectedRid];
    let next: Set<string>;
    if (!current || current.size === 0) {
      next = new Set(selectedColumns.filter((c) => c !== col));
    } else {
      next = new Set(current);
      if (next.has(col)) {
        next.delete(col);
      } else {
        next.add(col);
      }
      if (next.size === selectedColumns.length) {
        next = new Set<string>();
      }
    }
    onVisiblePropertiesChange(selectedRid, next);
  };

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    onMarkerStyleChange(selectedRid, emojiData.emoji);
    setPickerOpen(false);
  };

  const handleReset = () => {
    onMarkerStyleChange(selectedRid, "");
    setPickerOpen(false);
  };

  const msStyle: MediaSetStyleConfig =
    mediaSetStyles[selectedMediaSetKey] ?? { ...DEFAULT_MEDIA_SET_STYLE };
  const msColumns = datasetColumns[selectedMediaSetKey] ?? [];
  const msValues = mediaSetPropertyValues[selectedMediaSetKey] ?? [];

  const updateMsStyle = (patch: Partial<MediaSetStyleConfig>) => {
    onMediaSetStyleChange(selectedMediaSetKey, { ...msStyle, ...patch });
  };

  const getValueColor = (value: string, index: number): string => {
    return msStyle.valueColors[value] ?? CATEGORY_PALETTE[index % CATEGORY_PALETTE.length];
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className={css.settingsOverlay}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={(e) => { if (e.target === e.currentTarget) {onClose();} }}
      onKeyDown={(e) => { if (e.key === "Escape") {onClose();} }}
    >
      <div className={css.settingsPanel}>
        {/* Tab bar */}
        <div className={css.tabBar}>
          <button
            className={`${css.tab} ${activeTab === "settings" ? css.activeTab : ""}`}
            onClick={() => setActiveTab("settings")}
          >
            Settings
          </button>
          <button
            className={`${css.tab} ${activeTab === "howto" ? css.activeTab : ""}`}
            onClick={() => setActiveTab("howto")}
          >
            How to use
          </button>
        </div>

        {/* ── Settings tab ── */}
        {activeTab === "settings" && (
          <div className={css.settingsScrollArea}>
            {/* ── Custom Markers accordion ── */}
            <AccordionSection icon="📍" title="Custom Markers" defaultOpen>
              <div>
                <div className={css.settingRow}>
                  <span className={css.settingLabel} id="multi-pin-label">Multi-pin mode</span>
                  <label className={css.toggleSwitch} htmlFor="multi-pin-toggle">
                    <input
                      id="multi-pin-toggle"
                      type="checkbox"
                      checked={multiPinMode}
                      onChange={(e) => onMultiPinToggle(e.target.checked)}
                      aria-labelledby="multi-pin-label"
                    />
                    <span className={css.slider} />
                  </label>
                </div>
                <div className={css.settingDescription}>
                  Place multiple pins without removing the previous one.
                </div>
              </div>

              <div>
                <div className={css.settingRow}>
                  <span className={css.settingLabel} id="pin-color-label">Pin colour</span>
                  <input
                    id="pin-color-input"
                    type="color"
                    value={pinColor}
                    onChange={(e) => onPinColorChange(e.target.value)}
                    aria-labelledby="pin-color-label"
                    className={css.colorInput}
                  />
                </div>
                <div className={css.settingDescription}>
                  Choose the colour for newly placed pins.
                </div>
              </div>

              <button className={css.clearPinsButton} onClick={onClearPins}>
                Clear all pins
              </button>
            </AccordionSection>

            {/* ── Base Map accordion ── */}
            <AccordionSection icon="🗺" title="Base Map" defaultOpen={false}>
              <div className={css.settingDescription}>
                Choose the map style displayed beneath your data.
              </div>
              <div className={css.baseMapStrip}>
                {BASE_MAP_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    className={`${css.baseMapCard} ${baseMapStyle === opt.id ? css.baseMapCardActive : ""}`}
                    onClick={() => onBaseMapStyleChange(opt.id)}
                    title={opt.label}
                  >
                    <img
                      className={css.baseMapThumb}
                      src={baseMapPreviewUrl(opt.stylePath)}
                      alt={opt.label}
                      loading="lazy"
                    />
                    <span className={css.baseMapCardLabel}>{opt.label}</span>
                  </button>
                ))}
              </div>
            </AccordionSection>

            {/* ── Imported Datasets accordion ── */}
            <AccordionSection icon="📊" title="Imported Datasets" defaultOpen={false}>
              {datasetRids.length > 0 ? (
                <>
                  <div>
                    <div className={css.settingRow}>
                      <span className={css.settingLabel}>Dataset</span>
                      <select
                        className={css.datasetSelect}
                        value={selectedRid}
                        onChange={(e) => {
                          setSelectedRid(e.target.value);
                          setPickerOpen(false);
                        }}
                      >
                        <option value={ALL_DATASETS_KEY}>All Datasets</option>
                        {datasetRids.map((rid) => (
                          <option key={rid} value={rid}>
                            {datasetNames[rid] ?? rid.split(".").pop() ?? rid}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className={css.settingDescription}>
                      Settings below apply to the selected dataset{isAll ? "s" : ""}.
                    </div>
                  </div>

                  <div className={css.settingLabel}>Marker style</div>
                  <div className={css.settingRow}>
                    <span className={css.settingDescription}>
                      Current:{" "}
                      <span className={css.emojiPreview}>
                        {effectiveEmoji || (
                          <span style={{ color: "#5f6b7c" }}>default (●)</span>
                        )}
                      </span>
                      {!isAll && !currentEmoji && effectiveEmoji && (
                        <span style={{ color: "#8a9199", fontSize: 10, marginLeft: 4 }}>
                          (global)
                        </span>
                      )}
                    </span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        className={css.emojiPickerToggle}
                        onClick={() => setPickerOpen((p) => !p)}
                      >
                        {pickerOpen ? "Close" : "Pick emoji"}
                      </button>
                      {currentEmoji && (
                        <button className={css.resetEmojiButton} onClick={handleReset}>
                          Reset
                        </button>
                      )}
                    </div>
                  </div>

                  {pickerOpen && (
                    <div className={css.emojiPickerWrapper}>
                      <EmojiPicker
                        onEmojiClick={handleEmojiClick}
                        theme={Theme.LIGHT}
                        emojiStyle={EmojiStyle.NATIVE}
                        skinTonesDisabled
                        searchPlaceHolder="Search emoji…"
                        width="100%"
                        height={320}
                      />
                    </div>
                  )}

                  {!isAll && selectedColumns.length > 0 && (
                    <>
                      <div className={css.propertySectionDivider} />
                      <div className={css.settingLabel}>Popup properties</div>
                      <div className={css.settingRow}>
                        <span className={css.settingDescription}>Title property</span>
                        <select
                          className={css.datasetSelect}
                          value={titleProperties[selectedRid] ?? ""}
                          onChange={(e) =>
                            onTitlePropertyChange(selectedRid, e.target.value)
                          }
                        >
                          <option value="">None</option>
                          {selectedColumns.map((col) => (
                            <option key={col} value={col}>
                              {col}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className={css.settingDescription}>
                        Displayed bold at the top of the popup. Other visible properties are
                        listed below it.
                      </div>
                      <div className={css.propertyToggleList}>
                        {selectedColumns.map((col) => {
                          const isTitle = (titleProperties[selectedRid] ?? "") === col;
                          return (
                            <label key={col} className={css.propertyToggleRow}>
                              <input
                                type="checkbox"
                                checked={isPropertyVisible(col)}
                                onChange={() => handlePropertyToggle(col)}
                                className={css.propertyCheckbox}
                              />
                              <span className={css.propertyName}>
                                {col}
                                {isTitle && <span className={css.titleBadge}>title</span>}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              ) : (
                <div className={css.datasetListEmpty}>No datasets imported yet.</div>
              )}
            </AccordionSection>

            {/* ── Live Streams accordion ── */}
            <AccordionSection icon="📡" title="Live Streams" defaultOpen={false}>
              {streamSettingsInfos.length > 0 ? (
                <>
                  <div className={css.settingDescription}>
                    Connected streams update markers in real time. Set a custom emoji per
                    stream.
                  </div>

                  {/* Trail toggle */}
                  <div>
                    <div className={css.settingRow}>
                      <span className={css.settingLabel} id="trail-toggle-label">
                        Show entity trails
                      </span>
                      <label className={css.toggleSwitch} htmlFor="trail-toggle">
                        <input
                          id="trail-toggle"
                          type="checkbox"
                          checked={showTrails}
                          onChange={(e) => onShowTrailsToggle(e.target.checked)}
                          aria-labelledby="trail-toggle-label"
                        />
                        <span className={css.slider} />
                      </label>
                    </div>
                    <div className={css.settingDescription}>
                      Draw a fading path behind moving entities showing where they've been.
                    </div>
                  </div>

                  {streamSettingsInfos.map((info) => {
                    const emoji = markerStyles[info.rid] || "";
                    return (
                      <StreamEmojiRow
                        key={info.rid}
                        info={info}
                        emoji={emoji}
                        onEmojiChange={(e) => onMarkerStyleChange(info.rid, e)}
                      />
                    );
                  })}
                </>
              ) : (
                <div className={css.datasetListEmpty}>
                  No streams connected. Add streaming dataset RIDs to the{" "}
                  <strong>Stream RIDs</strong> variable.
                </div>
              )}
            </AccordionSection>

            {/* ── Media Set Boundaries accordion ── */}
            <AccordionSection icon="🔲" title="Media Set Boundaries" defaultOpen={false}>
              {mediaSetKeys.length > 0 ? (
                <>
                  {mediaSetKeys.length > 1 && (
                    <div>
                      <div className={css.settingRow}>
                        <span className={css.settingLabel}>Layer</span>
                        <select
                          className={css.datasetSelect}
                          value={selectedMediaSetKey}
                          onChange={(e) => setSelectedMediaSetKey(e.target.value)}
                        >
                          {mediaSetKeys.map((key) => {
                            const shortName =
                              key
                                .replace(/^mediaset-ri\.mio\.main\.media-set\.[^-]+-/, "")
                                .slice(0, 30) || key.slice(0, 30);
                            return (
                              <option key={key} value={key}>
                                {shortName}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                    </div>
                  )}

                  <div>
                    <div className={css.settingLabel}>Colour mode</div>
                    <div className={css.msColorModeRow}>
                      <button
                        className={`${css.msColorModeButton} ${msStyle.mode === "solid" ? css.msColorModeActive : ""}`}
                        onClick={() => updateMsStyle({ mode: "solid" })}
                      >
                        Solid
                      </button>
                      <button
                        className={`${css.msColorModeButton} ${msStyle.mode === "property" ? css.msColorModeActive : ""}`}
                        onClick={() => updateMsStyle({ mode: "property" })}
                      >
                        By Property
                      </button>
                    </div>
                  </div>

                  {msStyle.mode === "solid" && (
                    <div>
                      <div className={css.settingRow}>
                        <span className={css.settingLabel}>Fill colour</span>
                        <input
                          type="color"
                          value={msStyle.solidColor}
                          onChange={(e) => updateMsStyle({ solidColor: e.target.value })}
                          className={css.colorInput}
                        />
                      </div>
                    </div>
                  )}

                  {msStyle.mode === "property" && (
                    <>
                      <div>
                        <div className={css.settingRow}>
                          <span className={css.settingLabel}>Colour by</span>
                          <select
                            className={css.datasetSelect}
                            value={msStyle.colorByProperty}
                            onChange={(e) =>
                              updateMsStyle({
                                colorByProperty: e.target.value,
                                valueColors: {},
                              })
                            }
                          >
                            <option value="">Select property…</option>
                            {msColumns.map((col) => (
                              <option key={col} value={col}>
                                {col}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className={css.settingDescription}>
                          Each unique value gets a distinct colour.
                        </div>
                      </div>

                      {msStyle.colorByProperty && msValues.length > 0 && (
                        <div className={css.msValueColorList}>
                          {msValues.map((val, idx) => (
                            <div key={val} className={css.msValueColorRow}>
                              <input
                                type="color"
                                className={css.msValueSwatch}
                                value={getValueColor(val, idx)}
                                onChange={(e) => {
                                  const newColors = {
                                    ...msStyle.valueColors,
                                    [val]: e.target.value,
                                  };
                                  updateMsStyle({ valueColors: newColors });
                                }}
                              />
                              <span className={css.msValueLabel} title={val}>
                                {val.length > 28 ? val.slice(0, 26) + "…" : val}
                              </span>
                            </div>
                          ))}
                          {msValues.length > 20 && (
                            <div className={css.settingDescription}>
                              Showing first {msValues.length} unique values.
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  <div className={css.propertySectionDivider} />
                  <div>
                    <div className={css.settingRow}>
                      <span className={css.settingLabel}>Fill opacity</span>
                      <div className={css.msSliderGroup}>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={Math.round(msStyle.fillOpacity * 100)}
                          onChange={(e) =>
                            updateMsStyle({ fillOpacity: Number(e.target.value) / 100 })
                          }
                          className={css.msSlider}
                        />
                        <span className={css.msSliderValue}>
                          {Math.round(msStyle.fillOpacity * 100)}%
                        </span>
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className={css.settingRow}>
                      <span className={css.settingLabel}>Line opacity</span>
                      <div className={css.msSliderGroup}>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={Math.round(msStyle.lineOpacity * 100)}
                          onChange={(e) =>
                            updateMsStyle({ lineOpacity: Number(e.target.value) / 100 })
                          }
                          className={css.msSlider}
                        />
                        <span className={css.msSliderValue}>
                          {Math.round(msStyle.lineOpacity * 100)}%
                        </span>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className={css.datasetListEmpty}>No media set layers loaded yet.</div>
              )}
            </AccordionSection>
          </div>
        )}

        {/* ── How to use tab ── */}
        {activeTab === "howto" && (
          <div className={css.howToContent}>
            <AccordionSection icon="🚀" title="Getting Started" defaultOpen>
              <p className={css.howToText}>
                This widget requires Workshop variables wired up in the Workshop editor:
              </p>
              <ul className={css.howToList}>
                <li>
                  <strong>Dataset RIDs</strong> — a string list of Foundry dataset RIDs (
                  <code className={css.code}>ri.foundry.main.dataset.{'<uuid>'}</code>).
                </li>
                <li>
                  <strong>Geo Columns</strong> — a string list written back by the widget.
                  Leave empty for auto-detection or pre-populate with exact column names.
                </li>
                <li>
                  <strong>Pin Latitude</strong> &amp; <strong>Pin Longitude</strong> — number
                  list variables updated when a pin is placed or dragged.
                </li>
                <li>
                  <strong>Media Set Inputs</strong> — a string list in the format{" "}
                  <code className={css.code}>{'mediaSetRid::mediaItemIdentifier'}</code>.
                </li>
                <li>
                  <strong>Stream RIDs</strong> — a string list of streaming dataset RIDs (see{" "}
                  <em>Live Streams</em> below).
                </li>
              </ul>
              <p className={css.howToText}>
                <strong>Permissions:</strong> All datasets and streams must be accessible to
                the application's service user. Grant at least <strong>Viewer</strong> access
                in Foundry permissions.
              </p>
            </AccordionSection>

            <AccordionSection icon="📊" title="Datasets &amp; Geo Detection">
              <p className={css.howToText}>
                Add one or more dataset RIDs to the <strong>Dataset RIDs</strong> variable.
                The widget auto-detects geo columns by name (keywords like{" "}
                <code className={css.code}>geo</code>,{" "}
                <code className={css.code}>location</code>,{" "}
                <code className={css.code}>coordinates</code>,{" "}
                <code className={css.code}>point</code>).
              </p>
              <p className={css.howToText}>
                <strong>Supported point formats:</strong>
              </p>
              <ul className={css.howToList}>
                <li>
                  JSON: <code className={css.code}>{`{ latitude, longitude }`}</code> or{" "}
                  <code className={css.code}>{`{ lat, lng }`}</code>
                </li>
                <li>
                  GeoJSON Point:{" "}
                  <code className={css.code}>{`{ type: "Point", coordinates: [lng, lat] }`}</code>
                </li>
                <li>Geohash string (4–12 characters)</li>
              </ul>
              <p className={css.howToText}>
                If auto-detection fails, set the exact column name in{" "}
                <strong>Geo Columns</strong>.
              </p>
            </AccordionSection>

            <AccordionSection icon="🔲" title="Boundaries &amp; Geometry">
              <p className={css.howToText}>
                Datasets with geometry columns (names like{" "}
                <code className={css.code}>geometry</code>,{" "}
                <code className={css.code}>shape</code>,{" "}
                <code className={css.code}>polygon</code>,{" "}
                <code className={css.code}>boundary</code>) are rendered as filled polygons or
                lines.
              </p>
              <p className={css.howToText}>
                <strong>Supported formats:</strong>
              </p>
              <ul className={css.howToList}>
                <li>
                  GeoJSON:{" "}
                  <code className={css.code}>{`{ type: "Polygon", coordinates: [...] }`}</code>
                </li>
                <li>
                  GeoJSON Feature:{" "}
                  <code className={css.code}>{`{ type: "Feature", geometry: { ... } }`}</code>
                </li>
                <li>
                  WKT: <code className={css.code}>POLYGON((...)),</code>{" "}
                  <code className={css.code}>MULTIPOLYGON((...)),</code>{" "}
                  <code className={css.code}>LINESTRING(...)</code>
                </li>
              </ul>
              <p className={css.howToText}>
                Each dataset gets a unique colour. Click a boundary to see its properties.
              </p>
            </AccordionSection>

            <AccordionSection icon="🗂" title="Media Set GeoJSON">
              <p className={css.howToText}>
                Load GeoJSON files from Foundry Media Sets via the{" "}
                <strong>Media Set Inputs</strong> variable. Every entry <strong>must</strong>{" "}
                use the <code className={css.code}>::</code> separator:
              </p>
              <ul className={css.howToList}>
                <li>
                  <code className={css.code}>{'mediaSetRid::filename.geojson'}</code> — by
                  filename
                </li>
                <li>
                  <code className={css.code}>{'mediaSetRid::mediaItemRid'}</code> — by media
                  item RID
                </li>
              </ul>
              <p className={css.howToText}>
                Find the media set RID in the URL when viewing it in Foundry. Use{" "}
                <strong>Settings → Media Set Boundaries</strong> to colour by property, adjust
                opacity, or pick custom colours.
              </p>
            </AccordionSection>

            <AccordionSection icon="📡" title="Live Streams">
              <p className={css.howToText}>
                Display real-time data from Foundry Streams. Add one or more streaming dataset
                RIDs to the <strong>Stream RIDs</strong> variable.
              </p>
              <p className={css.howToText}>
                <strong>How it works:</strong>
              </p>
              <ul className={css.howToList}>
                <li>
                  On connect, the widget reads recent historical records to seed entity trails,
                  then snapshots the stream's current offsets — only <em>new</em> records after
                  that are polled live.
                </li>
                <li>
                  Every 5 seconds the widget polls for new records and updates markers in place.
                </li>
                <li>
                  Records with a unique ID field (e.g.{" "}
                  <code className={css.code}>id</code>,{" "}
                  <code className={css.code}>callsign</code>,{" "}
                  <code className={css.code}>device_id</code>) are deduplicated — a moving
                  entity shows one marker that updates position.
                </li>
                <li>
                  Moving entities automatically accumulate a <strong>trail</strong> showing
                  their path history. Toggle trails on/off in{" "}
                  <strong>Settings → Live Streams</strong>.
                </li>
              </ul>
              <p className={css.howToText}>
                <strong>Heading &amp; velocity (smooth animation):</strong>
              </p>
              <p className={css.howToText}>
                If records contain heading and velocity fields, markers are smoothly
                interpolated between poll cycles. Emoji markers also rotate to face the heading
                direction.
              </p>
              <p className={css.howToText}>
                <strong>Permissions:</strong> The OSDK client needs{" "}
                <code className={css.code}>api:use-streams-read</code> in its scopes.
              </p>
            </AccordionSection>

            <AccordionSection icon="📍" title="Placing Pins">
              <p className={css.howToText}>
                Click 📍 to enter pin mode — cursor becomes a crosshair. Click the map to
                place a pin. Coordinates are written back to <strong>Pin Latitude</strong> and{" "}
                <strong>Pin Longitude</strong> and can be dragged to update.
              </p>
              <p className={css.howToText}>
                Enable <strong>Multi-pin mode</strong> in Settings to place several pins at
                once. Use <strong>Clear all pins</strong> to remove them.
              </p>
            </AccordionSection>
          </div>
        )}

        <button className={css.settingsClose} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

// ─── Sub-component: per-stream emoji picker row ─────────────────────
function StreamEmojiRow({
  info,
  emoji,
  onEmojiChange,
}: {
  info: StreamSettingsInfo;
  emoji: string;
  onEmojiChange: (emoji: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={css.streamRow}>
      <div className={css.streamRowHeader}>
        <div className={css.streamRowNameGroup}>
          <span className={css.streamRowName}>{info.name}</span>
          <span className={css.streamRowMeta}>
            {info.pointCount + info.geometryCount} features · {info.geoExtractionMode}
          </span>
          <span className={css.streamRowMeta}>Columns: {info.fieldNames.join(", ")}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className={css.emojiPreview}>
            {emoji || <span style={{ color: "#ff6b35", fontSize: 16 }}>●</span>}
          </span>
          <button className={css.emojiPickerToggle} onClick={() => setOpen((p) => !p)}>
            {open ? "Close" : "Pick"}
          </button>
          {emoji && (
            <button className={css.resetEmojiButton} onClick={() => onEmojiChange("")}>
              ✕
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className={css.emojiPickerWrapper}>
          <EmojiPicker
            onEmojiClick={(data: EmojiClickData) => {
              onEmojiChange(data.emoji);
              setOpen(false);
            }}
            theme={Theme.LIGHT}
            emojiStyle={EmojiStyle.NATIVE}
            skinTonesDisabled
            searchPlaceHolder="Search emoji…"
            width="100%"
            height={280}
          />
        </div>
      )}
    </div>
  );
}

export default SettingsPanel;
