import asyncio
import time

import pytest

from rabbit_hole.config import Settings
from rabbit_hole.models import Answer, Claim, Evidence, Relation, Relationships, Snapshot
from rabbit_hole.search import Budget, Filters, SearchTools
from rabbit_hole.security import SnapshotSigner
from rabbit_hole.sources import Registry, normalize_url


def registry():
    r = Registry()
    a = r.add({'url': 'https://example.com/a?utm_source=x', 'title': 'A', 'content': 'Vector search uses embeddings.'})
    b = r.add({'url': 'https://example.com/b', 'title': 'B', 'content': 'Embeddings are vectors.'})
    return r, a, b


def test_pages_preserved_tracking_deduplicated_and_query_kept():
    r, a, b = registry()
    assert a.id != b.id
    assert r.add({'url': 'https://example.com/a?utm_source=another'}).id == a.id
    assert r.add({'url': 'https://example.com/a?id=2'}).id != a.id
    assert normalize_url('https://example.com/?q=a&q=b#frag') == 'https://example.com/?q=a&q=b'


@pytest.mark.parametrize('url', ['javascript:alert(1)', 'http://localhost/a', 'http://127.0.0.1/',
                                  'http://169.254.169.254/', 'https://user:pass@example.com',
                                  'http://[::1]/', 'https://example.com:8080', 'ftp://example.com'])
def test_unsafe_urls(url):
    with pytest.raises(ValueError):
        normalize_url(url)


def test_nonexistent_citation_and_false_read_blocked():
    r, a, _ = registry()
    for evidence in [Evidence(source_id='made_up', quote='x', basis='summary'),
                     Evidence(source_id=a.id, quote='Fabricated', basis='summary'),
                     Evidence(source_id=a.id, quote=a.summary, basis='excerpt')]:
        with pytest.raises(ValueError):
            r.validate_answer(Answer(claims=[Claim(text='X', evidence=[evidence])], limitation=''))


def test_nonexistent_endpoint_and_one_sided_evidence_blocked():
    r, a, b = registry()
    e = Evidence(source_id=a.id, quote=a.summary, basis='summary')
    for target in ['fake', b.id]:
        edge = Relation(source=a.id, target=target, kind='same_topic', label='topic', explanation='test',
                        evidence=[e], strength='core')
        with pytest.raises(ValueError):
            r.validate_relationships(Relationships(relations=[edge], clusters=[]))


def test_server_budgets_and_cancel():
    budget = Budget(Settings(max_search_calls=1, max_extract_sources=1))
    budget.search()
    budget.read(1)
    with pytest.raises(ValueError):
        budget.search()
    with pytest.raises(ValueError):
        budget.read(1)
    budget.cancelled.set()
    with pytest.raises(asyncio.CancelledError):
        budget.check()


def test_signed_continuation_tamper_and_sample_rejection():
    r, _, _ = registry()
    signer = SnapshotSigner('a' * 32)
    token = signer.sign(Snapshot(query='x', sources=list(r.sources.values()), issued_at=time.time()))
    assert len(signer.verify(token).sources) == 2
    with pytest.raises(ValueError):
        signer.verify(token + 'x')
    with pytest.raises(ValueError):
        Snapshot(query='x', sources=[], issued_at=time.time(), mode='sample')


async def test_unknown_extract_id_never_calls_provider():
    r, _, _ = registry()
    class Client:
        async def extract(self, **kwargs):
            pytest.fail('Provider must not be called')
    async def emit(*args):
        pass
    tools = SearchTools(r, Budget(Settings()), emit, Client())
    with pytest.raises(ValueError):
        await tools.read_sources(['missing'])


async def test_search_retry_is_charged(monkeypatch):
    class Client:
        calls = 0
        async def search(self, **kwargs):
            self.calls += 1
            raise TimeoutError()
    async def emit(*args):
        pass
    client = Client()
    tools = SearchTools(Registry(), Budget(Settings(max_search_calls=1)), emit, client)
    with pytest.raises(ValueError):
        await tools.search_web('hello', Filters(topic='general', include_domains=[]))
    assert client.calls == 1
