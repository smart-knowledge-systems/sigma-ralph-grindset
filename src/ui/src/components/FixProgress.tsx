import { CSSProperties } from "react";
import type { FixState } from "../types";

interface Props {
  fix: FixState;
}

function StatusBadge({ status }: { status: "running" | "done" | "failed" }) {
  const styles: Record<string, CSSProperties> = {
    running: {
      background: "#FFF4CC",
      color: "#B38F00",
      border: "1px solid #FFD90F",
      animation: "sigmaPulse 1.8s ease-in-out infinite",
    },
    done: {
      background: "#E6F5F2",
      color: "#2A9D8F",
      border: "1px solid #2A9D8F",
    },
    failed: {
      background: "#FCEAEA",
      color: "#D63333",
      border: "1px solid #D63333",
    },
  };
  const labels = { running: "Running", done: "Fixed", failed: "Failed" };
  return (
    <span style={{ ...badge, ...styles[status] }}>
      {status === "running" && (
        <span
          style={{
            fontSize: 8,
            animation: "sigmaPulse 1s ease-in-out infinite",
          }}
        >
          ●
        </span>
      )}
      {labels[status]}
    </span>
  );
}

export default function FixProgress({ fix }: Props) {
  const batchEntries = Object.entries(fix.batches)
    .map(([k, v]) => ({ num: Number(k), ...v }))
    .sort((a, b) => a.num - b.num);

  if (batchEntries.length === 0 && fix.totalBatches === 0) {
    return (
      <div style={emptyCard}>
        <span style={{ fontSize: 24 }}>⚡</span>
        <span style={{ color: "#8C8370", fontWeight: 600 }}>
          Waiting for fixes to begin...
        </span>
      </div>
    );
  }

  const completed = fix.fixed + fix.failed;

  return (
    <div style={card}>
      <div style={cardHeader}>
        <div style={headerTitle}>Fix Batches</div>
        <div style={headerStats}>
          <span style={statChip}>
            {completed}/{fix.totalBatches} batches
          </span>
          <span style={statChip}>{fix.totalIssues} issues</span>
        </div>
      </div>

      {/* Progress bar */}
      <div style={progressTrack}>
        <div
          style={{
            ...progressFill,
            width:
              fix.totalBatches > 0
                ? `${(completed / fix.totalBatches) * 100}%`
                : "0%",
          }}
        />
      </div>

      <div style={batchList}>
        {batchEntries.map((batch) => (
          <div
            key={batch.num}
            style={{
              ...batchRow,
              animation: "sigmaFadeIn 0.3s ease-out",
              ...(batch.status === "failed" ? failedRow : {}),
            }}
          >
            <span style={batchNum}>#{batch.num}</span>
            <span style={fileBadge}>{batch.fileCount} files</span>
            <span style={issueBadge}>{batch.issueCount} issues</span>
            <span style={attemptLabel}>
              {batch.attempt}/{batch.maxAttempts}
            </span>
            <span style={checkIcon}>
              {batch.checkPassed === true && (
                <span style={{ color: "#2A9D8F" }}>✓</span>
              )}
              {batch.checkPassed === false && (
                <span style={{ color: "#D63333" }}>✗</span>
              )}
              {batch.checkPassed === undefined && (
                <span style={{ color: "#C4B896" }}>—</span>
              )}
            </span>
            <StatusBadge status={batch.status} />
          </div>
        ))}
      </div>

      {completed > 0 && (
        <div style={cardFooter}>
          <span style={{ color: "#2A9D8F" }}>✓ {fix.fixed} fixed</span>
          {fix.failed > 0 && (
            <span style={{ color: "#D63333" }}>✗ {fix.failed} failed</span>
          )}
        </div>
      )}
    </div>
  );
}

const card: CSSProperties = {
  background: "#FFFFFF",
  borderRadius: 12,
  border: "1px solid #EDE5CC",
  overflow: "hidden",
  boxShadow: "0 1px 4px rgba(61, 61, 61, 0.06)",
};

const cardHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 18px 10px",
};

const headerTitle: CSSProperties = {
  fontWeight: 800,
  fontSize: 15,
  color: "#3D3D3D",
};

const headerStats: CSSProperties = { display: "flex", gap: 10 };

const statChip: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#8C8370",
};

const progressTrack: CSSProperties = {
  height: 3,
  background: "#F0E8D0",
  margin: "0 18px",
  borderRadius: 2,
  overflow: "hidden",
};

const progressFill: CSSProperties = {
  height: "100%",
  background: "linear-gradient(90deg, #FFD90F, #2A9D8F)",
  borderRadius: 2,
  transition: "width 0.5s ease",
};

const batchList: CSSProperties = {
  padding: "8px 18px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  maxHeight: 320,
  overflowY: "auto",
};

const batchRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "50px auto auto 50px 30px auto",
  alignItems: "center",
  gap: 12,
  padding: "7px 10px",
  borderRadius: 8,
  fontSize: 13,
};

const failedRow: CSSProperties = {
  background: "rgba(214, 51, 51, 0.04)",
  borderLeft: "3px solid #D63333",
  paddingLeft: 7,
};

const batchNum: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 13,
  fontWeight: 700,
  color: "#5C5545",
};

const fileBadge: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#8C8370",
  background: "#F5EED8",
  padding: "2px 8px",
  borderRadius: 10,
  whiteSpace: "nowrap",
};

const issueBadge: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#8C8370",
  background: "#F5EED8",
  padding: "2px 8px",
  borderRadius: 10,
  whiteSpace: "nowrap",
};

const attemptLabel: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  color: "#8C8370",
  textAlign: "center",
};

const checkIcon: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  textAlign: "center",
};

const badge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 11,
  fontWeight: 700,
  padding: "2px 10px",
  borderRadius: 20,
  whiteSpace: "nowrap",
};

const cardFooter: CSSProperties = {
  display: "flex",
  gap: 16,
  padding: "10px 18px",
  borderTop: "1px solid #F0E8D0",
  fontSize: 13,
  fontWeight: 700,
};

const emptyCard: CSSProperties = {
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
