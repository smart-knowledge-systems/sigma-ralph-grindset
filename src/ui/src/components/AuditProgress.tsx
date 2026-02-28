import { CSSProperties } from "react";
import type { AuditState } from "../types";
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
  audits: Record<string, AuditState>;
}

export default function AuditProgress({ audits }: Props) {
  const auditEntries = Object.values(audits);
  if (auditEntries.length === 0) {
    return (
      <div style={emptyCard}>
        <span style={{ fontSize: 24 }}>&#x2299;</span>
        <span style={{ color: "#8C8370", fontWeight: 600 }}>
          Waiting for audit to begin...
        </span>
      </div>
    );
  }

  return (
    <div style={wrapper}>
      {auditEntries.map((audit) => {
        const branches = Object.entries(audit.branches);
        const totalIssues = branches.reduce((s, [, b]) => s + b.issueCount, 0);
        return (
          <div key={audit.policy} style={card}>
            <div style={cardHeader}>
              <div style={policyTag}>{audit.policy}</div>
              <div style={headerStats}>
                <span style={statChip}>
                  {audit.processed}/{branches.length} branches
                </span>
                <span style={statChip}>{totalIssues} issues</span>
              </div>
            </div>

            {/* Progress bar */}
            <div style={progressTrack}>
              <div
                style={{
                  ...progressFill,
                  width:
                    branches.length > 0
                      ? `${(audit.processed / branches.length) * 100}%`
                      : "0%",
                }}
              />
            </div>

            {/* Branch list */}
            <div style={branchList}>
              {branches.length === 0 && (
                <div style={branchRowStyle}>
                  <span style={{ color: "#8C8370", fontStyle: "italic" }}>
                    No branches yet...
                  </span>
                </div>
              )}
              {branches.map(([path, branch]) => (
                <div
                  key={path}
                  style={{
                    ...branchRowStyle,
                    animation: "sigmaFadeIn 0.3s ease-out",
                    ...(branch.status === "failed" ? failedRowAccent : {}),
                  }}
                >
                  <span style={branchPath} title={path}>
                    {path}
                  </span>
                  <span style={fileBadge}>{branch.fileCount} files</span>
                  <StatusBadge
                    status={
                      branch.status === "running"
                        ? "running"
                        : branch.status === "done"
                          ? "done"
                          : branch.status === "failed"
                            ? "failed"
                            : "pending"
                    }
                  />
                  <span style={issueCount}>
                    {branch.status === "done" ? branch.issueCount : "\u2014"}
                  </span>
                </div>
              ))}
            </div>

            {/* Footer summary */}
            {audit.processed > 0 && (
              <div style={cardFooter}>
                <span style={{ color: "#2A9D8F" }}>
                  &#x2713; {audit.succeeded}
                </span>
                {audit.failed > 0 && (
                  <span style={{ color: "#D63333" }}>
                    &#x2717; {audit.failed}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const wrapper: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const policyTag: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 13,
  fontWeight: 700,
  background: "#FFF4CC",
  color: "#8C6D00",
  padding: "3px 12px",
  borderRadius: 20,
  border: "1px solid #FFD90F",
};

const branchList: CSSProperties = {
  padding: "8px 18px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  maxHeight: 320,
  overflowY: "auto",
};

const branchRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto auto 50px",
  alignItems: "center",
  gap: 12,
  padding: "7px 10px",
  borderRadius: 8,
  fontSize: 13,
  transition: "background 0.15s",
};

const failedRowAccent: CSSProperties = {
  background: "rgba(214, 51, 51, 0.04)",
  borderLeft: "3px solid #D63333",
  paddingLeft: 7,
};

const branchPath: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  color: "#3D3D3D",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const issueCount: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  fontWeight: 600,
  textAlign: "right",
  color: "#5C5545",
};
