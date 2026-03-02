import { CSSProperties, useState } from "react";

interface Props {
  requestId: string;
  message: string;
}

export default function ApiKeyPrompt({ requestId, message }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(cancelled: boolean) {
    setError(null);
    if (!cancelled && apiKey.trim().length === 0) {
      setError("Please enter an API key.");
      return;
    }
    setWaiting(true);
    try {
      const res = await fetch("/api/apikey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId,
          apiKey: cancelled ? undefined : apiKey.trim(),
        }),
      });
      if (!res.ok) {
        setWaiting(false);
        setError("Server error. Please try again.");
        return;
      }
      // State will be cleared server-side via event bus
    } catch {
      setWaiting(false);
      setError("Network error. Please try again.");
    }
  }

  return (
    <div style={card}>
      <div style={titleStyle}>API KEY REQUIRED</div>
      <p style={messageStyle}>{message}</p>
      <p style={hintStyle}>
        The key is used for this session only and is never written to disk.
      </p>

      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit(false);
        }}
        placeholder="sk-ant-..."
        style={inputStyle}
        autoFocus
        disabled={waiting}
      />

      {error && <div style={errorStyle}>{error}</div>}

      <div style={buttonRow}>
        <button
          style={waiting ? continueBtnWaiting : continueBtn}
          onClick={() => submit(false)}
          disabled={waiting}
        >
          {waiting ? "Setting key..." : "Continue"}
        </button>
        <button
          style={cancelBtn}
          onClick={() => submit(true)}
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
  borderLeft: "4px solid #D63333",
  padding: "16px 20px",
  boxShadow: "0 1px 4px rgba(61, 61, 61, 0.06)",
  animation: "sigmaFadeIn 0.3s ease-out",
  marginBottom: 16,
};

const titleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#D63333",
  letterSpacing: 1,
  textTransform: "uppercase",
  marginBottom: 8,
};

const messageStyle: CSSProperties = {
  fontSize: 13,
  color: "#5C5545",
  margin: "0 0 4px",
  lineHeight: 1.4,
};

const hintStyle: CSSProperties = {
  fontSize: 11,
  color: "#8C8370",
  margin: "0 0 12px",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  fontFamily: "'JetBrains Mono', monospace",
  border: "1px solid #EDE5CC",
  borderRadius: 8,
  background: "#FDFBF5",
  color: "#3D3D3D",
  outline: "none",
  marginBottom: 10,
  boxSizing: "border-box",
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

const continueBtn: CSSProperties = {
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

const continueBtnWaiting: CSSProperties = {
  ...continueBtn,
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
