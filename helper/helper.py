#!/usr/bin/env python3
"""Spotify -> BeamNG car radio bridge (Linux and Windows).

While the BeamNG mod "spotifyremote_davidx3d" sends heartbeats, Spotify's audio is redirected away from the
speakers, captured, given a car-speaker EQ and written as short crossfaded WAV segments into BeamNG's temp
folder. The mod plays them back through the game's sound engine.

Linux: Spotify is moved to a private PipeWire/PulseAudio null sink and its monitor is captured.
Windows: Spotify's output device is switched to VB-CABLE (with NirSoft svcl.exe) and the cable is captured.

It also forwards the mod's Spotify Web API requests (the game UI is not allowed to make web requests)
and opens the Spotify login page in the browser (the game cannot do that either).
"""
import asyncio
import base64
import glob
import http.client
import http.server
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time

import numpy as np

WINDOWS = sys.platform == "win32"
HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8898
PROXY_PORT = 8897
# path prefix -> (host, path prefix there); images come back base64 encoded so they can travel as text
PROXY_TARGETS = {"/accounts/": ("accounts.spotify.com", "/"), "/api/": ("api.spotify.com", "/"),
                 "/image/": ("i.scdn.co", "/image/"), "/mosaic/": ("mosaic.scdn.co", "/"),
                 "/imagecdn-ak/": ("image-cdn-ak.spotifycdn.com", "/image/"),
                 "/imagecdn-fa/": ("image-cdn-fa.spotifycdn.com", "/image/")}
IMAGE_PREFIXES = ("/image/", "/mosaic/", "/imagecdn-ak/", "/imagecdn-fa/")
LOGIN_PREFIX = "https://accounts.spotify.com/authorize?"
HEARTBEAT_TIMEOUT = 2.0
RATE = 48000
SEGMENT = 0.5  # seconds, must match radio.lua; the game plays about two segments behind live
CROSSFADE = 0.08
KEEP_SEGMENTS = 12
LIMIT_THRESHOLD = 0.7 * 32767  # the volume boost above 100% is soft limited from here on instead of clipping
# small car speakers: less sub bass, a bit of boom, slightly boxy mids, softer top end, narrower stereo
CAR_EQ = ("highpass=f=70,"
          "equalizer=f=130:t=q:w=1.0:g=3,"
          "equalizer=f=500:t=q:w=1.2:g=-2,"
          "equalizer=f=3000:t=q:w=1.5:g=2,"
          "lowpass=f=13000,"
          "extrastereo=m=0.6")
# no console windows for child processes when the helper runs with pythonw on Windows
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if WINDOWS else {}


def run(*args, **kwargs):
    try:
        return subprocess.run(args, capture_output=True, text=True, **NO_WINDOW, **kwargs)
    except OSError as err:  # tool not installed
        return subprocess.CompletedProcess(args, 127, "", str(err))


def log(msg):
    line = time.strftime("%H:%M:%S ") + msg
    if sys.stdout:
        print(line, flush=True)
    else:  # pythonw has no console
        with open(os.path.join(HERE, "helper.log"), "a", encoding="utf-8") as f:
            f.write(line + "\n")


def default_segment_dir():
    base = os.environ.get("LOCALAPPDATA", "") if WINDOWS else os.path.expanduser("~/.local/share")
    return os.path.join(base, "BeamNG", "BeamNG.drive", "current", "temp", "spotifyremote")


def segment_dir_from_game(path):
    """The mod sends <user folder>/temp/spotifyremote. Only accept exactly that shape, the helper deletes files there."""
    if not isinstance(path, str) or not path:
        return None
    path = os.path.normpath(path)
    parent = os.path.dirname(path)
    if os.path.basename(path) != "spotifyremote" or os.path.basename(parent) != "temp" or not os.path.isdir(parent):
        return None
    return path


def clear_segments(directory):
    for f in glob.glob(os.path.join(directory, "seg_*.wav*")):
        try:
            os.remove(f)
        except OSError:
            pass


def soft_limit(x):
    a = np.abs(x)
    over = a > LIMIT_THRESHOLD
    if over.any():
        room = 32767 - LIMIT_THRESHOLD
        x[over] = np.sign(x[over]) * (LIMIT_THRESHOLD + room * np.tanh((a[over] - LIMIT_THRESHOLD) / room))
    return x


