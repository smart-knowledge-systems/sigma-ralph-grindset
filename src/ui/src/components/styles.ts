// Shared style constants used across UI components

import type { CSSProperties } from "react";

// Brand styles shared between App.tsx and ConfigApp.tsx
export const brandRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};

export const brandMark: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 10,
  background: "linear-gradient(135deg, #FFD90F 0%, #F5C800 100%)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 800,
  fontSize: 22,
  color: "#3D3D3D",
  boxShadow: "0 2px 8px rgba(255, 217, 15, 0.3)",
};

export const brandTitle: CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 800,
  color: "#3D3D3D",
  letterSpacing: 1.5,
  lineHeight: 1,
};

export const brandSub: CSSProperties = {
  margin: 0,
  fontSize: 11,
  fontWeight: 600,
  color: "#8C8370",
  letterSpacing: 0.5,
  lineHeight: 1.3,
};

// Shared card styles used across AuditProgress, FixProgress, etc.
export const card: CSSProperties = {
  background: "#FFFFFF",
  borderRadius: 12,
  border: "1px solid #EDE5CC",
  overflow: "hidden",
  boxShadow: "0 1px 4px rgba(61, 61, 61, 0.06)",
};

export const cardHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 18px 10px",
};

export const cardFooter: CSSProperties = {
  display: "flex",
  gap: 16,
  padding: "10px 18px",
  borderTop: "1px solid #F0E8D0",
  fontSize: 13,
  fontWeight: 700,
};

export const headerStats: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
};

export const statChip: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#8C8370",
};

export const fileBadge: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#8C8370",
  background: "#F5EED8",
  padding: "2px 8px",
  borderRadius: 10,
  whiteSpace: "nowrap",
};

export const progressTrack: CSSProperties = {
  height: 3,
  background: "#F0E8D0",
  margin: "0 18px",
  borderRadius: 2,
  overflow: "hidden",
};

export const progressFill: CSSProperties = {
  height: "100%",
  background: "linear-gradient(90deg, #FFD90F, #2A9D8F)",
  borderRadius: 2,
  transition: "width 0.5s ease",
};

export const emptyCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  padding: 48,
  background: "#FFFFFF",
  borderRadius: 12,
  border: "1px solid #EDE5CC",
  boxShadow: "0 1px 4px rgba(61, 61, 61, 0.06)",
};

export const badge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 11,
  fontWeight: 700,
  padding: "2px 10px",
  borderRadius: 20,
  whiteSpace: "nowrap",
};
