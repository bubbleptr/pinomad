#!/bin/sh
# PiNomad installer (https://pinomad.si/install.sh):
#
#   curl -fsSL https://pinomad.si/install.sh | sh
#   curl -fsSL https://pinomad.si/install.sh | sh -s -- up --origin <server>
#
# Puts an official Node build and the pinomad npm package in ~/.pinomad/runtime
# and a `pinomad` launcher in ~/.local/bin, so the machine needs no Node of its
# own, and adds ~/.local/bin to the shell profile when it isn't on PATH yet.
# Running it again updates both. A pinomad installed another way (npm, a
# source checkout) is left alone. Arguments after `sh -s --` are a pinomad
# command to run once it is installed. Settings, all optional:
#
#   PINOMAD_VERSION      pinomad version to install (default: latest), or the
#                        path to a pinomad-*.tgz (the release workflow's check)
#   PINOMAD_RUNTIME_DIR  where Node and the package go (default ~/.pinomad/runtime)
#   PINOMAD_BIN_DIR      where the launcher goes (default ~/.local/bin)
#   PINOMAD_NODE_MIRROR  base URL of the Node downloads (default https://nodejs.org/dist)
#
# To uninstall: `pinomad service uninstall`, then delete the runtime dir, the
# launcher and the profile line that ends in the PATH_MARKER comment. The data
# dir (~/.pinomad, minus runtime/) is yours to keep.

set -eu

# Node is pinned with its checksums: changing the version means updating all
# three sums from https://nodejs.org/dist/v<version>/SHASUMS256.txt.
NODE_VERSION=26.12.1
SUM_DARWIN_ARM64=1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8
SUM_LINUX_X64=0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132
SUM_LINUX_ARM64=a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f

# The launcher's second line; a re-run looks for it to tell its own launcher
# from a pinomad installed some other way.
MARKER="pinomad launcher installed by https://pinomad.si/install.sh"
# Ends the PATH line in the shell profile, so a re-run adds no second one.
PATH_MARKER="added by https://pinomad.si/install.sh"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1" || fail "could not download $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || fail "could not download $1"
  else
    fail "needs curl or wget"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "needs sha256sum or shasum to check the download"
  fi
}

ours() { grep -qF "$MARKER" "$1" 2>/dev/null; }

# The file a new terminal reads for the user's login shell. Terminal on macOS
# opens login shells, which read .bash_profile (or what stands in for it)
# instead of .bashrc.
profile() {
  case ${SHELL##*/} in
    zsh) say "${ZDOTDIR:-$HOME}/.zshrc" ;;
    fish) say "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/pinomad.fish" ;;
    bash)
      if [ "$os" = Darwin ]; then
        for file in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
          if [ -e "$file" ]; then
            say "$file"
            return
          fi
        done
        say "$HOME/.bash_profile"
      else
        say "$HOME/.bashrc"
      fi
      ;;
    *) say "$HOME/.profile" ;;
  esac
}