class LinuxAudio:
    SINK = "beamng_radio"

    def __init__(self):
        self.module = None

    def check(self):
        for tool in ("pactl", "ffmpeg"):
            if not shutil.which(tool):
                log("missing: %s (install it with your package manager)" % tool)
        if not shutil.which("playerctl"):
            log("playerctl not found: Spotify will not be paused automatically")

    def spotify_inputs(self):
        try:
            items = json.loads(run("pactl", "-f", "json", "list", "sink-inputs").stdout or "[]")
        except json.JSONDecodeError:
            return []
        result = []
        for item in items:
            props = item.get("properties", {})
            name = (props.get("application.name", "") + " " + props.get("application.process.binary", "")).lower()
            if "spotify" in name:
                result.append((item["index"], item.get("sink")))
        return result

    def sink_index(self):
        try:
            sinks = json.loads(run("pactl", "-f", "json", "list", "short", "sinks").stdout or "[]")
        except json.JSONDecodeError:
            return None
        return next((s.get("index") for s in sinks if s.get("name") == self.SINK), None)

    def open(self):
        for line in run("pactl", "list", "short", "modules").stdout.splitlines():
            if "module-null-sink" in line and "sink_name=" + self.SINK in line:
                run("pactl", "unload-module", line.split()[0])
        res = run("pactl", "load-module", "module-null-sink", "sink_name=" + self.SINK,
                  "sink_properties=device.description=BeamNG-Car-Radio", "rate=%d" % RATE, "channels=2")
        if res.returncode != 0:
            log("could not create null sink: " + res.stderr.strip())
            return False
        self.module = res.stdout.strip()
        return True

    def ffmpeg_input(self):
        return ["-fragment_size", "3840", "-f", "pulse", "-sample_rate", str(RATE), "-channels", "2",
                "-i", self.SINK + ".monitor"]

    def route(self):
        target = self.sink_index()
        for index, sink in self.spotify_inputs():
            if sink != target:
                run("pactl", "move-sink-input", str(index), self.SINK)

    def close(self):
        for index, _ in self.spotify_inputs():
            run("pactl", "move-sink-input", str(index), "@DEFAULT_SINK@")
        if self.module:
            run("pactl", "unload-module", self.module)
            self.module = None

    def spotify_playing(self):
        return run("playerctl", "-p", "spotify", "status").stdout.strip() == "Playing"

    def spotify_pause(self):
        run("playerctl", "-p", "spotify", "pause")

    def spotify_play(self):
        run("playerctl", "-p", "spotify", "play")

    def open_url(self, url):
        subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def copy(self, text):
        for cmd in (["wl-copy"], ["xclip", "-selection", "clipboard"]):
            if shutil.which(cmd[0]):
                subprocess.run(cmd, input=text, text=True)
                return


class WindowsAudio:
    CABLE_RENDER = r"VB-Audio Virtual Cable\Device\CABLE Input\Render"
    CABLE_CAPTURE = "CABLE Output (VB-Audio Virtual Cable)"
    PROCESS = "Spotify.exe"

    def __init__(self):
        self.svcl = os.path.join(HERE, "svcl.exe") if os.path.exists(os.path.join(HERE, "svcl.exe")) else shutil.which("svcl")
        self.last_route = 0
        self.media = None

    def check(self):
        if not shutil.which("ffmpeg"):
            log("missing: ffmpeg (winget install Gyan.FFmpeg)")
        if not self.svcl:
            log("missing: svcl.exe from https://www.nirsoft.net/utils/sound_volume_command_line.html next to helper.py")
        try:
            from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
            self.media = GlobalSystemMediaTransportControlsSessionManager
        except ImportError:
            log("winrt-Windows.Media.Control not installed: Spotify will not be paused automatically")

    def svcl_set(self, device):
        res = run(self.svcl, "/SetAppDefault", device, "all", self.PROCESS)
        if res.returncode != 0:
            log("svcl failed (%s): %s" % (res.returncode, (res.stdout + res.stderr).strip()))

    def open(self):
        if not self.svcl:
            log("cannot redirect Spotify without svcl.exe")
            return False
        self.route()
        return True

    def ffmpeg_input(self):
        return ["-f", "dshow", "-audio_buffer_size", "20", "-i", "audio=" + self.CABLE_CAPTURE]

    def route(self):
        # Windows keeps the per-app device, re-applying now and then covers a restarted Spotify
        if time.time() - self.last_route > 10:
            self.svcl_set(self.CABLE_RENDER)
            self.last_route = time.time()

    def close(self):
        if self.svcl:
            self.svcl_set("DefaultRenderDevice")
        self.last_route = 0

    def media_session(self):
        async def find():
            manager = await self.media.request_async()
            for session in manager.get_sessions():
                if "spotify" in session.source_app_user_model_id.lower():
                    return session
        return asyncio.run(find()) if self.media else None

    def spotify_playing(self):
        session = self.media_session()
        return bool(session) and int(session.get_playback_info().playback_status) == 4  # PLAYING

    def media_call(self, name):
        session = self.media_session()
        if session:
            async def call():
                await getattr(session, name)()
            asyncio.run(call())

    def spotify_pause(self):
        self.media_call("try_pause_async")

    def spotify_play(self):
        self.media_call("try_play_async")

    def open_url(self, url):
        os.startfile(url)

    def copy(self, text):
        subprocess.run(["clip"], input=text, text=True, **NO_WINDOW)


