import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

const acceptedApiKeyDigests = env.APP_API_KEYS.map(digest);

function extractApiKey(req: Request): string | null {
  const headerKey = req.header("x-api-key")?.trim();
  if (headerKey) return headerKey;

  const authorization = req.header("authorization")?.trim();
  if (!authorization) return null;

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

export function requireAppApiKey(req: Request, res: Response, next: NextFunction): void {
  const supplied = extractApiKey(req);

  if (!supplied) {
    res.status(401).json({
      success: false,
      error: "Missing app API key.",
      code: "APP_API_KEY_REQUIRED",
    });
    return;
  }

  const suppliedDigest = digest(supplied);
  const valid = acceptedApiKeyDigests.some((expected) =>
    timingSafeEqual(expected, suppliedDigest)
  );

  if (!valid) {
    res.status(401).json({
      success: false,
      error: "Invalid app API key.",
      code: "APP_API_KEY_INVALID",
    });
    return;
  }

  next();
}
