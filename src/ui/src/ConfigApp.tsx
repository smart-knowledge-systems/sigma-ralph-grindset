import { CSSProperties, useEffect, useState } from "react";
import {
  brandRow as sharedBrandRow,
  brandMark as sharedBrandMark,
  brandTitle as sharedBrandTitle,
  brandSub as sharedBrandSub,
} from "./components/styles";

interface ConfigField {
  key: string;
  label: string;
  type: "string" | "string[]" | "number" | "boolean" | "model" | "enum";
  options?: string[];
  default: string | string[] | number | boolean;
  description: string;
  section: "paths" | "limits" | "models" | "defaults";
}

type ConfigValues = Record<string, string | string[] | number | boolean>;

const MODEL_OPTIONS = ["haiku", "sonnet", "opus"];

function isConfigResponse(
  data: unknown,
): data is { fields: ConfigField[]; values: ConfigValues } {
  if (data == null || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.fields) && typeof obj.values === "object" && obj.values != null;
}

function isSaveResponse(
  data: unknown,
): data is { ok?: boolean; errors?: Record<string, string> } {
  if (data == null || typeof data !== "object") return false;
  return true;
}

const ROOT_MODES = [
  { value: "", label: "Parent directory (auto-detect)" },
  { value: "./", label: "Self-audit (./)" },
  { value: "__custom__", label: "Custom path" },
];

