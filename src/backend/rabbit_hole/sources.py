import asyncio
import hashlib
import ipaddress
import socket
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .models import Answer, Evidence, Relationships, Source, utc_now

TRACKING = {"fbclid", "gclid", "msclkid", "mc_cid", "mc_eid"}


def normalize_url(raw: str) -> str:
    if len(raw) > 4096 or any(ord(c) < 32 for c in raw):
        raise ValueError("Invalid URL")
    p = urlsplit(raw)
    if p.scheme not in {"http", "https"} or not p.hostname or p.username or p.password:
        raise ValueError("Unsafe URL")
    host = p.hostname.encode("idna").decode().lower().rstrip(".")
    if host == "localhost" or "." not in host or host.endswith((".localhost", ".local", ".internal")):
        raise ValueError("Private hostname")
    try:
        if not ipaddress.ip_address(host).is_global:
            raise ValueError("Private IP")
    except ValueError as error:
        if str(error) == "Private IP":
            raise
    if p.port not in {None, 80, 443}:
        raise ValueError("Unsafe port")
    query = [
        (k, v)
        for k, v in parse_qsl(p.query, keep_blank_values=True)
        if not k.lower().startswith("utm_") and k.lower() not in TRACKING
    ]
    # Preserve parameter order, repeated keys and trailing slash: they can distinguish pages.
    netloc = f"[{host}]" if ":" in host else host
    if p.port and p.port != (443 if p.scheme == "https" else 80):
        netloc += f":{p.port}"
    return urlunsplit((p.scheme, netloc, p.path or "/", urlencode(query), ""))


async def public_url(raw: str) -> str:
    url = normalize_url(raw)
    host = urlsplit(url).hostname
    records = await asyncio.wait_for(
        asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM), 3
    )
    if not records or any(not ipaddress.ip_address(r[4][0]).is_global for r in records):
        raise ValueError("Non-public DNS")
    return url


class Registry:
    def __init__(self, sources: list[Source] | None = None):
        self.sources = {s.id: s for s in sources or []}

    def add(self, raw: dict) -> Source:
        original = raw["url"]
        url = normalize_url(original)
        sid = "src_" + hashlib.sha256(url.encode()).hexdigest()[:24]
        if sid not in self.sources:
            self.sources[sid] = Source(
                id=sid,
                original_url=original,
                url=url,
                domain=urlsplit(url).hostname or "",
                title=str(raw.get("title") or url)[:400],
                summary=str(raw.get("content") or "")[:2500],
                # Search does not guarantee publication dates. Never infer them.
                published_at=raw.get("published_date"),
                retrieved_at=utc_now(),
            )
        return self.sources[sid]

    def evidence(self, evidence: Evidence) -> bool:
        source = self.sources.get(evidence.source_id)
        if not source or not evidence.quote.strip():
            return False
        if evidence.basis == "excerpt" and source.read_status != "read":
            return False
        text = source.excerpt if evidence.basis == "excerpt" else source.summary
        return " ".join(evidence.quote.split()) in " ".join(text.split())

    def validate_answer(self, answer: Answer) -> Answer:
        for claim in answer.claims:
            if not claim.evidence or not all(self.evidence(e) for e in claim.evidence):
                raise ValueError("Unsupported citation")
        return answer

    def validate_relationships(self, graph: Relationships) -> Relationships:
        pairs = set()
        for edge in graph.relations:
            if (
                edge.source == edge.target
                or edge.source not in self.sources
                or edge.target not in self.sources
            ):
                raise ValueError("Unknown graph endpoint")
            if not edge.evidence or not all(self.evidence(e) for e in edge.evidence):
                raise ValueError("Unsupported edge evidence")
            if not {edge.source, edge.target}.issubset({e.source_id for e in edge.evidence}):
                raise ValueError("Both pages need evidence")
            pair = tuple(sorted([edge.source, edge.target]))
            if pair in pairs:
                raise ValueError("Duplicate relationship")
            pairs.add(pair)
        for label in graph.page_types:
            if label.source_id not in self.sources:
                raise ValueError("Unknown page classification")
        assigned = set()
        for cluster in graph.clusters:
            for sid in cluster.source_ids:
                if sid not in self.sources or sid in assigned:
                    raise ValueError("Invalid cluster source")
                assigned.add(sid)
        return graph
