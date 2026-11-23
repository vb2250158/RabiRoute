"""Resolve one Xiaomi Home event through the installed Host; optionally extract review frames."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


http = build_opener(ProxyHandler({}), NoRedirect())


def read_json(url):
    with http.open(url, timeout=12) as response:
        return json.load(response)


def check_owner(base, host):
    meta = read_json(base + "/meta")
    if not meta["health"]["live"] or any(
        not host.get(key) or meta.get(key) != host[key]
        for key in ("applicationGenerationId", "managerInstanceId")
    ):
        raise ValueError("Manager identity changed; resolve the original event again")


def resolve_record(result, event_id, resource, role, artifact_id):
    if result.get("code") != 0 or not isinstance(result.get("data"), list):
        raise ValueError("Artifact query did not return a list")
    matches = [row for row in result["data"] if row.get("resourceId") == resource
               and row.get("sourceEventId") == event_id and row.get("ownerRoleId") == role]
    if len(matches) > 1 or (artifact_id and (not matches or matches[0]["artifactId"] != artifact_id)):
        raise ValueError("Artifact reference does not resolve to this event and role")
    if not matches and result.get("coverage", {}).get("state") != "complete":
        raise ValueError("Artifact coverage is incomplete")
    return matches[0] if matches else None


def extract_frames(media, dest, media_kind):
    timestamps = [0]
    if media_kind == "video/mp4":
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(media)],
            capture_output=True, text=True, timeout=20, check=True)
        duration = float(json.loads(probe.stdout)["format"]["duration"])
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("Video duration unavailable")
        timestamps = [duration * fraction for fraction in (0, 0.45, 0.85)]
    elif media_kind != "image/jpeg":
        raise ValueError("Unsupported event media")
    frames = []
    for i, position in enumerate(timestamps):
        frame = dest / f"frame-{i + 1}.jpg"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", str(position), "-i", str(media),
                        "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=min(960\\,iw):-2",
                        "-q:v", "3", str(frame)], capture_output=True, timeout=30, check=True)
        if frame.is_file() and frame.stat().st_size:
            frames.append({"seconds": round(position, 3), "path": str(frame)})
    if not frames:
        raise ValueError("Decoder returned no frames")
    return frames


def review(args):
    status = subprocess.run([args.host, "--command", "status", "--json"], capture_output=True,
                            encoding="utf-8-sig", check=True, timeout=12)
    host = json.loads(status.stdout)
    base = host["managerBaseUrl"].rstrip("/")
    address = urlsplit(base)
    if address.scheme != "http" or address.hostname not in {"localhost", "127.0.0.1", "::1"} or address.username or address.password:
        raise ValueError("Expected the installed Host's local Manager")
    check_owner(base, host)
    root = base + "/api/agent/xiaomi-home/artifacts"
    result = read_json(root + "?" + urlencode({"resourceId": args.resource}))
    record = resolve_record(result, args.event, args.resource, args.role, args.artifact)
    check_owner(base, host)
    if record is None:
        return {"state": "no_matching_artifact", "sourceEventId": args.event}
    answer = {"state": "available", "sourceEventId": args.event, "artifactId": record["artifactId"]}
    if not args.frames:
        return answer
    url = root + "/" + quote(record["artifactId"], safe="") + "/content"
    dest = Path(tempfile.mkdtemp(prefix="rabi-event-frames-"))
    try:
        with tempfile.TemporaryDirectory(prefix="rabi-event-media-") as scratch:
            media = Path(scratch) / "event"
            digest = hashlib.sha256()
            with http.open(url, timeout=30) as response, media.open("xb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    digest.update(chunk)
                    if output.tell() > record["byteLength"]:
                        raise ValueError("Artifact exceeds its registered size")
            if media.stat().st_size != record["byteLength"] or digest.hexdigest() != record["sha256"]:
                raise ValueError("Artifact content does not match its registration")
            answer["frames"] = extract_frames(media, dest, record["mediaKind"])
            check_owner(base, host)
    except BaseException:
        shutil.rmtree(dest)
        raise
    return answer


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("host", "role", "event", "resource"):
        parser.add_argument("--" + field, required=True)
    parser.add_argument("--artifact", help="Also require this exact artifact ID")
    parser.add_argument("--frames", action="store_true", help="Extract frames for authorized review; remove them after viewing")
    try:
        print(json.dumps(review(parser.parse_args()), ensure_ascii=True))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        sys.exit(f"Event review unavailable: {error}")
