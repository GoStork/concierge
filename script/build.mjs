import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";
import { execSync } from "child_process";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "@nestjs/common",
  "@nestjs/core",
  "@nestjs/jwt",
  "@nestjs/passport",
  "@nestjs/platform-express",
  "@nestjs/swagger",
  "@prisma/adapter-pg",
  "axios",
  "connect-pg-simple",
  "connect-redis",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-jwt",
  "passport-local",
  "pg",
  "redis",
  "reflect-metadata",
  "stripe",
  "uuid",
  "ws",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("generating Prisma client...");
  execSync("npx prisma generate", { stdio: "inherit" });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  const nestOptionalExternals = [
    "@nestjs/websockets",
    "@nestjs/websockets/socket-module",
    "@nestjs/microservices",
    "@nestjs/microservices/microservices-module",
    "class-transformer",
    "class-validator",
  ];

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: [...externals, ...nestOptionalExternals],
    logLevel: "info",
  });

  console.log("building mcp-server...");
  await esbuild({
    entryPoints: ["server/src/mcp-server.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/mcp-server.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: [...externals, ...nestOptionalExternals],
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