class Segmenter:
    """Cuts the captured stream into overlapping segments with equal-power crossfades."""

    def __init__(self, directory):
        self.directory = directory
        self.seg = int(SEGMENT * RATE)
        self.xf = int(CROSSFADE * RATE)
        ramp = np.linspace(0, 0.5 * np.pi, self.xf, endpoint=False)
        self.fade_in = np.sin(ramp)[:, None]
        self.fade_out = np.cos(ramp)[:, None]
        self.buffer = np.zeros((0, 2), dtype=np.float32)
        self.index = 0

    def feed(self, frames):
        self.buffer = np.concatenate([self.buffer, frames])
        while len(self.buffer) >= self.seg + self.xf:
            chunk = self.buffer[: self.seg + self.xf].copy()
            if self.index > 0:
                chunk[: self.xf] *= self.fade_in
            chunk[self.seg:] *= self.fade_out
            self.write(chunk)
            self.buffer = self.buffer[self.seg:]
            self.index += 1

    def write(self, chunk):
        pcm = np.clip(chunk, -32768, 32767).astype("<i2").tobytes()
        header = (b"RIFF" + (36 + len(pcm)).to_bytes(4, "little") + b"WAVEfmt "
                  + (16).to_bytes(4, "little") + (1).to_bytes(2, "little") + (2).to_bytes(2, "little")
                  + RATE.to_bytes(4, "little") + (RATE * 4).to_bytes(4, "little")
                  + (4).to_bytes(2, "little") + (16).to_bytes(2, "little")
                  + b"data" + len(pcm).to_bytes(4, "little"))
        path = os.path.join(self.directory, "seg_%d.wav" % self.index)
        with open(path + ".tmp", "wb") as f:
            f.write(header + pcm)
        os.replace(path + ".tmp", path)
        old = os.path.join(self.directory, "seg_%d.wav" % (self.index - KEEP_SEGMENTS))
        if os.path.exists(old):
            os.remove(old)


