import { CSSProperties } from "react";

interface Props {
  phase: string;
  phaseStatuses: Record<string, "started" | "completed">;
  pipelineComplete: boolean;
  pipelineSuccess: boolean;
}

const PHASES = [
  { key: "branches", label: "Branches", icon: "⑃" },
  { key: "audit", label: "Audit", icon: "⊙" },
  { key: "fix", label: "Fix", icon: "⚡" },
  { key: "done", label: "Done", icon: "✦" },
] as const;

function getPhaseState(
  phaseKey: string,
  phaseStatuses: Record<string, "started" | "completed">,
  pipelineComplete: boolean,
  pipelineSuccess: boolean,
): "idle" | "active" | "completed" | "failed" {
  if (phaseKey === "done") {
    if (pipelineComplete) return pipelineSuccess ? "completed" : "failed";
    return "idle";
  }
  const status = phaseStatuses[phaseKey];
  if (status === "completed") return "completed";
  if (status === "started") return "active";
  return "idle";
}

export default function PipelinePhases({
  phaseStatuses,
  pipelineComplete,
  pipelineSuccess,
}: Props) {
  return (
    <div style={container}>
      {PHASES.map((p, i) => {
        const state = getPhaseState(
          p.key,
          phaseStatuses,
          pipelineComplete,
          pipelineSuccess,
        );
        return (
          <div key={p.key} style={stepRow}>
            {i > 0 && (
              <div
                style={{
                  ...connector,
                  background:
                    state === "completed" || state === "active"
                      ? "#2A9D8F"
                      : state === "failed"
                        ? "#D63333"
                        : "#E0D6BC",
                }}
              />
            )}
            <div
              style={{
                ...pill,
                ...(state === "active" ? activePill : {}),
                ...(state === "completed" ? completedPill : {}),
                ...(state === "failed" ? failedPill : {}),
                animation:
                  state === "active"
                    ? "sigmaGlow 2s ease-in-out infinite"
                    : "none",
              }}
            >
              <span style={iconStyle}>
                {state === "completed"
                  ? "✓"
                  : state === "failed"
                    ? "✗"
                    : p.icon}
              </span>
              <span style={labelStyle}>{p.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const container: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 0,
  padding: "20px 0",
};

const stepRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 0,
};

const connector: CSSProperties = {
  width: 48,
  height: 3,
  borderRadius: 2,
  transition: "background 0.4s ease",
};

const pill: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 20px",
  borderRadius: 24,
  background: "#F0E8D0",
  border: "2px solid #E0D6BC",
  fontWeight: 700,
  fontSize: 14,
  color: "#8C8370",
  transition: "all 0.35s ease",
  cursor: "default",
  userSelect: "none",
};

const activePill: CSSProperties = {
  background: "#FFF4CC",
  border: "2px solid #FFD90F",
  color: "#3D3D3D",
  boxShadow: "0 2px 12px rgba(255, 217, 15, 0.2)",
};

const completedPill: CSSProperties = {
  background: "#E6F5F2",
  border: "2px solid #2A9D8F",
  color: "#2A9D8F",
};

const failedPill: CSSProperties = {
  background: "#FCEAEA",
  border: "2px solid #D63333",
  color: "#D63333",
};

const iconStyle: CSSProperties = {
  fontSize: 16,
  lineHeight: 1,
};

const labelStyle: CSSProperties = {
  fontSize: 14,
  letterSpacing: 0.3,
};
