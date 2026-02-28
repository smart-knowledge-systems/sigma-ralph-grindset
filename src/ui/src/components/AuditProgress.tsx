import { CSSProperties } from "react";
import type { AuditState } from "../types";

interface Props {
  audits: Record<string, AuditState>;
}

function StatusBadge({
  status,
}: {
  status: "running" | "done" | "failed" | "pending";
}) {
  const badgeStyles: Record<string, CSSProperties> = {
    pending: {
      background: "#F0E8D0",
      color: "#8C8370",
      border: "1px solid #E0D6BC",
    },
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
  const labels: Record<string, string> = {
    pending: "Pending",
    running: "Running",
    done: "Done",
    failed: "Failed",
  };
  return (
    <span style={{ ...badge, ...badgeStyles[status] }}>
      {status === "running" && <span style={spinnerDot}>●</span>}
      {labels[status]}
    </span>
  );
}

export default function AuditProgress({ audits }: Props) {
  const auditEntries = Object.values(audits);
  if (auditEntries.length === 0) {
    return (
      <div style={emptyCard}>
        <span style={{ fontSize: 24 }}>⊙</span>
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
                  <StatusBadge status={branch.status} />
                  <span style={issueCount}>
                    {branch.status === "done" ? branch.issueCount : "—"}
                  </span>
                </div>
              ))}
            </div>

            {/* Footer summary */}
            {audit.processed > 0 && (
              <div style={cardFooter}>
                <span style={{ color: "#2A9D8F" }}>✓ {audit.succeeded}</span>
                {audit.failed > 0 && (
                  <span style={{ color: "#D63333" }}>✗ {audit.failed}</span>
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

const card: CSSProperties = {
  background: "#FFFFFF",
  borderRadius: 12,
  border: "1px solid #EDE5CC",
  padding: 0,
  overflow: "hidden",
  boxShadow: "0 1px 4px rgba(61, 61, 61, 0.06)",
};

const cardHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 18px 10px",
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

const headerStats: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
};

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

const fileBadge: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#8C8370",
  background: "#F5EED8",
  padding: "2px 8px",
  borderRadius: 10,
  whiteSpace: "nowrap",
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
  letterSpacing: 0.3,
};

const spinnerDot: CSSProperties = {
  fontSize: 8,
  animation: "sigmaPulse 1s ease-in-out infinite",
};

const issueCount: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  fontWeight: 600,
  textAlign: "right",
  color: "#5C5545",
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
