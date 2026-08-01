export const SUBAGENT_UI = {
  refreshMs: 3_000,
  widgetRowLimit: 3,
  doneRowLimit: 5,
  resultExcerptLines: 6,
  resultExcerptChars: 480,
  wideViewMin: 88,
  nameMin: 12,
  nameMax: 22,
  theme: {
    primary: "text",
    secondary: "muted",
    tertiary: "dim",
    divider: "borderMuted",
    selectionBg: "selectedBg",
    attention: "warning",
    error: "error",
  },
} as const;
