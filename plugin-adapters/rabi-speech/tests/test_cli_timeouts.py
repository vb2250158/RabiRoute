import io
import json
import runpy
import sys
import hashlib
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).parents[1] / "scripts"

def test_cli_defaults_follow_snapshot_and_explicit_options_win(monkeypatch):
    monkeypatch.setenv("RABIROUTE_TIMEOUT_OVERRIDES", json.dumps({"speech.benchmark.job":2500,"speech.install.download":3500,"speech.install.metadata":4500}))
    benchmark = runpy.run_path(str(SCRIPTS / "benchmark_models.py"))
    parser = benchmark["build_parser"]()
    args = parser.parse_args(["tts","--engine","test","--url","https://example.test","--texts","unused","--output","unused"])
    assert args.job_timeout == 2.5
    args = parser.parse_args(["tts","--engine","test","--url","https://example.test","--texts","unused","--output","unused","--job-timeout","6"])
    assert args.job_timeout == 6
    installer = runpy.run_path(str(SCRIPTS / "install_models.py"))
    with patch.object(sys,"argv",["install_models","--list"]):
        args = installer["parse_args"]()
        assert args.download_timeout == 3.5
        assert args.etag_timeout == 4.5
    with patch.object(sys,"argv",["install_models","--list","--download-timeout","7"]):
        assert installer["parse_args"]().download_timeout == 7

def test_file_download_uses_explicit_timeout_without_network(tmp_path, monkeypatch):
    monkeypatch.setenv("RABIROUTE_TIMEOUT_OVERRIDES",'{"speech.install.download":3500}')
    installer = runpy.run_path(str(SCRIPTS / "install_models.py"))
    calls=[]
    def opened(request,timeout):
        calls.append(timeout)
        return io.BytesIO(b"test-model")
    with patch("urllib.request.urlopen",opened):
        installer["download_file"]("https://example.test/model",tmp_path/"model",hashlib.sha256(b"test-model").hexdigest(),timeout_seconds=7)
    assert calls == [7]
