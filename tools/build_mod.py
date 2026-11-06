#!/usr/bin/env python3
"""Packs the mod folder into dist/spotifyremote_davidx3d.zip, ready to drop into BeamNG's mods folder."""
import os
import zipfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
mod = os.path.join(root, "mod")
out = os.path.join(root, "dist", "spotifyremote_davidx3d.zip")
os.makedirs(os.path.dirname(out), exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for folder, _, files in os.walk(mod):
        for name in files:
            path = os.path.join(folder, name)
            z.write(path, os.path.relpath(path, mod).replace(os.sep, "/"))
print(out)
