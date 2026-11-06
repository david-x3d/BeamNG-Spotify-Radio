# BeamNG Spotify Radio

Control Spotify from inside BeamNG.drive and hear it through your car's speakers.

- In-game app showing the current track, cover, and progress, with play/pause, next, and previous
- Bind play/pause, next, previous, and show/hide to keys or steering-wheel buttons
- **Car radio:** Spotify's sound comes out of the car. It fills the cabin when you sit inside, and it comes from the car, quieter and positioned, when the camera is outside
- Optional car-speaker EQ (less sub bass, narrower stereo)
- Pauses Spotify automatically when the ignition is off, when you walk, or when the game is paused
- Volume up to 200%

Works on **Linux** (native BeamNG build, PipeWire or PulseAudio) and **Windows** (10 version 1803 or newer).

## How it works

The project has two parts:

1. **The mod** (`mod/`): the in-game app plus Lua code that plays the radio and talks to the helper.
2. **The helper** (`helper/helper.py`): a small background program on your PC. It's needed because the game itself may not:
   - make web requests: the helper forwards the Spotify Web API calls and cover images;
   - open a browser: the helper opens the Spotify login page;
   - capture other programs' audio: the helper takes Spotify's sound away from your speakers and writes it as short audio pieces into BeamNG's temp folder, where the mod plays them back.

When the car radio is off or the game is closed, Spotify plays through your speakers as usual.

## Requirements

- Spotify desktop app and **Spotify Premium** (Spotify only allows playback control for Premium accounts)
- Python 3.9+ with `numpy`
- `ffmpeg`
- Linux: `pactl` (PipeWire or PulseAudio), `playerctl`, and `wl-copy` or `xclip`
- Windows: [VB-CABLE](https://vb-audio.com/Cable/) (free virtual audio cable) and NirSoft `svcl.exe` (the install script downloads it)

## Setup

### 1. Install the mod

Build the mod zip and put it into BeamNG's mods folder:

```
python3 tools/build_mod.py
```

Copy `dist/spotifyremote_davidx3d.zip` to:

- Linux: `~/.local/share/BeamNG/BeamNG.drive/current/mods/`
- Windows: `%LOCALAPPDATA%\BeamNG\BeamNG.drive\current\mods\`

For development you can link the `mod` folder as `mods/unpacked/spotifyremote_davidx3d` instead.

### 2. Install the helper

**Linux:** installs a systemd user service that starts with your session:

```
./helper/install-linux.sh
```

**Windows:**

1. Install [VB-CABLE](https://vb-audio.com/Cable/) (run the installer as administrator, then reboot).
2. Install [Python](https://www.python.org/) and tick "Add python.exe to PATH".
3. In PowerShell, run:

   ```
   powershell -ExecutionPolicy Bypass -File helper\install-windows.ps1
   ```

   The script installs the Python packages and ffmpeg, downloads `svcl.exe`, and adds the helper to Windows startup.

### 3. Create a Spotify app

1. Open the [Spotify developer dashboard](https://developer.spotify.com/dashboard) and create an app.
2. Add `http://127.0.0.1:8899/callback` as the Redirect URI, and tick "Web API".
3. Copy the app's **Client ID**.

### 4. Connect in the game

1. Add the "Spotify Remote" app to your UI layout (UI apps → General).
2. Paste the Client ID and click **Connect with Spotify**.
3. Log in to Spotify in the browser window that opens.

Key bindings are under Options → Controls → General ("Spotify: ...").

## Settings

The settings are behind the gear icon in the app:

| Setting | Effect |
| --- | --- |
| Car radio | Play Spotify through the car instead of your PC speakers |
| Volume | 0–200%. Above 100%, the helper boosts the audio with a soft limiter |
| Volume outside the car | Relative volume when the camera is outside |
| Car speaker sound (EQ) | Makes the music sound like small car speakers |
| Pause with ignition off / on foot | Pauses Spotify when the engine is off or you walk |
| Pause when the game is paused | Pauses Spotify while the game is paused |

## Troubleshooting

- **"No connection. Is the helper running?"**: start the helper.
  - Linux: check it with `systemctl --user status spotifyremote-radio`.
  - Windows: look at `helper\helper.log`.
- **"Waiting for sound"**: Spotify isn't playing, or the helper can't capture it.
  - Linux: check the helper log with `journalctl --user -u spotifyremote-radio -f`.
  - Windows: check that VB-CABLE is installed.
- **Nothing opens when connecting**: click "Nothing opened? Copy the link" and paste the link into your browser.
- **Spotify is silent after a crash on Windows**: the helper normally switches Spotify back to your speakers.
  - If it couldn't, run `svcl.exe /SetAppDefault DefaultRenderDevice all Spotify.exe`.
  - Or set Spotify's output back to "Default" under Settings → System → Sound → Volume mixer.
- **The car radio lags behind**: the car plays about one second behind Spotify. That's the cost of passing the audio through the game.

## Tests

```
node tests/test_app.js mod/ui/modules/apps/SpotifyRemote/app.js
```
