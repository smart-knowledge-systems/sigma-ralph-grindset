import { CSSProperties } from "react";
import { useSSE } from "./hooks/useSSE";
import PipelinePhases from "./components/PipelinePhases";
import AuditProgress from "./components/AuditProgress";
import FixProgress from "./components/FixProgress";
import CostConfirmation from "./components/CostConfirmation";
import SummaryPanel from "./components/SummaryPanel";
import LogStream from "./components/LogStream";

export default function App() {
  const state = useSSE();

  const dismissConfirm = () => {
    // No-op — the state will be cleared when the pipeline proceeds
  };

  const showAudit =
    state.phase === "audit" ||
    state.phase === "pipeline" ||
    (state.phase === "idle" && Object.keys(state.audits).length > 0) ||
    (state.phase === "done" &&
      Object.keys(state.audits).length > 0 &&
      state.fix.totalBatches === 0);

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
            style={{
              ...connDot,
              background: state.connected ? "#2A9D8F" : "#D63333",
            }}
          />
          {state.connected ? "Connected" : "Disconnected"}
        </div>
      </header>

      {/* Pipeline Stepper */}
      <PipelinePhases
        phase={state.phase}
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
              onDismiss={dismissConfirm}
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

const brandRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const brandMark: CSSProperties = {
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

const brandTitle: CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 800,
  color: "#3D3D3D",
  letterSpacing: 1.5,
  lineHeight: 1,
};

const brandSub: CSSProperties = {
  margin: 0,
  fontSize: 11,
  fontWeight: 600,
  color: "#8C8370",
  letterSpacing: 0.5,
  lineHeight: 1.3,
};

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

const connDot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  flexShrink: 0,
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
  bottom: 0,
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
