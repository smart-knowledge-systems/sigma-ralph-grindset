import { CSSProperties, useMemo } from "react";
import type { FixState } from "../types";
import StatusBadge from "./StatusBadge";
import {
  card,
  cardHeader,
  cardFooter,
  headerStats,
  statChip,
  fileBadge,
  progressTrack,
  progressFill,
  emptyCard,
} from "./styles";

interface Props {
  fix: FixState;
}

export default function FixProgress({ fix }: Props) {
  const batchEntries = useMemo(
    () =>
      Object.entries(fix.batches)
        .map(([k, v]) => ({ num: Number(k), ...v }))
        .filter((b) => !Number.isNaN(b.num))
        .sort((a, b) => a.num - b.num),
    [fix.batches],
  );

  if (batchEntries.length === 0 && fix.totalBatches === 0) {
    return (
      <div style={emptyCard}>
        <span style={{ fontSize: 24 }}>&#x26A1;</span>
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
                <span style={{ color: "#2A9D8F" }}>&#x2713;</span>
              )}
              {batch.checkPassed === false && (
                <span style={{ color: "#D63333" }}>&#x2717;</span>
              )}
              {batch.checkPassed === undefined && (
                <span style={{ color: "#C4B896" }}>&mdash;</span>
              )}
            </span>
            <StatusBadge status={batch.status} doneLabel="Fixed" />
          </div>
        ))}
      </div>

      {completed > 0 && (
        <div style={cardFooter}>
          <span style={{ color: "#2A9D8F" }}>&#x2713; {fix.fixed} fixed</span>
          {fix.failed > 0 && (
            <span style={{ color: "#D63333" }}>
              &#x2717; {fix.failed} failed
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const headerTitle: CSSProperties = {
  fontWeight: 800,
  fontSize: 15,
  color: "#3D3D3D",
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