export default function ConfigApp() {
  const [fields, setFields] = useState<ConfigField[]>([]);
  const [values, setValues] = useState<ConfigValues>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [customRoot, setCustomRoot] = useState("");

  useEffect(() => {
    let ignore = false;
    fetch("/api/config")
      .then((r) => r.json())
      .then((data: unknown) => {
        if (ignore) return;
        if (!isConfigResponse(data)) {
          setErrors({ _general: "Invalid configuration response" });
          setLoading(false);
          return;
        }
        setFields(data.fields);
        setValues(data.values);
        const root = data.values.PROJECT_ROOT as string;
        if (root && root !== "" && root !== "./") {
          setCustomRoot(root);
        }
        setLoading(false);
      })
      .catch(() => {
        if (ignore) return;
        setErrors({ _general: "Failed to load configuration" });
        setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  function setValue(key: string, val: string | string[] | number | boolean) {
    setValues((prev) => ({ ...prev, [key]: val }));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setErrors({});
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data: unknown = await res.json();
      if (!isSaveResponse(data)) {
        setErrors({ _general: "Invalid server response" });
        return;
      }
      if (data.ok) {
        setSaved(true);
      } else if (data.errors) {
        setErrors(data.errors);
      }
    } catch {
      setErrors({ _general: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div style={shell}>
        <div style={loadingText}>Loading configuration...</div>
        {errors._general && (
          <div style={{ ...errorText, textAlign: "center" }}>
            {errors._general}
          </div>
        )}
      </div>
    );
  }

  const sections: Array<{
    key: ConfigField["section"];
    header: string;
  }> = [
    { key: "paths", header: "Project Setup" },
    { key: "limits", header: "Limits" },
    { key: "models", header: "Models" },
    { key: "defaults", header: "Default Behavior" },
  ];

  const rootMode =
    (values.PROJECT_ROOT as string) === ""
      ? ""
      : (values.PROJECT_ROOT as string) === "./"
        ? "./"
        : "__custom__";

  return (
    <div style={shell}>
      <header style={header}>
        <div style={brandRow}>
          <span style={brandMark}>S</span>
          <div>
            <h1 style={brandTitle}>SIGMA</h1>
            <p style={brandSub}>Configuration</p>
          </div>
        </div>
      </header>

      <div style={formContainer}>
        {sections.map((section) => {
          const sectionFields = fields.filter((f) => f.section === section.key);
          if (sectionFields.length === 0) return null;

          return (
            <div key={section.key} style={card}>
              <div style={sectionTitle}>{section.header}</div>

              {sectionFields.map((field) => {
                // Special: PROJECT_ROOT as radio group
                if (field.key === "PROJECT_ROOT") {
                  return (
                    <div key={field.key} style={fieldGroup}>
                      <label style={fieldLabel}>{field.label}</label>
                      <p style={fieldDesc}>{field.description}</p>
                      <div style={radioGroup}>
                        {ROOT_MODES.map((opt) => (
                          <label key={opt.value} style={radioLabel}>
                            <input
                              type="radio"
                              name="PROJECT_ROOT"
                              checked={rootMode === opt.value}
                              onChange={() => {
                                if (opt.value === "__custom__") {
                                  setValue("PROJECT_ROOT", customRoot || "/");
                                } else {
                                  setValue("PROJECT_ROOT", opt.value);
                                }
                              }}
                              style={radioInput}
                            />
                            {opt.label}
                          </label>
                        ))}
                      </div>
                      {rootMode === "__custom__" && (
                        <input
                          style={textInput}
                          value={values.PROJECT_ROOT as string}
                          onChange={(e) => {
                            setCustomRoot(e.target.value);
                            setValue("PROJECT_ROOT", e.target.value);
                          }}
                          placeholder="/path/to/project"
                        />
                      )}
                      {errors[field.key] && (
                        <div style={errorText}>{errors[field.key]}</div>
                      )}
                    </div>
                  );
                }

                return (
                  <div key={field.key} style={fieldGroup}>
                    <label style={fieldLabel}>{field.label}</label>
                    <p style={fieldDesc}>{field.description}</p>
                    {renderInput(field, values, setValue)}
                    {errors[field.key] && (
                      <div style={errorText}>{errors[field.key]}</div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {errors._general && (
          <div style={errorText}>{errors._general}</div>
        )}

        <div style={buttonRow}>
          <button
            style={saving ? { ...saveBtn, opacity: 0.7 } : saveBtn}
            onClick={save}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save Configuration"}
          </button>
          {saved && <span style={savedBadge}>Saved</span>}
        </div>
      </div>
    </div>
  );
}

function renderInput(
  field: ConfigField,
  values: ConfigValues,
  setValue: (key: string, val: string | string[] | number | boolean) => void,
) {
  switch (field.type) {
    case "boolean":
      return (
        <label style={toggleLabel}>
          <input
            type="checkbox"
            checked={(values[field.key] as boolean) ?? false}
            onChange={(e) => setValue(field.key, e.target.checked)}
            style={checkboxInput}
          />
          <span style={toggleText}>
            {(values[field.key] as boolean) ? "Enabled" : "Disabled"}
          </span>
        </label>
      );

    case "model":
      return (
        <div style={radioGroup}>
          {MODEL_OPTIONS.map((m) => (
            <label key={m} style={radioLabel}>
              <input
                type="radio"
                name={field.key}
                checked={values[field.key] === m}
                onChange={() => setValue(field.key, m)}
                style={radioInput}
              />
              {m}
            </label>
          ))}
        </div>
      );

    case "enum":
      return (
        <div style={radioGroup}>
          {(field.options ?? []).map((opt) => (
            <label key={opt} style={radioLabel}>
              <input
                type="radio"
                name={field.key}
                checked={values[field.key] === opt}
                onChange={() => setValue(field.key, opt)}
                style={radioInput}
              />
              {opt.toUpperCase()}
            </label>
          ))}
        </div>
      );

    case "number":
      return (
        <input
          type="number"
          style={textInput}
          value={values[field.key] as number}
          onChange={(e) =>
            setValue(field.key, parseInt(e.target.value, 10) || 0)
          }
        />
      );

    case "string[]":
      return (
        <input
          style={textInput}
          value={(values[field.key] as string[])?.join(", ") ?? ""}
          onChange={(e) =>
            setValue(
              field.key,
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          placeholder="value1, value2"
        />
      );

    case "string":
    default:
      return (
        <input
          style={textInput}
          value={(values[field.key] as string) ?? ""}
          onChange={(e) => setValue(field.key, e.target.value)}
        />
      );
  }
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const shell: CSSProperties = {
  maxWidth: 680,
  margin: "0 auto",
  padding: "0 24px 40px",
  minHeight: "100vh",
};

const loadingText: CSSProperties = {
  textAlign: "center",
  padding: 64,
  fontSize: 15,
  color: "#8C8370",
};

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "20px 0 16px",
};

const brandRow = sharedBrandRow;
const brandMark = sharedBrandMark;
const brandTitle = sharedBrandTitle;
const brandSub = sharedBrandSub;

const formContainer: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const card: CSSProperties = {
  background: "#FFFFFF",
  borderRadius: 12,
  border: "1px solid #EDE5CC",
  padding: "20px 24px",
  boxShadow: "0 1px 4px rgba(61, 61, 61, 0.06)",
};

const sectionTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#8C8370",
  letterSpacing: 1,
  textTransform: "uppercase" as const,
  marginBottom: 16,
};

const fieldGroup: CSSProperties = {
  marginBottom: 16,
};

const fieldLabel: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 700,
  color: "#3D3D3D",
  marginBottom: 2,
};

const fieldDesc: CSSProperties = {
  margin: "0 0 6px",
  fontSize: 11,
  color: "#8C8370",
};

const textInput: CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  fontSize: 13,
  fontFamily: "'JetBrains Mono', monospace",
  border: "1px solid #EDE5CC",
  borderRadius: 8,
  background: "#FFFDF5",
  color: "#3D3D3D",
  outline: "none",
  boxSizing: "border-box" as const,
};

const radioGroup: CSSProperties = {
  display: "flex",
  gap: 16,
  flexWrap: "wrap" as const,
};

const radioLabel: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  fontWeight: 600,
  color: "#5C5545",
  cursor: "pointer",
};

const radioInput: CSSProperties = {
  accentColor: "#F5C800",
};

const toggleLabel: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  cursor: "pointer",
};

const checkboxInput: CSSProperties = {
  accentColor: "#F5C800",
  width: 16,
  height: 16,
};

const toggleText: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#5C5545",
};

const errorText: CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: "#D63333",
  fontWeight: 600,
};

const buttonRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  paddingTop: 8,
};

const saveBtn: CSSProperties = {
  padding: "10px 32px",
  background: "linear-gradient(135deg, #FFD90F 0%, #F5C800 100%)",
  color: "#2D2A23",
  fontFamily: "'Nunito', sans-serif",
  fontSize: 14,
  fontWeight: 700,
  border: "none",
  borderRadius: 10,
  cursor: "pointer",
  boxShadow: "0 2px 8px rgba(255, 217, 15, 0.3)",
  transition: "all 0.15s",
};

const savedBadge: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#2A9D8F",
};
