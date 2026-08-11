#!/usr/bin/env node

import { access, chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name}_value_required`);
  return value;
}

function safeSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

async function copyApplication(target) {
  await mkdir(target, { recursive: true, mode: 0o755 });
  for (const entry of [
    "config",
    "docs",
    "employee",
    "node_modules",
    "service",
    "LICENSE",
    "NOTICE",
    "README.md",
    "package.json",
    "package-lock.json",
  ]) {
    await cp(path.join(repositoryRoot, entry), path.join(target, entry), {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
    });
  }
}

async function copyNodeLicense(nodeBinary, target) {
  const candidates = [
    path.resolve(path.dirname(nodeBinary), "..", "LICENSE"),
    path.resolve(path.dirname(nodeBinary), "..", "LICENSE.md"),
    path.resolve(path.dirname(nodeBinary), "..", "share", "doc", "node", "LICENSE"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      await cp(candidate, target, { force: false, errorOnExist: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("node_license_not_found");
}

async function packageMac({ outputDirectory, nodeBinary, arch, version }) {
  const appName = "Senior Architect Pass Coach.app";
  const appRoot = path.join(outputDirectory, appName);
  const contents = path.join(appRoot, "Contents");
  const resources = path.join(contents, "Resources");
  const executable = path.join(contents, "MacOS", "architect-pass-coach");
  await mkdir(path.dirname(executable), { recursive: true, mode: 0o755 });
  await mkdir(resources, { recursive: true, mode: 0o755 });
  await copyApplication(path.join(resources, "app"));
  await cp(nodeBinary, path.join(resources, "node"), { force: false, errorOnExist: true });
  await copyNodeLicense(nodeBinary, path.join(resources, "NODE-LICENSE"));
  await chmod(path.join(resources, "node"), 0o755);

  const launcher = `#!/bin/zsh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RESOURCE_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../Resources" && pwd)"
exec /bin/zsh -lc 'exec "$1" "$2" --open' architect-pass-coach "$RESOURCE_DIR/node" "$RESOURCE_DIR/app/service/runtime-cli.mjs"
`;
  await writeFile(executable, launcher, { mode: 0o755 });
  await chmod(executable, 0o755);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>架构过线私教</string>
  <key>CFBundleExecutable</key><string>architect-pass-coach</string>
  <key>CFBundleIdentifier</key><string>io.github.peterguy326.architect-pass-coach</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Senior Architect Pass Coach</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSMultipleInstancesProhibited</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
  await writeFile(path.join(contents, "Info.plist"), plist);

  const metadata = {
    schema_version: "coach-runtime-bundle.v1",
    platform: "darwin",
    arch,
    version,
    node_version: process.version,
    unsigned_preview: true,
  };
  await writeFile(path.join(resources, "bundle.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return appRoot;
}

async function packageLinux({ outputDirectory, nodeBinary, arch, version }) {
  const bundleRoot = path.join(outputDirectory, `senior-architect-pass-coach-linux-${arch}`);
  await mkdir(bundleRoot, { recursive: true, mode: 0o755 });
  await copyApplication(path.join(bundleRoot, "app"));
  await cp(nodeBinary, path.join(bundleRoot, "node"), { force: false, errorOnExist: true });
  await copyNodeLicense(nodeBinary, path.join(bundleRoot, "NODE-LICENSE"));
  await chmod(path.join(bundleRoot, "node"), 0o755);
  const launcher = `#!/bin/sh
set -eu
BUNDLE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$BUNDLE_DIR/node" "$BUNDLE_DIR/app/service/runtime-cli.mjs" --open
`;
  await writeFile(path.join(bundleRoot, "start-local-coach"), launcher, { mode: 0o755 });
  await chmod(path.join(bundleRoot, "start-local-coach"), 0o755);
  await writeFile(path.join(bundleRoot, "bundle.json"), `${JSON.stringify({
    schema_version: "coach-runtime-bundle.v1",
    platform: "linux",
    arch,
    version,
    node_version: process.version,
    unsigned_preview: true,
  }, null, 2)}\n`);
  return bundleRoot;
}

async function main() {
  const platform = safeSegment(argument("platform", process.platform), "platform");
  const arch = safeSegment(argument("arch", process.arch), "arch");
  const nodeBinary = path.resolve(argument("node", process.execPath));
  const expectedOutputDirectory = path.join(repositoryRoot, "dist");
  const outputDirectory = path.resolve(argument("out", expectedOutputDirectory));
  if (outputDirectory !== expectedOutputDirectory) {
    throw new Error("output_directory_must_be_repository_dist");
  }
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const version = safeSegment(argument("version", packageJson.version), "version");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true, mode: 0o755 });

  const result = platform === "darwin"
    ? await packageMac({ outputDirectory, nodeBinary, arch, version })
    : platform === "linux"
      ? await packageLinux({ outputDirectory, nodeBinary, arch, version })
      : null;
  if (!result) throw new Error(`unsupported_platform:${platform}`);
  process.stdout.write(`${result}\n`);
}

await main();
