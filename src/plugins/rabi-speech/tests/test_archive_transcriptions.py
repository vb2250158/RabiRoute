from fastapi.testclient import TestClient
from test_api import fixture


def configured(tmp_path):
    client, _, asr = fixture(tmp_path)
    response = client.put('/v1/microphone/settings', json={'asr_model': 'fake-asr/pc-model', 'language': 'zh', 'prompt': 'pc-context'})
    assert response.status_code == 200
    return client, asr


def post(client, endpoint='/v1/audio/transcriptions', **data):
    return client.post(endpoint, files={'file': ('sample.wav', b'fake-audio', 'audio/wav')}, data=data)


def test_batch_uses_pc_selection_and_explicit_overrides(tmp_path):
    client, asr = configured(tmp_path)
    assert post(client).status_code == 200
    assert (asr.requests[-1].model, asr.requests[-1].language, asr.requests[-1].prompt) == ('pc-model', 'zh', 'pc-context')
    assert post(client, model='fake-asr/explicit', language='en', prompt='override').status_code == 200
    assert (asr.requests[-1].model, asr.requests[-1].language, asr.requests[-1].prompt) == ('explicit', 'en', 'override')
    assert post(client, provider='fake-asr', model='explicit').status_code == 200
    assert asr.requests[-1].model == 'explicit'
    assert post(client, provider='fake-asr').status_code == 200
    assert asr.requests[-1].model == 'asr-local'
    assert post(client, prompt='', language='en').status_code == 200
    assert asr.requests[-1].prompt is None
    assert asr.requests[-1].language == 'en'
    assert post(client, model='').status_code == 422


def test_archive_computation_has_no_record_side_effects_and_cleans_temp(tmp_path):
    client, asr = configured(tmp_path)
    response = post(client, '/v1/archive/transcriptions', job_key='job_123')
    assert response.status_code == 200
    assert response.json()['provider'] == 'fake-asr'
    assert response.json()['model'] == 'pc-model'
    assert response.json()['segments']
    assert not list((tmp_path / 'records').rglob('*.json'))
    assert not asr.requests[-1].audio_path.exists()
    assert post(client, '/v1/archive/transcriptions', job_key='../bad').status_code == 422
    assert post(client, '/v1/archive/transcriptions').status_code == 422


def test_archive_requires_loopback(tmp_path):
    client, asr = configured(tmp_path)
    remote = TestClient(client.app, client=('192.0.2.10', 12345))
    assert post(remote, '/v1/archive/transcriptions', job_key='job').status_code == 403
    assert not asr.requests


def test_archive_failure_does_not_fallback_and_cleans_temp(tmp_path):
    client, asr = configured(tmp_path)
    async def failed(request):
        asr.requests.append(request)
        raise RuntimeError('model unavailable')
    asr.transcribe = failed
    response = post(client, '/v1/archive/transcriptions', job_key='job', model='fake-asr/unavailable')
    assert response.status_code == 502
    assert len(asr.requests) == 1
    assert asr.requests[0].model == 'unavailable'
    assert not asr.requests[0].audio_path.exists()
    assert not list((tmp_path / 'records').rglob('*.json'))
    assert post(client, '/v1/archive/transcriptions', job_key='job2', provider='unknown-provider', model='model').status_code == 400
    assert len(asr.requests) == 1
