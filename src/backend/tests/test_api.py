import json
from uuid import uuid4

from fastapi.testclient import TestClient

from rabbit_hole.app import create_app
from rabbit_hole.config import Settings
from rabbit_hole.models import Answer


class FakeService:
    def __init__(self, settings, registry, budget, emit):
        self.registry, self.emit = registry, emit
    async def answer(self, request, original_query, search=True):
        s = self.registry.add({'url': 'https://example.com/article', 'title': 'Real fetched page', 'content': 'Evidence'})
        await self.emit('sources', {'sources': [s.model_dump()]})
        return Answer(claims=[], limitation='요약만 확보')
    async def relationships(self):
        raise RuntimeError('secret provider failure')
    async def close(self):
        pass


def events(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]


def settings(**kwargs):
    return Settings(openai_api_key='fake', tavily_api_key='fake', session_signing_key='x' * 32, **kwargs)


def test_partial_keeps_cards_and_sanitizes_error():
    client = TestClient(create_app(settings(), FakeService))
    request_id = str(uuid4())
    response = client.post('/api/search', json={'query': 'vector', 'request_id': request_id})
    assert response.status_code == 200
    data = events(response)
    assert all(e['request_id'] == request_id for e in data)
    assert any(e['type'] == 'sources' and e['data']['sources'][0]['title'] == 'Real fetched page' for e in data)
    assert data[-1]['data']['status'] == 'partial'
    assert 'secret provider failure' not in response.text
    assert '디자인 예시' not in response.text
    job = data[0]
    assert client.delete('/api/jobs/' + job['job_id']).status_code == 404
    assert client.delete('/api/jobs/' + job['job_id'], headers={'Authorization': 'Bearer ' + job['data']['access_token']}).status_code == 204


def test_flight_clarification_without_keys_or_paid_call():
    client = TestClient(create_app(Settings(openai_api_key='', tavily_api_key='')))
    data = events(client.post('/api/search', json={'query': '오사카 항공권', 'request_id': str(uuid4())}))
    assert [e['type'] for e in data] == ['started', 'clarification', 'done']


def test_missing_keys_explicit_error_no_sample():
    client = TestClient(create_app(Settings(openai_api_key='', tavily_api_key='')))
    response = client.post('/api/search', json={'query': 'vector', 'request_id': str(uuid4())})
    assert response.status_code == 503
    assert 'sources' not in response.json()


def test_rate_limit_input_and_forged_continuation():
    client = TestClient(create_app(settings(requests_per_minute=1), FakeService))
    body = {'query': 'vector', 'request_id': str(uuid4())}
    assert client.post('/api/search', json={**body, 'query': ' '}).status_code == 422
    assert client.post('/api/search', json={**body, 'continuation': 'fake'}).status_code == 409
    assert client.post('/api/search', json=body).status_code == 200
    assert client.post('/api/search', json=body).status_code == 429


def test_retry_uses_signed_sources_and_does_not_search():
    class RetryService(FakeService):
        async def answer(self, request, original_query, search=True):
            if request.retry_part:
                assert not search
                assert self.registry.sources
            return await super().answer(request, original_query, search)
    client = TestClient(create_app(settings(), RetryService))
    body = {'query': 'vector', 'request_id': str(uuid4())}
    data = events(client.post('/api/search', json=body))
    token = next(e['data']['continuation'] for e in data if e['type'] == 'checkpoint')
    response = client.post('/api/search', json={**body, 'continuation': token, 'retry_part': 'answer'})
    assert events(response)[-1]['data']['status'] == 'completed'
