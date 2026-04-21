import { Controller, Get, Req } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Request } from "express";

interface CachedEntry {
  code: string | null;
  at: number;
}

@ApiTags("Geo")
@Controller("api/geo")
export class GeoController {
  private readonly cache = new Map<string, CachedEntry>();
  private readonly TTL_MS = 60_000;

  @Get("country")
  @ApiOperation({ summary: "Detect the caller's ISO country code from their IP (public)" })
  @ApiResponse({ status: 200, description: "Country code or null if detection failed" })
  async country(@Req() req: Request): Promise<{ countryCode: string | null }> {
    const ip = this.extractIp(req);
    if (!ip) return { countryCode: null };

    const hit = this.cache.get(ip);
    if (hit && Date.now() - hit.at < this.TTL_MS) {
      return { countryCode: hit.code };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(
        `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=countryCode`,
        { signal: controller.signal },
      );
      clearTimeout(timeout);

      if (!res.ok) {
        this.cache.set(ip, { code: null, at: Date.now() });
        return { countryCode: null };
      }

      const json = (await res.json()) as { countryCode?: unknown };
      const code =
        typeof json.countryCode === "string" && json.countryCode.length === 2
          ? json.countryCode.toUpperCase()
          : null;
      this.cache.set(ip, { code, at: Date.now() });
      return { countryCode: code };
    } catch {
      this.cache.set(ip, { code: null, at: Date.now() });
      return { countryCode: null };
    }
  }

  private extractIp(req: Request): string | null {
    const xff = req.headers["x-forwarded-for"];
    let candidate = "";
    if (Array.isArray(xff)) {
      candidate = xff[0] ?? "";
    } else if (typeof xff === "string") {
      candidate = xff.split(",")[0]?.trim() ?? "";
    }
    const ip = (candidate || req.ip || "").replace(/^::ffff:/, "");
    if (!ip) return null;
    if (ip === "::1" || ip === "127.0.0.1") return null;
    if (ip.startsWith("10.") || ip.startsWith("192.168.")) return null;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return null;
    return ip;
  }
}
