import { IConfigDefinition } from "@osdk/workshop-iframe-custom-widget";

export const MAP_CONFIG_DEFINITION = [
  {
    fieldId: "pinLatitude",
    field: {
      type: "single",
      label: "Pin Latitudes",
      fieldValue: {
        type: "inputOutput",
        variableType: {
          type: "number-list",
          defaultValue: [],
        },
      },
    },
  },
  {
    fieldId: "pinLongitude",
    field: {
      type: "single",
      label: "Pin Longitudes",
      fieldValue: {
        type: "inputOutput",
        variableType: {
          type: "number-list",
          defaultValue: [],
        },
      },
    },
  },
  {
    fieldId: "datasetRids",
    field: {
      type: "single",
      label: "Dataset RIDs",
      fieldValue: {
        type: "inputOutput",
        variableType: {
          type: "string-list",
          defaultValue: [],
        },
      },
    },
  },
  {
    fieldId: "geoColumns",
    field: {
      type: "single",
      label: "Geo Columns",
      fieldValue: {
        type: "inputOutput",
        variableType: {
          type: "string-list",
          defaultValue: [],
        },
      },
    },
  },
  {
    fieldId: "mediaSetInputs",
    field: {
      type: "single",
      label: "Media Set Inputs (mediasetRid::mediaItemRid",
      fieldValue: {
        type: "inputOutput",
        variableType: {
          type: "string-list",
          defaultValue: [],
        },
      },
    },
  },
  {
    fieldId: "streamRids",
    field: {
      type: "single",
      label: "Stream RIDs",
      fieldValue: {
        type: "inputOutput",
        variableType: {
          type: "string-list",
          defaultValue: [],
        },
      },
    },
  },
  // ── New: UI toggle flags ────────────────────────────────────────────
  // Ordered: [zoomControls, toggle3D, pinButton, settingsButton, liveFeaturesUI]
  {
    fieldId: "toggleUI",
    field: {
      type: "single",
      label: "Toggle UI (zoom controls, 3D toggle, pin button, settings button, live features UI)",
      fieldValue: {
        type: "inputOutput",
        variableType: {
          type: "boolean-list",
          defaultValue: [true, true, true, true, true],
        },
      },
    },
  },
  // ── New: Saved state JSON string ────────────────────────────────────
  {
    fieldId: "savedState",
    field: {
      type: "single",
      label: "Saved State",
      fieldValue: {
        type: "inputOutput",
        variableType: {
          type: "string",
          defaultValue: "",
        },
      },
    },
  },
  // ── Selection outputs + events ─────────────────────────────────────
  {
    fieldId: "selectedDatasetPoint",
    field: {
      type: "single" as const,
      label: "Selected Dataset Point",
      fieldValue: {
        type: "inputOutput" as const,
        variableType: {
          type: "string" as const,
          defaultValue: "",
        },
      },
    },
  },
  {
    fieldId: "onDatasetPointSelected",
    field: {
      type: "single" as const,
      label: "On Dataset Point Selected",
      fieldValue: { type: "event" as const },
    },
  },
  {
    fieldId: "selectedBoundary",
    field: {
      type: "single" as const,
      label: "Selected Boundary",
      fieldValue: {
        type: "inputOutput" as const,
        variableType: {
          type: "string" as const,
          defaultValue: "",
        },
      },
    },
  },
  {
    fieldId: "onBoundarySelected",
    field: {
      type: "single" as const,
      label: "On Boundary Selected",
      fieldValue: { type: "event" as const },
    },
  },
  {
    fieldId: "selectedStreamEntity",
    field: {
      type: "single" as const,
      label: "Selected Stream Entity",
      fieldValue: {
        type: "inputOutput" as const,
        variableType: {
          type: "string" as const,
          defaultValue: "",
        },
      },
    },
  },
  {
    fieldId: "onStreamEntitySelected",
    field: {
      type: "single" as const,
      label: "On Stream Entity Selected",
      fieldValue: { type: "event" as const },
    },
  },
] as const satisfies IConfigDefinition;
