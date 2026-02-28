import {
  CSSProperties,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";

interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
}

interface Props {
  logs: LogEntry[];
}

const LEVELS = ["debug", "info", "warn", "error"] as const;

const levelColors: Record<string, string> = {
  debug: "#7A7568",
  info: "#D4C9A8",
  warn: "#FFD90F",
  error: "#D63333",
};

export default function LogStream({ logs }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [filters, setFilters] = useState<Set<string>>(
    new Set(["info", "warn", "error"]),
  );
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isUserScrolling = useRef(false);

  const filteredLogs = useMemo(
    () => logs.filter((l) => filters.has(l.level)),
    [logs, filters],
  );

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom && !isUserScrolling.current) {
      isUserScrolling.current = true;
      setAutoScroll(false);
    } else if (atBottom && isUserScrolling.current) {
      isUserScrolling.current = false;
      setAutoScroll(true);
    }
  }, []);

  // Auto-scroll when new logs arrive (not on filter changes).
  // Using logs.length ensures we only scroll on actual new entries.
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length, autoScroll]);

  const toggleFilter = (level: string) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  return (
    <div style={wrapper}>
      {/* Header bar */}
      <div style={header} onClick={() => setCollapsed(!collapsed)}>
        <div style={headerLeft}>
          <span style={chevron}>{collapsed ? "▸" : "▾"}</span>
          <span style={headerTitle}>Logs</span>
          <span style={logCount}>{logs.length}</span>
        </div>
        {!collapsed && (
          <div style={filterRow} onClick={(e) => e.stopPropagation()}>
            {LEVELS.map((level) => (
              <button
                key={level}
                onClick={() => toggleFilter(level)}
                style={{
                  ...filterChip,
                  background: filters.has(level)
                    ? levelColors[level] + "30"
                    : "transparent",
                  color: filters.has(level) ? levelColors[level] : "#5C5545",
                  borderColor: filters.has(level)
                    ? levelColors[level] + "60"
                    : "#4A4638",
                }}
              >
                {level}
              </button>
            ))}
            {!autoScroll && (
              <button
                onClick={() => {
                  setAutoScroll(true);
                  isUserScrolling.current = false;
                  if (scrollRef.current) {
                    scrollRef.current.scrollTop =
                      scrollRef.current.scrollHeight;
                  }
                }}
                style={scrollBtn}
              >
                ↓ Follow
              </button>
            )}
          </div>
        )}
      </div>

      {/* Log content */}
      {!collapsed && (
        <div ref={scrollRef} style={logBody} onScroll={handleScroll}>
          {filteredLogs.length === 0 && (
            <div style={emptyMsg}>No log entries yet.</div>
          )}
          {filteredLogs.map((entry) => (
            <div key={`${entry.timestamp}-${entry.message}`} style={logLine}>
              <span style={timestamp}>{entry.timestamp.slice(11, 19)}</span>
              <span
                style={{
                  ...levelBadge,
                  color: levelColors[entry.level] ?? "#D4C9A8",
                }}
              >
                {entry.level.slice(0, 3).toUpperCase()}
              </span>
              <span
                style={{
                  ...messageText,
                  color: levelColors[entry.level] ?? "#D4C9A8",
                  opacity: entry.level === "debug" ? 0.6 : 1,
                }}
              >
                {entry.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const wrapper: CSSProperties = {
  background: "#2D2A23",
  borderRadius: 12,
  overflow: "hidden",
  border: "1px solid #3D3930",
};

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 16px",
  background: "#353028",
  cursor: "pointer",
  userSelect: "none",
};

const headerLeft: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const chevron: CSSProperties = {
  fontSize: 12,
  color: "#8C8370",
  width: 14,
};

const headerTitle: CSSProperties = {
  fontWeight: 700,
  fontSize: 13,
  color: "#D4C9A8",
  letterSpacing: 0.5,
};

const logCount: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  fontWeight: 600,
  color: "#8C8370",
  background: "#2D2A23",
  padding: "1px 8px",
  borderRadius: 10,
};

const filterRow: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
};

const filterChip: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10,
  fontWeight: 600,
  padding: "2px 10px",
  borderRadius: 12,
  border: "1px solid",
  cursor: "pointer",
  textTransform: "uppercase",
  letterSpacing: 0.8,
  outline: "none",
  transition: "all 0.15s",
};

const scrollBtn: CSSProperties = {
  fontFamily: "'Nunito', sans-serif",
  fontSize: 11,
  fontWeight: 700,
  padding: "2px 10px",
  borderRadius: 12,
  border: "1px solid #FFD90F60",
  background: "#FFD90F20",
  color: "#FFD90F",
  cursor: "pointer",
  outline: "none",
  marginLeft: 8,
};

const logBody: CSSProperties = {
  maxHeight: 260,
  overflowY: "auto",
  padding: "6px 16px 12px",
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  lineHeight: 1.7,
};

const logLine: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "baseline",
  whiteSpace: "nowrap",
};

const timestamp: CSSProperties = {
  color: "#5C5545",
  fontSize: 11,
  flexShrink: 0,
};

const levelBadge: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  width: 30,
  flexShrink: 0,
  letterSpacing: 0.5,
};

const messageText: CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  overflow: "hidden",
};

const emptyMsg: CSSProperties = {
  color: "#5C5545",
  fontStyle: "italic",
  padding: "20px 0",
  textAlign: "center",
};
