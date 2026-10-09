# Screen forensics (`tools/screen/`)

Windows-only helpers for judging the **window** rather than the page. They exist because the
window is transparent: a screenshot of the window's screen rectangle contains whatever sits
behind it, which is the only way to see whether the desktop really shows through, whether the
material is doing anything, and whether the corners are round against the real desktop.

Every default output goes to `$env:TEMP`; pass `-OutFile` to keep a result.

| Script | What it answers |
|---|---|
| `shot-window.ps1` | Captures the screen area the DSH window occupies. Whatever is behind the transparent window is inside that rectangle, so this is the base evidence for "transparency works" and "is that a black bar". |
| `shot-window-topmost.ps1` | The same, but raises the window with `SetWindowPos(HWND_TOPMOST)` for the shot and lowers it again. Plain `SetForegroundWindow` is refused for a process that does not own the foreground, and the capture then silently contains somebody else's window — that failure looks exactly like a broken patch. |
| `zoom-corners.ps1` | Crops and magnifies a capture (nearest-neighbour, so pixels stay honest) to judge the rounded corners against the desktop. |
| `probe-corners.ps1` | Samples the corner pixels and reports them as numbers, plus two debug images: what the window paints there vs. what is behind it. |
| `window-shape.ps1` | `probe` reports the current window shape; `dwm` asks DWM to round the window; `rgn` sets a Win32 region; `dwm+rgn` both; `clear` undoes them. Region shaping has aliased edges, which is why the package rounds through DWM instead. |
| `verify-blackbar-after-restart.ps1` | The end-to-end evidence run: waits for the freshly restarted window, reads the fade element's computed style over CDP, and measures the pixel region where the sidebar's black bar used to be. |

Two notes that cost real time to learn:

- A restart also ends the desktop host, i.e. the session that would normally be doing the
  checking. That is why `restart-dsh-outside-session.ps1` launches through a scheduled task and
  why `verify-blackbar-after-restart.ps1` waits for the window instead of being run by hand.
- Capture the window **after** raising it (or with `shot-window-topmost.ps1`), and capture it at
  the same scroll position both times when comparing two states: two screenshots taken at
  different scroll offsets look identical to the eye and prove nothing.
