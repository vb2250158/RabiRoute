import argparse
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

root = Path(os.environ['RABI_PORT_CANDIDATE']) if os.environ.get('RABI_PORT_CANDIDATE') else Path(__file__).resolve().parents[4]
file = root / 'src/plugins/rabi-speech/scripts/benchmark_models.py'
spec = importlib.util.spec_from_file_location('benchmark_models', file)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class ServiceDiscoveryTest(unittest.TestCase):
    def test_parser_has_no_guessed_port(self):
        args = module.build_parser().parse_args(['asr-http', '--provider', 'fixture', '--model', 'fixture', '--tts-results', 'fixture.json', '--output', 'fixture-out.json'])
        self.assertIsNone(args.service_url)

    def test_explicit_url_needs_no_node(self):
        with patch.object(module.subprocess, 'run', side_effect=AssertionError('unexpected discovery')):
            self.assertEqual(module.resolve_speech_service_url('https://explicit.example.invalid/base/'), 'https://explicit.example.invalid/base')

    def test_default_uses_shared_owner_resolver(self):
        result = subprocess.CompletedProcess([], 0, 'http://127.0.0.1:51234\n', '')
        with patch.object(module.shutil, 'which', return_value='fixture-node'), patch.object(module.subprocess, 'run', return_value=result) as run:
            self.assertEqual(module.resolve_speech_service_url(None), 'http://127.0.0.1:51234')
            self.assertEqual(run.call_args.args[0], ['fixture-node', str(root / 'scripts/resolve-speech.mjs')])
            self.assertEqual(run.call_args.kwargs['timeout'], 30)

    def test_unavailable_discovery_is_an_error(self):
        with patch.object(module.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(RuntimeError, '--service-url'):
                module.resolve_speech_service_url(None)
        with patch.object(module.shutil, 'which', return_value='fixture-node'), patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'owner offline')):
            with self.assertRaisesRegex(RuntimeError, 'owner offline'):
                module.resolve_speech_service_url(None)

    def test_transcription_consumes_resolved_owner(self):
        args = argparse.Namespace(service_url=None, tts_results=['fixture.json'], worker_url=None,
            provider='fixture', model='fixture', language='zh', gpu_sample_interval=0.2, timeout=3,
            output='unused.json')
        source = dict(benchmark_audio='fixture.wav', reference_text='fixture', engine='fixture', sample_id='fixture')
        class Probe:
            def __init__(self, **kwargs): pass
            def start(self): pass
            def stop(self): return {}
        with tempfile.TemporaryDirectory() as directory:
            args.output = str(Path(directory) / 'result.json')
            with patch.object(module, 'resolve_speech_service_url', return_value='http://127.0.0.1:51234'), patch.object(module, 'read_json', return_value={'records': [source]}), patch.object(module, 'GpuProbe', Probe), patch.object(module, 'wav_stats', return_value={'duration_seconds': 1}), patch.object(module, 'request_multipart_json', return_value={'text': 'fixture'}) as request:
                module.benchmark_asr_http(args)
                self.assertEqual(request.call_args.args[0], 'http://127.0.0.1:51234/v1/audio/transcriptions')
                self.assertTrue(Path(args.output).is_file())


if __name__ == '__main__':
    unittest.main()
