import { CSSProperties, useState } from "react";
import type { CostEstimate, AggregatedCostEstimate } from "../types";

interface Props {
  estimate: CostEstimate;
  requestId: string;
  onDismiss: () => void;
  aggregated?: AggregatedCostEstimate;
}

export default function CostConfirmation({
  estimate,
  requestId,
  onDismiss,
  aggregated,
}: Props) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function respond(approved: boolean) {
    if (approved) setWaiting(true);
    setError(null);
    try {
      const res = await fetch("/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved, requestId }),
      });
      if (!res.ok) {
        setWaiting(false);
        setError("Server error. Please try again.");
        return;
      }
      if (approved) {
        setWaiting(false);
        onDismiss();
      } else {
        onDismiss();
      }
    } catch {
      setWaiting(false);
      setError("Network error. Please try again.");
    }
  }

  const showAggregated = aggregated && aggregated.perPolicy.length > 0;

  return (
    <div style={card}>
      <div style={titleStyle}>
        {showAggregated
          ? `CONFIRM COST \u2014 ${aggregated.perPolicy.length} POLICIES`
          : "CONFIRM COST"}
      </div>

      <div style={table}>
        {showAggregated ? (
          <>
            {aggregated.perPolicy.map((p) => (
              <div key={p.policyName} style={costRow}>
                <span style={policyLabel}>
                  <span style={policyName}>{p.policyName}</span>
                </span>
                <span style={costValuePrimary}>
                  ${p.batchApiCost.toFixed(2)}
                </span>
              </div>
            ))}
            <div style={separator} />
            <div style={costRow}>
              <span style={costLabel}>Total (Batch API)</span>
              <span style={costValuePrimary}>
                ${aggregated.totalBatchApiCost.toFixed(2)}
              </span>
            </div>
            {aggregated.totalNoCacheCost > 0 && (
              <div style={costRow}>
                <span style={costLabelMuted}>Without caching</span>
                <span style={costValueMuted}>
                  ${aggregated.totalNoCacheCost.toFixed(2)}
                </span>
              </div>
            )}
          </>
        ) : (
          <>
            <div style={costRow}>
              <span style={costLabel}>Batch API</span>
              <span style={costValuePrimary}>
                ${estimate.batchCost.toFixed(2)}
              </span>
            </div>
            <div style={costRow}>
              <span style={costLabelMuted}>Without caching</span>
              <span style={costValueMuted}>
                ${estimate.noCacheCost.toFixed(2)}
              </span>
            </div>
          </>
        )}
      </div>

      <div style={subStats}>
        <span>{showAggregated ? aggregated.model : estimate.model}</span>
        <span style={dot}>&middot;</span>
        <span>
          {showAggregated ? aggregated.branchCount : estimate.branchCount}{" "}
          branches
        </span>
      </div>

      {error && <div style={errorStyle}>{error}</div>}

      <div style={buttonRow}>
        <button
          style={waiting ? approveBtnWaiting : approveBtn}
          onClick={() => respond(true)}
          disabled={waiting}
        >
          {waiting ? "Waiting..." : "Approve"}
        </button>
        <button
          style={cancelBtn}
          onClick={() => respond(false)}
          disabled={waiting}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const card: CSSProperties = {
  background: "#FFFFFF",
  borderRadius: 12,
  border: "1px solid #EDE5CC",
  borderLeft: "4px solid #FFD90F",
  padding: "16px 20px",
  boxShadow: "0 1px 4px rgba(61, 61, 61, 0.06)",
  animation: "sigmaFadeIn 0.3s ease-out",
  marginBottom: 16,
};

const titleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#8C8370",
  letterSpacing: 1,
  textTransform: "uppercase",
  marginBottom: 12,
};

const table: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  marginBottom: 10,
};

const costRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const costLabel: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#2A9D8F",
};

const policyLabel: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const policyName: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  fontFamily: "'JetBrains Mono', monospace",
  color: "#5C5545",
};

const costValuePrimary: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  fontFamily: "'JetBrains Mono', monospace",
  color: "#3D3D3D",
};

const costLabelMuted: CSSProperties = {
  fontSize: 12,
  color: "#B8A882",
};

const costValueMuted: CSSProperties = {
  fontSize: 13,
  fontFamily: "'JetBrains Mono', monospace",
  color: "#B8A882",
};

const separator: CSSProperties = {
  height: 1,
  background: "#EDE5CC",
  margin: "4px 0",
};

const subStats: CSSProperties = {
  fontSize: 11,
  color: "#8C8370",
  marginBottom: 14,
  display: "flex",
  gap: 4,
};

const dot: CSSProperties = {
  color: "#D4C9A8",
};

const errorStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#D63333",
  marginBottom: 8,
};

const buttonRow: CSSProperties = {
  display: "flex",
  gap: 8,
};

const approveBtn: CSSProperties = {
  flex: 1,
  padding: "8px 0",
  background: "linear-gradient(135deg, #FFD90F 0%, #F5C800 100%)",
  color: "#2D2A23",
  fontFamily: "'Nunito', sans-serif",
  fontSize: 13,
  fontWeight: 700,
  border: "none",
  borderRadius: 10,
  cursor: "pointer",
  transition: "all 0.15s",
  boxShadow: "0 2px 8px rgba(255, 217, 15, 0.3)",
};

const approveBtnWaiting: CSSProperties = {
  ...approveBtn,
  animation: "sigmaPulse 2s ease-in-out infinite",
  opacity: 0.8,
  cursor: "default",
};

const cancelBtn: CSSProperties = {
  flex: 1,
  padding: "8px 0",
  background: "transparent",
  color: "#8C8370",
  fontFamily: "'Nunito', sans-serif",
  fontSize: 13,
  fontWeight: 700,
  border: "1px solid #EDE5CC",
  borderRadius: 10,
  cursor: "pointer",
  transition: "all 0.15s",
};
