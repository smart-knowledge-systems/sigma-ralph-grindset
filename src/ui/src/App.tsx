import type { CSSProperties } from "react";
import { useSSE } from "./hooks/useSSE";
import PipelinePhases from "./components/PipelinePhases";
import AuditProgress from "./components/AuditProgress";
import FixProgress from "./components/FixProgress";
import CostConfirmation from "./components/CostConfirmation";
import SummaryPanel from "./components/SummaryPanel";
import LogStream from "./components/LogStream";
import {
  brandRow as sharedBrandRow,
  brandMark as sharedBrandMark,
  brandTitle as sharedBrandTitle,
  brandSub as sharedBrandSub,
} from "./components/styles";

// Stable no-op callback — confirmation state is cleared server-side when
// the pipeline proceeds, so the client dismiss handler is intentionally empty.
const noop = () => {};

export default function App() {
  const state = useSSE();

  const auditCount = Object.keys(state.audits).length;
  const showAudit =
    state.phase === "audit" ||
    state.phase === "pipeline" ||
    (state.phase === "idle" && auditCount > 0) ||
    (state.phase === "done" && auditCount > 0 && state.fix.totalBatches === 0);

  const showFix =
    state.phase === "fix" ||
    (state.phase === "done" && state.fix.totalBatches > 0);

  return (
    <div style={shell}>
      {/* Header */}
      <header style={header}>
        <div style={brandRow}>
          <span style={brandMark}>S</span>
          <div>
            <h1 style={brandTitle}>SIGMA</h1>
            <p style={brandSub}>Audit Pipeline</p>
          </div>
        </div>
        <div style={connBadge}>
          <span
            style={state.connected ? connDotConnected : connDotDisconnected}
          />
          {state.connected ? "Connected" : "Disconnected"}
        </div>
      </header>

      {/* Pipeline Stepper */}
      <PipelinePhases
        phaseStatuses={state.phaseStatuses}
        pipelineComplete={state.pipelineComplete}
        pipelineSuccess={state.pipelineSuccess}
      />

      {/* Main content area */}
      <div style={mainGrid}>
        {/* Center content */}
        <div style={centerCol}>
          {state.costConfirmRequest && (
            <CostConfirmation
              estimate={state.costConfirmRequest.estimate}
              requestId={state.costConfirmRequest.requestId}
              onDismiss={noop}
              aggregated={state.costEstimateAggregated ?? undefined}
            />
          )}
          {showAudit && <AuditProgress audits={state.audits} />}
          {showFix && <FixProgress fix={state.fix} />}
          {!showAudit && !showFix && (
            <div style={idleCard}>
              <div style={idleIcon}>⊙</div>
              <div style={idleText}>
                {state.phase === "idle" || state.phase === "pipeline"
                  ? "Pipeline starting..."
                  : state.phase === "branches"
                    ? "Generating branches..."
                    : "Processing..."}
              </div>
              <div style={idleSpinner} />
            </div>
          )}
        </div>

        {/* Right sidebar — summary */}
        <aside style={sideCol}>
          <SummaryPanel
            audits={state.audits}
            fix={state.fix}
            costEstimate={state.costEstimate}
            costEstimateAggregated={state.costEstimateAggregated}
            startTime={state.startTime}
            pipelineComplete={state.pipelineComplete}
            pipelineSuccess={state.pipelineSuccess}
          />
        </aside>
      </div>

      {/* Log stream at bottom */}
      <div style={logArea}>
        <LogStream logs={state.logs} />
      </div>
    </div>
  );
}

const shell: CSSProperties = {
  maxWidth: 1200,
  margin: "0 auto",
  padding: "0 24px 0",
  display: "flex",
  flexDirection: "column",
  minHeight: "100vh",
};

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "20px 0 8px",
};

const brandRow = sharedBrandRow;
const brandMark = sharedBrandMark;
const brandTitle = sharedBrandTitle;
const brandSub = sharedBrandSub;

const connBadge: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  fontWeight: 600,
  color: "#8C8370",
  padding: "4px 12px",
  borderRadius: 20,
  background: "#FFFFFF",
  border: "1px solid #EDE5CC",
};

const connDotBase: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  flexShrink: 0,
};

const connDotConnected: CSSProperties = {
  ...connDotBase,
  background: "#2A9D8F",
};

const connDotDisconnected: CSSProperties = {
  ...connDotBase,
  background: "#D63333",
};

const mainGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 240px",
  gap: 20,
  flex: 1,
  padding: "8px 0 20px",
  alignItems: "start",
};

const centerCol: CSSProperties = {
  minWidth: 0,
};

const sideCol: CSSProperties = {};

const logArea: CSSProperties = {
  marginTop: "auto",
  position: "sticky",
  bottom: 16,
  paddingBottom: 16,
};

const idleCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  padding: 64,
  background: "#FFFFFF",
  borderRadius: 12,
  border: "1px solid #EDE5CC",
  boxShadow: "0 1px 4px rgba(61, 61, 61, 0.06)",
};

const idleIcon: CSSProperties = {
  fontSize: 36,
  animation: "sigmaPulse 2s ease-in-out infinite",
};

const idleText: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "#8C8370",
};

const idleSpinner: CSSProperties = {
  width: 20,
  height: 20,
  border: "2px solid #EDE5CC",
  borderTopColor: "#FFD90F",
  borderRadius: "50%",
  animation: "sigmaSpin 0.8s linear infinite",
};
