// Shared StatusBadge component used by AuditProgress and FixProgress

import type { CSSProperties } from "react";
import { badge } from "./styles";

type Status = "pending" | "running" | "done" | "failed";

const badgeStyles: Record<Status, CSSProperties> = {
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

const labels: Record<Status, string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  failed: "Failed",
};

const spinnerDot: CSSProperties = {
  fontSize: 8,
  animation: "sigmaPulse 1s ease-in-out infinite",
};

interface Props {
  status: Status;
  doneLabel?: string;
}

export default function StatusBadge({ status, doneLabel }: Props) {
  return (
    <span style={{ ...badge, ...badgeStyles[status] }}>
      {status === "running" && <span style={spinnerDot}>●</span>}
      {status === "done" && doneLabel ? doneLabel : labels[status]}
    </span>
  );
}
