/**
 * Singleton reference to the NestJS application instance.
 * This allows Express routers (like ai-router) to access NestJS services
 * without circular imports from index.ts.
 */
import type { INestApplication } from "@nestjs/common";

let app: INestApplication | null = null;

export function setNestApp(nestApp: INestApplication) {
  app = nestApp;
}

export function getNestApp(): INestApplication | null {
  return app;
}
