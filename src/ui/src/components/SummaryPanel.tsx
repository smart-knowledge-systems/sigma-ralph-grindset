import { CSSProperties, useEffect, useState } from "react";
import type { AuditState, FixState, CostEstimate } from "../types";

interface Props {
  audits: Record<string, AuditState>;
  fix: FixState;
  costEstimate: CostEstimate | null;
  startTime: string;
  pipelineComplete: boolean;
  pipelineSuccess: boolean;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

export default function SummaryPanel({
  audits,
  fix,
  costEstimate,
  startTime,
  pipelineComplete,
  pipelineSuccess,
}: Props) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = new Date(startTime).getTime();
    const tick = () => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    };
    tick();
    if (pipelineComplete) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startTime, pipelineComplete]);

  // Aggregate stats
  let totalIssues = 0;
  let totalBranches = 0;
  let failedBranches = 0;
  for (const audit of Object.values(audits)) {
    totalBranches += Object.keys(audit.branches).length;
    failedBranches += audit.failed;
    for (const branch of Object.values(audit.branches)) {
      totalIssues += branch.issueCount;
    }
  }

  return (
    <div style={panel}>
      {/* Timer */}
      <div style={timerCard}>
        <div style={timerValue}>{formatElapsed(elapsed)}</div>
        <div style={timerLabel}>
          {pipelineComplete
            ? pipelineSuccess
              ? "Completed"
              : "Failed"
            : "Elapsed"}
        </div>
        {pipelineComplete && (
          <div
            style={{
              ...statusDot,
              background: pipelineSuccess ? "#2A9D8F" : "#D63333",
            }}
          />
        )}
      </div>

      {/* Issues */}
      <div style={statCard}>
        <div style={statCardTitle}>Issues Found</div>
        <div style={bigNumber}>{totalIssues}</div>
        <div style={subStats}>
          <span>{totalBranches} branches scanned</span>
          {failedBranches > 0 && (
            <span style={{ color: "#D63333" }}>{failedBranches} failed</span>
          )}
        </div>
      </div>

      {/* Fixes */}
      {(fix.totalBatches > 0 || fix.fixed > 0 || fix.failed > 0) && (
        <div style={statCard}>
          <div style={statCardTitle}>Fix Results</div>
          <div style={fixRow}>
            <div style={fixStat}>
              <span style={{ ...fixNum, color: "#2A9D8F" }}>{fix.fixed}</span>
              <span style={fixLabel}>Fixed</span>
            </div>
            <div style={fixDivider} />
            <div style={fixStat}>
              <span style={{ ...fixNum, color: "#D63333" }}>{fix.failed}</span>
              <span style={fixLabel}>Failed</span>
            </div>
          </div>
          {fix.totalBatches > 0 && (
            <div style={subStats}>
              <span>
                {fix.fixed + fix.failed}/{fix.totalBatches} batches
              </span>
            </div>
          )}
        </div>
      )}

      {/* Cost Estimate */}
      {costEstimate && (
        <div style={{ ...statCard, borderColor: "#FFD90F" }}>
          <div style={statCardTitle}>Cost Estimate (Batch API)</div>
          <div style={costRow}>
            <span style={{ ...costLabel, color: "#2A9D8F", fontWeight: 600 }}>
              Batch API
            </span>
            <span style={costValue}>${costEstimate.batchCost.toFixed(2)}</span>
          </div>
          {costEstimate.noCacheCost > 0 && (
            <div style={costRow}>
              <span style={{ ...costLabel, color: "#B8A882" }}>No caching</span>
              <span style={{ ...costValue, color: "#B8A882" }}>
                ${costEstimate.noCacheCost.toFixed(2)}
              </span>
            </div>
          )}
          <div style={subStats}>
            <span>
              {costEstimate.model} / {costEstimate.branchCount} branches
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

const panel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  minWidth: 220,
};

const timerCard: CSSProperties = {
  background: "#FFFFFF",
  borderRadius: 12,
  border: "1px solid #EDE5CC",
  padding: "16px 18px",
  textAlign: "center",
  position: "relative",
  boxShadow: "0 1px 4px rgba(61, 61, 61, 0.06)",
};

const timerValue: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 28,
  fontWeight: 700,
  color: "#3D3D3D",
  letterSpacing: -0.5,
};

const timerLabel: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#8C8370",
  textTransform: "uppercase",
  letterSpacing: 1.2,
  marginTop: 2,
};

const statusDot: CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  width: 8,
  height: 8,
  borderRadius: "50%",
};

const statCard: CSSProperties = {
  background: "#FFFFFF",
  borderRadius: 12,
  border: "1px solid #EDE5CC",
  padding: "14px 18px",
  boxShadow: "0 1px 4px rgba(61, 61, 61, 0.06)",
};

const statCardTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#8C8370",
  textTransform: "uppercase",
  letterSpacing: 1,
  marginBottom: 6,
};

const bigNumber: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 32,
  fontWeight: 700,
  color: "#3D3D3D",
  lineHeight: 1,
};

const subStats: CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  color: "#8C8370",
  display: "flex",
  gap: 10,
};

const fixRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
};

const fixStat: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  flex: 1,
};

const fixNum: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 24,
  fontWeight: 700,
  lineHeight: 1,
};

const fixLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#8C8370",
  marginTop: 2,
};

const fixDivider: CSSProperties = {
  width: 1,
  height: 32,
  background: "#EDE5CC",
};

const costRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "3px 0",
};

const costLabel: CSSProperties = {
  fontSize: 13,
  color: "#5C5545",
};

const costValue: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 15,
  fontWeight: 700,
  color: "#3D3D3D",
};