class Radio:
    def __init__(self, audio):
        self.audio = audio
        self.active = False
        self.ffmpeg = None
        self.paused_by_us = False
        self.last_route = 0
        self.last_status = 0
        self.eq = True
        self.gain = 1.0
        self.directory = default_segment_dir()
        self.last_attempt = 0

    def start(self, eq, directory):
        if time.time() - self.last_attempt < 10:  # setup failed recently, don't retry on every heartbeat
            return
        self.last_attempt = time.time()
        self.directory = directory or default_segment_dir()
        if not self.audio.open():
            return
        self.last_attempt = 0
        self.active = True
        self.start_capture(eq)
        self.audio.route()
        self.last_route = time.time()
        log("radio on, segments in " + self.directory)

    def start_capture(self, eq):
        self.eq = eq
        os.makedirs(self.directory, exist_ok=True)
        clear_segments(self.directory)
        cmd = ["ffmpeg", "-loglevel", "error"] + self.audio.ffmpeg_input()
        if eq:
            cmd += ["-af", CAR_EQ]
        try:
            self.ffmpeg = subprocess.Popen(cmd + ["-f", "s16le", "-ac", "2", "-ar", str(RATE), "-"],
                                           stdout=subprocess.PIPE, **NO_WINDOW)
        except OSError as err:
            log("could not start ffmpeg: %s" % err)
            return
        threading.Thread(target=self.read_loop, args=(self.ffmpeg, Segmenter(self.directory)), daemon=True).start()

    def stop_capture(self):
        if self.ffmpeg:
            self.ffmpeg.terminate()
            self.ffmpeg.wait()
            self.ffmpeg = None

    def read_loop(self, proc, segmenter):
        block = RATE // 50 * 4
        while True:
            data = proc.stdout.read(block)
            if not data:
                return
            frames = np.frombuffer(data[: len(data) // 4 * 4], dtype="<i2").astype(np.float32).reshape(-1, 2)
            if self.gain > 1:
                frames = soft_limit(frames * self.gain)
            segmenter.feed(frames)

    def stop(self):
        if not self.active:
            return
        self.audio.close()
        self.stop_capture()
        self.active = False
        self.paused_by_us = False
        clear_segments(self.directory)
        log("radio off")

    def update(self, play, eq, gain):
        """Pause Spotify while the radio is off in game (ignition off, on foot, paused) and resume after."""
        self.gain = gain
        if eq != self.eq:
            self.stop_capture()
            self.start_capture(eq)
        if time.time() - self.last_route > 1:
            self.audio.route()
            self.last_route = time.time()
        if not play and not self.paused_by_us and time.time() - self.last_status > 1:
            self.last_status = time.time()
            if self.audio.spotify_playing():
                self.audio.spotify_pause()
                self.paused_by_us = True
        elif play and self.paused_by_us:
            self.audio.spotify_play()
            self.paused_by_us = False


class ConnectionPool:
    """Keeps HTTPS connections to Spotify open, a fresh TLS handshake per request costs up to a second."""

    def __init__(self):
        self.idle = {}
        self.lock = threading.Lock()

    def request(self, host, method, path, body, headers):
        for attempt in range(2):
            with self.lock:
                conn = (self.idle.get(host) or [None]).pop()
            if conn is None:
                conn = http.client.HTTPSConnection(host, timeout=10)
            try:
                conn.request(method, path, body=body, headers=headers)
                res = conn.getresponse()
                data = res.read()
            except (http.client.HTTPException, OSError):
                conn.close()
                if attempt:
                    raise
                continue  # the kept connection was closed by Spotify, retry on a new one
            with self.lock:
                self.idle.setdefault(host, []).append(conn)
            return res.status, data, res.getheader("Retry-After")


POOL = ConnectionPool()


class SpotifyProxy(http.server.BaseHTTPRequestHandler):
    """Forwards requests to Spotify for the mod's game Lua (the game UI may not make web requests)."""

    def forward(self):
        prefix = next((p for p in PROXY_TARGETS if self.path.startswith(p)), None)
        if prefix is None:
            self.send_response(404)
            self.end_headers()
            return
        host, base = PROXY_TARGETS[prefix]
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        if body is None and self.command in ("POST", "PUT"):
            body = b""  # Spotify wants a Content-Length on empty PUT/POST
        headers = {k: self.headers[k] for k in ("Authorization", "Content-Type") if self.headers.get(k)}
        try:
            status, data, retry = POOL.request(host, self.command, base + self.path[len(prefix):], body, headers)
        except (http.client.HTTPException, OSError) as err:
            status, data, retry = 502, json.dumps({"error": "proxy", "error_description": str(err)}).encode(), None
        if prefix in IMAGE_PREFIXES and status == 200:
            data = base64.b64encode(data)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        if retry:
            self.send_header("Retry-After", retry)
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_DELETE = forward

    def log_request(self, code="-", size="-"):
        if isinstance(code, int) and code >= 400:  # only failures, the mod polls every few seconds
            log("proxy: %s %s -> %s" % (self.command, self.path.split("?")[0], code))

    def log_message(self, fmt, *args):
        log("proxy: " + fmt % args)


def start_proxy():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PROXY_PORT), SpotifyProxy)
    threading.Thread(target=server.serve_forever, daemon=True).start()


def main():
    # systemd/kill send SIGTERM: exit through the finally block so Spotify gets its normal output back
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    audio = WindowsAudio() if WINDOWS else LinuxAudio()
    audio.check()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", PORT))
    sock.settimeout(0.25)
    start_proxy()
    log("helper running")
    radio = Radio(audio)
    last_heartbeat = 0
    try:
        while True:
            msg = None
            try:
                data, _ = sock.recvfrom(8192)
                msg = json.loads(data)
            except (socket.timeout, ConnectionResetError, json.JSONDecodeError, UnicodeDecodeError):
                pass
            if not isinstance(msg, dict):
                msg = None
            if msg is not None and isinstance(msg.get("copy"), str):
                if msg["copy"].startswith(LOGIN_PREFIX):
                    audio.copy(msg["copy"])
                    log("login link copied")
            elif msg is not None and isinstance(msg.get("open"), str):
                # Spotify login link from the mod (the game itself cannot start a browser)
                ok = msg["open"].startswith(LOGIN_PREFIX)
                log("login link received" if ok else "login link rejected: " + msg["open"][:60])
                if ok:
                    audio.open_url(msg["open"])
            elif msg is not None:
                if msg.get("on"):
                    last_heartbeat = time.time()
                    eq = msg.get("eq", True) is not False
                    gain = msg.get("gain")
                    gain = min(2.0, max(1.0, float(gain))) if isinstance(gain, (int, float)) else 1.0
                    if not radio.active:
                        radio.start(eq, segment_dir_from_game(msg.get("dir")))
                    if radio.active:
                        radio.update(bool(msg.get("play")), eq, gain)
                else:
                    radio.stop()
            elif radio.active and time.time() - last_heartbeat > HEARTBEAT_TIMEOUT:
                radio.stop()
    finally:
        radio.stop()


if __name__ == "__main__":
    main()