# Puts $bin_dir on PATH for new terminals; this one can't be changed from here.
add_to_path() {
  rc=$(profile)
  case $bin_dir in
    "$HOME"/*) entry="\$HOME${bin_dir#"$HOME"}" ;;
    *) entry=$bin_dir ;;
  esac
  case $rc in
    *.fish) line="fish_add_path -g \"$entry\" # $PATH_MARKER" ;;
    *) line="export PATH=\"$entry:\$PATH\" # $PATH_MARKER" ;;
  esac
  if grep -qF "$PATH_MARKER" "$rc" 2>/dev/null; then return 0; fi
  if {
    mkdir -p "$(dirname "$rc")" &&
      # A file that doesn't end in a newline would run into the new line.
      if [ -s "$rc" ] && [ -n "$(tail -c 1 "$rc")" ]; then printf '\n' >>"$rc"; fi &&
      say "$line" >>"$rc"
  } 2>/dev/null; then
    say "Added $bin_dir to PATH in $rc"
  else
    say "Could not write $rc; add this line to your shell profile yourself:"
    say "  $line"
  fi
}

# Everything runs from here, so a download cut short runs nothing.
main() {
  runtime=${PINOMAD_RUNTIME_DIR:-$HOME/.pinomad/runtime}
  bin_dir=${PINOMAD_BIN_DIR:-$HOME/.local/bin}
  mirror=${PINOMAD_NODE_MIRROR:-https://nodejs.org/dist}
  version=${PINOMAD_VERSION:-latest}
  # Both end up in the launcher, which runs from any directory.
  case $runtime in /*) ;; *) runtime=$(pwd)/${runtime#./} ;; esac
  case $bin_dir in /*) ;; *) bin_dir=$(pwd)/${bin_dir#./} ;; esac
  launcher=$bin_dir/pinomad
  node=$runtime/node/bin/node

  for found in "$(command -v pinomad 2>/dev/null || true)" "$launcher"; do
    if [ -e "$found" ] && ! ours "$found"; then
      say "pinomad is already installed at $found; leaving it alone."
      say "Update it with \`pinomad upgrade\`, or remove it (\`npm uninstall -g pinomad\`) and run this again."
      if [ $# -gt 0 ]; then run "$found" "$@"; fi
      return 0
    fi
  done
  reinstall=false
  if [ -e "$launcher" ]; then reinstall=true; fi

  os=$(uname -s)
  arch=$(uname -m)
  # A shell running under Rosetta reports x86_64 on Apple silicon.
  if [ "$os" = Darwin ] && [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  case "$os-$arch" in
    Darwin-arm64) platform=darwin-arm64 sum=$SUM_DARWIN_ARM64 ;;
    Linux-x86_64 | Linux-amd64) platform=linux-x64 sum=$SUM_LINUX_X64 ;;
    Linux-aarch64 | Linux-arm64) platform=linux-arm64 sum=$SUM_LINUX_ARM64 ;;
    *) fail "no build for $os on $arch (this script covers Apple silicon Macs and Linux on x64 or arm64); install Node 25+ and run \`npm i -g pinomad\` instead" ;;
  esac
  if [ "$os" = Linux ] && ldd --version 2>&1 | grep -qi musl; then
    fail "the official Node builds need glibc, and this system uses musl; install Node 25+ and run \`npm i -g pinomad\` instead"
  fi

  if [ "$("$node" --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
    mkdir -p "$runtime"
    # Inside the runtime dir, so the final move is a rename on one filesystem.
    tmp=$(mktemp -d "$runtime/.download.XXXXXX")
    trap 'rm -rf "$tmp"' EXIT
    name=node-v$NODE_VERSION-$platform
    say "Downloading Node $NODE_VERSION ($platform)"
    download "$mirror/v$NODE_VERSION/$name.tar.gz" "$tmp/$name.tar.gz"
    actual=$(sha256 "$tmp/$name.tar.gz")
    if [ "$actual" != "$sum" ]; then
      fail "checksum mismatch for $name.tar.gz (expected $sum, got $actual); nothing was installed"
    fi
    tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
    # Always the same path: the service definition records this node (ADR-0009 §4).
    rm -rf "$runtime/node.old"
    if [ -d "$runtime/node" ]; then mv "$runtime/node" "$runtime/node.old"; fi
    mv "$tmp/$name" "$runtime/node"
    rm -rf "$runtime/node.old"
  fi

  case $version in
    */*) spec=$version ;;
    *) spec=pinomad@$version ;;
  esac
  say "Installing $spec"
  # npm's own scripts and the packages' install scripts call `node` by name.
  PATH="$runtime/node/bin:$PATH" "$node" "$runtime/node/lib/node_modules/npm/bin/npm-cli.js" install --global \
    --prefix "$runtime" --no-fund --no-audit --no-update-notifier --loglevel=error "$spec" ||
    fail "npm could not install $spec"
  entry=$runtime/lib/node_modules/pinomad/dist/pinomad.js
  [ -f "$entry" ] || fail "npm finished but $entry is missing"

  # The package's own bin runs `/usr/bin/env node`, which may not exist here.
  mkdir -p "$bin_dir"
  # The bundled Node goes last on PATH: MCP servers run as `npx …` and the
  # agent's shell find it on a machine with no other Node, one the user
  # installed still wins, and `service install` keeps this PATH.
  cat >"$launcher.tmp" <<EOF
#!/bin/sh
# $MARKER
case ":\$PATH:" in
  *":$runtime/node/bin:"*) ;;
  *) PATH="\${PATH:+\$PATH:}$runtime/node/bin" && export PATH ;;
esac
exec "$node" "$entry" "\$@"
EOF
  chmod 755 "$launcher.tmp"
  mv "$launcher.tmp" "$launcher"

  say "Installed pinomad $("$launcher" --version) in $runtime"
  if [ "$reinstall" = true ]; then
    say "If the host runs as a service, \`pinomad service restart\` moves it to this version."
  fi
  case ":$PATH:" in
    *":$bin_dir:"*) next="Next: pinomad up" ;;
    *)
      add_to_path
      next="Next, in a new terminal: pinomad up"
      ;;
  esac
  if [ $# -gt 0 ]; then run "$launcher" "$@"; fi
  say "$next"
}

# Under `curl … | sh` stdin is the script itself; a command that asks
# questions (`pinomad up`) reads the terminal instead, when there is one.
run() {
  if (: </dev/tty) 2>/dev/null; then exec "$@" </dev/tty; fi
  exec "$@" </dev/null
}

main "$@"
