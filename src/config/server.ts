// ============================================================================
// Browser config editor backend — Bun.serve with REST API
// ============================================================================

import { resolve, normalize } from "path";
import { existsSync, realpathSync } from "fs";
import {
  CONFIG_FIELDS,
  readConfig,
  writeConfig,
  validateField,
  type ConfigValues,
} from "./editor";
import { log } from "../logging";

export function startConfigServer(auditDir: string): {
  port: number;
  stop: () => void;
} {
  const distDir = resolve(import.meta.dir, "..", "ui", "dist-config");

  // Container breaks the circular type reference between `server` and
  // the route handlers that read `server.port` at request time.
  const ctx: { server?: ReturnType<typeof Bun.serve> } = {};
  const getOrigin = (): string => `http://localhost:${ctx.server!.port}`;

  ctx.server = Bun.serve({
    port: 0,
    routes: {
      "/api/config": {
        GET(): Response {
          log.debug("Config server: reading configuration");
          const values = readConfig(auditDir);
          const origin: string = getOrigin();
          return Response.json(
            { fields: CONFIG_FIELDS, values },
            { headers: { "Access-Control-Allow-Origin": origin } },
          );
        },
        async PUT(req: Request) {
          const origin: string = getOrigin();
          const body = await req.json();
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return Response.json(
              { errors: { _: "Request body must be a JSON object" } },
              {
                status: 400,
                headers: { "Access-Control-Allow-Origin": origin },
              },
            );
          }

          // Filter to known config keys only — reject unknown properties
          const sanitized: ConfigValues = {};
          for (const field of CONFIG_FIELDS) {
            const val = (body as Record<string, unknown>)[field.key];
            if (val !== undefined) {
              sanitized[field.key] = val as
                | string
                | string[]
                | number
                | boolean;
            }
          }

          const errors: Record<string, string> = {};
          for (const field of CONFIG_FIELDS) {
            const val = sanitized[field.key];
            if (val === undefined) continue;
            const err = validateField(field, val);
            if (err) errors[field.key] = err;
          }

          if (Object.keys(errors).length > 0) {
            return Response.json(
              { errors },
              {
                status: 400,
                headers: { "Access-Control-Allow-Origin": origin },
              },
            );
          }

          writeConfig(auditDir, sanitized);
          log.info("Config server: configuration updated");
          return Response.json(
            { ok: true },
            { headers: { "Access-Control-Allow-Origin": origin } },
          );
        },
        OPTIONS() {
          const origin: string = getOrigin();
          return new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": origin,
              "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            },
          });
        },
      },
    },

    fetch(req) {
      const url = new URL(req.url);
      const filePath = url.pathname;

      // CORS for API routes
      if (filePath.startsWith("/api/")) {
        return new Response("Not Found", { status: 404 });
      }

      // Serve static files from dist-config
      if (filePath.startsWith("/assets/")) {
        const assetPath = resolve(distDir, normalize(filePath.slice(1)));
        if (
          existsSync(assetPath) &&
          realpathSync(assetPath).startsWith(realpathSync(distDir) + "/")
        ) {
          return new Response(Bun.file(assetPath));
        }
      }

      // SPA fallback
      const indexPath = resolve(distDir, "index.html");
      if (existsSync(indexPath)) {
        return new Response(Bun.file(indexPath));
      }

      return new Response("Config UI not built. Run: bun build:config-ui", {
        status: 404,
      });
    },
  });

  return {
    port: ctx.server.port as number,
    stop() {
      ctx.server!.stop();
    },
  };
}
