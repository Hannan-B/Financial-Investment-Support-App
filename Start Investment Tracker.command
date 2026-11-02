#!/bin/zsh
# Double-click to start the app. This window stays open while the app runs;
# closing the app's window stops it. (npm run tauri dev — the real app, not the demo.)

cd "${0:A:h}" || exit 1

# A double-clicked file does not read your shell's start-up files, so load
# Node (installed with nvm) and Rust's tools here.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -s "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

finish() {
  echo
  echo "$1"
  read -k1 "?Press any key to close this window."
  exit "${2:-0}"
}

command -v npm >/dev/null || finish "Could not find Node (npm). Is nvm installed in ~/.nvm?" 1
command -v cargo >/dev/null || finish "Could not find Rust (cargo). Is it installed in ~/.cargo?" 1

# The app and the demo share one local address: only one can run at a time.
if lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
  finish "The app (or the demo) is already running — look for its window, or stop it in its Terminal window first." 1
fi

echo "Starting Investment Tracker… the window opens in a minute or so."
echo "macOS may ask for keychain access: allow it, as usual."
echo
npm run tauri dev
finish "The app has stopped."
