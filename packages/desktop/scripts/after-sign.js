const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { smokePackagedDesktopApp } = require("./smoke-packaged-desktop-app.js");

const EXECUTABLE_NAME = "Paseo";
const LOCAL_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.device.audio-input</key>
  <true/>
</dict>
</plist>
`;

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function isAdHocSigned(appPath) {
  const result = spawnSync("codesign", ["-dv", "--verbose=4", appPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `Unable to inspect code signature for ${appPath}`);
  }
  const output = `${result.stdout}${result.stderr}`;
  return output.includes("TeamIdentifier=not set");
}

function signWithLocalEntitlements(target, entitlementsPath) {
  run("codesign", [
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    "--timestamp=none",
    "--entitlements",
    entitlementsPath,
    target,
  ]);
}

function repairAdHocMacSignature(appPath) {
  if (!isAdHocSigned(appPath)) {
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-local-sign-"));
  const entitlementsPath = path.join(tempDir, "entitlements.plist");

  try {
    fs.writeFileSync(entitlementsPath, LOCAL_ENTITLEMENTS);
    run("xattr", ["-cr", appPath]);
    run("codesign", [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--timestamp=none",
      appPath,
    ]);

    const frameworksDir = path.join(appPath, "Contents", "Frameworks");
    for (const entry of fs.readdirSync(frameworksDir)) {
      if (entry.startsWith(`${EXECUTABLE_NAME} Helper`) && entry.endsWith(".app")) {
        signWithLocalEntitlements(path.join(frameworksDir, entry), entitlementsPath);
      }
    }
    signWithLocalEntitlements(appPath, entitlementsPath);
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appPath = path.join(context.appOutDir, `${EXECUTABLE_NAME}.app`);
  repairAdHocMacSignature(appPath);

  if (process.env.PASEO_DESKTOP_SMOKE !== "1") {
    return;
  }

  await smokePackagedDesktopApp({
    appPath,
  });
};
