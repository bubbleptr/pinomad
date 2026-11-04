// electron-builder afterPack hook: builds the host launcher (pinomad-host.c)
// into PiNomad.app/Contents/Helpers before the app is signed, so it is signed
// and notarized with the app. The names here match the launcher path
// apps/desktop/electron/main.ts hands to `pinomad up --launcher`.
const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

// builder-util's Arch enum.
const CLANG_ARCH = { 1: "x86_64", 3: "arm64" };

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const arch = CLANG_ARCH[context.arch];
  if (arch === undefined) throw new Error(`host launcher: no build for arch ${context.arch}`);
  const { productFilename, version } = context.packager.appInfo;
  const minimum = context.packager.platformSpecificBuildOptions.minimumSystemVersion;
  if (minimum === undefined) throw new Error("host launcher: mac.minimumSystemVersion is not set");
  const contents = join(context.appOutDir, `${productFilename}.app`, "Contents", "Helpers", "PiNomad Host.app", "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  execFileSync(
    "xcrun",
    ["clang", "-arch", arch, `-mmacosx-version-min=${minimum}`, "-O2", "-Wall", "-Wextra", "-Werror",
      "-o", join(contents, "MacOS", "pinomad-host"), join(__dirname, "pinomad-host.c")],
    { stdio: "inherit" },
  );
  const plist = readFileSync(join(__dirname, "Info.plist"), "utf8")
    .replaceAll("${VERSION}", version)
    .replaceAll("${MINIMUM_SYSTEM_VERSION}", minimum);
  writeFileSync(join(contents, "Info.plist"), plist);
};
