# Homebrew formula template — NOT published yet.
#
# The tap (Ghost-9/homebrew-tap) does not exist; this file defines the shape so
# the release process and the install path are reviewed now. To actually use it:
#
#   # 1. fill the checksum for the tagged release tarball
#   V=v0.3.1
#   curl -L -o "/tmp/pi-ultrasearch-$V.tgz" \
#     "https://github.com/Ghost-9/pi-ultrasearch/releases/download/$V/pi-ultrasearch-$V.tgz"
#   shasum -a 256 "/tmp/pi-ultrasearch-$V.tgz"     # copy into sha256 below
#
#   # 2. test locally, without a tap
#   brew install --build-from-source ./packaging/homebrew/ultrasearch.rb
#
#   # 3. publish (only when the tap exists)
#   cp packaging/homebrew/ultrasearch.rb "$(brew --repository Ghost-9/tap)/Formula/"
#   brew install Ghost-9/tap/ultrasearch
#
# What this formula installs: the client surfaces (ultrasearch, ultrasearch-tui,
# ultrasearch-mcp) from the npm-pack tarball the release workflow attaches to
# every tag (`.github/workflows/release.yml`). What it does NOT install: the
# resident daemon. The daemon is a native Rust binary, is macOS-only today
# (issue #32), needs a Full Disk Access grant, and is installed by
# `scripts/install.sh` — deliberately not by a formula that cannot express the
# TCC grant. On a machine with the daemon already installed, this formula makes
# the CLI/MCP surfaces available; without the daemon the client's native
# fallback still answers queries.
class Ultrasearch < Formula
  desc "Sub-millisecond filesystem search and trigram code indexing"
  homepage "https://github.com/Ghost-9/pi-ultrasearch"
  url "https://github.com/Ghost-9/pi-ultrasearch/releases/download/v0.3.1/pi-ultrasearch-v0.3.1.tgz"
  sha256 "REPLACE_WITH_RELEASE_SHA256"
  license "AGPL-3.0-or-later"

  # The package is plain ESM with no runtime dependencies; the CLI and the MCP
  # server both require Node >= 22.18 (package.json engines).
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # `help` is offline: it prints the command surface and exits without
    # contacting the daemon, so the test does not depend on FDA or a socket.
    assert_match "PI-ULTRASEARCH", shell_output("#{bin}/ultrasearch help")
    assert_path_exists bin/"ultrasearch-mcp"
  end
end
